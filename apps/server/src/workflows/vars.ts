import { escapeText } from '@app/shared';
import { offsetSeconds, zonedInstant } from '../ai/zones.ts';
import type { ScheduleSpec } from './model.ts';

/** A variable's value and what kind of thing it names, so it can be shown properly in a message. */
export interface Value {
  value: string;
  kind: 'text' | 'user' | 'channel';
}

export type Vars = Record<string, Value>;

const TEMPLATE = /\{\{\s*([a-z0-9_.]+)\s*\}\}/gi;

/** Fill `{{name}}` placeholders for a message: people become mentions, channels links, text is escaped. */
export function renderMessage(template: string, vars: Vars): string {
  return template.replace(TEMPLATE, (_all, name: string) => {
    const found = vars[name.toLowerCase()];
    if (!found || !found.value) return '';
    if (found.kind === 'user') return `<@${found.value}>`;
    if (found.kind === 'channel') return `<#${found.value}>`;
    return escapeText(found.value);
  });
}

/** Fill placeholders with raw values (webhook bodies, app step inputs). */
export function renderPlain(template: string, vars: Vars): string {
  return template.replace(TEMPLATE, (_all, name: string) => vars[name.toLowerCase()]?.value ?? '');
}

export function lookup(vars: Vars, name: string): Value | undefined {
  return vars[name.toLowerCase()];
}

/** Store values under lower-case names, so `{{Steps.Ask.Reason}}` and `{{steps.ask.reason}}` agree. */
export function put(vars: Vars, name: string, value: Value): void {
  vars[name.toLowerCase()] = value;
}

// ── Schedules ───────────────────────────────────────────────────────────────

function localParts(tz: string, at: number): { year: number; month: number; day: number; weekday: number } {
  const shifted = new Date((at + offsetSeconds(tz, at)) * 1000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), weekday: shifted.getUTCDay() };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The first time the schedule fires strictly after `after` (seconds), or null when it never will again. */
export function nextFire(spec: ScheduleSpec, after: number): number | null {
  const [hour = 0, minute = 0] = spec.time.split(':').map(Number);
  if (spec.frequency === 'once') {
    const [year, month, day] = (spec.date ?? '').split('-').map(Number);
    const at = zonedInstant(spec.tz, year!, month!, day!, hour, minute);
    return at > after ? at : null;
  }
  // Walk forward day by day; at most a little over a month for monthly schedules.
  for (let offset = 0; offset <= 62; offset += 1) {
    const date = localParts(spec.tz, after + offset * 86_400);
    let matches = spec.frequency === 'daily';
    if (spec.frequency === 'weekly') matches = (spec.weekdays ?? []).includes(date.weekday);
    if (spec.frequency === 'monthly') matches = date.day === Math.min(spec.day ?? 1, daysInMonth(date.year, date.month));
    if (!matches) continue;
    const at = zonedInstant(spec.tz, date.year, date.month, date.day, hour, minute);
    if (at > after) return at;
  }
  return null;
}
