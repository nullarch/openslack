import type { Registry } from '../api/registry.ts';
import { canSee, getConv, getMember, resolveConv } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { nowSeconds } from '../core/ids.ts';
import { MAX_TEXT_LENGTH, messageToApi, type MsgRow } from '../core/messages.ts';
import type { Ctx } from '../ctx.ts';

/**
 * Drafts kept on the server so they follow a person between devices, and the
 * "Sent" list of their own recent messages.
 */

interface DraftRow {
  user_id: string;
  conversation_id: string;
  thread_ts: string;
  text: string;
  updated: number;
}

const MAX_DRAFTS = 500;

function toApi(row: DraftRow): Record<string, unknown> {
  const out: Record<string, unknown> = { channel: row.conversation_id, text: row.text, updated: row.updated };
  if (row.thread_ts) out.thread_ts = row.thread_ts;
  return out;
}

export function draftsFor(ctx: Ctx, userId: string): Record<string, unknown>[] {
  const out = [];
  for (const row of ctx.db.all<DraftRow>('SELECT * FROM drafts WHERE user_id = ? ORDER BY updated DESC', userId)) {
    const conv = getConv(ctx, row.conversation_id);
    if (!conv || !canSee(ctx, conv, userId)) continue;
    out.push(toApi(row));
  }
  return out;
}

export function registerDrafts(registry: Registry): void {
  registry.add('client.drafts.list', { auth: 'session' }, ({ ctx, actor }) => ({ drafts: draftsFor(ctx, actor.userId) }));

  /** Save or (with empty text) discard the draft for a conversation or a thread. */
  registry.add('client.drafts.set', { auth: 'session' }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const threadTs = args.ts('thread_ts') ?? '';
    const text = args.str('text') ?? '';
    if (text.length > MAX_TEXT_LENGTH) fail('msg_too_long');
    const now = nowSeconds();
    if (text.trim() === '') {
      ctx.db.run('DELETE FROM drafts WHERE user_id = ? AND conversation_id = ? AND thread_ts = ?', actor.userId, conv.id, threadTs);
    } else {
      ctx.db.run(
        `INSERT INTO drafts (user_id, conversation_id, thread_ts, text, updated) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, conversation_id, thread_ts) DO UPDATE SET text = excluded.text, updated = excluded.updated`,
        actor.userId,
        conv.id,
        threadTs,
        text,
        now,
      );
      ctx.db.run(
        `DELETE FROM drafts WHERE user_id = ? AND updated < (
           SELECT updated FROM drafts WHERE user_id = ? ORDER BY updated DESC LIMIT 1 OFFSET ?)`,
        actor.userId,
        actor.userId,
        MAX_DRAFTS,
      );
    }
    const event: Record<string, unknown> = { type: 'draft_changed', channel: conv.id, text: text.trim() === '' ? '' : text, updated: now };
    if (threadTs) event.thread_ts = threadTs;
    if (args.str('client_id')) event.client_id = args.str('client_id');
    ctx.bus.emit({ event: event as { type: string }, audience: { users: [actor.userId] }, clientOnly: true });
  });

  /** The person's own recent messages, newest first, in conversations they still belong to. */
  registry.add('client.messages.sent', { auth: 'session' }, ({ ctx, actor, args }) => {
    const limit = args.int('limit', 30, { min: 1, max: 100 });
    const before = args.ts('cursor') ?? '9999999999.999999';
    const rows = ctx.db.all<MsgRow>(
      `SELECT * FROM messages WHERE user_id = ? AND ts < ?
         AND (subtype IS NULL OR subtype IN ('thread_broadcast', 'me_message'))
       ORDER BY ts DESC LIMIT ?`,
      actor.userId,
      before,
      limit * 2,
    );
    const messages = [];
    let cursor = '';
    for (const row of rows) {
      cursor = row.ts;
      if (!getMember(ctx, row.conversation_id, actor.userId)) continue;
      messages.push({ channel: row.conversation_id, message: messageToApi(ctx, row) });
      if (messages.length === limit) break;
    }
    return { messages, response_metadata: { next_cursor: rows.length === limit * 2 || messages.length === limit ? cursor : '' } };
  });
}
