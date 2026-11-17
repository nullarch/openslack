import type { Attachment, Block } from '@app/shared';
import { readContent, postTarget } from '../api/methods/chat.ts';
import type { Registry } from '../api/registry.ts';
import { ApiError, fail } from '../core/errors.ts';
import { getConv, getMember, resolveConv } from '../core/conversations.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import { getMessage, MAX_TEXT_LENGTH, postMessage } from '../core/messages.ts';
import type { Ctx } from '../ctx.ts';
import { parseJson } from './common.ts';
import { checkPosting } from './posting.ts';
import type { Scheduler, TimedSource } from './scheduler.ts';

/** Slack's `chat.scheduleMessage` family: messages posted later, up to 120 days ahead. */

interface ScheduledRow {
  id: string;
  conversation_id: string;
  user_id: string;
  bot_id: string | null;
  app_id: string | null;
  post_at: number;
  text: string;
  blocks: string | null;
  attachments: string | null;
  metadata: string | null;
  thread_ts: string | null;
  reply_broadcast: number;
  state: 'pending' | 'sent' | 'failed';
  posted_ts: string | null;
  error: string | null;
  created: number;
}

const MAX_AHEAD_SECONDS = 120 * 86_400;
const BURST_WINDOW = 300;
const BURST_LIMIT = 30;

function toApi(row: ScheduledRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row.id,
    channel_id: row.conversation_id,
    post_at: row.post_at,
    date_created: row.created,
    text: row.text,
  };
  if (row.thread_ts) out.thread_ts = row.thread_ts;
  return out;
}

function changed(ctx: Ctx, userId: string, body: Record<string, unknown>): void {
  ctx.bus.emit({ event: { type: 'scheduled_messages_changed', ...body }, audience: { users: [userId] }, clientOnly: true });
}

function deliver(ctx: Ctx, row: ScheduledRow): void {
  try {
    const conv = getConv(ctx, row.conversation_id);
    if (!conv) throw new ApiError('channel_not_found');
    if (conv.is_archived === 1) throw new ApiError('is_archived');
    if (!getMember(ctx, conv.id, row.user_id) && !(row.bot_id && conv.kind === 'public')) throw new ApiError('not_in_channel');
    if (row.thread_ts && !getMessage(ctx, conv.id, row.thread_ts)) throw new ApiError('thread_not_found');
    const message = postMessage(ctx, {
      conv,
      userId: row.user_id,
      botId: row.bot_id,
      appId: row.app_id,
      text: row.text,
      blocks: parseJson<Block[]>(row.blocks) ?? null,
      attachments: parseJson<Attachment[]>(row.attachments) ?? null,
      metadata: parseJson(row.metadata),
      threadTs: row.thread_ts,
      broadcast: row.reply_broadcast === 1,
    });
    ctx.db.run("UPDATE scheduled_messages SET state = 'sent', posted_ts = ? WHERE id = ?", message.ts, row.id);
    changed(ctx, row.user_id, { sent: { id: row.id, channel: row.conversation_id, ts: message.ts } });
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'internal_error';
    if (!(error instanceof ApiError)) console.error('[scheduled] could not post', error);
    ctx.db.run("UPDATE scheduled_messages SET state = 'failed', error = ? WHERE id = ?", code, row.id);
    changed(ctx, row.user_id, { failed: { id: row.id, channel: row.conversation_id, error: code } });
  }
}

export function scheduledSource(ctx: Ctx): TimedSource {
  return {
    next: () => ctx.db.get<{ at: number | null }>("SELECT min(post_at) AS at FROM scheduled_messages WHERE state = 'pending'")?.at ?? null,
    run: (now) => {
      const due = ctx.db.all<ScheduledRow>("SELECT * FROM scheduled_messages WHERE state = 'pending' AND post_at <= ? ORDER BY post_at, created", now);
      for (const row of due) deliver(ctx, row);
    },
  };
}

export function pendingScheduledCount(ctx: Ctx, userId: string): number {
  return ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM scheduled_messages WHERE user_id = ? AND state = 'pending'", userId)?.n ?? 0;
}

export function registerScheduled(registry: Registry, scheduler: Scheduler): void {
  registry.add('chat.scheduleMessage', { scopes: ['chat:write'] }, ({ ctx, actor, args }) => {
    const conv = postTarget(ctx, actor, args);
    const postAtText = args.req('post_at', 'invalid_time');
    const postAt = Math.floor(Number(postAtText));
    if (!Number.isFinite(postAt) || postAt <= 0) fail('invalid_time');
    const now = nowSeconds();
    if (postAt <= now) fail('time_in_past');
    if (postAt > now + MAX_AHEAD_SECONDS) fail('time_too_far');
    const content = readContent(args);
    const text = content.text ?? '';
    if (!text && !content.blocks?.length && !content.attachments?.length) fail('no_text');
    if (text.length > MAX_TEXT_LENGTH) fail('msg_too_long');
    const threadTs = args.ts('thread_ts') ?? null;
    if (threadTs) {
      const parent = getMessage(ctx, conv.id, threadTs);
      if (!parent) fail('thread_not_found');
    }
    const broadcast = args.bool('reply_broadcast');
    checkPosting(ctx, conv, actor.userId, { threadTs, broadcast, text, blocks: content.blocks ?? undefined });
    const nearby =
      ctx.db.get<{ n: number }>(
        "SELECT count(*) AS n FROM scheduled_messages WHERE conversation_id = ? AND state = 'pending' AND post_at BETWEEN ? AND ?",
        conv.id,
        postAt - BURST_WINDOW,
        postAt + BURST_WINDOW,
      )?.n ?? 0;
    if (nearby >= BURST_LIMIT) fail('restricted_too_many');

    const id = newId('Q');
    ctx.db.run(
      `INSERT INTO scheduled_messages (id, conversation_id, user_id, bot_id, app_id, post_at, text, blocks, attachments, metadata,
         thread_ts, reply_broadcast, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      conv.id,
      actor.userId,
      actor.botId,
      actor.isBot ? actor.appId : null,
      postAt,
      text,
      content.blocks?.length ? JSON.stringify(content.blocks) : null,
      content.attachments?.length ? JSON.stringify(content.attachments) : null,
      args.has('metadata') ? JSON.stringify(args.json('metadata')) : null,
      threadTs,
      broadcast ? 1 : 0,
      now,
    );
    scheduler.arm();
    changed(ctx, actor.userId, { added: toApi(ctx.db.get<ScheduledRow>('SELECT * FROM scheduled_messages WHERE id = ?', id)!) });

    const message: Record<string, unknown> = { type: 'delayed_message', text, user: actor.userId, team: ctx.requireTeam().id };
    if (actor.botId) message.bot_id = actor.botId;
    if (actor.isBot && actor.appId) message.app_id = actor.appId;
    if (content.blocks?.length) message.blocks = content.blocks;
    return { channel: conv.id, scheduled_message_id: id, post_at: postAt, message };
  });

  registry.add('chat.scheduledMessages.list', { scopes: ['chat:write'] }, ({ ctx, actor, args }) => {
    const limit = args.int('limit', 100, { min: 1, max: 1000 });
    const latest = args.has('latest') ? Number(args.req('latest')) : Number.MAX_SAFE_INTEGER;
    const oldest = args.has('oldest') ? Number(args.req('oldest')) : 0;
    const channel = args.has('channel') ? resolveConv(ctx, actor, args.req('channel')).id : null;
    const offset = args.str('cursor') ? Number(Buffer.from(args.req('cursor'), 'base64').toString('utf8')) : 0;
    if (!Number.isInteger(offset) || offset < 0) fail('invalid_cursor');
    const rows = ctx.db.all<ScheduledRow>(
      `SELECT * FROM scheduled_messages WHERE user_id = ? AND state = 'pending' AND post_at <= ? AND post_at >= ?
         ${channel ? 'AND conversation_id = ?' : ''}
       ORDER BY post_at, created LIMIT ? OFFSET ?`,
      actor.userId,
      latest,
      oldest,
      ...(channel ? [channel] : []),
      limit + 1,
      offset,
    );
    const more = rows.length > limit;
    return {
      scheduled_messages: rows.slice(0, limit).map(toApi),
      response_metadata: { next_cursor: more ? Buffer.from(String(offset + limit)).toString('base64') : '' },
    };
  });

  registry.add('chat.deleteScheduledMessage', { scopes: ['chat:write'] }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const id = args.req('scheduled_message_id', 'invalid_scheduled_message_id');
    const row = ctx.db.get<ScheduledRow>(
      "SELECT * FROM scheduled_messages WHERE id = ? AND conversation_id = ? AND user_id = ? AND state = 'pending'",
      id,
      conv.id,
      actor.userId,
    );
    if (!row) fail('invalid_scheduled_message_id');
    ctx.db.run('DELETE FROM scheduled_messages WHERE id = ?', id);
    scheduler.arm();
    changed(ctx, actor.userId, { removed: { id, channel: conv.id } });
  });
}
