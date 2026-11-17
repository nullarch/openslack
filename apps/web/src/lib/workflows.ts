/** Workflow shapes as the server stores them, and what the builder derives from them. */

export type TriggerType = 'shortcut' | 'link' | 'schedule' | 'reaction' | 'member_joined' | 'webhook';

export interface ScheduleSpec {
  frequency: 'once' | 'daily' | 'weekly' | 'monthly';
  time: string;
  tz: string;
  date?: string;
  weekdays?: number[];
  day?: number;
}

export interface Trigger {
  type: TriggerType;
  channel?: string;
  reaction?: string;
  schedule?: ScheduleSpec;
  variables?: string[];
}

export type FieldType = 'text' | 'long_text' | 'select' | 'user' | 'channel' | 'number' | 'date';

export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
}

export type Destination = { to: 'channel'; channel: string } | { to: 'trigger_channel' } | { to: 'thread' } | { to: 'user'; user: string };

export type Operator = 'equals' | 'not_equals' | 'contains' | 'is_empty' | 'is_not_empty';

export type Step =
  | { id: string; type: 'message'; destination: Destination; text: string }
  | { id: string; type: 'form'; title: string; submit: string; fields: FormField[]; post_to?: string | null }
  | { id: string; type: 'add_to_channel'; channel: string; user: string }
  | { id: string; type: 'webhook'; url: string; body: Record<string, string> }
  | { id: string; type: 'app'; app_id: string; callback_id: string; inputs: Record<string, string> }
  | { id: string; type: 'list_item'; list_id: string; fields: Record<string, string> }
  | { id: string; type: 'branch'; variable: string; operator: Operator; value: string; then: Step[]; else: Step[] };

export type StepType = Step['type'];

export interface LogEntry {
  step: string;
  type: string;
  at: number;
  ok: boolean;
  detail?: string;
}

export interface Run {
  id: string;
  runner: string | null;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  error: string | null;
  started: number;
  finished: number | null;
  log: LogEntry[];
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'published' | 'disabled';
  trigger: Trigger;
  created_by: string;
  created_by_name: string;
  created: number;
  updated: number;
  next_run: number | null;
  last_run?: { status: Run['status']; started: number };
  steps?: Step[];
  link_url?: string;
  webhook_url?: string;
  problems?: string[];
}

export interface FunctionParameter {
  name: string;
  title: string;
  type: 'string' | 'user_id' | 'channel_id' | 'number' | 'boolean';
  required: boolean;
}

export interface AppFunction {
  callback_id: string;
  title: string;
  description: string;
  input_parameters: FunctionParameter[];
  output_parameters: FunctionParameter[];
}

export interface StepTypes {
  apps: { app_id: string; app_name: string; functions: AppFunction[] }[];
  lists_available: boolean;
}

export type VariableKind = 'text' | 'user' | 'channel';

export interface Variable {
  name: string;
  label: string;
  kind: VariableKind;
}

/** Triggers with a person behind them, who can be shown a form. */
export const PERSON_TRIGGERS: TriggerType[] = ['shortcut', 'link', 'reaction', 'member_joined'];

export function triggerVariables(trigger: Trigger, labels: Record<string, string>): Variable[] {
  const out: Variable[] = [];
  const add = (name: string, kind: VariableKind): void => {
    out.push({ name: `trigger.${name}`, label: labels[name] ?? name, kind });
  };
  if (PERSON_TRIGGERS.includes(trigger.type)) {
    add('user', 'user');
    add('channel', 'channel');
  }
  if (trigger.type === 'reaction') {
    add('message_text', 'text');
    add('message_author', 'user');
    add('reaction', 'text');
  }
  add('time', 'text');
  if (trigger.type === 'webhook') {
    for (const name of trigger.variables ?? []) out.push({ name: `webhook.${name.toLowerCase()}`, label: `${labels.webhook ?? 'webhook'} › ${name}`, kind: 'text' });
  }
  return out;
}

/** What a step hands to the steps after it. */
export function stepOutputs(step: Step, index: string, types: StepTypes | null, labels: Record<string, string>): Variable[] {
  const prefix = `${index}. `;
  const v = (name: string, label: string, kind: VariableKind = 'text'): Variable => ({ name: `steps.${step.id}.${name}`, label: `${prefix}${label}`, kind });
  switch (step.type) {
    case 'form':
      return [
        ...step.fields.map((field) => v(field.key, field.label || field.key, field.type === 'user' ? 'user' : field.type === 'channel' ? 'channel' : 'text')),
        v('user', labels.submitter ?? 'submitted by', 'user'),
      ];
    case 'message':
      return [v('ts', labels.messageTs ?? 'message time')];
    case 'webhook':
      return [v('status', labels.webhookStatus ?? 'response status')];
    case 'list_item':
      return [v('item_id', labels.itemId ?? 'item')];
    case 'app': {
      const fn = types?.apps.find((app) => app.app_id === step.app_id)?.functions.find((entry) => entry.callback_id === step.callback_id);
      return (fn?.output_parameters ?? []).map((parameter) =>
        v(parameter.name, parameter.title || parameter.name, parameter.type === 'user_id' ? 'user' : parameter.type === 'channel_id' ? 'channel' : 'text'),
      );
    }
    default:
      return [];
  }
}

/** A fresh step id not used anywhere in the workflow. */
export function freshId(steps: Step[], base: string): string {
  const used = new Set<string>();
  const walk = (list: Step[]): void => {
    for (const step of list) {
      used.add(step.id);
      if (step.type === 'branch') {
        walk(step.then);
        walk(step.else);
      }
    }
  };
  walk(steps);
  for (let n = 1; ; n += 1) {
    const id = `${base}_${n}`;
    if (!used.has(id)) return id;
  }
}

/** A field key from its label: lowercase letters, digits and underscores, starting with a letter. */
export function fieldKey(label: string, taken: string[]): string {
  let base = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  if (!/^[a-z]/.test(base)) base = `field${base ? `_${base}` : ''}`.slice(0, 24);
  let key = base;
  for (let n = 2; taken.includes(key); n += 1) key = `${base}_${n}`;
  return key;
}

export function blankStep(type: StepType, id: string, defaults: { channel?: string; trigger: Trigger }): Step {
  const channelTrigger = PERSON_TRIGGERS.includes(defaults.trigger.type);
  switch (type) {
    case 'message':
      return {
        id,
        type,
        destination: defaults.trigger.type === 'reaction' ? { to: 'thread' } : channelTrigger ? { to: 'trigger_channel' } : { to: 'channel', channel: defaults.channel ?? '' },
        text: '',
      };
    case 'form':
      return { id, type, title: 'Form', submit: 'Submit', fields: [{ key: 'answer', label: 'Answer', type: 'text', required: true }], post_to: null };
    case 'add_to_channel':
      return { id, type, channel: defaults.channel ?? '', user: 'trigger.user' };
    case 'webhook':
      return { id, type, url: 'https://', body: {} };
    case 'app':
      return { id, type, app_id: '', callback_id: '', inputs: {} };
    case 'list_item':
      return { id, type, list_id: '', fields: {} };
    case 'branch':
      return { id, type, variable: '', operator: 'equals', value: '', then: [], else: [] };
  }
}

export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
