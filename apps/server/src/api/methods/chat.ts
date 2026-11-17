import type { Attachment, Block, Message } from '@app/shared';
import type { Actor, Ctx } from '../../ctx.ts';
import { channelTypeWord, getMember, resolveConv, type ConvRow } from '../../core/conversations.ts';
import { fail } from '../../core/errors.ts';
import {
  addReaction,
  canPost,
  deleteMessage,
  messageToApi,
  normalizeReactionName,
  postMessage,
  removeReaction,
  requireMessage,
  updateMessage,
  type MsgRow,
} from '../../core/messages.ts';
import { getUser, isAdmin } from '../../core/users.ts';
import type { Args, Registry } from '../registry.ts';
import { checkDelete, checkEdit } from '../../attention/policy.ts';

const WRITE = ['chat:write'];
const MAX_BLOCKS = 50;
const MAX_ATTACHMENTS = 100;

export interface Content {
  text: string | undefined;
  blocks: Block[] | null | undefined;
  attachments: Attachment[] | null | undefined;
}

/** Read `text`, `blocks`, `attachments` and `markdown_text` from call arguments. */
export function readContent(args: Args): Content {
  let text = args.str('text');
  let blocks = args.json<Block[]>('blocks');
  const attachments = args.json<Attachment[]>('attachments');
  if (blocks !== undefined && (!Array.isArray(blocks) || blocks.length > MAX_BLOCKS)) fail('invalid_blocks');
  if (blocks?.some((block) => !block || typeof block !== 'object' || typeof block.type !== 'string')) {
    fail('invalid_blocks_format');
  }
  if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS)) {
    fail('invalid_attachments');
  }
  // Standard Markdown input is carried as a `markdown` block and doubles as the fallback text.
  const markdown = args.str('markdown_text');
  if (markdown !== undefined && markdown !== '') {
    if (blocks !== undefined || text) fail('markdown_text_conflict');
    blocks = [{ type: 'markdown', text: markdown }];
    text = markdown;
  }
  return { text, blocks, attachments };
}

export function requirePostable(ctx: Ctx, conv: ConvRow, actor: Actor): void {
  if (conv.is_archived === 1) fail('is_archived');
  if (!canPost(ctx, conv, actor.userId, actor.isBot)) fail('not_in_channel');
}

/** Resolve a `channel` argument for posting; a user id means that person's direct message. */
export function postTarget(ctx: Ctx, actor: Actor, args: Args): ConvRow {
  const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
  requirePostable(ctx, conv, actor);
  return conv;
}

export function registerChat(registry: Registry): void {
  registry.add('chat.postMessage', { scopes: WRITE }, ({ ctx, actor, args }) => {
    const conv = postTarget(ctx, actor, args);
    const content = readContent(args);
    const custom = actor.isBot || actor.kind !== 'session';
    const row = postMessage(ctx, {
      conv,
      userId: actor.userId,
      botId: actor.botId,
      appId: actor.isBot ? actor.appId : null,
      text: content.text,
      blocks: content.blocks,
      attachments: content.attachments,
      threadTs: args.ts('thread_ts'),
      broadcast: args.bool('reply_broadcast'),
      clientMsgId: args.str('client_msg_id') ?? null,
      metadata: args.json('metadata'),
      username: custom ? (args.str('username') ?? null) : null,
      iconEmoji: custom ? (args.str('icon_emoji') ?? null) : null,
      iconUrl: custom ? (args.str('icon_url') ?? null) : null,
    });
    return { channel: conv.id, ts: row.ts, message: messageToApi(ctx, row) };
  });

  registry.add('chat.meMessage', { scopes: WRITE }, ({ ctx, actor, args }) => {
    const conv = postTarget(ctx, actor, args);
    const row = postMessage(ctx, { conv, userId: actor.userId, text: args.req('text', 'no_text'), subtype: 'me_message' });
    return { channel: conv.id, ts: row.ts };
  });

  registry.add('chat.update', { scopes: WRITE }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const row = requireMessage(ctx, conv.id, args.reqTs('ts'));
    if (row.user_id !== actor.userId) fail('cant_update_message');
    if (conv.is_archived === 1) fail('is_archived');
    checkEdit(ctx, actor, row);
    const content = readContent(args);
    if (content.text === undefined && content.blocks === undefined && content.attachments === undefined) fail('no_text');
    const updated = updateMessage(
      ctx,
      conv,
      row,
      {
        text: content.text ?? (content.blocks !== undefined ? '' : undefined),
        blocks: content.blocks,
        attachments: content.attachments,
        metadata: args.has('metadata') ? args.json('metadata') : undefined,
        fileIds: args.has('file_ids') ? args.list('file_ids') : undefined,
      },
      { markEditedBy: actor.userId },
    );
    return { channel: conv.id, ts: updated.ts, text: updated.text, message: messageToApi(ctx, updated) };
  });

  registry.add('chat.delete', { scopes: WRITE }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const row = requireMessage(ctx, conv.id, args.reqTs('ts'));
    if (row.user_id !== actor.userId && !isAdmin(actor)) fail('cant_delete_message');
    checkDelete(ctx, actor, row);
    deleteMessage(ctx, conv, row);
    return { channel: conv.id, ts: row.ts };
  });

  registry.add('chat.getPermalink', {}, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const row = requireMessage(ctx, conv.id, args.reqTs('message_ts'));
    return { channel: conv.id, permalink: permalink(ctx, conv, row) };
  });

  /** A message shown to one member only. It is delivered live and never stored. */
  registry.add('chat.postEphemeral', { scopes: WRITE }, ({ ctx, actor, args }) => {
    const conv = postTarget(ctx, actor, args);
    const target = args.req('user', 'user_not_in_channel');
    if (!getUser(ctx, target) || !getMember(ctx, conv.id, target)) fail('user_not_in_channel');
    const content = readContent(args);
    if (!content.text && !content.blocks?.length && !content.attachments?.length) fail('no_text');
    const ts = ctx.clock.eventTs();
    const message: Message = {
      type: 'message',
      ts,
      text: content.text ?? '',
      user: actor.userId,
      is_ephemeral: true,
      channel: conv.id,
      channel_type: channelTypeWord(conv),
      event_ts: ts,
    };
    if (actor.botId) message.bot_id = actor.botId;
    if (actor.isBot && actor.appId) message.app_id = actor.appId;
    if (content.blocks?.length) message.blocks = content.blocks;
    if (content.attachments?.length) message.attachments = content.attachments;
    const threadTs = args.ts('thread_ts');
    if (threadTs) message.thread_ts = threadTs;
    ctx.bus.emit({ event: { ...message }, audience: { users: [target] }, clientOnly: true });
    return { message_ts: ts };
  });

  // ── Reactions ─────────────────────────────────────────────────────────────

  registry.add('reactions.add', { scopes: ['reactions:write'] }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const row = requireMessage(ctx, conv.id, args.reqTs('timestamp'));
    if (conv.is_archived === 1) fail('is_archived');
    addReaction(ctx, conv, row, normalizeReactionName(args.req('name', 'invalid_name')), actor.userId);
  });

  registry.add('reactions.remove', { scopes: ['reactions:write'] }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const row = requireMessage(ctx, conv.id, args.reqTs('timestamp'));
    removeReaction(ctx, conv, row, normalizeReactionName(args.req('name', 'invalid_name')), actor.userId);
  });

  registry.add('reactions.get', { scopes: ['reactions:read'] }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const row = requireMessage(ctx, conv.id, args.reqTs('timestamp'));
    return { type: 'message', channel: conv.id, message: { ...messageToApi(ctx, row), permalink: permalink(ctx, conv, row) } };
  });

  // ── Pins ──────────────────────────────────────────────────────────────────

  registry.add('pins.add', { scopes: ['pins:write'] }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const row = requireMessage(ctx, conv.id, args.reqTs('timestamp'));
    const result = ctx.db.run(
      'INSERT OR IGNORE INTO pins (conversation_id, ts, user_id, created) VALUES (?, ?, ?, ?)',
      conv.id,
      row.ts,
      actor.userId,
      Math.floor(Date.now() / 1000),
    );
    if (result.changes === 0) fail('already_pinned');
    emitPin(ctx, 'pin_added', conv, row, actor.userId);
  });

  registry.add('pins.remove', { scopes: ['pins:write'] }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const row = requireMessage(ctx, conv.id, args.reqTs('timestamp'));
    const result = ctx.db.run('DELETE FROM pins WHERE conversation_id = ? AND ts = ?', conv.id, row.ts);
    if (result.changes === 0) fail('no_pin');
    emitPin(ctx, 'pin_removed', conv, row, actor.userId);
  });

  registry.add('pins.list', { scopes: ['pins:read'] }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const pins = ctx.db.all<{ ts: string; user_id: string; created: number }>(
      'SELECT ts, user_id, created FROM pins WHERE conversation_id = ? ORDER BY created DESC',
      conv.id,
    );
    const items = [];
    for (const pin of pins) {
      const row = ctx.db.get<MsgRow>('SELECT * FROM messages WHERE conversation_id = ? AND ts = ?', conv.id, pin.ts);
      if (!row) continue;
      items.push({
        type: 'message',
        created: pin.created,
        created_by: pin.user_id,
        channel: conv.id,
        message: { ...messageToApi(ctx, row), permalink: permalink(ctx, conv, row) },
      });
    }
    return { items };
  });
}

export function permalink(ctx: Ctx, conv: ConvRow, row: MsgRow): string {
  const base = `${ctx.config.publicUrl}/archives/${conv.id}/p${row.ts.replace('.', '')}`;
  return row.thread_ts && row.thread_ts !== row.ts ? `${base}?thread_ts=${row.thread_ts}&cid=${conv.id}` : base;
}

function emitPin(ctx: Ctx, type: 'pin_added' | 'pin_removed', conv: ConvRow, row: MsgRow, userId: string): void {
  const count = ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM pins WHERE conversation_id = ?', conv.id)?.n ?? 0;
  const message = messageToApi(ctx, requireMessage(ctx, conv.id, row.ts));
  ctx.bus.emit({
    event: {
      type,
      user: userId,
      channel_id: conv.id,
      item: { type: 'message', created: Math.floor(Date.now() / 1000), created_by: userId, channel: conv.id, message },
      pin_count: count,
      has_pins: count > 0,
      event_ts: ctx.clock.eventTs(),
    },
    audience: { conversation: conv.id },
  });
}
