import type { Conversation, User } from '@app/shared';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { displayName } from '../../lib/store';
import {
  blankStep,
  fieldKey,
  freshId,
  PERSON_TRIGGERS,
  stepOutputs,
  type Destination,
  type FieldType,
  type FormField,
  type Step,
  type StepType,
  type StepTypes,
  type Trigger,
  type Variable,
} from '../../lib/workflows';
import { S } from '../../strings';
import { Button, Field, IconButton, MenuItem, Popover } from '../ui';

/** What every editor in the builder needs to know about the workflow around it. */
export interface BuilderContext {
  trigger: Trigger;
  /** The whole workflow, for fresh step ids. */
  root: Step[];
  types: StepTypes | null;
  channels: Conversation[];
  people: User[];
}

type Patch<T> = (next: T) => void;

// ── Pickers ─────────────────────────────────────────────────────────────────

export function ChannelSelect({ value, onChange, channels, label, publicOnly = false }: { value: string; onChange: Patch<string>; channels: Conversation[]; label: string; publicOnly?: boolean }) {
  return (
    <Field label={label}>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{S.wf.pickChannel}</option>
        {channels
          .filter((conv) => !publicOnly || !conv.is_private)
          .map((conv) => (
            <option key={conv.id} value={conv.id}>
              {conv.is_private ? '🔒 ' : '#'}
              {conv.name}
            </option>
          ))}
      </select>
    </Field>
  );
}

/** A person: one of the variables holding a person, or someone by name. */
function PersonSelect({ value, onChange, vars, people }: { value: string; onChange: Patch<string>; vars: Variable[]; people: User[] }) {
  const personVars = vars.filter((variable) => variable.kind === 'user');
  return (
    <Field label={S.wf.person}>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{S.wf.pickPerson}</option>
        {personVars.length ? (
          <optgroup label={S.wf.insertVariable}>
            {personVars.map((variable) => (
              <option key={variable.name} value={variable.name}>
                {variable.label}
              </option>
            ))}
          </optgroup>
        ) : null}
        <optgroup label={S.wf.person}>
          {people.map((user) => (
            <option key={user.id} value={user.id}>
              {displayName(user)}
            </option>
          ))}
        </optgroup>
      </select>
    </Field>
  );
}

/** A text box with a menu that inserts `{{variable}}` where the cursor is. */
function TemplateInput({ label, value, onChange, vars, multiline = false, placeholder }: { label: string; value: string; onChange: Patch<string>; vars: Variable[]; multiline?: boolean; placeholder?: string }) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const insert = (name: string): void => {
    const token = `{{${name}}}`;
    const element = ref.current;
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <div className="wf-template">
      <Field label={label}>
        {multiline ? (
          <textarea ref={ref} rows={3} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
        ) : (
          <input ref={ref} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
        )}
      </Field>
      {vars.length ? (
        <select
          className="wf-insert"
          aria-label={`${S.wf.insertVariable}: ${label}`}
          value=""
          onChange={(event) => {
            if (event.target.value) insert(event.target.value);
          }}
        >
          <option value="">{`{ } ${S.wf.insertVariable}`}</option>
          {vars.map((variable) => (
            <option key={variable.name} value={variable.name}>
              {variable.label}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

/** Key → template pairs: a webhook's JSON body, a list item's fields. */
function KeyValues({ label, value, onChange, vars }: { label: string; value: Record<string, string>; onChange: Patch<Record<string, string>>; vars: Variable[] }) {
  const entries = Object.entries(value);
  const [key, setKey] = useState('');
  return (
    <div className="wf-keyvalues">
      <span className="field-label">{label}</span>
      {entries.map(([name, template]) => (
        <div key={name} className="wf-keyvalue">
          <code>{name}</code>
          <TemplateInput label={name} value={template} vars={vars} onChange={(next) => onChange({ ...value, [name]: next })} />
          <IconButton
            label={S.remove}
            onClick={() => {
              const next = { ...value };
              delete next[name];
              onChange(next);
            }}
          >
            <Trash2 size={15} />
          </IconButton>
        </div>
      ))}
      <div className="wf-inline">
        <input aria-label={S.wf.bodyKey} placeholder={S.wf.bodyKey} value={key} onChange={(event) => setKey(event.target.value.replace(/[^A-Za-z0-9_]/g, ''))} />
        <Button
          size="sm"
          disabled={!key || key in value}
          onClick={() => {
            onChange({ ...value, [key]: '' });
            setKey('');
          }}
        >
          {S.wf.addKey}
        </Button>
      </div>
    </div>
  );
}

// ── One step ────────────────────────────────────────────────────────────────

function MessageEditor({ step, onChange, vars, ctx }: { step: Extract<Step, { type: 'message' }>; onChange: Patch<Step>; vars: Variable[]; ctx: BuilderContext }) {
  const destination = step.destination;
  const allowed: Destination['to'][] = ['channel', 'user'];
  if (PERSON_TRIGGERS.includes(ctx.trigger.type)) allowed.splice(1, 0, 'trigger_channel');
  if (ctx.trigger.type === 'reaction') allowed.splice(2, 0, 'thread');
  const setTo = (to: Destination['to']): void => {
    const next: Destination = to === 'channel' ? { to, channel: '' } : to === 'user' ? { to, user: 'trigger.user' } : { to };
    onChange({ ...step, destination: next });
  };
  return (
    <>
      <Field label={S.wf.sendTo}>
        <select value={destination.to} onChange={(event) => setTo(event.target.value as Destination['to'])}>
          {[...new Set([...allowed, destination.to])].map((to) => (
            <option key={to} value={to}>
              {S.wf.destinations[to]}
            </option>
          ))}
        </select>
      </Field>
      {destination.to === 'channel' ? (
        <ChannelSelect label={S.wf.channel} value={destination.channel} channels={ctx.channels} onChange={(channel) => onChange({ ...step, destination: { to: 'channel', channel } })} />
      ) : null}
      {destination.to === 'user' ? (
        <PersonSelect value={destination.user} vars={vars} people={ctx.people} onChange={(user) => onChange({ ...step, destination: { to: 'user', user } })} />
      ) : null}
      <TemplateInput label={S.wf.message} multiline value={step.text} vars={vars} onChange={(text) => onChange({ ...step, text })} />
    </>
  );
}

function FormEditor({ step, onChange, ctx }: { step: Extract<Step, { type: 'form' }>; onChange: Patch<Step>; ctx: BuilderContext }) {
  const setField = (index: number, next: FormField): void => onChange({ ...step, fields: step.fields.map((field, at) => (at === index ? next : field)) });
  const types: FieldType[] = ['text', 'long_text', 'select', 'user', 'channel', 'number', 'date'];
  return (
    <>
      <div className="wf-row">
        <Field label={S.wf.formTitle}>
          <input value={step.title} maxLength={24} onChange={(event) => onChange({ ...step, title: event.target.value })} />
        </Field>
        <Field label={S.wf.submitLabel}>
          <input value={step.submit} maxLength={24} onChange={(event) => onChange({ ...step, submit: event.target.value })} />
        </Field>
      </div>
      <span className="field-label">{S.wf.fields}</span>
      <ol className="wf-fields">
        {step.fields.map((field, index) => (
          <li key={field.key}>
            <div className="wf-row">
              <Field label={S.wf.fieldLabel}>
                <input value={field.label} maxLength={80} onChange={(event) => setField(index, { ...field, label: event.target.value })} />
              </Field>
              <Field label={S.wf.fieldType}>
                <select
                  value={field.type}
                  onChange={(event) => {
                    const type = event.target.value as FieldType;
                    setField(index, type === 'select' ? { ...field, type, options: field.options ?? [] } : { key: field.key, label: field.label, type, required: field.required });
                  }}
                >
                  {types.map((type) => (
                    <option key={type} value={type}>
                      {S.wf.fieldTypes[type]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {field.type === 'select' ? (
              <Field label={S.wf.fieldOptions}>
                <input
                  defaultValue={(field.options ?? []).join(', ')}
                  onBlur={(event) =>
                    setField(index, {
                      ...field,
                      options: event.target.value
                        .split(',')
                        .map((option) => option.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </Field>
            ) : null}
            <div className="wf-field-foot">
              <label className="check-row">
                <input type="checkbox" checked={field.required} onChange={(event) => setField(index, { ...field, required: event.target.checked })} />
                <span>{S.wf.fieldRequired}</span>
              </label>
              {step.fields.length > 1 ? (
                <IconButton label={S.remove} onClick={() => onChange({ ...step, fields: step.fields.filter((_, at) => at !== index) })}>
                  <Trash2 size={15} />
                </IconButton>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <Button
        size="sm"
        disabled={step.fields.length >= 15}
        onClick={() => {
          const label = `${S.wf.fieldLabel} ${step.fields.length + 1}`;
          onChange({ ...step, fields: [...step.fields, { key: fieldKey(label, step.fields.map((field) => field.key)), label, type: 'text', required: false }] });
        }}
      >
        <Plus size={14} /> {S.wf.addField}
      </Button>
      <Field label={S.wf.postAnswers}>
        <select value={step.post_to ?? ''} onChange={(event) => onChange({ ...step, post_to: event.target.value || null })}>
          <option value="">{S.wf.postNowhere}</option>
          {PERSON_TRIGGERS.includes(ctx.trigger.type) ? <option value="trigger_channel">{S.wf.destinations.trigger_channel}</option> : null}
          {ctx.channels
            .filter((conv) => conv.is_channel || conv.is_group)
            .map((conv) => (
              <option key={conv.id} value={conv.id}>
                {conv.is_private ? '🔒 ' : '#'}
                {conv.name}
              </option>
            ))}
        </select>
      </Field>
    </>
  );
}

function AppStepEditor({ step, onChange, vars, ctx }: { step: Extract<Step, { type: 'app' }>; onChange: Patch<Step>; vars: Variable[]; ctx: BuilderContext }) {
  const apps = ctx.types?.apps ?? [];
  const fn = apps.find((app) => app.app_id === step.app_id)?.functions.find((entry) => entry.callback_id === step.callback_id);
  if (apps.length === 0) return <p className="muted">{S.wf.noAppSteps}</p>;
  return (
    <>
      <Field label={S.wf.appStep}>
        <select
          value={step.app_id ? `${step.app_id}|${step.callback_id}` : ''}
          onChange={(event) => {
            const [appId = '', callbackId = ''] = event.target.value.split('|');
            onChange({ ...step, app_id: appId, callback_id: callbackId, inputs: {} });
          }}
        >
          <option value="">{S.wf.pickAppStep}</option>
          {apps.flatMap((app) =>
            app.functions.map((entry) => (
              <option key={`${app.app_id}|${entry.callback_id}`} value={`${app.app_id}|${entry.callback_id}`}>
                {app.app_name} — {entry.title}
              </option>
            )),
          )}
        </select>
      </Field>
      {fn?.input_parameters.map((parameter) => (
        <TemplateInput
          key={parameter.name}
          label={`${parameter.title || parameter.name}${parameter.required ? '' : ` (${S.optional})`}`}
          value={step.inputs[parameter.name] ?? ''}
          vars={vars}
          onChange={(next) => onChange({ ...step, inputs: { ...step.inputs, [parameter.name]: next } })}
        />
      ))}
    </>
  );
}

function BranchEditor({ step, onChange, vars, ctx, index }: { step: Extract<Step, { type: 'branch' }>; onChange: Patch<Step>; vars: Variable[]; ctx: BuilderContext; index: string }) {
  const unary = step.operator === 'is_empty' || step.operator === 'is_not_empty';
  return (
    <>
      <div className="wf-row">
        <Field label={S.wf.ifVariable}>
          <select value={step.variable} onChange={(event) => onChange({ ...step, variable: event.target.value })}>
            <option value="">{S.wf.insertVariable}</option>
            {vars.map((variable) => (
              <option key={variable.name} value={variable.name}>
                {variable.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={S.wf.condition}>
          <select value={step.operator} onChange={(event) => onChange({ ...step, operator: event.target.value as typeof step.operator })}>
            {(['equals', 'not_equals', 'contains', 'is_empty', 'is_not_empty'] as const).map((operator) => (
              <option key={operator} value={operator}>
                {S.wf.operators[operator]}
              </option>
            ))}
          </select>
        </Field>
        {unary ? null : (
          <Field label={S.wf.value}>
            <input value={step.value} onChange={(event) => onChange({ ...step, value: event.target.value })} />
          </Field>
        )}
      </div>
      <div className="wf-branch">
        <div className="wf-branch-arm">
          <span className="wf-arm-label">{S.wf.thenLabel}</span>
          <StepList steps={step.then} onChange={(then) => onChange({ ...step, then })} before={vars} ctx={ctx} nested prefix={`${index}a`} />
        </div>
        <div className="wf-branch-arm">
          <span className="wf-arm-label">{S.wf.elseLabel}</span>
          <StepList steps={step.else} onChange={(otherwise) => onChange({ ...step, else: otherwise })} before={vars} ctx={ctx} nested prefix={`${index}b`} />
        </div>
      </div>
    </>
  );
}

function StepBody({ step, onChange, vars, ctx, index }: { step: Step; onChange: Patch<Step>; vars: Variable[]; ctx: BuilderContext; index: string }) {
  switch (step.type) {
    case 'message':
      return <MessageEditor step={step} onChange={onChange} vars={vars} ctx={ctx} />;
    case 'form':
      return <FormEditor step={step} onChange={onChange} ctx={ctx} />;
    case 'add_to_channel':
      return (
        <>
          <ChannelSelect label={S.wf.channel} publicOnly value={step.channel} channels={ctx.channels.filter((conv) => conv.is_channel)} onChange={(channel) => onChange({ ...step, channel })} />
          <PersonSelect value={step.user} vars={vars} people={ctx.people} onChange={(user) => onChange({ ...step, user })} />
        </>
      );
    case 'webhook':
      return (
        <>
          <Field label={S.wf.url}>
            <input type="url" value={step.url} onChange={(event) => onChange({ ...step, url: event.target.value })} />
          </Field>
          <KeyValues label={S.wf.body} value={step.body} vars={vars} onChange={(body) => onChange({ ...step, body })} />
        </>
      );
    case 'app':
      return <AppStepEditor step={step} onChange={onChange} vars={vars} ctx={ctx} />;
    case 'list_item':
      return (
        <>
          <Field label={S.wf.list}>
            <input value={step.list_id} onChange={(event) => onChange({ ...step, list_id: event.target.value.trim() })} />
          </Field>
          <KeyValues label={S.wf.listFields} value={step.fields} vars={vars} onChange={(fields) => onChange({ ...step, fields })} />
        </>
      );
    case 'branch':
      return <BranchEditor step={step} onChange={onChange} vars={vars} ctx={ctx} index={index} />;
  }
}

// ── A list of steps ─────────────────────────────────────────────────────────

function AddStep({ onAdd, nested, ctx }: { onAdd: (type: StepType) => void; nested: boolean; ctx: BuilderContext }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const types: StepType[] = ['message', 'form', 'add_to_channel', 'webhook'];
  if (ctx.types?.lists_available) types.push('list_item');
  if ((ctx.types?.apps.length ?? 0) > 0) types.push('app');
  if (!nested) types.push('branch');
  return (
    <>
      <button ref={anchor} type="button" className="btn btn-default btn-sm wf-add" aria-haspopup="menu" onClick={() => setOpen(true)}>
        <Plus size={14} />
        <span className="btn-label">{S.wf.addStep}</span>
      </button>
      {open ? (
        <Popover anchor={anchor.current} onClose={() => setOpen(false)} className="menu">
          {types.map((type) => (
            <MenuItem
              key={type}
              label={S.wf.stepTypes[type]}
              onSelect={() => {
                setOpen(false);
                onAdd(type);
              }}
            />
          ))}
        </Popover>
      ) : null}
    </>
  );
}

export function StepList({ steps, onChange, before, ctx, nested = false, prefix = '' }: { steps: Step[]; onChange: Patch<Step[]>; before: Variable[]; ctx: BuilderContext; nested?: boolean; prefix?: string }) {
  const labels = S.wf.variables;
  let vars = before;
  const items = steps.map((step, at) => {
    const index = `${prefix}${at + 1}`;
    const available = vars;
    vars = [...vars, ...stepOutputs(step, index, ctx.types, labels)];
    if (step.type === 'branch') {
      for (const inner of [...step.then, ...step.else]) vars = [...vars, ...stepOutputs(inner, `${index}·`, ctx.types, labels)];
    }
    return { step, index, available };
  });
  const move = (from: number, to: number): void => {
    const next = [...steps];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onChange(next);
  };
  return (
    <div className={`wf-steps ${nested ? 'is-nested' : ''}`}>
      {steps.length === 0 && !nested ? <p className="muted">{S.wf.noSteps}</p> : null}
      <ol>
        {items.map(({ step, index, available }, at) => (
          <li key={step.id} className={`wf-step is-${step.type}`} data-step={step.id}>
            <header>
              <span className="wf-step-index">{index}</span>
              <strong>{S.wf.stepTypes[step.type]}</strong>
              <span className="spacer" />
              <IconButton label={S.wf.moveUp} disabled={at === 0} onClick={() => move(at, at - 1)}>
                <ArrowUp size={15} />
              </IconButton>
              <IconButton label={S.wf.moveDown} disabled={at === steps.length - 1} onClick={() => move(at, at + 1)}>
                <ArrowDown size={15} />
              </IconButton>
              <IconButton label={S.wf.removeStep} onClick={() => onChange(steps.filter((_, i) => i !== at))}>
                <Trash2 size={15} />
              </IconButton>
            </header>
            <div className="wf-step-body">
              <StepBody step={step} vars={available} ctx={ctx} index={index} onChange={(next) => onChange(steps.map((item, i) => (i === at ? next : item)))} />
            </div>
          </li>
        ))}
      </ol>
      <AddStep
        nested={nested}
        ctx={ctx}
        onAdd={(type) => {
          const id = freshId(ctx.root, type === 'add_to_channel' ? 'add' : type === 'list_item' ? 'item' : type);
          onChange([...steps, blankStep(type, id, { trigger: ctx.trigger, channel: ctx.channels.find((conv) => conv.is_channel && !conv.is_private)?.id })]);
        }}
      />
    </div>
  );
}
