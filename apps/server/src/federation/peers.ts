import type { Ctx } from '../ctx.ts';
import { getMessage } from '../core/messages.ts';
import { createUser, getUser, userToApi, type UserRow } from '../core/users.ts';
import type { MessageRef, PersonRef } from './wire.ts';

/** Another server this one is connected to. */
export interface PeerRow {
  id: string;
  url: string;
  team_id: string;
  name: string;
  public_key: string;
  status: 'active' | 'disconnected';
  created: number;
  updated: number;
}

export interface SharedRow {
  conversation_id: string;
  peer_id: string;
  remote_id: string;
  host: number;
  status: 'active' | 'disconnected';
  created: number;
}

/** What a server says about one of its people, sent along with anything that names them. */
export interface WireProfile {
  team: string;
  id: string;
  name: string;
  real_name: string;
  display_name: string;
  title: string;
  tz: string;
  color: string;
  status_text: string;
  status_emoji: string;
  deleted: boolean;
  is_bot: boolean;
}

export function peerById(ctx: Ctx, id: string): PeerRow | undefined {
  return ctx.db.get<PeerRow>('SELECT * FROM peers WHERE id = ?', id);
}

export function peerByUrl(ctx: Ctx, url: string): PeerRow | undefined {
  return ctx.db.get<PeerRow>('SELECT * FROM peers WHERE url = ?', url);
}

/** The peer a conversation is shared with, while the sharing lasts. */
export function sharedWith(ctx: Ctx, conversationId: string): (SharedRow & { peer: PeerRow }) | undefined {
  const row = ctx.db.get<SharedRow>("SELECT * FROM shared_conversations WHERE conversation_id = ? AND status = 'active'", conversationId);
  const peer = row ? peerById(ctx, row.peer_id) : undefined;
  return row && peer && peer.status === 'active' ? { ...row, peer } : undefined;
}

/** The local conversation a peer calls `remoteId`. */
export function sharedByRemote(ctx: Ctx, peer: PeerRow, remoteId: string): SharedRow | undefined {
  return ctx.db.get<SharedRow>("SELECT * FROM shared_conversations WHERE peer_id = ? AND remote_id = ? AND status = 'active'", peer.id, remoteId);
}

/** The peer a person comes from, or undefined for this server's own people. */
export function homePeer(ctx: Ctx, user: Pick<UserRow, 'home'>): PeerRow | undefined {
  return user.home ? peerById(ctx, user.home) : undefined;
}

export function wireProfile(ctx: Ctx, user: UserRow): WireProfile {
  return {
    team: ctx.requireTeam().id,
    id: user.id,
    name: user.name,
    real_name: user.real_name,
    display_name: user.display_name,
    title: user.title,
    tz: user.tz,
    color: user.color,
    status_text: user.status_text,
    status_emoji: user.status_emoji,
    deleted: user.deleted === 1,
    is_bot: user.is_bot === 1,
  };
}

/** How a local person is named on the wire. */
export function personRef(ctx: Ctx, userId: string): PersonRef | null {
  const user = getUser(ctx, userId);
  if (!user) return null;
  if (!user.home) return { team: ctx.requireTeam().id, id: user.id };
  const peer = peerById(ctx, user.home);
  const remote = ctx.db.get<{ remote_id: string }>('SELECT remote_id FROM remote_users WHERE user_id = ?', user.id);
  return peer && remote ? { team: peer.team_id, id: remote.remote_id } : null;
}

/**
 * The local user for a person named by `peer`: one of this server's own (only
 * when the peer names them back), or the stand-in for one of the peer's people,
 * made (or brought up to date) from the profile the peer sent.
 */
export function localPerson(ctx: Ctx, peer: PeerRow, ref: PersonRef, profile?: WireProfile): string | null {
  if (ref.team === ctx.requireTeam().id) {
    const user = getUser(ctx, ref.id);
    return user && !user.home ? user.id : null;
  }
  if (ref.team !== peer.team_id) return null;
  const known = ctx.db.get<{ user_id: string }>('SELECT user_id FROM remote_users WHERE peer_id = ? AND remote_id = ?', peer.id, ref.id);
  if (known) {
    if (profile) updateStandIn(ctx, known.user_id, profile);
    return known.user_id;
  }
  if (!profile || profile.id !== ref.id) return null;
  return ctx.db.tx(() => {
    const again = ctx.db.get<{ user_id: string }>('SELECT user_id FROM remote_users WHERE peer_id = ? AND remote_id = ?', peer.id, ref.id);
    if (again) return again.user_id;
    const user = createUser(ctx, {
      realName: profile.real_name.slice(0, 120) || profile.name.slice(0, 80),
      displayName: profile.display_name.slice(0, 80),
      title: profile.title.slice(0, 120),
      tz: profile.tz,
      // Their handle, made unique here; they never sign in here.
      handle: undefined,
      email: null,
      passwordHash: null,
    });
    ctx.db.run('UPDATE users SET home = ?, color = ?, status_text = ?, status_emoji = ?, is_bot = ? WHERE id = ?', peer.id, safeColor(profile.color), profile.status_text.slice(0, 100), profile.status_emoji.slice(0, 100), profile.is_bot ? 1 : 0, user.id);
    ctx.db.run('INSERT INTO remote_users (user_id, peer_id, remote_id) VALUES (?, ?, ?)', user.id, peer.id, ref.id);
    // Open clients learn of people from these events; apps are not told of someone who is not a member here.
    ctx.bus.emit({ event: { type: 'user_change', user: userToApi(ctx, getUser(ctx, user.id)!) }, audience: { all: true }, clientOnly: true });
    return user.id;
  });
}

function safeColor(value: string): string {
  return /^[0-9a-f]{6}$/i.test(value) ? value : '';
}

/** Bring a stand-in's name, title and status up to date. Returns whether anything changed. */
export function updateStandIn(ctx: Ctx, userId: string, profile: WireProfile): boolean {
  const user = getUser(ctx, userId);
  if (!user || !user.home) return false;
  const next = {
    real_name: profile.real_name.slice(0, 120) || profile.name.slice(0, 80),
    display_name: profile.display_name.slice(0, 80),
    title: profile.title.slice(0, 120),
    tz: profile.tz || 'UTC',
    status_text: profile.status_text.slice(0, 100),
    status_emoji: profile.status_emoji.slice(0, 100),
    deleted: profile.deleted ? 1 : 0,
  };
  const same = (Object.keys(next) as (keyof typeof next)[]).every((key) => user[key] === next[key]);
  if (same) return false;
  ctx.db.run(
    'UPDATE users SET real_name = ?, display_name = ?, title = ?, tz = ?, status_text = ?, status_emoji = ?, deleted = ?, updated = ? WHERE id = ?',
    next.real_name,
    next.display_name,
    next.title,
    next.tz,
    next.status_text,
    next.status_emoji,
    next.deleted,
    Math.floor(Date.now() / 1000),
    userId,
  );
  return true;
}

/** How a message in a shared conversation is named on the wire. */
export function messageRef(ctx: Ctx, conversationId: string, ts: string): MessageRef {
  const remote = ctx.db.get<{ peer_id: string; remote_ts: string }>('SELECT peer_id, remote_ts FROM remote_messages WHERE conversation_id = ? AND ts = ?', conversationId, ts);
  const peer = remote ? peerById(ctx, remote.peer_id) : undefined;
  return peer && remote ? { team: peer.team_id, ts: remote.remote_ts } : { team: ctx.requireTeam().id, ts };
}

/** The local ts of a message `peer` names, if this server has it. */
export function localTs(ctx: Ctx, conversationId: string, peer: PeerRow, ref: MessageRef | null | undefined): string | null {
  if (!ref || typeof ref.ts !== 'string') return null;
  if (ref.team === ctx.requireTeam().id) return getMessage(ctx, conversationId, ref.ts) && !fromPeer(ctx, conversationId, ref.ts) ? ref.ts : null;
  if (ref.team !== peer.team_id) return null;
  return ctx.db.get<{ ts: string }>('SELECT ts FROM remote_messages WHERE conversation_id = ? AND peer_id = ? AND remote_ts = ?', conversationId, peer.id, ref.ts)?.ts ?? null;
}

/** Whether a local message arrived from a peer (as opposed to being written here). */
export function fromPeer(ctx: Ctx, conversationId: string, ts: string): boolean {
  return ctx.db.get('SELECT 1 FROM remote_messages WHERE conversation_id = ? AND ts = ?', conversationId, ts) !== undefined;
}
