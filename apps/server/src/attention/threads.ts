import type { Registry } from '../api/registry.ts';
import { ZERO_TS } from '../core/clock.ts';
import { canSee, getConv, resolveConv } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { getMessage, messageToApi, type MsgRow } from '../core/messages.ts';
import type { Ctx } from '../ctx.ts';
import { markActivityRead } from './activity.ts';
import { isPerson } from './common.ts';

/**
 * Following threads. People follow a thread when they start it, reply in it or
 * are mentioned in it, and can follow or unfollow by hand; an explicit unfollow
 * sticks. Each follower has a read position in the thread.
 */

interface SubRow {
  conversation_id: string;
  thread_ts: string;
  user_id: string;
  subscribed: number;
  last_read: string;
}

export function getSub(ctx: Ctx, channel: string, threadTs: string, userId: string): SubRow | undefined {
  return ctx.db.get<SubRow>(
    'SELECT * FROM thread_subs WHERE conversation_id = ? AND thread_ts = ? AND user_id = ?',
    channel,
    threadTs,
    userId,
  );
}

/** Follow automatically, unless the person unfollowed this thread before. Returns true when newly following. */
export function autoFollow(ctx: Ctx, channel: string, threadTs: string, userId: string): boolean {
  if (!isPerson(ctx, userId)) return false;
  const result = ctx.db.run(
    'INSERT OR IGNORE INTO thread_subs (conversation_id, thread_ts, user_id, subscribed) VALUES (?, ?, ?, 1)',
    channel,
    threadTs,
    userId,
  );
  return result.changes > 0;
}

export function followers(ctx: Ctx, channel: string, threadTs: string): string[] {
  return ctx.db
    .all<{ user_id: string }>(
      'SELECT user_id FROM thread_subs WHERE conversation_id = ? AND thread_ts = ? AND subscribed = 1',
      channel,
      threadTs,
    )
    .map((row) => row.user_id);
}

/** Move a person's read position in a thread forward (never back) and tell their other devices. */
export function markThreadRead(ctx: Ctx, channel: string, threadTs: string, userId: string, ts: string): void {
  ctx.db.run(
    `INSERT INTO thread_subs (conversation_id, thread_ts, user_id, subscribed, last_read) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT (conversation_id, thread_ts, user_id) DO UPDATE SET last_read = max(last_read, excluded.last_read)`,
    channel,
    threadTs,
    userId,
    ts,
  );
  const sub = getSub(ctx, channel, threadTs, userId)!;
  ctx.bus.emit({
    event: { type: 'thread_marked', channel, thread_ts: threadTs, ts: sub.last_read, unread_count: unreadThreads(ctx, userId).length },
    audience: { users: [userId] },
    clientOnly: true,
  });
  markActivityRead(ctx, userId, channel, ts, threadTs);
}

/** Followed threads with replies the person has not read. */
export function unreadThreads(ctx: Ctx, userId: string, limit = 500): { channel: string; thread_ts: string; latest_reply: string }[] {
  const rows = ctx.db.all<{ conversation_id: string; thread_ts: string; latest_reply: string }>(
    `SELECT s.conversation_id, s.thread_ts, m.latest_reply FROM thread_subs s
       JOIN messages m ON m.conversation_id = s.conversation_id AND m.ts = s.thread_ts
     WHERE s.user_id = ? AND s.subscribed = 1 AND m.latest_reply IS NOT NULL AND m.latest_reply > s.last_read
     ORDER BY m.latest_reply DESC LIMIT ?`,
    userId,
    limit,
  );
  const out = [];
  for (const row of rows) {
    const conv = getConv(ctx, row.conversation_id);
    if (!conv || !canSee(ctx, conv, userId)) continue;
    out.push({ channel: row.conversation_id, thread_ts: row.thread_ts, latest_reply: row.latest_reply });
  }
  return out;
}

/** Fields Slack adds to a thread parent for the person asking: whether they follow it and how far they have read. */
export function viewerThreadFields(ctx: Ctx, channel: string, threadTs: string, userId: string): { subscribed: boolean; last_read: string } {
  const sub = getSub(ctx, channel, threadTs, userId);
  return { subscribed: sub?.subscribed === 1, last_read: sub?.last_read ?? ZERO_TS };
}

/** A new reply: who follows the thread now, and who should hear about it. Returns the followers to tell. */
export function onReply(ctx: Ctx, channel: string, threadTs: string, replyTs: string, author: string | null, mentioned: string[]): string[] {
  const parent = getMessage(ctx, channel, threadTs);
  if (parent?.user_id) autoFollow(ctx, channel, threadTs, parent.user_id);
  for (const userId of mentioned) autoFollow(ctx, channel, threadTs, userId);
  if (author) {
    autoFollow(ctx, channel, threadTs, author);
    ctx.db.run(
      'UPDATE thread_subs SET last_read = max(last_read, ?) WHERE conversation_id = ? AND thread_ts = ? AND user_id = ?',
      replyTs,
      channel,
      threadTs,
      author,
    );
  }
  const conv = getConv(ctx, channel);
  const notify = followers(ctx, channel, threadTs).filter((userId) => userId !== author && conv !== undefined && canSee(ctx, conv, userId));
  for (const userId of notify) {
    ctx.bus.emit({
      event: { type: 'thread_unread', channel, thread_ts: threadTs, latest_reply: replyTs },
      audience: { users: [userId] },
      clientOnly: true,
    });
  }
  return notify;
}

function latestReplies(ctx: Ctx, channel: string, threadTs: string, count: number): MsgRow[] {
  return ctx.db
    .all<MsgRow>(
      'SELECT * FROM messages WHERE conversation_id = ? AND thread_ts = ? AND ts != ? ORDER BY ts DESC LIMIT ?',
      channel,
      threadTs,
      threadTs,
      count,
    )
    .reverse();
}

export function registerThreads(registry: Registry): void {
  /** Followed threads, most recently active first, each with its parent and newest replies. */
  registry.add('client.threads.list', { auth: 'session' }, ({ ctx, actor, args }) => {
    const limit = args.int('limit', 20, { min: 1, max: 50 });
    const offset = args.str('cursor') ? Number(args.str('cursor')) : 0;
    if (!Number.isInteger(offset) || offset < 0) fail('invalid_cursor');
    const rows = ctx.db.all<SubRow & { latest_reply: string; reply_count: number }>(
      `SELECT s.*, m.latest_reply, m.reply_count FROM thread_subs s
         JOIN messages m ON m.conversation_id = s.conversation_id AND m.ts = s.thread_ts
       WHERE s.user_id = ? AND s.subscribed = 1 AND m.reply_count > 0
       ORDER BY m.latest_reply DESC LIMIT ? OFFSET ?`,
      actor.userId,
      limit + 1,
      offset,
    );
    const threads = [];
    for (const row of rows.slice(0, limit)) {
      const conv = getConv(ctx, row.conversation_id);
      const parent = getMessage(ctx, row.conversation_id, row.thread_ts);
      if (!conv || !parent || !canSee(ctx, conv, actor.userId)) continue;
      threads.push({
        channel: row.conversation_id,
        thread_ts: row.thread_ts,
        root: { ...messageToApi(ctx, parent), subscribed: true, last_read: row.last_read },
        latest_replies: latestReplies(ctx, row.conversation_id, row.thread_ts, 3).map((reply) => messageToApi(ctx, reply)),
        unread: row.latest_reply > row.last_read,
        last_read: row.last_read,
      });
    }
    return {
      threads,
      unread: unreadThreads(ctx, actor.userId).map((item) => ({ channel: item.channel, thread_ts: item.thread_ts })),
      response_metadata: { next_cursor: rows.length > limit ? String(offset + limit) : '' },
    };
  });

  registry.add('client.threads.mark', { auth: 'session' }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const threadTs = args.reqTs('thread_ts', 'thread_not_found');
    if (!getMessage(ctx, conv.id, threadTs)) fail('thread_not_found');
    markThreadRead(ctx, conv.id, threadTs, actor.userId, args.reqTs('ts', 'invalid_timestamp'));
  });

  registry.add('client.threads.setSubscription', { auth: 'session' }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const threadTs = args.reqTs('thread_ts', 'thread_not_found');
    const parent = getMessage(ctx, conv.id, threadTs);
    if (!parent) fail('thread_not_found');
    const subscribed = args.bool('subscribed', true);
    // Following starts caught up; unfollowing is remembered so later replies do not re-follow.
    const caughtUp = parent.latest_reply ?? parent.ts;
    ctx.db.run(
      `INSERT INTO thread_subs (conversation_id, thread_ts, user_id, subscribed, last_read) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (conversation_id, thread_ts, user_id) DO UPDATE SET subscribed = excluded.subscribed,
         last_read = CASE WHEN excluded.subscribed = 1 THEN max(last_read, excluded.last_read) ELSE last_read END`,
      conv.id,
      threadTs,
      actor.userId,
      subscribed ? 1 : 0,
      caughtUp,
    );
    ctx.bus.emit({
      event: { type: 'thread_subscription_changed', channel: conv.id, thread_ts: threadTs, subscribed, unread_count: unreadThreads(ctx, actor.userId).length },
      audience: { users: [actor.userId] },
      clientOnly: true,
    });
    return { subscribed };
  });
}
