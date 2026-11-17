import { Archive, Columns3, Download, Kanban, MessageSquare, MoreHorizontal, Plus, Star, Table2, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { attempt, errorText } from '../../lib/actions';
import { call, type Json } from '../../lib/api';
import { useDocs } from '../../lib/docs';
import { displayName, get, useStore } from '../../lib/store';
import { relative } from '../../lib/time';
import { S } from '../../strings';
import { T } from './text';
import { confirmDialog } from '../dialogs/confirm';
import { Avatar, Button, Field, IconButton, MenuDivider, MenuItem, Modal, Popover, Spinner } from '../ui';
import { useTabList } from '../../lib/roving';

/** Lists: a table (sort, filter, group) and a board (drag cards between a select column's options). */

type ColumnType = 'text' | 'number' | 'select' | 'user' | 'date' | 'checkbox' | 'link' | 'rating' | 'email' | 'phone' | 'channel';

interface Choice {
  value: string;
  label: string;
  color: string;
}

interface Column {
  id: string;
  key: string;
  name: string;
  type: ColumnType;
  is_primary_column?: boolean;
  options?: { choices?: Choice[]; format?: string; max?: number; notify_users?: boolean };
}

interface Item {
  id: string;
  values: Record<string, unknown>;
  created_by: string;
  date_created: number;
  comment_count: number;
}

interface ListInfo {
  id: string;
  name: string;
  editable: boolean;
  list_metadata: { schema: Column[] };
}

const VALUE_KEY: Record<ColumnType, string> = {
  text: 'rich_text',
  number: 'number',
  select: 'select',
  user: 'user',
  date: 'date',
  checkbox: 'checkbox',
  link: 'link',
  rating: 'rating',
  email: 'email',
  phone: 'phone',
  channel: 'channel',
};

function toItem(raw: Json, schema: Column[]): Item {
  const values: Record<string, unknown> = {};
  for (const field of raw.fields as Json[]) {
    const column = schema.find((entry) => entry.id === field.column_id);
    if (!column) continue;
    values[column.id] = column.type === 'text' ? String(field.text ?? '') : field[VALUE_KEY[column.type]];
  }
  return { id: raw.id, values, created_by: raw.created_by, date_created: raw.date_created, comment_count: raw.comment_count ?? 0 };
}

/** What a cell shows as plain text: for sorting, filtering and read-only cells. */
function textOf(column: Column, value: unknown): string {
  if (value === undefined || value === null) return '';
  const list = Array.isArray(value) ? value : [value];
  switch (column.type) {
    case 'select':
      return list.map((v) => column.options?.choices?.find((choice) => choice.value === v)?.label ?? String(v)).join(', ');
    case 'user':
      return list.map((id) => displayName(get().users[String(id)])).join(', ');
    case 'channel':
      return list.map((id) => `#${get().channels[String(id)]?.name ?? get().others[String(id)]?.name ?? id}`).join(', ');
    case 'link':
      return list.map((link) => (link as { original_url: string }).original_url).join(', ');
    case 'checkbox':
      return value === true ? '✓' : '';
    case 'rating':
      return '★'.repeat(Number(list[0] ?? 0));
    default:
      return list.map(String).join(', ');
  }
}

function compare(column: Column, a: unknown, b: unknown): number {
  const empty = (value: unknown): boolean => value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
  if (empty(a) || empty(b)) return empty(a) === empty(b) ? 0 : empty(a) ? 1 : -1;
  if (column.type === 'number' || column.type === 'rating') return Number((a as number[])[0]) - Number((b as number[])[0]);
  if (column.type === 'select') {
    const order = (value: unknown): number => column.options?.choices?.findIndex((choice) => choice.value === (value as string[])[0]) ?? 0;
    return order(a) - order(b);
  }
  if (column.type === 'checkbox') return (a === true ? 1 : 0) - (b === true ? 1 : 0);
  return textOf(column, a).localeCompare(textOf(column, b));
}

interface Prefs {
  view: 'table' | 'board';
  sort: { column: string; desc: boolean } | null;
  group: string | null;
  board: string | null;
}

function loadPrefs(id: string): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(`list-view:${id}`) ?? 'null') as Prefs | null;
    if (saved) return saved;
  } catch {
    // Storage can be unavailable; defaults are fine.
  }
  return { view: 'table', sort: null, group: null, board: null };
}

function savePrefs(id: string, prefs: Prefs): void {
  try {
    localStorage.setItem(`list-view:${id}`, JSON.stringify(prefs));
  } catch {
    // Not remembered, which is fine.
  }
}

// ── Cells ───────────────────────────────────────────────────────────────────

function PeoplePicker({ value, onChange, anchor, onClose }: { value: string[]; onChange: (ids: string[]) => void; anchor: HTMLElement | null; onClose: () => void }) {
  const users = useStore((state) => state.users);
  const [query, setQuery] = useState('');
  const matches = Object.values(users)
    .filter((user) => !user.deleted && !user.is_bot && `${user.name} ${user.real_name} ${user.profile.display_name}`.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 12);
  return (
    <Popover anchor={anchor} onClose={onClose} className="menu people-picker" role="dialog" label={T.searchPeople}>
      <input className="input" autoFocus placeholder={T.searchPeople} value={query} onChange={(event) => setQuery(event.target.value)} aria-label={T.searchPeople} />
      <div role="listbox" aria-multiselectable="true" aria-label={T.searchPeople}>
        {matches.map((user) => {
          const on = value.includes(user.id);
          return (
            <button key={user.id} type="button" role="option" aria-selected={on} className={`menu-item ${on ? 'is-checked' : ''}`} onClick={() => onChange(on ? value.filter((id) => id !== user.id) : [...value, user.id])}>
              <Avatar user={user} size={20} />
              <span className="menu-label">{displayName(user)}</span>
              {on ? <span className="menu-hint">✓</span> : null}
            </button>
          );
        })}
      </div>
    </Popover>
  );
}

function ChoicesPicker({ column, value, onChange, anchor, onClose }: { column: Column; value: string[]; onChange: (values: string[]) => void; anchor: HTMLElement | null; onClose: () => void }) {
  const multi = column.options?.format === 'multi_select';
  return (
    <Popover anchor={anchor} onClose={onClose} className="menu">
      {(column.options?.choices ?? []).map((choice) => {
        const on = value.includes(choice.value);
        return (
          <button
            key={choice.value}
            type="button"
            role={multi ? 'menuitemcheckbox' : 'menuitemradio'}
            aria-checked={on}
            className="menu-item"
            onClick={() => {
              if (multi) onChange(on ? value.filter((v) => v !== choice.value) : [...value, choice.value]);
              else {
                onChange(on ? [] : [choice.value]);
                onClose();
              }
            }}
          >
            <span className={`opt is-${choice.color}`}>{choice.label}</span>
            {on ? <span className="menu-hint">✓</span> : null}
          </button>
        );
      })}
    </Popover>
  );
}

function Chips({ column, value }: { column: Column; value: unknown }) {
  const list = (value as string[] | undefined) ?? [];
  return (
    <>
      {list.map((v) => {
        const choice = column.options?.choices?.find((entry) => entry.value === v);
        return (
          <span key={v} className={`opt is-${choice?.color ?? 'gray'}`}>
            {choice?.label ?? v}
          </span>
        );
      })}
    </>
  );
}

function Cell({ column, value, editable, onChange }: { column: Column; value: unknown; editable: boolean; onChange: (value: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const users = useStore((state) => state.users);
  const channels = useStore((state) => state.channels);
  const first = Array.isArray(value) ? value[0] : value;

  if (!editable) {
    if (column.type === 'select') return <Chips column={column} value={value} />;
    if (column.type === 'user')
      return (
        <span className="cell-people">
          {((value as string[] | undefined) ?? []).map((id) => (
            <span key={id} className="cell-person">
              <Avatar user={users[id]} size={18} /> {displayName(users[id])}
            </span>
          ))}
        </span>
      );
    if (column.type === 'link' && first)
      return (
        <a href={(first as { original_url: string }).original_url} target="_blank" rel="noopener noreferrer">
          {(first as { original_url: string }).original_url}
        </a>
      );
    return <span className="cell-text">{textOf(column, value)}</span>;
  }

  const commitText = (raw: string, previous: string): void => {
    if (raw === previous) return;
    if (column.type === 'number') onChange(raw === '' ? [] : [Number(raw)]);
    else if (column.type === 'link') onChange(raw.trim() ? [{ original_url: raw.trim() }] : []);
    else if (column.type === 'email' || column.type === 'phone') onChange(raw.trim() ? [raw.trim()] : []);
    else onChange(raw);
  };

  switch (column.type) {
    case 'text':
    case 'number':
    case 'link':
    case 'email':
    case 'phone': {
      const current = column.type === 'link' ? ((first as { original_url?: string } | undefined)?.original_url ?? '') : column.type === 'text' ? String(value ?? '') : String(first ?? '');
      return (
        <input
          key={current}
          className="cell-input"
          type={column.type === 'number' ? 'number' : column.type === 'link' ? 'url' : column.type === 'email' ? 'email' : 'text'}
          defaultValue={current}
          aria-label={column.name}
          onBlur={(event) => commitText(event.target.value, current)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
            if (event.key === 'Escape') {
              (event.target as HTMLInputElement).value = current;
              (event.target as HTMLInputElement).blur();
            }
          }}
        />
      );
    }
    case 'date':
      return <input className="cell-input" type="date" value={String(first ?? '')} aria-label={column.name} onChange={(event) => onChange(event.target.value ? [event.target.value] : [])} />;
    case 'checkbox':
      return <input type="checkbox" checked={value === true} aria-label={column.name} onChange={(event) => onChange(event.target.checked)} />;
    case 'rating': {
      const max = column.options?.max ?? 5;
      const stars = Number(first ?? 0);
      return (
        <span className="cell-rating" role="radiogroup" aria-label={column.name}>
          {Array.from({ length: max }, (_, index) => (
            <button key={index} type="button" role="radio" aria-checked={stars === index + 1} aria-label={`${index + 1}`} className={index < stars ? 'is-on' : ''} onClick={() => onChange(stars === index + 1 ? [] : [index + 1])}>
              <Star size={14} fill={index < stars ? 'currentColor' : 'none'} />
            </button>
          ))}
        </span>
      );
    }
    case 'channel':
      return (
        <select className="cell-input" value={String(first ?? '')} aria-label={column.name} onChange={(event) => onChange(event.target.value ? [event.target.value] : [])}>
          <option value="">—</option>
          {Object.values(channels)
            .filter((conv) => conv.is_channel)
            .map((conv) => (
              <option key={conv.id} value={conv.id}>
                #{conv.name}
              </option>
            ))}
        </select>
      );
    case 'select':
    case 'user':
      return (
        <>
          {/* Named by what it shows; an empty cell by its column. */}
          <button ref={ref} type="button" className="cell-button" aria-label={((value as string[] | undefined) ?? []).length === 0 ? column.name : undefined} onClick={() => setOpen(true)}>
            {column.type === 'select' ? (
              <Chips column={column} value={value} />
            ) : (
              <span className="cell-people">
                {((value as string[] | undefined) ?? []).map((id) => (
                  <span key={id} className="cell-person">
                    <Avatar user={users[id]} size={18} /> {displayName(users[id])}
                  </span>
                ))}
              </span>
            )}
            {!(value as unknown[] | undefined)?.length ? <span className="cell-empty">—</span> : null}
          </button>
          {open && column.type === 'select' ? <ChoicesPicker column={column} value={(value as string[] | undefined) ?? []} onChange={onChange} anchor={ref.current} onClose={() => setOpen(false)} /> : null}
          {open && column.type === 'user' ? <PeoplePicker value={(value as string[] | undefined) ?? []} onChange={onChange} anchor={ref.current} onClose={() => setOpen(false)} /> : null}
        </>
      );
  }
}

// ── Column settings ─────────────────────────────────────────────────────────

const TYPES: ColumnType[] = ['text', 'number', 'select', 'user', 'date', 'checkbox', 'link', 'rating', 'email', 'phone', 'channel'];

function ColumnDialog({ column, onSave, onClose }: { column?: Column; onSave: (column: Partial<Column>) => Promise<unknown>; onClose: () => void }) {
  const [name, setName] = useState(column?.name ?? '');
  const [type, setType] = useState<ColumnType>(column?.type ?? 'text');
  const [choices, setChoices] = useState((column?.options?.choices ?? []).map((choice) => choice.label).join('\n'));
  const [multi, setMulti] = useState(column?.options?.format === 'multi_select');
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    if (!name.trim()) return;
    setBusy(true);
    const previous = column?.options?.choices ?? [];
    const options =
      type === 'select'
        ? {
            format: multi ? 'multi_select' : 'single_select',
            choices: choices
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
              .map((label) => previous.find((choice) => choice.label === label) ?? { label }),
          }
        : type === 'rating'
          ? { max: 5 }
          : {};
    const ok = await attempt(() => onSave({ ...(column ? { id: column.id, key: column.key } : {}), name: name.trim(), type, options: options as Column['options'] }));
    setBusy(false);
    if (ok !== undefined) onClose();
  };
  return (
    <Modal
      title={column ? T.rename : T.addColumn}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{S.cancel}</Button>
          <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={() => void save()}>
            {S.done}
          </Button>
        </>
      }
    >
      <Field label={T.columnName}>
        <input className="input" autoFocus value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label={T.columnType}>
        <select className="input" value={type} disabled={Boolean(column)} onChange={(event) => setType(event.target.value as ColumnType)}>
          {TYPES.map((entry) => (
            <option key={entry} value={entry}>
              {T.types[entry]}
            </option>
          ))}
        </select>
      </Field>
      {type === 'select' ? (
        <>
          <Field label={T.choices}>
            <textarea className="input" rows={5} value={choices} onChange={(event) => setChoices(event.target.value)} />
          </Field>
          <label className="toggle-label">
            <input type="checkbox" checked={multi} onChange={(event) => setMulti(event.target.checked)} /> {T.multiple}
          </label>
        </>
      ) : null}
    </Modal>
  );
}

// ── Item panel ──────────────────────────────────────────────────────────────

interface ItemComment {
  id: string;
  user: string;
  text: string;
  created: number;
}

function ItemPanel({ listId, item, schema, editable, onChange, onClose }: { listId: string; item: Item; schema: Column[]; editable: boolean; onChange: (column: Column, value: unknown) => void; onClose: () => void }) {
  const users = useStore((state) => state.users);
  const version = useDocs((state) => state.version[listId] ?? 0);
  const [comments, setComments] = useState<ItemComment[] | null>(null);
  const [text, setText] = useState('');
  useEffect(() => {
    let live = true;
    call('client.lists.comments.list', { list_id: listId, item_id: item.id })
      .then((result) => live && setComments(result.comments as ItemComment[]))
      .catch(() => live && setComments([]));
    return () => {
      live = false;
    };
  }, [listId, item.id, version]);
  const primary = schema.find((column) => column.is_primary_column);
  const send = async (): Promise<void> => {
    if (!text.trim()) return;
    const ok = await attempt(() => call('client.lists.comments.add', { list_id: listId, item_id: item.id, text: text.trim() }));
    if (ok !== undefined) setText('');
  };
  return (
    <aside className="canvas-side list-item-panel" aria-label={T.openItem}>
      <header className="canvas-side-head">
        <h2>{primary ? textOf(primary, item.values[primary.id]) || T.newItem : T.newItem}</h2>
        <IconButton label={T.close} onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      <div className="canvas-side-scroll">
        <dl className="item-fields">
          {schema.map((column) => (
            <div key={column.id} className="item-field">
              <dt>{column.name}</dt>
              <dd>
                <Cell column={column} value={item.values[column.id]} editable={editable} onChange={(value) => onChange(column, value)} />
              </dd>
            </div>
          ))}
        </dl>
        <h3 className="item-comments-title">{T.itemComments}</h3>
        {comments === null ? <Spinner /> : comments.length === 0 ? <p className="view-empty">{T.noItemComments}</p> : null}
        {comments?.map((comment) => (
          <div key={comment.id} className="comment" data-item-comment={comment.id}>
            <Avatar user={users[comment.user]} size={24} />
            <div className="comment-body">
              <div className="comment-meta">
                <strong>{displayName(users[comment.user])}</strong>
                <time>{relative(String(comment.created))}</time>
              </div>
              <p>{comment.text}</p>
            </div>
          </div>
        ))}
        <form
          className="comment-box"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea rows={2} value={text} placeholder={T.commentPlaceholder} aria-label={T.commentPlaceholder} onChange={(event) => setText(event.target.value)} />
          <Button type="submit" size="sm" variant="primary" disabled={!text.trim()}>
            {T.reply}
          </Button>
        </form>
      </div>
    </aside>
  );
}

// ── Board ───────────────────────────────────────────────────────────────────

/** Drag with pointer events (mouse, pen and touch alike); drop on another column to change the card's value. */
function useCardDrag(onDrop: (itemId: string, lane: string) => void) {
  const drag = useRef<{ id: string; startX: number; startY: number; element: HTMLElement; active: boolean } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const laneAt = (x: number, y: number): string | null => {
    const element = document.elementFromPoint(x, y)?.closest('[data-lane]') as HTMLElement | null;
    return element?.dataset.lane ?? null;
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>, id: string): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, input, select, a')) return;
    drag.current = { id, startX: event.clientX, startY: event.clientY, element: event.currentTarget, active: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const state = drag.current;
    if (!state) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (!state.active && Math.hypot(dx, dy) < 6) return;
    state.active = true;
    state.element.classList.add('is-dragging');
    state.element.style.transform = `translate(${dx}px, ${dy}px)`;
    state.element.style.pointerEvents = 'none';
    setOver(laneAt(event.clientX, event.clientY));
    state.element.style.pointerEvents = '';
  };
  const finish = (event: ReactPointerEvent<HTMLElement>, cancel: boolean): boolean => {
    const state = drag.current;
    drag.current = null;
    setOver(null);
    if (!state) return false;
    state.element.classList.remove('is-dragging');
    state.element.style.transform = '';
    if (!state.active) return false;
    state.element.style.visibility = 'hidden';
    const lane = laneAt(event.clientX, event.clientY);
    state.element.style.visibility = '';
    if (!cancel && lane !== null) onDrop(state.id, lane);
    return true;
  };
  return { over, onPointerDown, onPointerMove, finish };
}

function Board({ items, schema, laneColumn, editable, onMove, onOpen }: { items: Item[]; schema: Column[]; laneColumn: Column; editable: boolean; onMove: (item: Item, lane: string) => void; onOpen: (item: Item) => void }) {
  const primary = schema.find((column) => column.is_primary_column);
  const shown = schema.filter((column) => column !== primary && column !== laneColumn && ['user', 'date', 'select'].includes(column.type)).slice(0, 3);
  // Items with no value come first: that is where new items land.
  const lanes = [{ id: '', label: T.noValue, color: 'gray' }, ...(laneColumn.options?.choices ?? []).map((choice) => ({ id: choice.value, label: choice.label, color: choice.color }))];
  const { over, onPointerDown, onPointerMove, finish } = useCardDrag((itemId, lane) => {
    const item = items.find((entry) => entry.id === itemId);
    if (item) onMove(item, lane);
  });
  return (
    <div className="board">
      {lanes.map((lane) => {
        const cards = items.filter((item) => (((item.values[laneColumn.id] as string[] | undefined) ?? [])[0] ?? '') === lane.id);
        return (
          <section key={lane.id || 'none'} className={`board-lane ${over === lane.id ? 'is-over' : ''}`} data-lane={lane.id} aria-label={lane.label}>
            <header className="board-lane-head">
              <span className={`opt is-${lane.color}`}>{lane.label}</span>
              <span className="board-count">{cards.length}</span>
            </header>
            <div className="board-cards">
              {cards.map((item) => (
                <article
                  key={item.id}
                  className="board-card"
                  data-item={item.id}
                  tabIndex={0}
                  onPointerDown={editable ? (event) => onPointerDown(event, item.id) : undefined}
                  onPointerMove={editable ? onPointerMove : undefined}
                  onPointerUp={(event) => {
                    if (!finish(event, false)) onOpen(item);
                  }}
                  onPointerCancel={(event) => finish(event, true)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onOpen(item);
                  }}
                >
                  <strong>{primary ? textOf(primary, item.values[primary.id]) || T.newItem : T.newItem}</strong>
                  {shown.map((column) =>
                    item.values[column.id] !== undefined ? (
                      <span key={column.id} className="board-card-field">
                        {column.type === 'select' ? <Chips column={column} value={item.values[column.id]} /> : textOf(column, item.values[column.id])}
                      </span>
                    ) : null,
                  )}
                  {item.comment_count ? (
                    <span className="board-card-field">
                      <MessageSquare size={12} /> {item.comment_count}
                    </span>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ── The list ────────────────────────────────────────────────────────────────

export default function ListView({ id }: { id: string }) {
  const viewTabs = useTabList();
  const version = useDocs((state) => state.version[id] ?? 0);
  const [list, setList] = useState<ListInfo | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefsState] = useState<Prefs>(() => loadPrefs(id));
  const [filter, setFilter] = useState('');
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [columnDialog, setColumnDialog] = useState<{ column?: Column } | null>(null);
  const [columnMenu, setColumnMenu] = useState<{ column: Column; anchor: HTMLElement } | null>(null);
  const [rowMenu, setRowMenu] = useState<{ item: Item; anchor: HTMLElement } | null>(null);
  const [sortMenu, setSortMenu] = useState<HTMLElement | null>(null);
  const [newText, setNewText] = useState('');
  const request = useRef(0);

  const load = (): void => {
    const current = (request.current += 1);
    call('client.lists.info', { list_id: id })
      .then((result) => {
        if (current !== request.current) return;
        const info = result.list as ListInfo;
        setList(info);
        setItems((result.items as Json[]).map((raw) => toItem(raw, info.list_metadata.schema)));
        setError(null);
      })
      .catch((failure: unknown) => current === request.current && setError(errorText(failure)));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [id, version]);

  const setPrefs = (patch: Partial<Prefs>): void => {
    setPrefsState((current) => {
      const next = { ...current, ...patch };
      savePrefs(id, next);
      return next;
    });
  };

  const schema = list?.list_metadata.schema ?? [];
  const editable = Boolean(list?.editable);
  const primary = schema.find((column) => column.is_primary_column) ?? schema[0];
  const selects = schema.filter((column) => column.type === 'select');
  const laneColumn = schema.find((column) => column.id === prefs.board && column.type === 'select') ?? selects[0];

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    let rows = needle ? items.filter((item) => schema.some((column) => textOf(column, item.values[column.id]).toLowerCase().includes(needle))) : items;
    const sortColumn = prefs.sort ? schema.find((column) => column.id === prefs.sort!.column) : undefined;
    if (sortColumn) {
      rows = [...rows].sort((a, b) => compare(sortColumn, a.values[sortColumn.id], b.values[sortColumn.id]) * (prefs.sort!.desc ? -1 : 1));
    }
    return rows;
  }, [items, filter, prefs.sort, schema]);

  const groups = useMemo(() => {
    const column = schema.find((entry) => entry.id === prefs.group);
    if (!column) return [{ key: '', label: '', rows: shown }];
    const keyOf = (item: Item): string => {
      const value = item.values[column.id];
      if (column.type === 'checkbox') return value === true ? 'true' : '';
      return String(((value as unknown[] | undefined) ?? [])[0] ?? '');
    };
    const keys = column.type === 'select' ? [...(column.options?.choices ?? []).map((choice) => choice.value), ''] : [...new Set(shown.map(keyOf))].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : 0));
    return keys
      .map((key) => ({
        key,
        label: key === '' ? T.noValue : column.type === 'checkbox' ? column.name : textOf(column, [key]),
        rows: shown.filter((item) => keyOf(item) === key),
      }))
      .filter((group) => group.rows.length > 0 || column.type === 'select');
  }, [shown, prefs.group, schema]);

  const update = (item: Item, column: Column, value: unknown): void => {
    setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, values: { ...entry.values, [column.id]: value } } : entry)));
    const cell: Record<string, unknown> = { row_id: item.id, column_id: column.id };
    if (column.type === 'text') cell.text = value;
    else cell[VALUE_KEY[column.type]] = value;
    void attempt(() => call('slackLists.items.update', { list_id: id, cells: [cell] })).then((ok) => {
      if (ok === undefined) load();
    });
  };

  const addItem = async (text: string, laneValue?: string): Promise<void> => {
    const fields: Record<string, unknown>[] = [];
    if (primary && text.trim()) fields.push({ column_id: primary.id, text: text.trim() });
    if (laneColumn && laneValue) fields.push({ column_id: laneColumn.id, select: [laneValue] });
    const result = await attempt(() => call('slackLists.items.create', { list_id: id, initial_fields: fields }));
    if (result) load();
  };

  const saveColumns = async (next: Partial<Column>[]): Promise<void> => {
    await call('client.lists.columns.set', { list_id: id, schema: next });
    load();
  };

  if (error) return <p className="view-empty doc-error">{error}</p>;
  if (!list) {
    return (
      <div className="list-loading">
        <Spinner />
      </div>
    );
  }

  const item = openItem ? items.find((entry) => entry.id === openItem) : undefined;
  const sortColumn = prefs.sort ? schema.find((column) => column.id === prefs.sort!.column) : undefined;
  return (
    <div className={`canvas-layout list-layout ${item ? 'has-side' : ''}`}>
      <div className="canvas-main">
        <div className="list-bar">
          <div ref={viewTabs} className="seg" role="tablist" aria-label={T.table}>
            <button type="button" role="tab" aria-selected={prefs.view === 'table'} className={prefs.view === 'table' ? 'is-on' : ''} onClick={() => setPrefs({ view: 'table' })}>
              <Table2 size={15} /> {T.table}
            </button>
            <button type="button" role="tab" aria-selected={prefs.view === 'board'} className={prefs.view === 'board' ? 'is-on' : ''} disabled={!laneColumn} onClick={() => setPrefs({ view: 'board' })}>
              <Kanban size={15} /> {T.board}
            </button>
          </div>
          <input className="input list-filter" type="search" placeholder={T.filterPlaceholder} aria-label={T.filter} value={filter} onChange={(event) => setFilter(event.target.value)} />
          {prefs.view === 'table' ? (
            <>
              <Button size="sm" variant="ghost" onClick={(event) => setSortMenu(event.currentTarget)}>
                {sortColumn ? `${T.sortBy}: ${sortColumn.name}` : T.sort}
              </Button>
              <label className="list-select">
                <span>{T.groupBy}</span>
                <select value={prefs.group ?? ''} onChange={(event) => setPrefs({ group: event.target.value || null })}>
                  <option value="">{T.groupNone}</option>
                  {schema
                    .filter((column) => ['select', 'user', 'checkbox'].includes(column.type))
                    .map((column) => (
                      <option key={column.id} value={column.id}>
                        {column.name}
                      </option>
                    ))}
                </select>
              </label>
            </>
          ) : selects.length > 1 ? (
            <label className="list-select">
              <span>{T.boardBy}</span>
              <select value={laneColumn?.id ?? ''} onChange={(event) => setPrefs({ board: event.target.value })}>
                {selects.map((column) => (
                  <option key={column.id} value={column.id}>
                    {column.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <span className="composer-spacer" />
          <span className="list-count">{T.items(items.length)}</span>
          <a className="btn btn-ghost btn-sm" href={`/lists-export/${id}.csv`} download>
            <Download size={15} /> <span className="btn-label">{T.exportCsv}</span>
          </a>
          {editable ? (
            <Button size="sm" onClick={() => setColumnDialog({})}>
              <Columns3 size={15} /> {T.addColumn}
            </Button>
          ) : null}
        </div>

        {prefs.view === 'board' && laneColumn ? (
          <Board items={shown} schema={schema} laneColumn={laneColumn} editable={editable} onMove={(entry, lane) => update(entry, laneColumn, lane ? [lane] : [])} onOpen={(entry) => setOpenItem(entry.id)} />
        ) : (
          <div className="list-table-wrap">
            <table className="list-table">
              <thead>
                <tr>
                  {schema.map((column) => (
                    <th key={column.id} scope="col">
                      <button
                        type="button"
                        className="col-head"
                        onClick={(event) => (editable ? setColumnMenu({ column, anchor: event.currentTarget }) : setPrefs({ sort: { column: column.id, desc: prefs.sort?.column === column.id && !prefs.sort.desc } }))}
                      >
                        {column.name}
                        {prefs.sort?.column === column.id ? <span aria-hidden="true">{prefs.sort.desc ? ' ↓' : ' ↑'}</span> : null}
                      </button>
                    </th>
                  ))}
                  <th className="col-actions" aria-hidden="true" />
                </tr>
              </thead>
              {groups.map((group) => (
                <tbody key={group.key || 'all'} data-group={group.key}>
                  {prefs.group ? (
                    <tr className="group-row">
                      <th colSpan={schema.length + 1} scope="rowgroup">
                        {group.label} <span className="board-count">{group.rows.length}</span>
                      </th>
                    </tr>
                  ) : null}
                  {group.rows.map((row) => (
                    <tr key={row.id} data-item={row.id} className={openItem === row.id ? 'is-open' : ''}>
                      {schema.map((column) => (
                        <td key={column.id} data-column={column.key}>
                          <Cell column={column} value={row.values[column.id]} editable={editable} onChange={(value) => update(row, column, value)} />
                        </td>
                      ))}
                      <td className="col-actions">
                        <IconButton label={T.openItem} onClick={() => setOpenItem(row.id)}>
                          {row.comment_count ? (
                            <span className="row-comments">
                              <MessageSquare size={14} /> {row.comment_count}
                            </span>
                          ) : (
                            <MessageSquare size={14} />
                          )}
                        </IconButton>
                        {editable ? (
                          <IconButton label={T.openItem} onClick={(event) => setRowMenu({ item: row, anchor: event.currentTarget })}>
                            <MoreHorizontal size={14} />
                          </IconButton>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
            {items.length === 0 ? <p className="view-empty">{T.noItems}</p> : shown.length === 0 ? <p className="view-empty">{T.noMatch}</p> : null}
          </div>
        )}
        {editable ? (
          <form
            className="list-add"
            onSubmit={(event) => {
              event.preventDefault();
              const text = newText;
              setNewText('');
              void addItem(text);
            }}
          >
            <Plus size={16} />
            <input className="input" placeholder={T.addItem} aria-label={T.addItem} value={newText} onChange={(event) => setNewText(event.target.value)} />
          </form>
        ) : null}
      </div>
      {item ? <ItemPanel listId={id} item={item} schema={schema} editable={editable} onChange={(column, value) => update(item, column, value)} onClose={() => setOpenItem(null)} /> : null}

      {sortMenu ? (
        <Popover anchor={sortMenu} onClose={() => setSortMenu(null)} className="menu">
          <MenuItem label={T.sortNone} onSelect={() => (setPrefs({ sort: null }), setSortMenu(null))} />
          <MenuDivider />
          {schema.map((column) => (
            <MenuItem
              key={column.id}
              label={column.name}
              hint={prefs.sort?.column === column.id ? (prefs.sort.desc ? T.descending : T.ascending) : undefined}
              onSelect={() => {
                setPrefs({ sort: { column: column.id, desc: prefs.sort?.column === column.id && !prefs.sort.desc } });
                setSortMenu(null);
              }}
            />
          ))}
        </Popover>
      ) : null}
      {columnMenu ? (
        <Popover anchor={columnMenu.anchor} onClose={() => setColumnMenu(null)} className="menu">
          <MenuItem
            label={`${T.ascending}`}
            onSelect={() => {
              setPrefs({ sort: { column: columnMenu.column.id, desc: false } });
              setColumnMenu(null);
            }}
          />
          <MenuItem
            label={`${T.descending}`}
            onSelect={() => {
              setPrefs({ sort: { column: columnMenu.column.id, desc: true } });
              setColumnMenu(null);
            }}
          />
          <MenuDivider />
          <MenuItem
            label={T.rename}
            onSelect={() => {
              setColumnDialog({ column: columnMenu.column });
              setColumnMenu(null);
            }}
          />
          {schema.length > 1 ? (
            <MenuItem
              label={T.deleteColumn}
              danger
              onSelect={() => {
                const column = columnMenu.column;
                setColumnMenu(null);
                void confirmDialog(column.name, T.deleteColumn).then((ok) => {
                  if (ok) void attempt(() => saveColumns(schema.filter((entry) => entry.id !== column.id)));
                });
              }}
            />
          ) : null}
        </Popover>
      ) : null}
      {rowMenu ? (
        <Popover anchor={rowMenu.anchor} onClose={() => setRowMenu(null)} className="menu" align="end">
          <MenuItem
            icon={<Archive size={16} />}
            label={T.archive}
            onSelect={() => {
              const target = rowMenu.item;
              setRowMenu(null);
              void attempt(() => call('client.lists.items.archive', { list_id: id, id: target.id })).then(load);
            }}
          />
          <MenuItem
            icon={<Trash2 size={16} />}
            label={T.deleteItem}
            danger
            onSelect={() => {
              const target = rowMenu.item;
              setRowMenu(null);
              void attempt(() => call('slackLists.items.delete', { list_id: id, id: target.id })).then(load);
            }}
          />
        </Popover>
      ) : null}
      {columnDialog ? (
        <ColumnDialog
          column={columnDialog.column}
          onClose={() => setColumnDialog(null)}
          onSave={(column) => saveColumns(columnDialog.column ? schema.map((entry) => (entry.id === column.id ? { ...entry, ...column } : entry)) : [...schema, column])}
        />
      ) : null}
    </div>
  );
}

