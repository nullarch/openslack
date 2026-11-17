import type { Registry } from '../api/registry.ts';
import { canSee, getConv } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { nowSeconds } from '../core/ids.ts';
import { getMessage, messageToApi } from '../core/messages.ts';
import type { Ctx } from '../ctx.ts';

/**
 * The Activity view: what happened that concerns one person. Rows are written
 * as things happen (a mention, a reply in a followed thread, a reaction to their
 * message, being added to a channel, a keyword) and read back newest first.
 */

export type ActivityKind = 'mention' | 'thread_reply' | 'reaction' | 'invite' | 'keyword' | (string & {});

/**
 * Activity about something other than a message (a canvas mention, a list
 * assignment) registers how to check who may see it and how to show it.
 * For such rows `conversation_id` holds the document id and `ts` an item id.
 */
export interface ActivityResolver {
  canSee(ctx: Ctx, row: { conversation_id: string; ts: string; detail: string }, userId: string): boolean;
  toApi(ctx: Ctx, row: { conversation_id: string; ts: string; detail: string; actor: string }): Record<string, unknown>;
}
export const activityResolvers = new Map<string, ActivityResolver>();

interface ActivityRow {
  id: number;
  user_id: string;
  kind: ActivityKind;
  conversation_id: string;
  ts: string;
  thread_ts: string | null;
  actor: string;
  detail: string;
  created: number;
  is_read: number;
}

const KEEP_PER_USER = 500;

export interface NewActivity {
  kind: ActivityKind;
  channel: string;
  ts: string;
  threadTs?: string | null;
  actor: string;
  /** Reaction name, matched keyword, or `broadcast` for @channel/@here mentions. */
  detail?: string;
}

function activityToApi(ctx: Ctx, row: ActivityRow): Record<string, unknown> {
  const item: Record<string, unknown> = {
    id: String(row.id),
    type: row.kind,
    created: row.created,
    is_unread: row.is_read === 0,
    channel: row.conversation_id,
    ts: row.ts,
    actor: row.actor || null,
  };
  if (row.thread_ts) item.thread_ts = row.thread_ts;
  if (row.kind === 'reaction') item.reaction = row.detail;
  if (row.kind === 'keyword') item.keyword = row.detail;
  if (row.kind === 'mention' && row.detail === 'broadcast') item.broadcast = true;
  const resolver = activityResolvers.get(row.kind);
  if (resolver) return { ...item, ...resolver.toApi(ctx, row) };
  const message = getMessage(ctx, row.conversation_id, row.ts);
  if (message) item.message = messageToApi(ctx, message);
  return item;
}

export function unreadActivity(ctx: Ctx, userId: string): number {
  return ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM activity WHERE user_id = ? AND is_read = 0', userId)?.n ?? 0;
}

export function addActivity(ctx: Ctx, userId: string, entry: NewActivity): void {
  const result = ctx.db.run(
    `INSERT OR IGNORE INTO activity (user_id, kind, conversation_id, ts, thread_ts, actor, detail, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    userId,
    entry.kind,
    entry.channel,
    entry.ts,
    entry.threadTs ?? null,
    entry.actor,
    entry.detail ?? '',
    nowSeconds(),
  );
  if (result.changes === 0) return;
  const row = ctx.db.get<ActivityRow>('SELECT * FROM activity WHERE id = ?', result.lastInsertRowid)!;
  ctx.db.run(
    `DELETE FROM activity WHERE user_id = ? AND id <= (
       SELECT id FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?
     )`,
    userId,
    userId,
    KEEP_PER_USER,
  );
  ctx.bus.emit({
    event: { type: 'activity_added', item: activityToApi(ctx, row), unread_count: unreadActivity(ctx, userId) },
    audience: { users: [userId] },
    clientOnly: true,
  });
}

/** Forget activity about a message that no longer exists, or a reaction that was taken back. */
export function removeActivity(ctx: Ctx, channel: string, ts: string, filter?: { kind: ActivityKind; actor: string; detail: string }): void {
  const rows = filter
    ? ctx.db.all<{ user_id: string }>(
        'SELECT DISTINCT user_id FROM activity WHERE conversation_id = ? AND ts = ? AND kind = ? AND actor = ? AND detail = ?',
        channel,
        ts,
        filter.kind,
        filter.actor,
        filter.detail,
      )
    : ctx.db.all<{ user_id: string }>('SELECT DISTINCT user_id FROM activity WHERE conversation_id = ? AND ts = ?', channel, ts);
  if (rows.length === 0) return;
  if (filter) {
    ctx.db.run(
      'DELETE FROM activity WHERE conversation_id = ? AND ts = ? AND kind = ? AND actor = ? AND detail = ?',
      channel,
      ts,
      filter.kind,
      filter.actor,
      filter.detail,
    );
  } else {
    ctx.db.run('DELETE FROM activity WHERE conversation_id = ? AND ts = ?', channel, ts);
  }
  for (const { user_id: userId } of rows) {
    ctx.bus.emit({
      event: { type: 'activity_removed', channel, ts, unread_count: unreadActivity(ctx, userId) },
      audience: { users: [userId] },
      clientOnly: true,
    });
  }
}

function emitMarked(ctx: Ctx, userId: string, ids: string[] | 'all', read: boolean): void {
  ctx.bus.emit({
    event: { type: 'activity_marked', ids: ids === 'all' ? [] : ids, all: ids === 'all', read, unread_count: unreadActivity(ctx, userId) },
    audience: { users: [userId] },
    clientOnly: true,
  });
}

/** Reading a conversation (or a thread) up to `ts` also reads the activity about it. */
export function markActivityRead(ctx: Ctx, userId: string, channel: string, ts: string, threadTs: string | null): void {
  const rows = threadTs
    ? ctx.db.all<{ id: number }>(
        'SELECT id FROM activity WHERE user_id = ? AND conversation_id = ? AND thread_ts = ? AND ts <= ? AND is_read = 0',
        userId,
        channel,
        threadTs,
        ts,
      )
    : ctx.db.all<{ id: number }>(
        `SELECT id FROM activity WHERE user_id = ? AND conversation_id = ? AND ts <= ? AND is_read = 0
           AND kind IN ('mention', 'keyword', 'invite') AND (thread_ts IS NULL OR thread_ts = ts)`,
        userId,
        channel,
        ts,
      );
  if (rows.length === 0) return;
  const ids = rows.map((row) => row.id);
  ctx.db.run(`UPDATE activity SET is_read = 1 WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  emitMarked(ctx, userId, ids.map(String), true);
}

export function registerActivity(registry: Registry): void {
  registry.add('client.activity.list', { auth: 'session' }, ({ ctx, actor, args }) => {
    const limit = args.int('limit', 30, { min: 1, max: 100 });
    const before = args.str('cursor') ? Number(args.str('cursor')) : Number.MAX_SAFE_INTEGER;
    if (!Number.isFinite(before)) fail('invalid_cursor');
    const types = args.list('types').filter((type) => ['mention', 'thread_reply', 'reaction', 'invite', 'keyword', ...activityResolvers.keys()].includes(type));
    const unreadOnly = args.bool('unread_only');
    const items: Record<string, unknown>[] = [];
    let cursor = before;
    let exhausted = false;
    // Rows about conversations the person can no longer see are skipped, so read in batches.
    while (items.length < limit && !exhausted) {
      const rows = ctx.db.all<ActivityRow>(
        `SELECT * FROM activity WHERE user_id = ? AND id < ?
           ${types.length ? `AND kind IN (${types.map(() => '?').join(',')})` : ''}
           ${unreadOnly ? 'AND is_read = 0' : ''}
         ORDER BY id DESC LIMIT ?`,
        actor.userId,
        cursor,
        ...types,
        limit * 2,
      );
      if (rows.length < limit * 2) exhausted = true;
      for (const row of rows) {
        cursor = row.id;
        const resolver = activityResolvers.get(row.kind);
        if (resolver) {
          if (!resolver.canSee(ctx, row, actor.userId)) continue;
        } else {
          const conv = getConv(ctx, row.conversation_id);
          if (!conv || !canSee(ctx, conv, actor.userId)) continue;
        }
        items.push(activityToApi(ctx, row));
        if (items.length === limit) break;
      }
    }
    const more = items.length === limit && !exhausted;
    return {
      items,
      unread_count: unreadActivity(ctx, actor.userId),
      response_metadata: { next_cursor: more ? String(cursor) : '' },
    };
  });

  registry.add('client.activity.mark', { auth: 'session' }, ({ ctx, actor, args }) => {
    const read = !args.bool('unread');
    if (args.bool('all')) {
      ctx.db.run('UPDATE activity SET is_read = ? WHERE user_id = ?', read ? 1 : 0, actor.userId);
      emitMarked(ctx, actor.userId, 'all', read);
      return { unread_count: unreadActivity(ctx, actor.userId) };
    }
    const ids = args
      .list('ids')
      .map(Number)
      .filter((id) => Number.isInteger(id));
    if (ids.length === 0) fail('invalid_arguments', { needed: 'ids' });
    ctx.db.run(
      `UPDATE activity SET is_read = ? WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
      read ? 1 : 0,
      actor.userId,
      ...ids,
    );
    emitMarked(ctx, actor.userId, ids.map(String), read);
    return { unread_count: unreadActivity(ctx, actor.userId) };
  });
}
