import { fail } from '../core/errors.ts';
import { validZone } from '../ai/zones.ts';

/**
 * What a workflow is made of: one trigger and an ordered list of steps. Steps
 * read variables from the trigger and from earlier steps (`{{trigger.user}}`,
 * `{{steps.ask.reason}}`). A branch step holds two lists of its own, one level
 * deep. Before a run starts, steps compile to a flat program with jumps, so a
 * run that pauses (a form, an app's step) resumes at a plain index.
 */

export type TriggerType = 'shortcut' | 'link' | 'schedule' | 'reaction' | 'member_joined' | 'webhook';

export interface ScheduleSpec {
  frequency: 'once' | 'daily' | 'weekly' | 'monthly';
  /** `HH:MM`, wall clock in `tz`. */
  time: string;
  tz: string;
  /** `once`: YYYY-MM-DD. */
  date?: string;
  /** `weekly`: 0 = Sunday … 6 = Saturday. */
  weekdays?: number[];
  /** `monthly`: 1–31 (the last day of shorter months when larger). */
  day?: number;
}

export interface Trigger {
  type: TriggerType;
  /** `reaction`, `member_joined`: the channel watched. */
  channel?: string;
  /** `reaction`: emoji name without colons. */
  reaction?: string;
  schedule?: ScheduleSpec;
  /** `webhook`: JSON keys taken from the request body as variables. */
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

/** Where a message step posts. */
export type Destination =
  | { to: 'channel'; channel: string }
  | { to: 'trigger_channel' }
  | { to: 'thread' }
  | { to: 'user'; user: string };

export type Step =
  | { id: string; type: 'message'; destination: Destination; text: string }
  | { id: string; type: 'form'; title: string; submit: string; fields: FormField[]; post_to?: string | null }
  | { id: string; type: 'add_to_channel'; channel: string; user: string }
  | { id: string; type: 'webhook'; url: string; body: Record<string, string> }
  | { id: string; type: 'app'; app_id: string; callback_id: string; inputs: Record<string, string> }
  | { id: string; type: 'list_item'; list_id: string; fields: Record<string, string> }
  | {
      id: string;
      type: 'branch';
      variable: string;
      operator: 'equals' | 'not_equals' | 'contains' | 'is_empty' | 'is_not_empty';
      value: string;
      then: Step[];
      else: Step[];
    };

export type Instruction =
  | { op: 'step'; step: Exclude<Step, { type: 'branch' }> }
  | { op: 'branch'; step: Extract<Step, { type: 'branch' }>; elseAt: number }
  | { op: 'jump'; to: number };

/** Triggers where a person sets the run off, so a form can be put in front of them. */
export const PERSON_TRIGGERS = new Set<TriggerType>(['shortcut', 'link', 'reaction', 'member_joined']);
const CHANNEL_TRIGGERS = new Set<TriggerType>(['shortcut', 'link', 'reaction', 'member_joined']);

const MAX_STEPS = 30;
const MAX_TEXT = 4000;
const ID_PATTERN = /^[a-z][a-z0-9_]{0,30}$/;
const VARIABLE_PATTERN = /^(trigger|webhook|steps)(\.[a-z0-9_]+){1,2}$/i;

function bad(detail: string): never {
  fail('invalid_workflow', { detail });
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function readSchedule(raw: unknown): ScheduleSpec {
  const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const frequency = item.frequency;
  if (frequency !== 'once' && frequency !== 'daily' && frequency !== 'weekly' && frequency !== 'monthly') bad('schedule.frequency');
  const time = str(item.time, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) bad('schedule.time must be HH:MM');
  const tz = str(item.tz, 80) || 'UTC';
  if (!validZone(tz)) bad('schedule.tz');
  const spec: ScheduleSpec = { frequency, time, tz };
  if (frequency === 'once') {
    const date = str(item.date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) bad('schedule.date must be YYYY-MM-DD');
    spec.date = date;
  }
  if (frequency === 'weekly') {
    const days = Array.isArray(item.weekdays) ? [...new Set(item.weekdays.map(Number))].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6) : [];
    if (days.length === 0) bad('schedule.weekdays');
    spec.weekdays = days.sort();
  }
  if (frequency === 'monthly') {
    const day = Number(item.day);
    if (!Number.isInteger(day) || day < 1 || day > 31) bad('schedule.day');
    spec.day = day;
  }
  return spec;
}

export function readTrigger(raw: unknown): Trigger {
  const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const type = item.type as TriggerType;
  if (!['shortcut', 'link', 'schedule', 'reaction', 'member_joined', 'webhook'].includes(type)) bad('trigger.type');
  const trigger: Trigger = { type };
  if (type === 'reaction' || type === 'member_joined') {
    const channel = str(item.channel, 30);
    if (!/^C[A-Z0-9]+$/.test(channel)) bad('trigger.channel');
    trigger.channel = channel;
  }
  if (type === 'reaction') {
    const reaction = str(item.reaction, 100).replace(/^:|:$/g, '');
    if (!/^[\p{L}\p{N}_+'-]+(::skin-tone-[2-6])?$/u.test(reaction)) bad('trigger.reaction');
    trigger.reaction = reaction;
  }
  if (type === 'schedule') trigger.schedule = readSchedule(item.schedule);
  if (type === 'webhook') {
    const variables = Array.isArray(item.variables) ? item.variables.map((name) => String(name)) : [];
    if (variables.length > 20 || variables.some((name) => !/^[a-z0-9_]{1,40}$/i.test(name))) bad('trigger.variables');
    trigger.variables = [...new Set(variables)];
  }
  return trigger;
}

function readField(raw: unknown, index: number): FormField {
  const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const key = str(item.key, 31);
  if (!ID_PATTERN.test(key)) bad(`form field ${index + 1}: key`);
  const type = item.type as FieldType;
  if (!['text', 'long_text', 'select', 'user', 'channel', 'number', 'date'].includes(type)) bad(`form field ${key}: type`);
  const field: FormField = { key, label: str(item.label, 80) || key, type, required: item.required === true };
  if (type === 'select') {
    const options = Array.isArray(item.options) ? item.options.map((option) => String(option).slice(0, 75)).filter(Boolean) : [];
    if (options.length === 0 || options.length > 50) bad(`form field ${key}: options`);
    field.options = [...new Set(options)];
  }
  return field;
}

function readVariable(value: unknown, where: string): string {
  const name = str(value, 80);
  if (!VARIABLE_PATTERN.test(name)) bad(`${where}: variable`);
  return name;
}

function readTemplateMap(raw: unknown, where: string): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) bad(where);
  const out: Record<string, string> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 30) bad(where);
  for (const [key, value] of entries) {
    if (!/^[a-z0-9_]{1,50}$/i.test(key)) bad(`${where}: ${key}`);
    out[key] = str(value, MAX_TEXT);
  }
  return out;
}

function readStep(raw: unknown, ids: Set<string>, depth: number): Step {
  const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const id = str(item.id, 31);
  if (!ID_PATTERN.test(id)) bad('step id must be letters, digits and _ starting with a letter');
  if (ids.has(id)) bad(`step id ${id} is used twice`);
  ids.add(id);
  switch (item.type) {
    case 'message': {
      const destination = (item.destination && typeof item.destination === 'object' ? item.destination : {}) as Record<string, unknown>;
      let parsed: Destination;
      if (destination.to === 'channel') {
        const channel = str(destination.channel, 30);
        if (!/^[CDG][A-Z0-9]+$/.test(channel)) bad(`${id}: channel`);
        parsed = { to: 'channel', channel };
      } else if (destination.to === 'trigger_channel' || destination.to === 'thread') {
        parsed = { to: destination.to };
      } else if (destination.to === 'user') {
        const user = str(destination.user, 80);
        parsed = { to: 'user', user: /^U[A-Z0-9]+$/.test(user) ? user : readVariable(user, `${id}: user`) };
      } else {
        bad(`${id}: destination`);
      }
      const text = str(item.text, MAX_TEXT);
      if (!text.trim()) bad(`${id}: the message is empty`);
      return { id, type: 'message', destination: parsed, text };
    }
    case 'form': {
      const fields = Array.isArray(item.fields) ? item.fields.map(readField) : [];
      if (fields.length === 0 || fields.length > 15) bad(`${id}: a form needs 1 to 15 fields`);
      if (new Set(fields.map((field) => field.key)).size !== fields.length) bad(`${id}: field keys repeat`);
      const postTo = str(item.post_to, 30);
      if (postTo && postTo !== 'trigger_channel' && !/^C[A-Z0-9]+$/.test(postTo)) bad(`${id}: post_to`);
      return { id, type: 'form', title: str(item.title, 24) || 'Form', submit: str(item.submit, 24) || 'Submit', fields, post_to: postTo || null };
    }
    case 'add_to_channel': {
      const channel = str(item.channel, 30);
      if (!/^C[A-Z0-9]+$/.test(channel)) bad(`${id}: channel`);
      const user = str(item.user, 80);
      return { id, type: 'add_to_channel', channel, user: /^U[A-Z0-9]+$/.test(user) ? user : readVariable(user, `${id}: user`) };
    }
    case 'webhook': {
      const url = str(item.url, 2000);
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error();
      } catch {
        bad(`${id}: url`);
      }
      return { id, type: 'webhook', url, body: readTemplateMap(item.body, `${id}: body`) };
    }
    case 'app': {
      const appId = str(item.app_id, 30);
      const callbackId = str(item.callback_id, 100);
      if (!/^A[A-Z0-9]+$/.test(appId) || !callbackId) bad(`${id}: app step`);
      return { id, type: 'app', app_id: appId, callback_id: callbackId, inputs: readTemplateMap(item.inputs, `${id}: inputs`) };
    }
    case 'list_item': {
      const listId = str(item.list_id, 40);
      if (!listId) bad(`${id}: list`);
      return { id, type: 'list_item', list_id: listId, fields: readTemplateMap(item.fields, `${id}: fields`) };
    }
    case 'branch': {
      if (depth > 0) bad(`${id}: a branch cannot contain another branch`);
      const operator = item.operator as Extract<Step, { type: 'branch' }>['operator'];
      if (!['equals', 'not_equals', 'contains', 'is_empty', 'is_not_empty'].includes(operator)) bad(`${id}: operator`);
      const list = (value: unknown): Step[] => (Array.isArray(value) ? value.map((entry) => readStep(entry, ids, depth + 1)) : []);
      return {
        id,
        type: 'branch',
        variable: readVariable(item.variable, id),
        operator,
        value: str(item.value, 500),
        then: list(item.then),
        else: list(item.else),
      };
    }
    default:
      bad(`${id}: unknown step type`);
  }
}

export function readSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw)) bad('steps');
  const ids = new Set<string>();
  const steps = raw.map((entry) => readStep(entry, ids, 0));
  const count = (list: Step[]): number => list.reduce((sum, step) => sum + 1 + (step.type === 'branch' ? count(step.then) + count(step.else) : 0), 0);
  if (count(steps) > MAX_STEPS) bad(`at most ${MAX_STEPS} steps`);
  return steps;
}

/** Every step, branches flattened, in order. */
export function allSteps(steps: Step[]): Step[] {
  return steps.flatMap((step) => (step.type === 'branch' ? [step, ...allSteps(step.then), ...allSteps(step.else)] : [step]));
}

/** Flatten steps into instructions: a branch jumps to its else-list when the test fails. */
export function compile(steps: Step[]): Instruction[] {
  const program: Instruction[] = [];
  const emit = (list: Step[]): void => {
    for (const step of list) {
      if (step.type !== 'branch') {
        program.push({ op: 'step', step });
        continue;
      }
      const branchAt = program.length;
      program.push({ op: 'branch', step, elseAt: -1 });
      emit(step.then);
      const jumpAt = program.length;
      program.push({ op: 'jump', to: -1 });
      (program[branchAt] as Extract<Instruction, { op: 'branch' }>).elseAt = program.length;
      emit(step.else);
      (program[jumpAt] as Extract<Instruction, { op: 'jump' }>).to = program.length;
    }
  };
  emit(steps);
  return program;
}

/** Problems that keep a workflow from being published (beyond shape), as plain sentences. */
export function publishProblems(trigger: Trigger, steps: Step[]): string[] {
  const problems: string[] = [];
  if (steps.length === 0) problems.push('Add at least one step.');
  const flat = allSteps(steps);
  const personless = !PERSON_TRIGGERS.has(trigger.type);
  if (personless && flat.some((step) => step.type === 'form')) problems.push('A form needs a person to fill it in; this trigger has none.');
  if (!CHANNEL_TRIGGERS.has(trigger.type) && flat.some((step) => step.type === 'message' && (step.destination.to === 'trigger_channel'))) {
    problems.push('“The channel where it started” needs a trigger that starts in a channel.');
  }
  if (trigger.type !== 'reaction' && flat.some((step) => step.type === 'message' && step.destination.to === 'thread')) {
    problems.push('Replying in the thread needs the emoji-reaction trigger.');
  }
  return problems;
}
