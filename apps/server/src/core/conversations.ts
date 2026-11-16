import { channelNameError, normalizeChannelName, type Conversation } from '@app/shared';
import type { Actor, Ctx } from '../ctx.ts';
import { ZERO_TS } from './clock.ts';
import { fail } from './errors.ts';
import { newId, nowSeconds } from './ids.ts';
import { postSystemMessage } from './messages.ts';
import { getUser, isAdmin } from './users.ts';

export type ConvKind = 'public' | 'private' | 'im' | 'mpim';

export interface ConvRow {
  id: string;
  kind: ConvKind;
  name: string | null;
  topic: string;
  topic_creator: string;
  topic_set: number;
  purpose: string;
  purpose_creator: string;
  purpose_set: number;
  creator: string;
  is_archived: number;
  is_general: number;
  im_key: string | null;
  last_ts: string;
  created: number;
  updated: number;
}

export interface MemberRow {
  conversation_id: string;
  user_id: string;
  joined: number;
  last_read: string;
  is_open: number;
  is_starred: number;
  is_muted: number;
}

const MAX_GROUP_DM = 9;

// ── Lookup ──────────────────────────────────────────────────────────────────

export function getConv(ctx: Ctx, id: string): ConvRow | undefined {
  return ctx.db.get<ConvRow>('SELECT * FROM conversations WHERE id = ?', id);
}

export function getMember(ctx: Ctx, conversationId: string, userId: string): MemberRow | undefined {
  return ctx.db.get<MemberRow>(
    'SELECT * FROM members WHERE conversation_id = ? AND user_id = ?',
    conversationId,
    userId,
  );
}

export function memberIds(ctx: Ctx, conversationId: string): string[] {
  return ctx.db
    .all<{ user_id: string }>('SELECT user_id FROM members WHERE conversation_id = ? ORDER BY joined, user_id', conversationId)
    .map((row) => row.user_id);
}

/** A conversation is visible to everyone when public, otherwise only to its members. */
export function canSee(ctx: Ctx, conv: ConvRow, userId: string): boolean {
  return conv.kind === 'public' || getMember(ctx, conv.id, userId) !== undefined;
}

/**
 * Resolve a `channel` argument: a conversation id, `#name`, a bare name, or a
 * user id (which means the direct message with that person). Anything the
 * caller may not see is reported as not found, never as forbidden.
 */
export function resolveConv(ctx: Ctx, actor: Actor, value: string | undefined): ConvRow {
  if (!value) fail('channel_not_found');
  let conv: ConvRow | undefined;
  if (/^[UW][A-Z0-9]{6,}$/.test(value)) {
    conv = openDirect(ctx, actor.userId, [value]).conv;
  } else if (/^[CDG][A-Z0-9]{6,}$/.test(value)) {
    conv = getConv(ctx, value);
  } else {
    conv = ctx.db.get<ConvRow>(
      "SELECT * FROM conversations WHERE name = ? AND kind IN ('public', 'private')",
      normalizeChannelName(value),
    );
  }
  if (!conv || !canSee(ctx, conv, actor.userId)) fail('channel_not_found');
  return conv;
}

// ── Read state ──────────────────────────────────────────────────────────────

export interface ReadState {
  unread: number;
  mentions: number;
}

export function readState(ctx: Ctx, conv: ConvRow, member: MemberRow): ReadState {
  let unread = 0;
  if (conv.last_ts > member.last_read) {
    unread =
      ctx.db.get<{ n: number }>(
        `SELECT count(*) AS n FROM messages
         WHERE conversation_id = ? AND ts > ?
           AND (thread_ts IS NULL OR thread_ts = ts OR is_broadcast = 1)
           AND (user_id IS NULL OR user_id != ?)
           AND (subtype IS NULL OR subtype NOT IN ('channel_join', 'channel_leave'))`,
        conv.id,
        member.last_read,
        member.user_id,
      )?.n ?? 0;
  }
  if (conv.kind === 'im' || conv.kind === 'mpim') return { unread, mentions: unread };
  const mentions =
    ctx.db.get<{ n: number }>(
      `SELECT count(*) AS n FROM mentions
       WHERE conversation_id = ? AND ts > ? AND user_id IN (?, '*') AND author != ?`,
      conv.id,
      member.last_read,
      member.user_id,
      member.user_id,
    )?.n ?? 0;
  return { unread, mentions };
}

/** Move a member's read position (forwards or backwards) and tell their other devices. */
export function markRead(ctx: Ctx, conv: ConvRow, userId: string, ts: string): void {
  const changed = ctx.db.run(
    'UPDATE members SET last_read = ? WHERE conversation_id = ? AND user_id = ?',
    ts,
    conv.id,
    userId,
  );
  if (changed.changes === 0) return;
  const member = getMember(ctx, conv.id, userId)!;
  const state = readState(ctx, conv, member);
  ctx.bus.emit({
    event: {
      type: 'channel_marked',
      channel: conv.id,
      ts,
      unread_count: state.unread,
      unread_count_display: state.unread,
      mention_count: state.mentions,
      event_ts: ctx.clock.eventTs(),
    },
    audience: { users: [userId] },
    clientOnly: true,
  });
}

// ── API shape ───────────────────────────────────────────────────────────────

export interface ConvView {
  /** Include `num_members`. */
  numMembers?: boolean;
  /** Include the viewer's read position and unread counts. */
  readState?: boolean;
}

function groupDmName(ctx: Ctx, ids: string[]): string {
  const handles = ids.map((id) => getUser(ctx, id)?.name ?? id.toLowerCase());
  return `mpdm-${handles.join('--')}-1`;
}

export function convToApi(ctx: Ctx, conv: ConvRow, viewerId: string | null, view: ConvView = {}): Conversation {
  const team = ctx.requireTeam();
  const member = viewerId ? getMember(ctx, conv.id, viewerId) : undefined;
  const base: Conversation = {
    id: conv.id,
    is_channel: conv.kind === 'public' || conv.kind === 'private',
    is_group: false,
    is_im: conv.kind === 'im',
    is_mpim: conv.kind === 'mpim',
    is_private: conv.kind !== 'public',
    is_archived: conv.is_archived === 1,
    is_general: conv.is_general === 1,
    is_shared: false,
    is_ext_shared: false,
    is_org_shared: false,
    created: conv.created,
    updated: conv.updated * 1000,
    context_team_id: team.id,
  };

  if (conv.kind === 'im') {
    const ids = (conv.im_key ?? '').split(',');
    const other = ids.find((id) => id !== viewerId) ?? ids[0]!;
    base.user = other;
    base.is_user_deleted = getUser(ctx, other)?.deleted === 1;
    base.is_open = member ? member.is_open === 1 : false;
  } else {
    const ids = conv.kind === 'mpim' ? (conv.im_key ?? '').split(',') : [];
    const name = conv.kind === 'mpim' ? groupDmName(ctx, ids) : (conv.name ?? '');
    base.name = name;
    base.name_normalized = name;
    base.creator = conv.creator;
    base.is_member = member !== undefined;
    base.topic = { value: conv.topic, creator: conv.topic_creator, last_set: conv.topic_set };
    base.purpose = { value: conv.purpose, creator: conv.purpose_creator, last_set: conv.purpose_set };
    base.previous_names = [];
    if (conv.kind === 'mpim') {
      base.members = ids;
      base.is_open = member ? member.is_open === 1 : false;
    }
  }

  if (view.numMembers) {
    base.num_members =
      ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM members WHERE conversation_id = ?', conv.id)?.n ?? 0;
  }
  if (view.readState && member) {
    const state = readState(ctx, conv, member);
    base.last_read = member.last_read;
    base.unread_count = state.unread;
    base.unread_count_display = state.unread;
    base.mention_count = state.mentions;
    base.latest_ts = conv.last_ts;
    base.is_starred = member.is_starred === 1;
    base.is_muted = member.is_muted === 1;
  }
  return base;
}

/** The `channel_type` letter used in membership events. */
export function channelTypeLetter(conv: ConvRow): 'C' | 'G' | 'D' {
  return conv.kind === 'public' ? 'C' : conv.kind === 'im' ? 'D' : 'G';
}

/** The `channel_type` word used in message events. */
export function channelTypeWord(conv: ConvRow): 'channel' | 'group' | 'im' | 'mpim' {
  return conv.kind === 'public' ? 'channel' : conv.kind === 'private' ? 'group' : conv.kind;
}

// ── Channels ────────────────────────────────────────────────────────────────

export interface NewChannel {
  name: string;
  isPrivate: boolean;
  creator: string;
  isGeneral?: boolean;
  purpose?: string;
}

export function createChannel(ctx: Ctx, input: NewChannel): ConvRow {
  const name = normalizeChannelName(input.name);
  const error = channelNameError(name);
  if (error) fail(error);
  if (ctx.db.get("SELECT 1 FROM conversations WHERE name = ? AND kind IN ('public', 'private')", name)) fail('name_taken');
  const id = newId('C');
  const now = nowSeconds();
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO conversations (id, kind, name, creator, is_general, purpose, purpose_creator, purpose_set, created, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.isPrivate ? 'private' : 'public',
      name,
      input.creator,
      input.isGeneral ? 1 : 0,
      input.purpose ?? '',
      input.purpose ? input.creator : '',
      input.purpose ? now : 0,
      now,
      now,
    );
    ctx.db.run('INSERT INTO members (conversation_id, user_id, joined) VALUES (?, ?, ?)', id, input.creator, now);
  });
  const conv = getConv(ctx, id)!;
  if (!input.isPrivate) {
    ctx.bus.emit({
      event: {
        type: 'channel_created',
        channel: { id, name, is_channel: true, created: now, creator: input.creator, name_normalized: name },
        event_ts: ctx.clock.eventTs(),
      },
      audience: { all: true },
    });
  }
  ctx.bus.emit({
    event: { type: 'channel_joined', channel: convToApi(ctx, conv, input.creator, { readState: true }) },
    audience: { users: [input.creator] },
    clientOnly: true,
  });
  postSystemMessage(ctx, conv, input.creator, 'channel_join', `<@${input.creator}> has joined the channel`);
  return getConv(ctx, id)!;
}

export interface JoinOptions {
  inviter?: string;
  /** Skip the "has joined" message (imports, default channels at sign-up). */
  silent?: boolean;
}

/** Add a member. Returns false when they already belonged. */
export function addMember(ctx: Ctx, conv: ConvRow, userId: string, options: JoinOptions = {}): boolean {
  if (getMember(ctx, conv.id, userId)) return false;
  // New members start with nothing unread.
  const lastRead = ctx.clock.eventTs();
  ctx.db.run(
    'INSERT INTO members (conversation_id, user_id, joined, last_read) VALUES (?, ?, ?, ?)',
    conv.id,
    userId,
    nowSeconds(),
    lastRead,
  );
  const event: { type: string; [key: string]: unknown } = {
    type: 'member_joined_channel',
    user: userId,
    channel: conv.id,
    channel_type: channelTypeLetter(conv),
    team: ctx.requireTeam().id,
    event_ts: ctx.clock.eventTs(),
  };
  if (options.inviter) event.inviter = options.inviter;
  ctx.bus.emit({ event, audience: { conversation: conv.id } });
  ctx.bus.emit({
    event: { type: 'channel_joined', channel: convToApi(ctx, conv, userId, { readState: true }) },
    audience: { users: [userId] },
    clientOnly: true,
  });
  if (!options.silent && (conv.kind === 'public' || conv.kind === 'private')) {
    postSystemMessage(ctx, conv, userId, 'channel_join', `<@${userId}> has joined the channel`, {
      inviter: options.inviter,
    });
  }
  return true;
}

export function removeMember(ctx: Ctx, conv: ConvRow, userId: string): boolean {
  if (!getMember(ctx, conv.id, userId)) return false;
  if (conv.kind === 'public' || conv.kind === 'private') {
    postSystemMessage(ctx, conv, userId, 'channel_leave', `<@${userId}> has left the channel`);
  }
  ctx.db.run('DELETE FROM members WHERE conversation_id = ? AND user_id = ?', conv.id, userId);
  ctx.bus.emit({
    event: {
      type: 'member_left_channel',
      user: userId,
      channel: conv.id,
      channel_type: channelTypeLetter(conv),
      team: ctx.requireTeam().id,
      event_ts: ctx.clock.eventTs(),
    },
    audience: { conversation: conv.id },
  });
  ctx.bus.emit({
    event: { type: 'channel_left', channel: conv.id },
    audience: { users: [userId] },
    clientOnly: true,
  });
  return true;
}

/** Channel settings may be changed by workspace admins and by the channel's creator. */
export function canManage(conv: ConvRow, actor: Actor): boolean {
  return isAdmin(actor) || conv.creator === actor.userId;
}

export function touchConv(ctx: Ctx, id: string): void {
  ctx.db.run('UPDATE conversations SET updated = ? WHERE id = ?', nowSeconds(), id);
}

// ── Direct messages ─────────────────────────────────────────────────────────

export interface OpenedDirect {
  conv: ConvRow;
  created: boolean;
  alreadyOpen: boolean;
}

/** Find or create the direct conversation between `actorId` and `others`. */
export function openDirect(ctx: Ctx, actorId: string, others: string[]): OpenedDirect {
  const ids = [...new Set([actorId, ...others])].sort();
  if (ids.length > MAX_GROUP_DM) fail('too_many_users');
  for (const id of ids) {
    const user = getUser(ctx, id);
    if (!user) fail('user_not_found');
    if (user.deleted === 1) fail('user_disabled');
  }
  const key = ids.join(',');
  const existing = ctx.db.get<ConvRow>('SELECT * FROM conversations WHERE im_key = ?', key);
  if (existing) {
    const member = getMember(ctx, existing.id, actorId);
    const alreadyOpen = member?.is_open === 1;
    if (!alreadyOpen) setDirectOpen(ctx, existing, actorId, true);
    return { conv: existing, created: false, alreadyOpen };
  }
  const id = newId('D');
  const now = nowSeconds();
  ctx.db.tx(() => {
    ctx.db.run(
      'INSERT INTO conversations (id, kind, creator, im_key, created, updated) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      ids.length > 2 ? 'mpim' : 'im',
      actorId,
      key,
      now,
      now,
    );
    for (const userId of ids) {
      // Only the opener sees it in their sidebar until someone writes.
      ctx.db.run(
        'INSERT INTO members (conversation_id, user_id, joined, last_read, is_open) VALUES (?, ?, ?, ?, ?)',
        id,
        userId,
        now,
        ZERO_TS,
        userId === actorId ? 1 : 0,
      );
    }
  });
  const conv = getConv(ctx, id)!;
  ctx.bus.emit({
    event: { type: 'channel_joined', channel: convToApi(ctx, conv, actorId, { readState: true }) },
    audience: { users: [actorId] },
    clientOnly: true,
  });
  return { conv, created: true, alreadyOpen: false };
}

/** Show or hide a direct conversation in one member's sidebar. */
export function setDirectOpen(ctx: Ctx, conv: ConvRow, userId: string, open: boolean): void {
  const result = ctx.db.run(
    'UPDATE members SET is_open = ? WHERE conversation_id = ? AND user_id = ? AND is_open != ?',
    open ? 1 : 0,
    conv.id,
    userId,
    open ? 1 : 0,
  );
  if (result.changes === 0) return;
  ctx.bus.emit({
    event: open
      ? { type: 'channel_joined', channel: convToApi(ctx, conv, userId, { readState: true }) }
      : { type: 'channel_left', channel: conv.id },
    audience: { users: [userId] },
    clientOnly: true,
  });
}

/** Re-open a direct conversation for every member who closed it (a new message arrived). */
export function reopenDirectForAll(ctx: Ctx, conv: ConvRow): void {
  const closed = ctx.db.all<{ user_id: string }>(
    'SELECT user_id FROM members WHERE conversation_id = ? AND is_open = 0',
    conv.id,
  );
  for (const row of closed) setDirectOpen(ctx, conv, row.user_id, true);
}
