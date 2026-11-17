import {
  blocksToPlainText,
  extractBlockMentions,
  extractMentions,
  type Attachment,
  type Block,
  type BotProfile,
  type Message,
  type Reaction,
} from '@app/shared';
import type { Ctx } from '../ctx.ts';
import { ZERO_TS } from './clock.ts';
import { channelTypeWord, getConv, getMember, reopenDirectForAll, type ConvRow } from './conversations.ts';
import { fail } from './errors.ts';
import { filesToApi, shareFiles } from './files.ts';
import { avatarUrl, getUser } from './users.ts';

export interface MsgRow {
  id: number;
  conversation_id: string;
  ts: string;
  user_id: string | null;
  bot_id: string | null;
  app_id: string | null;
  subtype: string | null;
  text: string;
  plain: string;
  blocks: string | null;
  attachments: string | null;
  files: string | null;
  metadata: string | null;
  username: string | null;
  icon_url: string | null;
  icon_emoji: string | null;
  thread_ts: string | null;
  reply_count: number;
  reply_users: string | null;
  latest_reply: string | null;
  is_broadcast: number;
  edited_ts: string | null;
  edited_user: string | null;
  client_msg_id: string | null;
  streaming: number;
}

export const MAX_TEXT_LENGTH = 40_000;

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export function getMessage(ctx: Ctx, conversationId: string, ts: string): MsgRow | undefined {
  return ctx.db.get<MsgRow>('SELECT * FROM messages WHERE conversation_id = ? AND ts = ?', conversationId, ts);
}

export function requireMessage(ctx: Ctx, conversationId: string, ts: string): MsgRow {
  return getMessage(ctx, conversationId, ts) ?? fail('message_not_found');
}

// ── API shape ───────────────────────────────────────────────────────────────

export function reactionsOf(ctx: Ctx, conversationId: string, ts: string): Reaction[] {
  const rows = ctx.db.all<{ name: string; user_id: string }>(
    'SELECT name, user_id FROM reactions WHERE conversation_id = ? AND ts = ? ORDER BY created, user_id',
    conversationId,
    ts,
  );
  const byName = new Map<string, Reaction>();
  for (const row of rows) {
    let reaction = byName.get(row.name);
    if (!reaction) {
      reaction = { name: row.name, users: [], count: 0 };
      byName.set(row.name, reaction);
    }
    reaction.users.push(row.user_id);
    reaction.count += 1;
  }
  return [...byName.values()];
}

function botProfile(ctx: Ctx, row: MsgRow): BotProfile | undefined {
  if (!row.bot_id || !row.user_id) return undefined;
  const bot = getUser(ctx, row.user_id);
  if (!bot) return undefined;
  return {
    id: row.bot_id,
    app_id: row.app_id ?? '',
    name: bot.real_name || bot.name,
    icons: { image_36: avatarUrl(ctx, bot, 36), image_48: avatarUrl(ctx, bot, 48), image_72: avatarUrl(ctx, bot, 72) },
    deleted: bot.deleted === 1,
    updated: bot.updated,
    team_id: ctx.requireTeam().id,
  };
}

export function messageToApi(ctx: Ctx, row: MsgRow): Message {
  const message: Message = { type: 'message', ts: row.ts, text: row.text };
  if (row.subtype) message.subtype = row.subtype;
  if (row.user_id) message.user = row.user_id;
  message.team = ctx.requireTeam().id;
  if (row.bot_id) {
    message.bot_id = row.bot_id;
    if (row.app_id) message.app_id = row.app_id;
    const profile = botProfile(ctx, row);
    if (profile) message.bot_profile = profile;
  }
  if (row.username) message.username = row.username;
  if (row.icon_emoji || row.icon_url) {
    message.icons = {};
    if (row.icon_emoji) message.icons.emoji = row.icon_emoji;
    if (row.icon_url) message.icons.image_64 = row.icon_url;
  }
  const blocks = parseJson<Block[]>(row.blocks);
  if (blocks) message.blocks = blocks;
  const attachments = parseJson<Attachment[]>(row.attachments);
  if (attachments) message.attachments = attachments;
  const fileIds = parseJson<string[]>(row.files);
  if (fileIds?.length) {
    message.files = filesToApi(ctx, fileIds);
    message.upload = true;
  }
  const metadata = parseJson<Message['metadata']>(row.metadata);
  if (metadata) message.metadata = metadata;
  if (row.client_msg_id) message.client_msg_id = row.client_msg_id;

  if (row.thread_ts) {
    message.thread_ts = row.thread_ts;
    if (row.thread_ts === row.ts) {
      const users = parseJson<string[]>(row.reply_users) ?? [];
      message.reply_count = row.reply_count;
      message.reply_users_count = users.length;
      message.reply_users = users.slice(0, 5);
      if (row.latest_reply) message.latest_reply = row.latest_reply;
      message.is_locked = false;
      message.subscribed = false;
    } else {
      const parent = getMessage(ctx, row.conversation_id, row.thread_ts);
      if (parent?.user_id) message.parent_user_id = parent.user_id;
    }
  }
  if (row.edited_ts && row.edited_user) message.edited = { user: row.edited_user, ts: row.edited_ts };
  const reactions = reactionsOf(ctx, row.conversation_id, row.ts);
  if (reactions.length) message.reactions = reactions;
  if (ctx.db.get('SELECT 1 FROM pins WHERE conversation_id = ? AND ts = ?', row.conversation_id, row.ts)) {
    message.pinned_to = [row.conversation_id];
  }
  if (row.streaming === 1) message.streaming = true;
  return message;
}

/** The message as it appears in events: the API shape plus where it happened. */
export function messageEvent(ctx: Ctx, conv: ConvRow, row: MsgRow): Message & { type: 'message' } {
  return {
    ...messageToApi(ctx, row),
    channel: conv.id,
    channel_type: channelTypeWord(conv),
    event_ts: row.ts,
  };
}

// ── Writing ─────────────────────────────────────────────────────────────────

export interface NewMessage {
  conv: ConvRow;
  /** The author's user id (for bots, the bot's user id). Null for webhook posts without an identity. */
  userId: string | null;
  botId?: string | null;
  appId?: string | null;
  text?: string;
  blocks?: Block[] | null;
  attachments?: Attachment[] | null;
  fileIds?: string[];
  threadTs?: string | null;
  /** Also show a thread reply in the channel. */
  broadcast?: boolean;
  subtype?: string | null;
  clientMsgId?: string | null;
  metadata?: unknown;
  username?: string | null;
  iconUrl?: string | null;
  iconEmoji?: string | null;
  streaming?: boolean;
  /** Use this timestamp instead of issuing one (imports). */
  ts?: string;
  /** Do not emit events (imports). */
  silent?: boolean;
  /** Accept a message with no content (imports of messages whose only content could not be carried over). */
  allowEmpty?: boolean;
  /** Extra fields for the emitted event only. */
  eventExtra?: Record<string, unknown>;
}

function plainText(text: string, blocks: unknown, attachments: unknown): string {
  const parts = [text];
  if (blocks) parts.push(blocksToPlainText(blocks));
  if (attachments) parts.push(blocksToPlainText(attachments));
  return parts.filter(Boolean).join(' ');
}

function writeMentions(ctx: Ctx, conversationId: string, ts: string, author: string, text: string, blocks: unknown): void {
  ctx.db.run('DELETE FROM mentions WHERE conversation_id = ? AND ts = ?', conversationId, ts);
  const fromText = extractMentions(text);
  const fromBlocks = blocks ? extractBlockMentions(blocks) : { users: [], broadcast: false, groups: [] };
  const users = new Set([...fromText.users, ...fromBlocks.users]);
  // A user group mention reaches each member, as a mention of them.
  for (const group of new Set([...fromText.groups, ...fromBlocks.groups])) {
    const members = ctx.db.all<{ user_id: string }>(
      `SELECT m.user_id FROM usergroup_members m JOIN usergroups g ON g.id = m.usergroup_id
       WHERE g.id = ? AND g.date_delete = 0`,
      group,
    );
    for (const member of members) users.add(member.user_id);
  }
  for (const userId of users) {
    ctx.db.run(
      'INSERT OR IGNORE INTO mentions (conversation_id, ts, user_id, author) VALUES (?, ?, ?, ?)',
      conversationId,
      ts,
      userId,
      author,
    );
  }
  if (fromText.broadcast || fromBlocks.broadcast) {
    ctx.db.run(
      "INSERT OR IGNORE INTO mentions (conversation_id, ts, user_id, author) VALUES (?, ?, '*', ?)",
      conversationId,
      ts,
      author,
    );
  }
}

/** Recompute a thread parent's reply summary from its replies. */
function refreshThread(ctx: Ctx, conversationId: string, threadTs: string): void {
  const replies = ctx.db.all<{ ts: string; user_id: string | null }>(
    'SELECT ts, user_id FROM messages WHERE conversation_id = ? AND thread_ts = ? AND ts != ? ORDER BY ts',
    conversationId,
    threadTs,
    threadTs,
  );
  const users: string[] = [];
  for (const reply of replies) {
    if (reply.user_id && !users.includes(reply.user_id)) users.push(reply.user_id);
  }
  ctx.db.run(
    `UPDATE messages SET thread_ts = ?, reply_count = ?, reply_users = ?, latest_reply = ?
     WHERE conversation_id = ? AND ts = ?`,
    replies.length > 0 ? threadTs : null,
    replies.length,
    replies.length > 0 ? JSON.stringify(users) : null,
    replies.at(-1)?.ts ?? null,
    conversationId,
    threadTs,
  );
}

function refreshLastTs(ctx: Ctx, conversationId: string): void {
  const row = ctx.db.get<{ ts: string | null }>(
    `SELECT max(ts) AS ts FROM messages
     WHERE conversation_id = ? AND (thread_ts IS NULL OR thread_ts = ts OR is_broadcast = 1)`,
    conversationId,
  );
  ctx.db.run('UPDATE conversations SET last_ts = ? WHERE id = ?', row?.ts ?? ZERO_TS, conversationId);
}

/**
 * Checks run before a message is stored (posting permissions). Each throws an
 * API error to refuse. Imports and system lines skip them.
 */
export const messageGuards: ((ctx: Ctx, input: NewMessage) => void)[] = [];

/**
 * Checks run before a person's message is stored or changed (not for imports).
 * A check throws to refuse it. Workspace policies register here.
 */
export const contentChecks: ((ctx: Ctx, userId: string, text: string, blocks: unknown) => void)[] = [];

function runContentChecks(ctx: Ctx, userId: string | null, text: string, blocks: unknown): void {
  if (!userId) return;
  for (const check of contentChecks) check(ctx, userId, text, blocks);
}

export function postMessage(ctx: Ctx, input: NewMessage): MsgRow {
  const { conv } = input;
  if (!input.silent) for (const guard of messageGuards) guard(ctx, input);
  const text = input.text ?? '';
  // System lines (joins, topic changes) are written by the server, not composed by the person.
  const system = input.subtype?.startsWith('channel_') || input.subtype === 'pinned_item';
  if (!input.silent && !system) runContentChecks(ctx, input.userId, text, input.blocks);
  if (text.length > MAX_TEXT_LENGTH) fail('msg_too_long');
  const hasContent = text.length > 0 || input.blocks?.length || input.attachments?.length || input.fileIds?.length;
  if (!hasContent && !input.streaming && !input.allowEmpty) fail('no_text');

  let threadTs: string | null = null;
  if (input.threadTs) {
    const target = getMessage(ctx, conv.id, input.threadTs);
    if (!target) fail('thread_not_found');
    // Replying to a reply lands in the same thread.
    threadTs = target.thread_ts ?? target.ts;
  }
  const broadcast = threadTs !== null && input.broadcast === true;
  const subtype = broadcast ? 'thread_broadcast' : (input.subtype ?? null);
  const topLevel = threadTs === null || broadcast;

  const ts = input.ts ?? ctx.clock.next(conv.id);
  if (input.ts) ctx.clock.observe(conv.id, input.ts);

  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO messages (conversation_id, ts, user_id, bot_id, app_id, subtype, text, plain, blocks, attachments, files,
         metadata, username, icon_url, icon_emoji, thread_ts, is_broadcast, client_msg_id, streaming)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      conv.id,
      ts,
      input.userId,
      input.botId ?? null,
      input.appId ?? null,
      subtype,
      text,
      plainText(text, input.blocks, input.attachments),
      input.blocks?.length ? JSON.stringify(input.blocks) : null,
      input.attachments?.length ? JSON.stringify(input.attachments) : null,
      input.fileIds?.length ? JSON.stringify(input.fileIds) : null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.username ?? null,
      input.iconUrl ?? null,
      input.iconEmoji ?? null,
      threadTs,
      broadcast ? 1 : 0,
      input.clientMsgId ?? null,
      input.streaming ? 1 : 0,
    );
    if (input.userId) writeMentions(ctx, conv.id, ts, input.userId, text, input.blocks);
    if (input.fileIds?.length) shareFiles(ctx, input.fileIds, conv.id, ts);
    if (threadTs) refreshThread(ctx, conv.id, threadTs);
    if (topLevel && ts > conv.last_ts) {
      ctx.db.run('UPDATE conversations SET last_ts = ? WHERE id = ?', ts, conv.id);
    }
    // Writing in a conversation means the author has read it.
    if (topLevel && input.userId && !input.silent) {
      ctx.db.run(
        'UPDATE members SET last_read = ? WHERE conversation_id = ? AND user_id = ? AND last_read < ?',
        ts,
        conv.id,
        input.userId,
        ts,
      );
    }
  });

  const row = requireMessage(ctx, conv.id, ts);
  if (input.silent) return row;

  if (conv.kind === 'im' || conv.kind === 'mpim') reopenDirectForAll(ctx, conv);
  ctx.bus.emit({
    event: { ...messageEvent(ctx, conv, row), ...input.eventExtra },
    audience: { conversation: conv.id },
  });
  if (threadTs) emitThreadSummary(ctx, conv, threadTs);
  return row;
}

/** Tell clients that a thread parent's reply summary changed. */
function emitThreadSummary(ctx: Ctx, conv: ConvRow, threadTs: string): void {
  const parent = getMessage(ctx, conv.id, threadTs);
  if (!parent) return;
  ctx.bus.emit({
    event: {
      type: 'message',
      subtype: 'message_replied',
      hidden: true,
      channel: conv.id,
      message: messageToApi(ctx, parent),
      event_ts: ctx.clock.eventTs(),
    },
    audience: { conversation: conv.id },
    clientOnly: true,
  });
}

export function postSystemMessage(
  ctx: Ctx,
  conv: ConvRow,
  userId: string,
  subtype: string,
  text: string,
  eventExtra: Record<string, unknown> = {},
): MsgRow {
  const fresh = getConv(ctx, conv.id) ?? conv;
  const extra = Object.fromEntries(Object.entries(eventExtra).filter(([, value]) => value !== undefined));
  return postMessage(ctx, { conv: fresh, userId, text, subtype, eventExtra: extra });
}

export interface MessagePatch {
  text?: string;
  blocks?: Block[] | null;
  attachments?: Attachment[] | null;
  fileIds?: string[];
  metadata?: unknown;
  streaming?: boolean;
}

export interface UpdateOptions {
  /** Record who edited and when (user edits and `chat.update`); false for streaming appends. */
  markEditedBy?: string | null;
  /** Tell connected clients only, not apps (intermediate updates of a streamed message). */
  clientOnly?: boolean;
}

export function updateMessage(
  ctx: Ctx,
  conv: ConvRow,
  row: MsgRow,
  patch: MessagePatch,
  options: UpdateOptions = {},
): MsgRow {
  const previous = messageToApi(ctx, row);
  const text = patch.text ?? row.text;
  if (text.length > MAX_TEXT_LENGTH) fail('msg_too_long');
  const blocks = patch.blocks === undefined ? parseJson<Block[]>(row.blocks) : patch.blocks;
  const attachments = patch.attachments === undefined ? parseJson<Attachment[]>(row.attachments) : patch.attachments;
  if (options.markEditedBy) runContentChecks(ctx, options.markEditedBy, text, blocks);
  const eventTs = ctx.clock.eventTs();

  ctx.db.tx(() => {
    ctx.db.run(
      `UPDATE messages SET text = ?, plain = ?, blocks = ?, attachments = ?, files = ?, metadata = ?, streaming = ?,
         edited_ts = ?, edited_user = ?
       WHERE id = ?`,
      text,
      plainText(text, blocks, attachments),
      blocks?.length ? JSON.stringify(blocks) : null,
      attachments?.length ? JSON.stringify(attachments) : null,
      patch.fileIds === undefined ? row.files : patch.fileIds.length ? JSON.stringify(patch.fileIds) : null,
      patch.metadata === undefined ? row.metadata : patch.metadata ? JSON.stringify(patch.metadata) : null,
      patch.streaming === undefined ? row.streaming : patch.streaming ? 1 : 0,
      options.markEditedBy ? eventTs : row.edited_ts,
      options.markEditedBy ? options.markEditedBy : row.edited_user,
      row.id,
    );
    if (row.user_id) writeMentions(ctx, conv.id, row.ts, row.user_id, text, blocks);
  });

  const updated = requireMessage(ctx, conv.id, row.ts);
  ctx.bus.emit({
    event: {
      type: 'message',
      subtype: 'message_changed',
      hidden: true,
      channel: conv.id,
      channel_type: channelTypeWord(conv),
      ts: eventTs,
      event_ts: eventTs,
      message: messageToApi(ctx, updated),
      previous_message: previous,
    },
    audience: { conversation: conv.id },
    ...(options.clientOnly ? { clientOnly: true } : {}),
  });
  return updated;
}

export function deleteMessage(ctx: Ctx, conv: ConvRow, row: MsgRow): void {
  const previous = messageToApi(ctx, row);
  const eventTs = ctx.clock.eventTs();
  const isParentWithReplies = row.thread_ts === row.ts && row.reply_count > 0;

  if (isParentWithReplies) {
    // Keep a placeholder so the thread stays reachable.
    ctx.db.tx(() => {
      ctx.db.run(
        `UPDATE messages SET subtype = 'tombstone', text = 'This message was deleted.', plain = '', blocks = NULL,
           attachments = NULL, files = NULL, metadata = NULL WHERE id = ?`,
        row.id,
      );
      ctx.db.run('DELETE FROM reactions WHERE conversation_id = ? AND ts = ?', conv.id, row.ts);
      ctx.db.run('DELETE FROM pins WHERE conversation_id = ? AND ts = ?', conv.id, row.ts);
      ctx.db.run('DELETE FROM mentions WHERE conversation_id = ? AND ts = ?', conv.id, row.ts);
      ctx.db.run('DELETE FROM file_shares WHERE conversation_id = ? AND ts = ?', conv.id, row.ts);
    });
    ctx.bus.emit({
      event: {
        type: 'message',
        subtype: 'message_changed',
        hidden: true,
        channel: conv.id,
        channel_type: channelTypeWord(conv),
        ts: eventTs,
        event_ts: eventTs,
        message: messageToApi(ctx, requireMessage(ctx, conv.id, row.ts)),
        previous_message: previous,
      },
      audience: { conversation: conv.id },
    });
    return;
  }

  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM messages WHERE id = ?', row.id);
    ctx.db.run('DELETE FROM reactions WHERE conversation_id = ? AND ts = ?', conv.id, row.ts);
    ctx.db.run('DELETE FROM pins WHERE conversation_id = ? AND ts = ?', conv.id, row.ts);
    ctx.db.run('DELETE FROM mentions WHERE conversation_id = ? AND ts = ?', conv.id, row.ts);
    ctx.db.run('DELETE FROM file_shares WHERE conversation_id = ? AND ts = ?', conv.id, row.ts);
    if (row.thread_ts && row.thread_ts !== row.ts) refreshThread(ctx, conv.id, row.thread_ts);
    refreshLastTs(ctx, conv.id);
  });

  ctx.bus.emit({
    event: {
      type: 'message',
      subtype: 'message_deleted',
      hidden: true,
      channel: conv.id,
      channel_type: channelTypeWord(conv),
      ts: eventTs,
      deleted_ts: row.ts,
      event_ts: eventTs,
      previous_message: previous,
    },
    audience: { conversation: conv.id },
  });
  if (row.thread_ts && row.thread_ts !== row.ts) emitThreadSummary(ctx, conv, row.thread_ts);
}

// ── Reading ─────────────────────────────────────────────────────────────────

export interface PageOptions {
  latest?: string;
  oldest?: string;
  inclusive?: boolean;
  limit: number;
}

export interface Page {
  rows: MsgRow[];
  hasMore: boolean;
}

/**
 * Channel history, newest first. Thread replies are excluded unless they were
 * also sent to the channel. With only `oldest` set, the page holds the messages
 * immediately after it, which is what incremental sync needs.
 */
export function history(ctx: Ctx, conv: ConvRow, options: PageOptions): Page {
  const lower = options.oldest ?? ZERO_TS;
  const upper = options.latest ?? '9999999999.999999';
  const lowerOp = options.inclusive ? '>=' : '>';
  const upperOp = options.inclusive ? '<=' : '<';
  const forward = options.oldest !== undefined && options.latest === undefined;
  const rows = ctx.db.all<MsgRow>(
    `SELECT * FROM messages
     WHERE conversation_id = ? AND ts ${lowerOp} ? AND ts ${upperOp} ?
       AND (thread_ts IS NULL OR thread_ts = ts OR is_broadcast = 1)
     ORDER BY ts ${forward ? 'ASC' : 'DESC'} LIMIT ?`,
    conv.id,
    lower,
    upper,
    options.limit + 1,
  );
  const hasMore = rows.length > options.limit;
  const page = rows.slice(0, options.limit);
  if (forward) page.reverse();
  return { rows: page, hasMore };
}

/** A thread: the parent followed by its replies, oldest first. */
export function replies(ctx: Ctx, conv: ConvRow, threadTs: string, options: PageOptions): Page {
  const parent = getMessage(ctx, conv.id, threadTs);
  if (!parent) fail('thread_not_found');
  const lower = options.oldest ?? ZERO_TS;
  const upper = options.latest ?? '9999999999.999999';
  const lowerOp = options.inclusive ? '>=' : '>';
  const upperOp = options.inclusive ? '<=' : '<';
  const rows = ctx.db.all<MsgRow>(
    `SELECT * FROM messages
     WHERE conversation_id = ? AND thread_ts = ? AND ts != ? AND ts ${lowerOp} ? AND ts ${upperOp} ?
     ORDER BY ts ASC LIMIT ?`,
    conv.id,
    threadTs,
    threadTs,
    lower,
    upper,
    options.limit + 1,
  );
  const hasMore = rows.length > options.limit;
  return { rows: [parent, ...rows.slice(0, options.limit)], hasMore };
}

// ── Reactions and pins ──────────────────────────────────────────────────────

export function normalizeReactionName(input: string): string {
  const name = input.trim().replace(/^:|:$/g, '');
  if (!name || name.length > 100 || !/^[\p{L}\p{N}_+'-]+(::skin-tone-[2-6])?$/u.test(name)) fail('invalid_name');
  return name;
}

let lastReactionStamp = 0;

/**
 * Reactions are listed in the order they were added. Wall-clock milliseconds
 * alone tie when two arrive together, so the stamp never repeats or goes back.
 */
function reactionStamp(): number {
  lastReactionStamp = Math.max(Date.now(), lastReactionStamp + 1);
  return lastReactionStamp;
}

export function addReaction(ctx: Ctx, conv: ConvRow, row: MsgRow, name: string, userId: string): void {
  const result = ctx.db.run(
    'INSERT OR IGNORE INTO reactions (conversation_id, ts, name, user_id, created) VALUES (?, ?, ?, ?, ?)',
    conv.id,
    row.ts,
    name,
    userId,
    reactionStamp(),
  );
  if (result.changes === 0) fail('already_reacted');
  ctx.bus.emit({
    event: {
      type: 'reaction_added',
      user: userId,
      reaction: name,
      item: { type: 'message', channel: conv.id, ts: row.ts },
      item_user: row.user_id ?? '',
      event_ts: ctx.clock.eventTs(),
    },
    audience: { conversation: conv.id },
  });
}

export function removeReaction(ctx: Ctx, conv: ConvRow, row: MsgRow, name: string, userId: string): void {
  const result = ctx.db.run(
    'DELETE FROM reactions WHERE conversation_id = ? AND ts = ? AND name = ? AND user_id = ?',
    conv.id,
    row.ts,
    name,
    userId,
  );
  if (result.changes === 0) fail('no_reaction');
  ctx.bus.emit({
    event: {
      type: 'reaction_removed',
      user: userId,
      reaction: name,
      item: { type: 'message', channel: conv.id, ts: row.ts },
      item_user: row.user_id ?? '',
      event_ts: ctx.clock.eventTs(),
    },
    audience: { conversation: conv.id },
  });
}

/** Whether `userId` may post in `conv`: members always; bots also in any public channel. */
export function canPost(ctx: Ctx, conv: ConvRow, userId: string, isBot: boolean): boolean {
  if (getMember(ctx, conv.id, userId)) return true;
  return isBot && conv.kind === 'public';
}
