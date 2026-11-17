import type { Registry } from '../api/registry.ts';
import { canSee, getConv, resolveConv } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { nowSeconds } from '../core/ids.ts';
import { getMessage, messageToApi } from '../core/messages.ts';
import { requireUser } from '../core/users.ts';
import type { Ctx } from '../ctx.ts';
import { createReminder, resolveTime } from './reminders.ts';
import type { Scheduler } from './scheduler.ts';

/** "Save for later": a personal list of messages, each in progress, archived or completed. */

type SavedState = 'in_progress' | 'archived' | 'completed';
const STATES: SavedState[] = ['in_progress', 'archived', 'completed'];

interface SavedRow {
  user_id: string;
  conversation_id: string;
  ts: string;
  state: SavedState;
  created: number;
  updated: number;
}

function itemToApi(ctx: Ctx, row: SavedRow): Record<string, unknown> {
  const out: Record<string, unknown> = { channel: row.conversation_id, ts: row.ts, state: row.state, date_saved: row.created, date_updated: row.updated };
  const message = getMessage(ctx, row.conversation_id, row.ts);
  if (message) out.message = messageToApi(ctx, message);
  return out;
}

function emit(ctx: Ctx, userId: string, body: Record<string, unknown>): void {
  ctx.bus.emit({ event: { type: 'saved_changed', ...body }, audience: { users: [userId] }, clientOnly: true });
}

export function savedKeys(ctx: Ctx, userId: string): { channel: string; ts: string; state: SavedState }[] {
  return ctx.db
    .all<SavedRow>('SELECT * FROM saved WHERE user_id = ? ORDER BY created DESC LIMIT 1000', userId)
    .map((row) => ({ channel: row.conversation_id, ts: row.ts, state: row.state }));
}

export function registerSaved(registry: Registry, scheduler: Scheduler): void {
  registry.add('client.saved.add', { auth: 'session' }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const ts = args.reqTs('ts');
    if (!getMessage(ctx, conv.id, ts)) fail('message_not_found');
    const now = nowSeconds();
    ctx.db.run(
      `INSERT INTO saved (user_id, conversation_id, ts, state, created, updated) VALUES (?, ?, ?, 'in_progress', ?, ?)
       ON CONFLICT (user_id, conversation_id, ts) DO UPDATE SET state = 'in_progress', updated = excluded.updated`,
      actor.userId,
      conv.id,
      ts,
      now,
      now,
    );
    const row = ctx.db.get<SavedRow>('SELECT * FROM saved WHERE user_id = ? AND conversation_id = ? AND ts = ?', actor.userId, conv.id, ts)!;
    const item = itemToApi(ctx, row);
    emit(ctx, actor.userId, { item });
    return { item };
  });

  registry.add('client.saved.update', { auth: 'session' }, ({ ctx, actor, args }) => {
    const channel = args.req('channel', 'channel_not_found');
    const ts = args.reqTs('ts');
    const state = args.req('state') as SavedState;
    if (!STATES.includes(state)) fail('invalid_arguments', { needed: 'state' });
    const result = ctx.db.run(
      'UPDATE saved SET state = ?, updated = ? WHERE user_id = ? AND conversation_id = ? AND ts = ?',
      state,
      nowSeconds(),
      actor.userId,
      channel,
      ts,
    );
    if (result.changes === 0) fail('not_found');
    const item = itemToApi(ctx, ctx.db.get<SavedRow>('SELECT * FROM saved WHERE user_id = ? AND conversation_id = ? AND ts = ?', actor.userId, channel, ts)!);
    emit(ctx, actor.userId, { item });
    return { item };
  });

  registry.add('client.saved.remove', { auth: 'session' }, ({ ctx, actor, args }) => {
    const channel = args.req('channel', 'channel_not_found');
    const ts = args.reqTs('ts');
    const result = ctx.db.run('DELETE FROM saved WHERE user_id = ? AND conversation_id = ? AND ts = ?', actor.userId, channel, ts);
    if (result.changes === 0) fail('not_found');
    emit(ctx, actor.userId, { removed: { channel, ts } });
  });

  registry.add('client.saved.list', { auth: 'session' }, ({ ctx, actor, args }) => {
    const state = (args.str('state') ?? 'in_progress') as SavedState;
    if (!STATES.includes(state)) fail('invalid_arguments', { needed: 'state' });
    const rows = ctx.db.all<SavedRow>('SELECT * FROM saved WHERE user_id = ? AND state = ? ORDER BY updated DESC LIMIT 500', actor.userId, state);
    const items = [];
    for (const row of rows) {
      const conv = getConv(ctx, row.conversation_id);
      if (!conv || !canSee(ctx, conv, actor.userId)) continue;
      items.push(itemToApi(ctx, row));
    }
    return { items };
  });

  /** "Remind me about this": a reminder that links back to the message. */
  registry.add('client.saved.remind', { auth: 'session' }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const ts = args.reqTs('ts');
    if (!getMessage(ctx, conv.id, ts)) fail('message_not_found');
    const user = requireUser(ctx, actor.userId);
    const { time } = resolveTime(args.req('time', 'cannot_parse'), user.tz);
    const reminder = createReminder(ctx, scheduler, {
      creator: actor.userId,
      user: actor.userId,
      text: args.str('text')?.trim() || 'Look at this message',
      time,
      recurrence: null,
      channel: conv.id,
      messageTs: ts,
    });
    return { reminder: { id: reminder.id, time: reminder.time } };
  });
}
