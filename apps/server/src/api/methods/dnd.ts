import { addDays, zonedParts, zonedToEpoch } from '@app/shared';
import type { Ctx } from '../../ctx.ts';
import { getMember, resolveConv } from '../../core/conversations.ts';
import { fail } from '../../core/errors.ts';
import { getMessage } from '../../core/messages.ts';
import { getUser, requireUser } from '../../core/users.ts';
import type { Registry } from '../registry.ts';

/**
 * Do Not Disturb: a snooze for a while, and a daily schedule in the person's
 * own time zone. Slack's `dnd.*` methods and events, plus `client.dnd.*` for the
 * schedule and for "notify anyway".
 */

interface DndRow {
  user_id: string;
  snooze_until: number;
  snooze_started: number;
  schedule_enabled: number;
  start_minute: number;
  end_minute: number;
  /** Weekdays the schedule starts on, as digits 0 (Sunday) … 6. */
  days: string;
  /** The current scheduled window was ended early, until this time. */
  ended_until: number;
}

const DEFAULT_ROW: Omit<DndRow, 'user_id'> = {
  snooze_until: 0,
  snooze_started: 0,
  schedule_enabled: 0,
  start_minute: 22 * 60,
  end_minute: 8 * 60,
  days: '0123456',
  ended_until: 0,
};

function row(ctx: Ctx, userId: string): DndRow {
  return ctx.db.get<DndRow>('SELECT * FROM dnd WHERE user_id = ?', userId) ?? { user_id: userId, ...DEFAULT_ROW };
}

function save(ctx: Ctx, value: DndRow): void {
  ctx.db.run(
    `INSERT INTO dnd (user_id, snooze_until, snooze_started, schedule_enabled, start_minute, end_minute, days, ended_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET snooze_until = excluded.snooze_until, snooze_started = excluded.snooze_started,
       schedule_enabled = excluded.schedule_enabled, start_minute = excluded.start_minute, end_minute = excluded.end_minute,
       days = excluded.days, ended_until = excluded.ended_until`,
    value.user_id,
    value.snooze_until,
    value.snooze_started,
    value.schedule_enabled,
    value.start_minute,
    value.end_minute,
    value.days,
    value.ended_until,
  );
}

/** The scheduled window that contains `now`, or the next one. Times in seconds. */
function scheduledWindow(value: DndRow, tz: string, now: number): { start: number; end: number } | null {
  if (value.schedule_enabled !== 1 || value.days.length === 0) return null;
  const parts = zonedParts(now * 1000, tz);
  let date = addDays({ year: parts.year, month: parts.month, day: parts.day }, -1);
  for (let i = 0; i < 10; i += 1, date = addDays(date, 1)) {
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    if (!value.days.includes(String(weekday))) continue;
    const start = zonedToEpoch(date, Math.floor(value.start_minute / 60), value.start_minute % 60, tz) / 1000;
    const endDate = value.end_minute <= value.start_minute ? addDays(date, 1) : date;
    const end = zonedToEpoch(endDate, Math.floor(value.end_minute / 60), value.end_minute % 60, tz) / 1000;
    // A window ended early ("end Do Not Disturb") is skipped until it would have finished.
    if (end <= now || end <= value.ended_until) continue;
    return { start, end };
  }
  return null;
}

export interface DndStatus {
  dnd_enabled: boolean;
  next_dnd_start_ts: number;
  next_dnd_end_ts: number;
  snooze_enabled?: boolean;
  snooze_endtime?: number;
  snooze_remaining?: number;
  snooze_is_indefinite?: boolean;
}

/**
 * Status as Slack reports it. For other people, a running snooze shows as the
 * current window (that is what makes the "paused" mark appear); the snooze
 * fields themselves are only for the person.
 */
export function dndStatus(ctx: Ctx, userId: string, self: boolean, now = Math.floor(Date.now() / 1000)): DndStatus {
  const value = row(ctx, userId);
  const tz = getUser(ctx, userId)?.tz ?? 'UTC';
  const window = scheduledWindow(value, tz, now);
  const snoozing = value.snooze_until > now;
  const status: DndStatus = {
    dnd_enabled: value.schedule_enabled === 1,
    next_dnd_start_ts: window?.start ?? 1,
    next_dnd_end_ts: window?.end ?? 1,
  };
  if (snoozing && !self) {
    status.dnd_enabled = true;
    status.next_dnd_start_ts = value.snooze_started || now;
    status.next_dnd_end_ts = value.snooze_until;
  }
  if (self) {
    status.snooze_enabled = snoozing;
    if (snoozing) {
      status.snooze_endtime = value.snooze_until;
      status.snooze_remaining = value.snooze_until - now;
      status.snooze_is_indefinite = false;
    }
  }
  return status;
}

/** Whether notifications are paused for this person right now. */
export function inDnd(ctx: Ctx, userId: string, now = Math.floor(Date.now() / 1000)): boolean {
  const status = dndStatus(ctx, userId, false, now);
  return status.next_dnd_start_ts <= now && now < status.next_dnd_end_ts && status.next_dnd_end_ts > 1;
}

export function dndSchedule(ctx: Ctx, userId: string): { enabled: boolean; start: string; end: string; days: number[] } {
  const value = row(ctx, userId);
  const clock = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return { enabled: value.schedule_enabled === 1, start: clock(value.start_minute), end: clock(value.end_minute), days: [...value.days].map(Number) };
}

function announce(ctx: Ctx, userId: string): void {
  ctx.bus.emit({
    event: { type: 'dnd_updated', user: userId, dnd_status: dndStatus(ctx, userId, true), schedule: dndSchedule(ctx, userId), event_ts: ctx.clock.eventTs() },
    audience: { users: [userId] },
  });
  ctx.bus.emit({
    event: { type: 'dnd_updated_user', user: userId, dnd_status: dndStatus(ctx, userId, false), event_ts: ctx.clock.eventTs() },
    audience: { all: true },
  });
}

function parseClock(value: string, name: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) fail('invalid_arguments', { needed: name });
  return Number(match[1]) * 60 + Number(match[2]);
}

export function registerDnd(registry: Registry): void {
  registry.add('dnd.info', { scopes: ['dnd:read'] }, ({ ctx, actor, args }) => {
    const userId = args.str('user') || actor.userId;
    requireUser(ctx, userId);
    return { ...dndStatus(ctx, userId, userId === actor.userId) };
  });

  registry.add('dnd.teamInfo', { scopes: ['dnd:read'] }, ({ ctx, args }) => {
    const ids = args.list('users');
    if (ids.length === 0) fail('invalid_arguments', { needed: 'users' });
    const users: Record<string, DndStatus> = {};
    for (const id of ids.slice(0, 50)) {
      if (getUser(ctx, id)) users[id] = dndStatus(ctx, id, false);
    }
    return { users };
  });

  registry.add('dnd.setSnooze', { scopes: ['dnd:write'] }, ({ ctx, actor, args }) => {
    const minutes = args.int('num_minutes', 0);
    if (minutes <= 0) fail('invalid_arguments', { needed: 'num_minutes' });
    const now = Math.floor(Date.now() / 1000);
    const value = row(ctx, actor.userId);
    save(ctx, { ...value, snooze_until: now + Math.min(minutes, 60 * 24 * 365) * 60, snooze_started: value.snooze_until > now ? value.snooze_started : now });
    announce(ctx, actor.userId);
    const status = dndStatus(ctx, actor.userId, true, now);
    return {
      snooze_enabled: true,
      snooze_endtime: status.snooze_endtime,
      snooze_remaining: status.snooze_remaining,
      snooze_is_indefinite: false,
    };
  });

  registry.add('dnd.endSnooze', { scopes: ['dnd:write'] }, ({ ctx, actor }) => {
    const value = row(ctx, actor.userId);
    if (value.snooze_until <= Math.floor(Date.now() / 1000)) fail('snooze_not_active');
    save(ctx, { ...value, snooze_until: 0, snooze_started: 0 });
    announce(ctx, actor.userId);
    const status = dndStatus(ctx, actor.userId, true);
    return {
      dnd_enabled: status.dnd_enabled,
      next_dnd_start_ts: status.next_dnd_start_ts,
      next_dnd_end_ts: status.next_dnd_end_ts,
      snooze_enabled: false,
    };
  });

  /** Ends the current Do Not Disturb session: the snooze and any scheduled window in progress. */
  registry.add('dnd.endDnd', { scopes: ['dnd:write'] }, ({ ctx, actor }) => {
    const now = Math.floor(Date.now() / 1000);
    const value = row(ctx, actor.userId);
    const tz = getUser(ctx, actor.userId)?.tz ?? 'UTC';
    const window = scheduledWindow(value, tz, now);
    const endedUntil = window && window.start <= now ? window.end : value.ended_until;
    save(ctx, { ...value, snooze_until: 0, snooze_started: 0, ended_until: endedUntil });
    announce(ctx, actor.userId);
  });

  /** The daily schedule: `enabled`, `start` and `end` as "HH:MM" in the person's time zone, `days` 0 (Sunday) … 6. */
  registry.add('client.dnd.setSchedule', { auth: 'session' }, ({ ctx, actor, args }) => {
    const value = row(ctx, actor.userId);
    const next = { ...value };
    if (args.has('enabled')) next.schedule_enabled = args.bool('enabled') ? 1 : 0;
    if (args.has('start')) next.start_minute = parseClock(args.req('start'), 'start');
    if (args.has('end')) next.end_minute = parseClock(args.req('end'), 'end');
    if (args.has('days')) {
      const days = args.list('days').map(Number);
      if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) fail('invalid_arguments', { needed: 'days' });
      next.days = [...new Set(days)].sort().join('');
    }
    if (next.start_minute === next.end_minute) fail('invalid_arguments', { needed: 'end' });
    next.ended_until = 0;
    save(ctx, next);
    announce(ctx, actor.userId);
    return { schedule: dndSchedule(ctx, actor.userId), dnd_status: dndStatus(ctx, actor.userId, true) };
  });

  /**
   * "Notify anyway": the author of a direct message asks for it to reach
   * someone whose notifications are paused.
   */
  registry.add('client.dnd.notifyAnyway', { auth: 'session' }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    if (conv.kind !== 'im' && conv.kind !== 'mpim') fail('method_not_supported_for_channel_type');
    const message = getMessage(ctx, conv.id, args.reqTs('ts'));
    if (!message || message.user_id !== actor.userId) fail('message_not_found');
    const recipients = (conv.im_key ?? '').split(',').filter((id) => id && id !== actor.userId && getMember(ctx, conv.id, id));
    const paused = recipients.filter((id) => inDnd(ctx, id));
    for (const userId of paused) {
      ctx.bus.emit({
        event: { type: 'dnd_override', channel: conv.id, ts: message.ts, user: actor.userId },
        audience: { users: [userId] },
        clientOnly: true,
      });
    }
    return { notified: paused };
  });

  registry.add('client.dnd.status', { auth: 'session' }, ({ ctx, actor }) => {
    const now = Math.floor(Date.now() / 1000);
    const others: Record<string, DndStatus> = {};
    for (const user of ctx.db.all<{ user_id: string }>('SELECT user_id FROM dnd WHERE schedule_enabled = 1 OR snooze_until > ?', now)) {
      if (user.user_id !== actor.userId) others[user.user_id] = dndStatus(ctx, user.user_id, false, now);
    }
    return { self: dndStatus(ctx, actor.userId, true, now), schedule: dndSchedule(ctx, actor.userId), users: others };
  });
}
