import { blocksToPlainText, extractBlockMentions, extractMentions } from '@app/shared';
import type { BusEvent } from '../core/bus.ts';
import { getMember, type ConvRow } from '../core/conversations.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import { createUser, getUser, userToApi, type UserRow } from '../core/users.ts';
import type { Ctx } from '../ctx.ts';

export type EventBody = BusEvent['event'];

const SYSTEM_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'pinned_item',
  'tombstone',
]);

/** A message a person wrote or an app posted, as opposed to an edit, a deletion or a join line. */
export function isNewMessage(event: EventBody): boolean {
  if (event.type !== 'message' || event.hidden || event.is_ephemeral) return false;
  const subtype = typeof event.subtype === 'string' ? event.subtype : undefined;
  return subtype === undefined || !SYSTEM_SUBTYPES.has(subtype);
}

export function isReply(event: EventBody): boolean {
  return typeof event.thread_ts === 'string' && event.thread_ts !== event.ts;
}

export interface MessageMentions {
  users: string[];
  broadcast: boolean;
}

export function mentionsIn(event: EventBody): MessageMentions {
  const text = extractMentions(String(event.text ?? ''));
  const blocks = event.blocks ? extractBlockMentions(event.blocks) : { users: [], broadcast: false };
  return { users: [...new Set([...text.users, ...blocks.users])], broadcast: text.broadcast || blocks.broadcast };
}

/** Everything a person could read in a message, for keyword matching. */
export function plainOf(event: EventBody): string {
  const parts = [String(event.text ?? '')];
  if (event.blocks) parts.push(blocksToPlainText(event.blocks));
  if (event.attachments) parts.push(blocksToPlainText(event.attachments));
  return parts.join(' ');
}

export function isPerson(ctx: Ctx, userId: string): boolean {
  const user = getUser(ctx, userId);
  return user !== undefined && user.is_bot === 0 && user.deleted === 0;
}

export function isWorkspaceAdmin(user: UserRow | undefined): boolean {
  return user !== undefined && user.is_bot === 0 && user.role !== 'member';
}

export function isChannelManager(ctx: Ctx, conversationId: string, userId: string): boolean {
  return ctx.db.get('SELECT 1 FROM channel_managers WHERE conversation_id = ? AND user_id = ?', conversationId, userId) !== undefined;
}

/** Workspace admins and the channel's managers. */
export function isPrivileged(ctx: Ctx, conv: ConvRow, userId: string): boolean {
  return isWorkspaceAdmin(getUser(ctx, userId)) || isChannelManager(ctx, conv.id, userId);
}

export function isMember(ctx: Ctx, conversationId: string, userId: string): boolean {
  return getMember(ctx, conversationId, userId) !== undefined;
}

/**
 * A built-in user that is not an app, created the first time it is needed.
 * The reminder bot posts reminders into people's direct messages.
 */
export function systemUser(ctx: Ctx, role: 'reminders' | 'email' | 'huddles'): UserRow {
  const known = ctx.db.get<{ user_id: string }>('SELECT user_id FROM system_users WHERE role = ?', role);
  const existing = known ? getUser(ctx, known.user_id) : undefined;
  if (existing) return existing;
  const user = ctx.db.tx(() => {
    const label = role === 'email' ? 'Email' : role === 'huddles' ? 'Huddles' : 'Reminders';
    const created = createUser(ctx, { realName: label, displayName: label, isBot: true, botId: newId('B'), handle: undefined });
    ctx.db.run('INSERT OR REPLACE INTO system_users (role, user_id) VALUES (?, ?)', role, created.id);
    ctx.db.run('UPDATE users SET updated = ? WHERE id = ?', nowSeconds(), created.id);
    return created;
  });
  // Open clients learn about the new user before its first message arrives.
  ctx.bus.emit({ event: { type: 'team_join', user: userToApi(ctx, user), event_ts: ctx.clock.eventTs() }, audience: { all: true } });
  return user;
}

/** Parse a JSON column, tolerating bad data. */
export function parseJson<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
