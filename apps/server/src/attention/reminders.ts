import { nextOccurrence, parseWhen, WEEKDAY_NAMES, zonedParts, type Recurrence, type WeekdayName } from '@app/shared';
import { permalink } from '../api/methods/chat.ts';
import type { Registry } from '../api/registry.ts';
import { getConv, openDirect } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import { getMessage, postMessage } from '../core/messages.ts';
import { getUser, requireUser } from '../core/users.ts';
import type { Ctx } from '../ctx.ts';
import { parseJson, systemUser } from './common.ts';
import type { Scheduler, TimedSource } from './scheduler.ts';

/**
 * Slack's `reminders.*`: a message from the reminder bot in your direct
 * messages at the time you chose, once or on a schedule. Times can be given as a
 * timestamp, as seconds from now, or in words ("tomorrow at 9am",
 * "every weekday at 9:30"); see `@app/shared` `parseWhen` for the phrases.
 */

interface ReminderRow {
  id: string;
  user_id: string;
  creator: string;
  text: string;
  time: number;
  recurrence: string | null;
  complete_ts: number;
  fired: number;
  channel: string | null;
  message_ts: string | null;
  created: number;
}

const MAX_TEXT = 4000;
const FIVE_YEARS = 5 * 365 * 86_400;

export function reminderToApi(row: ReminderRow): Record<string, unknown> {
  const recurrence = parseJson<Recurrence>(row.recurrence);
  const out: Record<string, unknown> = { id: row.id, creator: row.creator, user: row.user_id, text: row.text, recurring: Boolean(recurrence) };
  if (recurrence) {
    const shape: Record<string, unknown> = { frequency: recurrence.frequency };
    if (recurrence.weekdays) shape.weekdays = recurrence.weekdays;
    out.recurrence = shape;
    out.next_time = row.time;
  } else {
    out.time = row.time;
    out.complete_ts = row.complete_ts;
  }
  if (row.channel && row.message_ts) {
    out.channel = row.channel;
    out.message_ts = row.message_ts;
  }
  return out;
}

function changed(ctx: Ctx, userId: string): void {
  ctx.bus.emit({ event: { type: 'reminders_changed' }, audience: { users: [userId] }, clientOnly: true });
}

function deliver(ctx: Ctx, row: ReminderRow, now: number): void {
  const user = getUser(ctx, row.user_id);
  if (user && user.deleted === 0) {
    const bot = systemUser(ctx, 'reminders');
    const conv = openDirect(ctx, bot.id, [row.user_id]).conv;
    let text = `Reminder: ${row.text}${/[.!?]$/.test(row.text) ? '' : '.'}`;
    const source = row.channel && row.message_ts ? getConv(ctx, row.channel) : undefined;
    const message = source && row.message_ts ? getMessage(ctx, source.id, row.message_ts) : undefined;
    if (source && message) text += ` <${permalink(ctx, source, message)}|View the message>`;
    postMessage(ctx, { conv: getConv(ctx, conv.id)!, userId: bot.id, botId: bot.bot_id, text });
  }
  const recurrence = parseJson<Recurrence>(row.recurrence);
  if (recurrence && user) {
    const next = Math.floor(nextOccurrence(recurrence, Math.max(now, row.time) * 1000, user.tz) / 1000);
    ctx.db.run('UPDATE reminders SET time = ? WHERE id = ?', next, row.id);
  } else {
    ctx.db.run('UPDATE reminders SET fired = 1 WHERE id = ?', row.id);
  }
  changed(ctx, row.user_id);
}

export function reminderSource(ctx: Ctx): TimedSource {
  return {
    next: () => ctx.db.get<{ at: number | null }>('SELECT min(time) AS at FROM reminders WHERE fired = 0 AND complete_ts = 0')?.at ?? null,
    run: (now) => {
      for (const row of ctx.db.all<ReminderRow>('SELECT * FROM reminders WHERE fired = 0 AND complete_ts = 0 AND time <= ? ORDER BY time', now)) {
        deliver(ctx, row, now);
      }
    },
  };
}

/** Read Slack's structured `recurrence` argument. */
function readRecurrence(value: unknown, firstTime: number, tz: string): Recurrence | null {
  if (!value || typeof value !== 'object') return null;
  const shape = value as { frequency?: unknown; weekdays?: unknown };
  const parts = zonedParts(firstTime * 1000, tz);
  const base = { hour: parts.hour, minute: parts.minute, day: parts.day, month: parts.month };
  if (shape.frequency === 'daily' || shape.frequency === 'monthly' || shape.frequency === 'yearly') return { frequency: shape.frequency, ...base };
  if (shape.frequency === 'weekly') {
    const days = Array.isArray(shape.weekdays) ? shape.weekdays.map((day) => String(day).toLowerCase()) : [];
    if (days.length === 0 || days.some((day) => !WEEKDAY_NAMES.includes(day as WeekdayName))) fail('invalid_arguments', { needed: 'recurrence' });
    return { frequency: 'weekly', weekdays: days as WeekdayName[], ...base };
  }
  fail('invalid_arguments', { needed: 'recurrence' });
}

export interface NewReminder {
  creator: string;
  user: string;
  text: string;
  time: number;
  recurrence: Recurrence | null;
  channel?: string | null;
  messageTs?: string | null;
}

export function createReminder(ctx: Ctx, scheduler: Scheduler, input: NewReminder): ReminderRow {
  const id = `Rm${newId('', 10)}`;
  ctx.db.run(
    'INSERT INTO reminders (id, user_id, creator, text, time, recurrence, channel, message_ts, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    input.user,
    input.creator,
    input.text,
    input.time,
    input.recurrence ? JSON.stringify(input.recurrence) : null,
    input.channel ?? null,
    input.messageTs ?? null,
    nowSeconds(),
  );
  scheduler.arm();
  changed(ctx, input.user);
  if (input.creator !== input.user) changed(ctx, input.creator);
  return ctx.db.get<ReminderRow>('SELECT * FROM reminders WHERE id = ?', id)!;
}

/** Resolve the `time` argument: a timestamp, seconds from now (within a day), or words. Returns seconds. */
export function resolveTime(value: string, tz: string, now = nowSeconds()): { time: number; recurrence: Recurrence | null } {
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const number = Math.floor(Number(trimmed));
    const time = number <= 86_400 ? now + number : number;
    if (time < now || time > now + FIVE_YEARS) fail('cannot_parse');
    return { time, recurrence: null };
  }
  const parsed = parseWhen(trimmed, now * 1000, tz);
  if (!parsed) fail('cannot_parse');
  const time = Math.floor(parsed.time / 1000);
  if (time < now || time > now + FIVE_YEARS) fail('cannot_parse');
  return { time, recurrence: parsed.recurrence ?? null };
}

function visibleReminder(ctx: Ctx, id: string, userId: string): ReminderRow {
  const row = ctx.db.get<ReminderRow>('SELECT * FROM reminders WHERE id = ?', id);
  if (!row || (row.user_id !== userId && row.creator !== userId)) fail('not_found');
  return row;
}

export function remindersFor(ctx: Ctx, userId: string): ReminderRow[] {
  return ctx.db.all<ReminderRow>('SELECT * FROM reminders WHERE user_id = ? OR creator = ? ORDER BY time', userId, userId);
}

export function registerReminders(registry: Registry, scheduler: Scheduler): void {
  registry.add('reminders.add', { scopes: ['reminders:write'] }, ({ ctx, actor, args }) => {
    const text = (args.str('text') ?? '').trim();
    if (!text) fail('no_text');
    if (text.length > MAX_TEXT) fail('msg_too_long');
    const targetId = args.str('user') || actor.userId;
    const target = getUser(ctx, targetId);
    if (!target || target.deleted === 1) fail('user_not_found');
    if (target.is_bot === 1) fail('cannot_add_bot');
    const creator = requireUser(ctx, actor.userId);
    const resolved = resolveTime(args.req('time', 'cannot_parse'), creator.tz);
    let recurrence = resolved.recurrence;
    const structured = args.json<unknown>('recurrence');
    if (structured !== undefined) recurrence = readRecurrence(structured, resolved.time, creator.tz);
    const row = createReminder(ctx, scheduler, { creator: actor.userId, user: targetId, text, time: resolved.time, recurrence });
    return { reminder: reminderToApi(row) };
  });

  registry.add('reminders.list', { scopes: ['reminders:read'] }, ({ ctx, actor }) => ({
    reminders: remindersFor(ctx, actor.userId).map(reminderToApi),
  }));

  registry.add('reminders.info', { scopes: ['reminders:read'] }, ({ ctx, actor, args }) => ({
    reminder: reminderToApi(visibleReminder(ctx, args.req('reminder', 'not_found'), actor.userId)),
  }));

  registry.add('reminders.complete', { scopes: ['reminders:write'] }, ({ ctx, actor, args }) => {
    const row = visibleReminder(ctx, args.req('reminder', 'not_found'), actor.userId);
    if (row.recurrence) fail('cannot_complete_recurring');
    ctx.db.run('UPDATE reminders SET complete_ts = ? WHERE id = ?', nowSeconds(), row.id);
    scheduler.arm();
    changed(ctx, row.user_id);
  });

  registry.add('reminders.delete', { scopes: ['reminders:write'] }, ({ ctx, actor, args }) => {
    const row = visibleReminder(ctx, args.req('reminder', 'not_found'), actor.userId);
    ctx.db.run('DELETE FROM reminders WHERE id = ?', row.id);
    scheduler.arm();
    changed(ctx, row.user_id);
  });

  /** Move a reminder to a new time (the "snooze" choices in the Later view). */
  registry.add('client.reminders.reschedule', { auth: 'session' }, ({ ctx, actor, args }) => {
    const row = visibleReminder(ctx, args.req('reminder', 'not_found'), actor.userId);
    const creator = requireUser(ctx, actor.userId);
    const { time } = resolveTime(args.req('time', 'cannot_parse'), creator.tz);
    ctx.db.run('UPDATE reminders SET time = ?, fired = 0, complete_ts = 0 WHERE id = ?', time, row.id);
    scheduler.arm();
    changed(ctx, row.user_id);
    return { reminder: reminderToApi(ctx.db.get<ReminderRow>('SELECT * FROM reminders WHERE id = ?', row.id)!) };
  });
}
