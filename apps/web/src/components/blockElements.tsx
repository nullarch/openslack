import { Check, ChevronDown, MoreHorizontal, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { conversationName, get, useStore } from '../lib/store';
import { textOf, useSurface, type OptionObject, type StateValue, type Suggestions } from '../lib/surface';
import { S } from '../strings';
import { confirmDialog } from './dialogs/confirm';
import { PlainText } from './text';
import { MenuItem, Popover } from './ui';

// Block Kit arrives as loosely typed JSON; each element checks what it reads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface ElementProps {
  element: Any;
  blockId: string;
  /** The block holding the element; `input` blocks collect values instead of acting at once. */
  block: Any;
}

/** Ask the person to confirm when the element carries a `confirm` object. */
async function confirmed(element: Any): Promise<boolean> {
  const dialog = element?.confirm;
  if (!dialog) return true;
  return confirmDialog(textOf(dialog.text), textOf(dialog.confirm) || S.platform.confirmYes, textOf(dialog.title) || S.platform.confirmTitle);
}

/**
 * What an element needs from its surface: record a value into the surface's
 * state, and deliver an action when the element acts (anywhere outside an
 * `input` block, or inside one with `dispatch_action`).
 */
function useElement({ element, blockId, block }: ElementProps) {
  const surface = useSurface();
  const actionId = String(element?.action_id ?? '');
  const type = String(element?.type ?? '');
  const dispatches = block?.type !== 'input' || block?.dispatch_action === true;
  const [busy, setBusy] = useState(false);
  // What was entered before (going back to a view, or after a reload) wins over the element's initial value.
  const [stored] = useState<StateValue | undefined>(() => (surface && actionId ? surface.state.get(blockId, actionId) : undefined));

  const record = (fields: Record<string, unknown>): void => {
    if (!surface || !actionId) return;
    surface.state.set(blockId, actionId, { type, ...fields } as StateValue);
  };
  /** A change the person made (not the starting value): the block's error no longer applies. */
  const touch = (fields: Record<string, unknown>): void => {
    record(fields);
    surface?.changed?.(blockId);
  };

  /** Record, then act (after confirmation). Resolves false when the person declined. */
  const send = async (fields: Record<string, unknown>, force = false): Promise<boolean> => {
    touch(fields);
    if (!surface || !actionId || (!dispatches && !force)) return true;
    if (!(await confirmed(element))) return false;
    setBusy(true);
    try {
      await surface.act({ type, action_id: actionId, block_id: blockId, ...fields });
    } finally {
      setBusy(false);
    }
    return true;
  };

  return { surface, actionId, type, dispatches, busy, record, touch, send, stored };
}

/** Record an element's starting value once, so it is part of the state even if never touched. */
function useInitial(record: (fields: Record<string, unknown>) => void, fields: Record<string, unknown> | null): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || fields === null) return;
    done.current = true;
    record(fields);
    // The starting value is read once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

// ── Buttons and menus that act ─────────────────────────────────────────────

export function ActionButton(props: ElementProps) {
  const { element } = props;
  const { send, busy } = useElement(props);
  const style = element.style === 'primary' ? 'primary' : element.style === 'danger' ? 'danger' : 'default';
  const click = async (): Promise<void> => {
    if (element.url) {
      if (!(await confirmed(element))) return;
      window.open(String(element.url), '_blank', 'noopener');
      // A link button tells the app only when it has an action id.
      if (element.action_id) await send({ value: element.value, text: element.text, style: element.style }, true).catch(() => undefined);
      return;
    }
    // Without an action id there is nothing to tell the app.
    if (!element.action_id) return;
    await send({ value: element.value, text: element.text, style: element.style }, true);
  };
  return (
    <button type="button" className={`block-btn is-${style} ${busy ? 'is-pending' : ''}`} disabled={busy} onClick={() => void click()}>
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      <span>
        <PlainText text={textOf(element.text)} />
      </span>
    </button>
  );
}

function optionsOf(element: Any): OptionObject[] {
  const out: OptionObject[] = [];
  if (Array.isArray(element?.options)) out.push(...element.options);
  if (Array.isArray(element?.option_groups)) for (const group of element.option_groups) if (Array.isArray(group?.options)) out.push(...group.options);
  return out;
}

export function StaticSelect(props: ElementProps) {
  const { element } = props;
  const { send, record, stored } = useElement(props);
  const options = optionsOf(element);
  const start = stored ? (stored.selected_option as OptionObject | null) : element.initial_option;
  const initial = start?.value !== undefined ? String(start.value) : '';
  const [value, setValue] = useState(initial);
  useInitial(record, { selected_option: initial ? (options.find((option) => String(option.value) === initial) ?? null) : null });
  const groups: Any[] = Array.isArray(element.option_groups) ? element.option_groups : [];
  return (
    <select
      className="block-select"
      value={value}
      onChange={(event) => {
        const previous = value;
        const next = event.target.value;
        setValue(next);
        const selected = options.find((option) => String(option.value) === next) ?? null;
        void send({ selected_option: selected }).then((ok) => {
          if (!ok) setValue(previous);
        });
      }}
    >
      <option value="" disabled>
        {textOf(element.placeholder) || S.blocks.choose}
      </option>
      {groups.length > 0
        ? groups.map((group, groupIndex) => (
            <optgroup key={groupIndex} label={textOf(group.label)}>
              {(group.options ?? []).map((option: Any, index: number) => (
                <option key={index} value={String(option.value)}>
                  {textOf(option.text)}
                </option>
              ))}
            </optgroup>
          ))
        : options.map((option, index) => (
            <option key={index} value={String(option.value)}>
              {textOf(option.text)}
            </option>
          ))}
    </select>
  );
}

export function Overflow(props: ElementProps) {
  const { element } = props;
  const { send } = useElement(props);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const options = optionsOf(element);
  return (
    <>
      <button ref={anchor} type="button" className="block-btn is-default is-icon" aria-label={S.blocks.moreOptions} onClick={() => setOpen(true)}>
        <MoreHorizontal size={16} />
      </button>
      {open ? (
        <Popover anchor={anchor.current} onClose={() => setOpen(false)} align="end" className="menu">
          {options.map((option, index) => (
            <MenuItem
              key={index}
              label={textOf(option.text)}
              onSelect={() => {
                setOpen(false);
                if (option.url) window.open(String(option.url), '_blank', 'noopener');
                void send({ selected_option: option }, true);
              }}
            />
          ))}
        </Popover>
      ) : null}
    </>
  );
}

// ── Text, numbers, dates and times ─────────────────────────────────────────

function TextInput(props: ElementProps) {
  const { element } = props;
  const { send, record, touch, dispatches, type, stored } = useElement(props);
  const [value, setValue] = useState<string>(() => {
    if (stored) return typeof stored.value === 'string' ? stored.value : '';
    return element.initial_value !== undefined ? String(element.initial_value) : '';
  });
  useInitial(record, { value: value === '' ? null : value });
  const triggers: string[] = element.dispatch_action_config?.trigger_actions_on ?? ['on_enter_pressed'];
  const typing = useRef<number | null>(null);

  const change = (next: string): void => {
    setValue(next);
    touch({ value: next === '' ? null : next });
    if (dispatches && triggers.includes('on_character_entered')) {
      if (typing.current) window.clearTimeout(typing.current);
      typing.current = window.setTimeout(() => void send({ value: next }), 600);
    }
  };
  const common = {
    className: 'block-input',
    value,
    placeholder: textOf(element.placeholder),
    maxLength: typeof element.max_length === 'number' ? element.max_length : undefined,
    minLength: typeof element.min_length === 'number' ? element.min_length : undefined,
    'data-action-id': element.action_id,
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const multiline = element.multiline === true;
      if (event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey) && dispatches && triggers.includes('on_enter_pressed')) {
        event.preventDefault();
        void send({ value });
      }
    },
  };
  if (type === 'plain_text_input' && element.multiline === true) {
    return <textarea {...common} rows={4} onChange={(event) => change(event.target.value)} />;
  }
  const inputType = type === 'email_text_input' ? 'email' : type === 'url_text_input' ? 'url' : type === 'number_input' ? 'number' : 'text';
  return (
    <input
      {...common}
      type={inputType}
      step={type === 'number_input' ? (element.is_decimal_allowed ? 'any' : '1') : undefined}
      min={type === 'number_input' && element.min_value !== undefined ? String(element.min_value) : undefined}
      max={type === 'number_input' && element.max_value !== undefined ? String(element.max_value) : undefined}
      onChange={(event) => change(event.target.value)}
    />
  );
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function DateLike(props: ElementProps) {
  const { element } = props;
  const { send, record, type, stored } = useElement(props);
  const field = type === 'datepicker' ? 'selected_date' : type === 'timepicker' ? 'selected_time' : 'selected_date_time';
  const toInput = (): string => {
    const start = stored ? stored[field] : type === 'datepicker' ? element.initial_date : type === 'timepicker' ? element.initial_time : element.initial_date_time;
    if (type !== 'datetimepicker') return typeof start === 'string' ? start : '';
    if (typeof start !== 'number') return '';
    const date = new Date(start * 1000);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const toValue = (input: string): unknown => {
    if (!input) return null;
    return type === 'datetimepicker' ? Math.floor(new Date(input).getTime() / 1000) : input;
  };
  const [value, setValue] = useState(toInput);
  useInitial(record, { [field]: toValue(value) });
  return (
    <input
      className="block-input block-date"
      type={type === 'datepicker' ? 'date' : type === 'timepicker' ? 'time' : 'datetime-local'}
      value={value}
      aria-label={textOf(element.placeholder) || undefined}
      data-action-id={element.action_id}
      onChange={(event) => {
        const previous = value;
        setValue(event.target.value);
        void send({ [field]: toValue(event.target.value) }).then((ok) => {
          if (!ok) setValue(previous);
        });
      }}
    />
  );
}

// ── Checkboxes and radio buttons ───────────────────────────────────────────

function OptionLabel({ option }: { option: OptionObject }) {
  return (
    <span className="block-choice-text">
      <PlainText text={textOf(option.text)} />
      {option.description ? <span className="block-choice-hint">{textOf(option.description)}</span> : null}
    </span>
  );
}

function Checkboxes(props: ElementProps) {
  const { element } = props;
  const { send, record, stored } = useElement(props);
  const options = optionsOf(element);
  const [chosen, setChosen] = useState<string[]>(() => {
    const start = stored ? stored.selected_options : element.initial_options;
    return Array.isArray(start) ? start.map((option: Any) => String(option.value)) : [];
  });
  const picked = (values: string[]): OptionObject[] => options.filter((option) => values.includes(String(option.value)));
  useInitial(record, { selected_options: picked(chosen) });
  return (
    <div className="block-choices" role="group">
      {options.map((option) => {
        const value = String(option.value);
        return (
          <label key={value} className="block-choice">
            <input
              type="checkbox"
              checked={chosen.includes(value)}
              onChange={(event) => {
                const next = event.target.checked ? [...chosen, value] : chosen.filter((entry) => entry !== value);
                setChosen(next);
                void send({ selected_options: picked(next) }).then((ok) => {
                  if (!ok) setChosen(chosen);
                });
              }}
            />
            <OptionLabel option={option} />
          </label>
        );
      })}
    </div>
  );
}

function RadioButtons(props: ElementProps) {
  const { element, blockId } = props;
  const { send, record, stored } = useElement(props);
  const options = optionsOf(element);
  const [chosen, setChosen] = useState<string>(() => {
    const start = stored ? (stored.selected_option as OptionObject | null) : element.initial_option;
    return start?.value !== undefined ? String(start.value) : '';
  });
  useInitial(record, { selected_option: options.find((option) => String(option.value) === chosen) ?? null });
  return (
    <div className="block-choices" role="radiogroup">
      {options.map((option) => {
        const value = String(option.value);
        return (
          <label key={value} className="block-choice">
            <input
              type="radio"
              name={`${blockId}:${String(element.action_id)}`}
              checked={chosen === value}
              onChange={() => {
                const previous = chosen;
                setChosen(value);
                void send({ selected_option: option }).then((ok) => {
                  if (!ok) setChosen(previous);
                });
              }}
            />
            <OptionLabel option={option} />
          </label>
        );
      })}
    </div>
  );
}

// ── Pickers: people, conversations, external options, several of anything ──

interface Choice {
  value: string;
  label: string;
  option?: OptionObject;
}

interface PickerProps {
  placeholder: string;
  multiple: boolean;
  selected: Choice[];
  /** Choices for what was typed (all of them for an empty query). */
  load: (query: string) => Promise<Choice[]> | Choice[];
  onChange: (next: Choice[]) => void;
  actionId: string;
}

function Picker({ placeholder, multiple, selected, load, onChange, actionId }: PickerProps) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [choices, setChoices] = useState<Choice[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void Promise.resolve(load(query))
        .then((next) => live && setChoices(next))
        .catch(() => live && setChoices([]));
    }, 180);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // `load` is rebuilt each render; the query and open state are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);

  const toggle = (choice: Choice): void => {
    if (!multiple) {
      onChange([choice]);
      setOpen(false);
      return;
    }
    const has = selected.some((entry) => entry.value === choice.value);
    onChange(has ? selected.filter((entry) => entry.value !== choice.value) : [...selected, choice]);
  };

  return (
    <>
      <button ref={anchor} type="button" className="block-picker" data-action-id={actionId} onClick={() => setOpen(true)}>
        <span className="block-picker-value">
          {selected.length === 0 ? <span className="muted">{placeholder}</span> : null}
          {multiple
            ? selected.map((entry) => (
                <span key={entry.value} className="block-chip">
                  {entry.label}
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={S.remove}
                    onClick={(event) => {
                      event.stopPropagation();
                      onChange(selected.filter((item) => item.value !== entry.value));
                    }}
                  >
                    <X size={12} />
                  </span>
                </span>
              ))
            : selected[0]?.label}
        </span>
        <ChevronDown size={15} />
      </button>
      {open ? (
        <Popover anchor={anchor.current} onClose={() => setOpen(false)} className="block-picker-pop">
          <input className="block-picker-search" autoFocus value={query} placeholder={S.platform.search} onChange={(event) => setQuery(event.target.value)} />
          <div className="block-picker-list" role="listbox">
            {choices === null ? <div className="muted block-picker-empty">{S.loading}</div> : null}
            {choices?.length === 0 ? <div className="muted block-picker-empty">{S.platform.noMatches}</div> : null}
            {choices?.map((choice) => {
              const on = selected.some((entry) => entry.value === choice.value);
              return (
                <button key={choice.value} type="button" role="option" aria-selected={on} className={`block-picker-item ${on ? 'is-on' : ''}`} onClick={() => toggle(choice)}>
                  <span>{choice.label}</span>
                  {on ? <Check size={14} /> : null}
                </button>
              );
            })}
          </div>
        </Popover>
      ) : null}
    </>
  );
}

function matches(label: string, query: string): boolean {
  return !query || label.toLowerCase().includes(query.trim().toLowerCase());
}

function SelectElement(props: ElementProps) {
  const { element } = props;
  const { send, record, surface, type, actionId, stored } = useElement(props);
  const users = useStore((state) => state.users);
  const channels = useStore((state) => state.channels);
  const others = useStore((state) => state.others);
  const multiple = type.startsWith('multi_');
  const kind = type.replace(/^multi_/, '').replace(/_select$/, '');

  const userChoice = (id: string): Choice => {
    const user = users[id];
    return { value: id, label: user ? user.profile.display_name || user.real_name || user.name : id };
  };
  const convChoice = (id: string): Choice => {
    const conv = channels[id] ?? others[id];
    return { value: id, label: conv ? `${conv.is_channel ? '#' : ''}${conversationName(get(), conv)}` : id };
  };
  const optionChoice = (option: OptionObject): Choice => ({ value: String(option.value), label: textOf(option.text), option });

  const initial = useMemo((): Choice[] => {
    const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : typeof value === 'string' && value ? [value] : []);
    const from = (key: string): unknown => (stored ? (stored[`selected_${key}s`] ?? stored[`selected_${key}`]) : (element[`initial_${key}s`] ?? element[`initial_${key}`]));
    if (kind === 'users') return list(from('user')).map(userChoice);
    if (kind === 'conversations') return list(from('conversation')).map(convChoice);
    if (kind === 'channels') return list(from('channel')).map(convChoice);
    const start = from('option');
    const options: OptionObject[] = Array.isArray(start) ? start : start ? [start as OptionObject] : [];
    return options.map(optionChoice);
    // Read once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [selected, setSelected] = useState<Choice[]>(initial);

  const fields = (next: Choice[]): Record<string, unknown> => {
    const ids = next.map((entry) => entry.value);
    if (kind === 'users') return multiple ? { selected_users: ids } : { selected_user: ids[0] ?? null };
    if (kind === 'conversations') return multiple ? { selected_conversations: ids } : { selected_conversation: ids[0] ?? null };
    if (kind === 'channels') return multiple ? { selected_channels: ids } : { selected_channel: ids[0] ?? null };
    const options = next.map((entry) => entry.option ?? { text: { type: 'plain_text', text: entry.label }, value: entry.value });
    return multiple ? { selected_options: options } : { selected_option: options[0] ?? null };
  };
  useInitial(record, fields(initial));

  const load = async (query: string): Promise<Choice[]> => {
    if (kind === 'users') {
      return Object.values(users)
        .filter((user) => !user.deleted)
        .map((user) => userChoice(user.id))
        .filter((choice) => matches(choice.label, query))
        .slice(0, 50);
    }
    if (kind === 'conversations' || kind === 'channels') {
      const include: string[] | undefined = element.filter?.include;
      return Object.values({ ...others, ...channels })
        .filter((conv) => {
          if (kind === 'channels') return conv.is_channel && !conv.is_private && !conv.is_archived;
          if (!include) return !conv.is_archived;
          const what = conv.is_im ? 'im' : conv.is_mpim ? 'mpim' : conv.is_private ? 'private' : 'public';
          return include.includes(what);
        })
        .map((conv) => convChoice(conv.id))
        .filter((choice) => matches(choice.label, query))
        .slice(0, 50);
    }
    if (kind === 'external') {
      const min = typeof element.min_query_length === 'number' ? element.min_query_length : 3;
      if (!surface || query.trim().length < min) return [];
      const found: Suggestions = await surface.suggest(actionId, props.blockId, query);
      const options = found.options ?? (found.option_groups ?? []).flatMap((group) => group.options ?? []);
      return options.map(optionChoice);
    }
    return optionsOf(element).map(optionChoice).filter((choice) => matches(choice.label, query));
  };

  return (
    <Picker
      placeholder={textOf(element.placeholder) || S.blocks.choose}
      multiple={multiple}
      selected={selected}
      actionId={actionId}
      load={load}
      onChange={(next) => {
        const previous = selected;
        setSelected(next);
        void send(fields(next)).then((ok) => {
          if (!ok) setSelected(previous);
        });
      }}
    />
  );
}

/** Any interactive element other than images; null for what this client does not draw. */
export function InteractiveElement(props: ElementProps): ReactNode {
  switch (props.element?.type) {
    case 'button':
      return <ActionButton {...props} />;
    case 'static_select':
      return <StaticSelect {...props} />;
    case 'overflow':
      return <Overflow {...props} />;
    case 'plain_text_input':
    case 'number_input':
    case 'email_text_input':
    case 'url_text_input':
      return <TextInput {...props} />;
    case 'datepicker':
    case 'timepicker':
    case 'datetimepicker':
      return <DateLike {...props} />;
    case 'checkboxes':
      return <Checkboxes {...props} />;
    case 'radio_buttons':
      return <RadioButtons {...props} />;
    case 'multi_static_select':
    case 'users_select':
    case 'multi_users_select':
    case 'conversations_select':
    case 'multi_conversations_select':
    case 'channels_select':
    case 'multi_channels_select':
    case 'external_select':
    case 'multi_external_select':
      return <SelectElement {...props} />;
    default:
      return null;
  }
}

/** An `input` block: a label, one element, a hint, and the app's error message for it. */
export function InputBlock({ block, blockId }: { block: Any; blockId: string }) {
  const surface = useSurface();
  const error = surface?.errors[blockId];
  const element = <InteractiveElement element={block.element} blockId={blockId} block={block} />;
  return (
    <div className={`block-input-block ${error ? 'has-error' : ''}`} data-block-id={blockId}>
      <label className="block-input-label">
        <PlainText text={textOf(block.label)} />
        {block.optional ? <span className="muted"> ({S.optional})</span> : null}
      </label>
      {element}
      {block.hint ? <div className="field-hint">{textOf(block.hint)}</div> : null}
      {error ? (
        <div className="field-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
