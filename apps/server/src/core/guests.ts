import type { Ctx } from '../ctx.ts';
import { nowSeconds } from './ids.ts';
import { emitUserChange, getUser, type UserRow } from './users.ts';

/**
 * Guests see only what they were invited to: the conversations they belong
 * to and the people in them. Everything else is "not found" to them.
 *
 * - A multi-channel guest belongs to any number of channels an admin adds them to.
 * - A single-channel guest belongs to exactly one channel.
 * - Neither can browse or join channels, and neither can open a conversation
 *   with someone outside their channels.
 */

export function isGuestRow(row: Pick<UserRow, 'guest'> | undefined): boolean {
  return row !== undefined && row.guest !== '';
}

export function isGuest(ctx: Ctx, userId: string): boolean {
  return isGuestRow(getUser(ctx, userId));
}

/** Whether a guest account has passed its expiry date. */
export function guestExpired(row: Pick<UserRow, 'guest' | 'guest_expires'>): boolean {
  return row.guest !== '' && row.guest_expires > 0 && row.guest_expires <= nowSeconds();
}

/** Whether two people share a channel (public or private). */
export function shareChannel(ctx: Ctx, a: string, b: string): boolean {
  return (
    ctx.db.get(
      `SELECT 1 FROM members m1
       JOIN members m2 ON m2.conversation_id = m1.conversation_id
       JOIN conversations c ON c.id = m1.conversation_id
       WHERE m1.user_id = ? AND m2.user_id = ? AND c.kind IN ('public', 'private')
       LIMIT 1`,
      a,
      b,
    ) !== undefined
  );
}

/** Everyone a guest may see: themselves and the people in any conversation they belong to. */
export function visibleUserIds(ctx: Ctx, guestId: string): Set<string> {
  const rows = ctx.db.all<{ user_id: string }>(
    `SELECT DISTINCT m2.user_id FROM members m1
     JOIN members m2 ON m2.conversation_id = m1.conversation_id
     WHERE m1.user_id = ?`,
    guestId,
  );
  const out = new Set(rows.map((row) => row.user_id));
  out.add(guestId);
  return out;
}

/** Whether `viewerId` may see the person `targetId`. Members see everyone; guests see their channels' people. */
export function canSeeUser(ctx: Ctx, viewerId: string, targetId: string): boolean {
  if (viewerId === targetId) return true;
  const viewer = getUser(ctx, viewerId);
  if (!isGuestRow(viewer)) return true;
  return (
    ctx.db.get(
      `SELECT 1 FROM members m1 JOIN members m2 ON m2.conversation_id = m1.conversation_id
       WHERE m1.user_id = ? AND m2.user_id = ? LIMIT 1`,
      viewerId,
      targetId,
    ) !== undefined
  );
}

/** Deactivate guests whose access has expired. Returns their ids. */
export function expireGuests(ctx: Ctx): string[] {
  const rows = ctx.db.all<{ id: string }>(
    "SELECT id FROM users WHERE guest != '' AND guest_expires > 0 AND guest_expires <= ? AND deleted = 0",
    nowSeconds(),
  );
  for (const row of rows) {
    ctx.db.tx(() => {
      ctx.db.run('UPDATE users SET deleted = 1, updated = ? WHERE id = ?', nowSeconds(), row.id);
      ctx.db.run('DELETE FROM sessions WHERE user_id = ?', row.id);
      ctx.db.run('DELETE FROM tokens WHERE user_id = ?', row.id);
    });
    // Open tabs hear it and are closed.
    emitUserChange(ctx, row.id);
  }
  return rows.map((row) => row.id);
}

/**
 * Whether a guest's tab may receive a workspace-wide event: only events about
 * conversations they belong to (any event naming a channel, huddles included)
 * and about people they can see.
 */
export function eventVisibleToGuest(ctx: Ctx, guestId: string, event: { type: string; [key: string]: unknown }): boolean {
  if (event.type.startsWith('subteam_')) return false;
  const channel = event.channel;
  const item = event.item as { channel?: unknown } | undefined;
  const id = typeof channel === 'string' ? channel : (channel as { id?: unknown } | undefined)?.id ?? event.channel_id ?? item?.channel;
  if (typeof id === 'string' && /^[CDG][A-Z0-9]+$/.test(id)) {
    return ctx.db.get('SELECT 1 FROM members WHERE conversation_id = ? AND user_id = ?', id, guestId) !== undefined;
  }
  if (event.type === 'user_change' || event.type === 'team_join' || event.type === 'presence_change') {
    const user = event.user;
    const userId = typeof user === 'string' ? user : (user as { id?: unknown } | undefined)?.id;
    return typeof userId !== 'string' || canSeeUser(ctx, guestId, userId);
  }
  return true;
}

/** Ids of every guest, for filtering workspace-wide events. */
export function guestIds(ctx: Ctx): Set<string> {
  return new Set(ctx.db.all<{ id: string }>("SELECT id FROM users WHERE guest != ''").map((row) => row.id));
}
