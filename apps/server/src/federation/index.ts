import { createHash, timingSafeEqual } from 'node:crypto';
import type { Attachment, Block } from '@app/shared';
import type { Kernel } from '../app.ts';
import { readBody, sendJson } from '../api/http.ts';
import { Args, type MethodDef } from '../api/registry.ts';
import type { Actor, Ctx } from '../ctx.ts';
import { addMember, conversationExtensions, convToApi, createChannel, getConv, getMember, memberIds, openDirect, removeMember, type ConvRow } from '../core/conversations.ts';
import { ApiError, fail } from '../core/errors.ts';
import { newId, newSecret, nowSeconds } from '../core/ids.ts';
import { addReaction, deleteMessage, getMessage, messageToApi, postMessage, removeReaction, updateMessage } from '../core/messages.ts';
import { getUser, userToApi, type UserRow } from '../core/users.ts';
import { allowPrivateTargets, get as httpGet, OutboundError, post } from '../platform/net.ts';
import { serverKey, signedHeaders, validPublicKey, verifySigned } from './keys.ts';
import {
  fromPeer,
  localPerson,
  localTs,
  messageRef,
  peerById,
  peerByUrl,
  personRef,
  sharedByRemote,
  sharedWith,
  updateStandIn,
  wireProfile,
  type PeerRow,
  type WireProfile,
} from './peers.ts';
import { peopleIn, rewriteBlocks, rewriteText, type MessageRef, type PersonRef, type Rewrite } from './wire.ts';

type Json = Record<string, unknown>;

/**
 * Shared channels and direct messages between servers (what Slack calls Slack
 * Connect), between two servers per conversation.
 *
 * An admin shares a channel by making an invitation link
 * (`conversations.inviteShared`); an admin of another server accepts it there
 * (`conversations.acceptSharedInvite` with the link). The accepting server
 * asks the inviting one, signing with its own key; the two pin each other's
 * keys, and the channel now exists on both, each keeping a full copy. From
 * then on everything that happens in it on one side (messages, replies, edits,
 * deletions, reactions, people joining and leaving, topic and description, the
 * profiles of the people involved) is sent to the other as signed events, in
 * order, through a queue that retries until the peer answers. People from the
 * other server exist here as stand-in users (`users.home` names their server)
 * who never sign in here. Once two servers share a channel, their people can
 * also message each other directly.
 *
 * A peer may only speak for its own people, about conversations shared with
 * it, and change only messages that came from it.
 */

const PROTOCOL = 1;
const INVITE_TTL_S = 7 * 24 * 3600;
const HISTORY = 50;
const BATCH = 50;
const TIMEOUT_MS = 10_000;
const MAX_BODY = 2 * 1024 * 1024;
const RETRY_MS = [1000, 5000, 30_000, 120_000, 600_000, 3_600_000];
const EVENT_TTL_MS = 7 * 24 * 3600_000;

interface ServerInfo {
  url: string;
  team_id: string;
  name: string;
  public_key: string;
  version: number;
}

interface WireMessage {
  ref: MessageRef;
  user: PersonRef;
  text: string;
  blocks?: Block[];
  attachments?: Attachment[];
  thread?: MessageRef | null;
  broadcast?: boolean;
  subtype?: string | null;
}

/** One event between servers. `channel` is the sender's id for the conversation. */
interface WireEvent {
  id?: string;
  type: string;
  channel?: string;
  [key: string]: unknown;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function serverInfo(ctx: Ctx): ServerInfo {
  const team = ctx.requireTeam();
  return { url: ctx.config.publicUrl, team_id: team.id, name: team.name, public_key: serverKey(ctx).publicKey, version: PROTOCOL };
}

function validInfo(value: unknown): value is ServerInfo {
  const info = value as ServerInfo | undefined;
  return (
    !!info &&
    typeof info.url === 'string' &&
    /^https?:\/\/[^/]+$/.test(info.url) &&
    typeof info.team_id === 'string' &&
    /^T[A-Z0-9]+$/.test(info.team_id) &&
    typeof info.name === 'string' &&
    validPublicKey(info.public_key)
  );
}

function validProfile(value: unknown): value is WireProfile {
  const profile = value as WireProfile | undefined;
  return (
    !!profile &&
    ['team', 'id', 'name', 'real_name', 'display_name', 'title', 'tz', 'color', 'status_text', 'status_emoji'].every((key) => typeof (profile as never)[key] === 'string')
  );
}

/** The invitation link: `<origin>/connect/<invite id>.<secret>`. */
function parseLink(link: string): { origin: string; inviteId: string; secret: string } | null {
  try {
    const url = new URL(link.trim());
    const match = /^\/connect\/(I[A-Z0-9]+)\.([A-Za-z0-9_-]+)$/.exec(url.pathname);
    return match ? { origin: url.origin, inviteId: match[1]!, secret: match[2]! } : null;
  } catch {
    return null;
  }
}

function sharingEnabled(ctx: Ctx): boolean {
  try {
    return (JSON.parse(ctx.requireTeam().prefs) as { shared_channels?: boolean }).shared_channels !== false;
  } catch {
    return true;
  }
}

let extended = false;

/** Shared channels in Slack's conversation fields, plus the other organisation's name for the client. */
function extendConversations(): void {
  if (extended) return;
  extended = true;
  conversationExtensions.push((ctx, conv, out) => {
    const shared = sharedWith(ctx, conv.id);
    const team = ctx.team();
    if (!shared || !team) return;
    out.is_shared = true;
    out.is_ext_shared = true;
    out.shared_team_ids = [team.id, shared.peer.team_id];
    out.connected_team_ids = [shared.peer.team_id];
    out.conversation_host_id = shared.host === 1 ? team.id : shared.peer.team_id;
    out.shared_with = { id: shared.peer.team_id, name: shared.peer.name };
  });
}

export function installFederation(kernel: Kernel): void {
  const { ctx, registry, router } = kernel;
  extendConversations();
  const asPerson = (userId: string): Actor => {
    const user = getUser(ctx, userId)!;
    return { userId, kind: 'session', role: user.role as Actor['role'], isBot: false, appId: null, botId: null, scopes: null };
  };
  const call = async (name: string, actor: Actor, args: Json): Promise<unknown> => {
    const def = registry.get(name) as MethodDef;
    return def.handler({ ctx, actor, args: new Args(args as never), req: undefined as never, res: undefined as never } as never);
  };

  // ── Talking to peers ──────────────────────────────────────────────────────

  const signedPost = async (url: string, path: string, body: unknown): Promise<{ status: number; body: string; headers: Record<string, unknown> }> => {
    const text = JSON.stringify(body);
    const response = await post(`${url}${path}`, {
      headers: { 'content-type': 'application/json', ...signedHeaders(ctx, 'POST', path, text) },
      body: text,
      timeoutMs: TIMEOUT_MS,
      allowPrivate: allowPrivateTargets(ctx),
    });
    return { status: response.status, body: response.body, headers: response.headers as Record<string, unknown> };
  };

  /** Turn this server's ids into wire references, for a message going to `peer`. */
  const outgoing = (conv: ConvRow): Rewrite => ({
    person: (id) => {
      const ref = personRef(ctx, id);
      return ref ? `${ref.team}/${ref.id}` : null;
    },
    conversation: (id) => (id === conv.id ? '~' : null),
    label: (kind, id, given) => {
      if (kind === 'person') return `@${given || displayName(getUser(ctx, id))}`;
      if (kind === 'conversation') return given ? `#${given}` : `#${getConv(ctx, id)?.name ?? 'channel'}`;
      return `@${given || 'group'}`;
    },
  });

  /** Turn wire references from `peer` into this server's ids. */
  const incoming = (conv: ConvRow, peer: PeerRow, profiles: Map<string, WireProfile>): Rewrite => ({
    person: (wire) => {
      const [team, id] = wire.split('/');
      if (!team || !id) return null;
      return localPerson(ctx, peer, { team, id }, profiles.get(`${team}/${id}`));
    },
    conversation: (wire) => (wire === '~' ? conv.id : null),
    label: (kind, id, given) => (kind === 'person' ? `@${given || profiles.get(id)?.real_name || 'someone'}` : kind === 'conversation' ? `#${given || 'channel'}` : `@${given || 'group'}`),
  });

  const profilesFor = (ids: string[]): WireProfile[] => {
    const out: WireProfile[] = [];
    for (const id of new Set(ids)) {
      const user = getUser(ctx, id);
      if (user && !user.home) out.push(wireProfile(ctx, user));
    }
    return out;
  };

  const wireMessage = (conv: ConvRow, ts: string): { message: WireMessage; people: WireProfile[] } | null => {
    const row = getMessage(ctx, conv.id, ts);
    if (!row || !row.user_id) return null;
    const author = personRef(ctx, row.user_id);
    if (!author) return null;
    const blocks = row.blocks ? (JSON.parse(row.blocks) as Block[]) : undefined;
    const attachments = row.attachments ? (JSON.parse(row.attachments) as Attachment[]) : [];
    const files = row.files ? (JSON.parse(row.files) as string[]) : [];
    // Files are not carried across yet: their names are, so the other side knows something was shared.
    for (const fileId of files) {
      const file = ctx.db.get<{ name: string; title: string }>('SELECT name, title FROM files WHERE id = ?', fileId);
      if (file) attachments.push({ fallback: file.title || file.name, title: file.title || file.name, text: 'A file shared on the other server' } as Attachment);
    }
    const rewrite = outgoing(conv);
    const message: WireMessage = {
      ref: messageRef(ctx, conv.id, row.ts),
      user: author,
      text: rewriteText(row.text, rewrite),
      ...(blocks?.length ? { blocks: rewriteBlocks(blocks, rewrite) } : {}),
      ...(attachments.length ? { attachments: rewriteBlocks(attachments, rewrite) } : {}),
      thread: row.thread_ts && row.thread_ts !== row.ts ? messageRef(ctx, conv.id, row.thread_ts) : null,
      broadcast: row.is_broadcast === 1,
      subtype: row.subtype === 'me_message' ? 'me_message' : null,
    };
    return { message, people: profilesFor([row.user_id, ...peopleIn(row.text, blocks)]) };
  };

  // ── Outbox ────────────────────────────────────────────────────────────────

  const inFlight = new Set<string>();
  let drainTimer: NodeJS.Timeout | null = null;

  const enqueue = (peer: PeerRow, event: WireEvent): void => {
    ctx.db.run('INSERT INTO peer_outbox (peer_id, body, next_at, created) VALUES (?, ?, ?, ?)', peer.id, JSON.stringify(event), Date.now(), Date.now());
    if (ctx.instances.isLeader()) setImmediate(() => void drain());
    else ctx.instances.publish('peers.drain', null);
  };

  /** Leader only: send what is queued, in order, one batch at a time per peer. */
  const drain = async (): Promise<void> => {
    if (!ctx.instances.isLeader()) return;
    const peers = ctx.db.all<{ peer_id: string }>('SELECT DISTINCT peer_id FROM peer_outbox');
    await Promise.all(peers.map(({ peer_id: peerId }) => drainPeer(peerId)));
  };

  const drainPeer = async (peerId: string): Promise<void> => {
    if (inFlight.has(peerId)) return;
    const peer = peerById(ctx, peerId);
    if (!peer) {
      ctx.db.run('DELETE FROM peer_outbox WHERE peer_id = ?', peerId);
      return;
    }
    inFlight.add(peerId);
    try {
      for (;;) {
        const rows = ctx.db.all<{ id: number; body: string; attempt: number; next_at: number }>('SELECT id, body, attempt, next_at FROM peer_outbox WHERE peer_id = ? ORDER BY id LIMIT ?', peerId, BATCH);
        // Strictly in order: a batch waiting to be retried holds back everything after it.
        if (rows.length === 0 || rows[0]!.next_at > Date.now()) return;
        const team = ctx.requireTeam().id;
        const events = rows.map((row) => ({ ...(JSON.parse(row.body) as WireEvent), id: `${team}:${row.id}` }));
        let error: string | null = null;
        try {
          const response = await signedPost(peer.url, '/federation/v1/events', { events });
          if (response.status < 200 || response.status >= 300) error = `http_${response.status}`;
        } catch (failure) {
          error = failure instanceof OutboundError ? failure.reason : 'connection_failed';
        }
        if (error === null) {
          ctx.db.run('DELETE FROM peer_outbox WHERE peer_id = ? AND id <= ?', peerId, rows.at(-1)!.id);
          continue;
        }
        const attempt = rows[0]!.attempt;
        const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!;
        ctx.db.run('UPDATE peer_outbox SET attempt = ?, next_at = ?, last_error = ? WHERE peer_id = ? AND id <= ?', attempt + 1, Date.now() + wait, error, peerId, rows.at(-1)!.id);
        return;
      }
    } finally {
      inFlight.delete(peerId);
    }
  };

  ctx.instances.on('peers.drain', () => void drain());
  ctx.instances.onLeader(() => void drain());
  drainTimer = setInterval(() => void drain(), 1000);
  drainTimer.unref();
  kernel.onClose.push(() => {
    if (drainTimer) clearInterval(drainTimer);
  });

  // ── Relaying what happens here ────────────────────────────────────────────

  const isLocalPerson = (userId: unknown): userId is string => typeof userId === 'string' && getUser(ctx, userId)?.home === '';

  const unsubscribe = ctx.bus.subscribe(({ event }) => {
    try {
      relay(event);
    } catch (error) {
      console.error('[federation] not relayed', error);
    }
  });
  kernel.onClose.push(unsubscribe);

  const relay = (event: { type: string; [key: string]: unknown }): void => {
    if (event.type === 'user_change') {
      const user = event.user as { id?: string } | undefined;
      if (!user?.id || !isLocalPerson(user.id)) return;
      const row = getUser(ctx, user.id)!;
      for (const { peer_id: peerId } of ctx.db.all<{ peer_id: string }>(
        "SELECT DISTINCT s.peer_id FROM shared_conversations s JOIN members m ON m.conversation_id = s.conversation_id WHERE m.user_id = ? AND s.status = 'active'",
        user.id,
      )) {
        const peer = peerById(ctx, peerId);
        if (peer?.status === 'active') enqueue(peer, { type: 'user.changed', profile: wireProfile(ctx, row) });
      }
      return;
    }
    const channel = typeof event.channel === 'string' ? event.channel : (event.item as { channel?: string } | undefined)?.channel;
    if (!channel) return;
    const shared = sharedWith(ctx, channel);
    if (!shared) return;
    const conv = getConv(ctx, channel);
    if (!conv) return;
    const send = (wire: WireEvent): void => enqueue(shared.peer, { ...wire, channel: conv.id });

    switch (event.type) {
      case 'message': {
        if (event.is_ephemeral === true) return;
        const subtype = event.subtype as string | undefined;
        if (subtype === undefined || subtype === 'thread_broadcast' || subtype === 'me_message' || subtype === 'file_share') {
          if (!isLocalPerson(event.user) || typeof event.ts !== 'string') return;
          const wire = wireMessage(conv, event.ts);
          if (wire) send({ type: 'message.posted', message: wire.message, people: wire.people });
        } else if (subtype === 'message_changed') {
          const message = event.message as { ts?: string; user?: string; streaming?: boolean } | undefined;
          if (!message?.ts || !isLocalPerson(message.user) || fromPeer(ctx, conv.id, message.ts) || message.streaming) return;
          const wire = wireMessage(conv, message.ts);
          if (wire) send({ type: 'message.changed', message: wire.message, people: wire.people });
        } else if (subtype === 'message_deleted') {
          const previous = event.previous_message as { user?: string } | undefined;
          if (typeof event.deleted_ts !== 'string' || !isLocalPerson(previous?.user)) return;
          send({ type: 'message.deleted', ref: { team: ctx.requireTeam().id, ts: event.deleted_ts } });
        } else if (subtype === 'channel_topic' || subtype === 'channel_purpose') {
          if (!isLocalPerson(event.user)) return;
          const fresh = getConv(ctx, conv.id)!;
          send({ type: 'channel.changed', user: personRef(ctx, event.user as string), people: profilesFor([event.user as string]), ...(subtype === 'channel_topic' ? { topic: fresh.topic } : { purpose: fresh.purpose }) });
        }
        return;
      }
      case 'reaction_added':
      case 'reaction_removed': {
        const item = event.item as { ts?: string } | undefined;
        if (!item?.ts || !isLocalPerson(event.user)) return;
        send({
          type: event.type === 'reaction_added' ? 'reaction.added' : 'reaction.removed',
          ref: messageRef(ctx, conv.id, item.ts),
          user: personRef(ctx, event.user),
          people: profilesFor([event.user]),
          name: event.reaction,
        });
        return;
      }
      case 'member_joined_channel':
        if (isLocalPerson(event.user)) send({ type: 'member.joined', user: personRef(ctx, event.user), people: profilesFor([event.user]) });
        return;
      case 'member_left_channel':
        if (isLocalPerson(event.user)) send({ type: 'member.left', user: personRef(ctx, event.user) });
        return;
      default:
        return;
    }
  };

  // ── Applying what a peer sends ────────────────────────────────────────────

  /** Apply one event from `peer`. Unknown or out-of-bounds events are dropped. */
  const apply = (peer: PeerRow, event: WireEvent): void => {
    const profiles = new Map<string, WireProfile>();
    for (const profile of Array.isArray(event.people) ? event.people : []) {
      // A peer speaks only for its own people.
      if (validProfile(profile) && profile.team === peer.team_id) profiles.set(`${profile.team}/${profile.id}`, profile);
    }
    if (event.type === 'user.changed') {
      const profile = event.profile;
      if (!validProfile(profile) || profile.team !== peer.team_id) return;
      const known = ctx.db.get<{ user_id: string }>('SELECT user_id FROM remote_users WHERE peer_id = ? AND remote_id = ?', peer.id, profile.id);
      if (known && updateStandIn(ctx, known.user_id, profile)) {
        ctx.bus.emit({ event: { type: 'user_change', user: userToApi(ctx, getUser(ctx, known.user_id)!) }, audience: { all: true } });
      }
      return;
    }
    if (event.type === 'dm.open') {
      openFromPeer(peer, event, profiles);
      return;
    }
    if (event.type === 'dm.linked') {
      const local = typeof event.remote === 'string' ? event.remote : '';
      const theirs = typeof event.channel === 'string' ? event.channel : '';
      if (local && theirs) {
        ctx.db.run("UPDATE shared_conversations SET remote_id = ? WHERE conversation_id = ? AND peer_id = ? AND remote_id = ''", theirs, local, peer.id);
      }
      return;
    }

    if (event.type === 'conversation.ready') {
      ready(peer, typeof event.channel === 'string' ? event.channel : '');
      return;
    }
    const shared = typeof event.channel === 'string' ? sharedByRemote(ctx, peer, event.channel) : undefined;
    const conv = shared ? getConv(ctx, shared.conversation_id) : undefined;
    if (!shared || !conv) return;
    /** A person the event names: only the peer's own people may act. */
    const theirs = (ref: unknown): string | null => {
      const person = ref as PersonRef | undefined;
      if (!person || typeof person.team !== 'string' || typeof person.id !== 'string' || person.team !== peer.team_id) return null;
      return localPerson(ctx, peer, person, profiles.get(`${person.team}/${person.id}`));
    };

    switch (event.type) {
      case 'message.posted':
        receiveMessage(peer, conv, event.message as WireMessage, profiles, theirs);
        return;
      case 'message.changed': {
        const message = event.message as WireMessage;
        const ts = message?.ref?.team === peer.team_id ? localTs(ctx, conv.id, peer, message.ref) : null;
        const row = ts ? getMessage(ctx, conv.id, ts) : undefined;
        if (!row) return;
        const rewrite = incoming(conv, peer, profiles);
        updateMessage(
          ctx,
          conv,
          row,
          {
            text: rewriteText(String(message.text ?? ''), rewrite),
            blocks: Array.isArray(message.blocks) ? rewriteBlocks(message.blocks, rewrite) : null,
            attachments: Array.isArray(message.attachments) ? rewriteBlocks(message.attachments, rewrite) : null,
          },
          { markEditedBy: row.user_id },
        );
        return;
      }
      case 'message.deleted': {
        const ref = event.ref as MessageRef;
        const ts = ref?.team === peer.team_id ? localTs(ctx, conv.id, peer, ref) : null;
        const row = ts ? getMessage(ctx, conv.id, ts) : undefined;
        if (row) deleteMessage(ctx, conv, row);
        return;
      }
      case 'reaction.added':
      case 'reaction.removed': {
        const userId = theirs(event.user);
        const ts = localTs(ctx, conv.id, peer, event.ref as MessageRef);
        const row = ts ? getMessage(ctx, conv.id, ts) : undefined;
        const name = typeof event.name === 'string' ? event.name.slice(0, 100) : '';
        if (!userId || !row || !name) return;
        try {
          if (event.type === 'reaction.added') addReaction(ctx, conv, row, name, userId);
          else removeReaction(ctx, conv, row, name, userId);
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
        }
        return;
      }
      case 'member.joined': {
        const userId = theirs(event.user);
        if (userId && !getMember(ctx, conv.id, userId)) addMember(ctx, conv, userId);
        return;
      }
      case 'member.left': {
        const userId = theirs(event.user);
        if (userId && getMember(ctx, conv.id, userId)) removeMember(ctx, conv, userId);
        return;
      }
      case 'channel.changed': {
        const userId = theirs(event.user);
        if (!userId) return;
        if (!getMember(ctx, conv.id, userId)) addMember(ctx, conv, userId, { silent: true });
        if (typeof event.topic === 'string') void call('conversations.setTopic', asPerson(userId), { channel: conv.id, topic: event.topic.slice(0, 250) }).catch(() => undefined);
        if (typeof event.purpose === 'string') void call('conversations.setPurpose', asPerson(userId), { channel: conv.id, purpose: event.purpose.slice(0, 250) }).catch(() => undefined);
        return;
      }
      case 'conversation.unshared':
        unshare(conv, peer, false);
        return;
      default:
        return;
    }
  };

  const receiveMessage = (peer: PeerRow, conv: ConvRow, message: WireMessage, profiles: Map<string, WireProfile>, theirs: (ref: unknown) => string | null): void => {
    if (!message || typeof message.text !== 'string' || message.ref?.team !== peer.team_id || typeof message.ref.ts !== 'string') return;
    if (localTs(ctx, conv.id, peer, message.ref)) return;
    const userId = theirs(message.user);
    if (!userId) return;
    if (!getMember(ctx, conv.id, userId)) addMember(ctx, conv, userId, { silent: true });
    const rewrite = incoming(conv, peer, profiles);
    const threadTs = message.thread ? localTs(ctx, conv.id, peer, message.thread) : null;
    if (message.thread && !threadTs) return;
    ctx.db.tx(() => {
      const row = postMessage(ctx, {
        conv,
        userId,
        text: rewriteText(message.text, rewrite).slice(0, 40_000),
        blocks: Array.isArray(message.blocks) ? rewriteBlocks(message.blocks, rewrite) : null,
        attachments: Array.isArray(message.attachments) ? rewriteBlocks(message.attachments, rewrite) : null,
        threadTs,
        broadcast: message.broadcast === true,
        subtype: message.subtype === 'me_message' ? 'me_message' : null,
        fromPeer: true,
        eventExtra: { user_team: peer.team_id, source_team: peer.team_id },
        beforeEmit: (posted) => {
          ctx.db.run('INSERT INTO remote_messages (conversation_id, ts, peer_id, remote_ts) VALUES (?, ?, ?, ?)', conv.id, posted.ts, peer.id, message.ref.ts);
        },
      });
      return row;
    });
  };

  /** The other side made its copy: start passing things on, beginning with what was posted meanwhile. */
  const ready = (peer: PeerRow, remoteId: string): void => {
    const row = ctx.db.get<{ conversation_id: string }>("SELECT conversation_id FROM shared_conversations WHERE peer_id = ? AND remote_id = ? AND status = 'pending'", peer.id, remoteId);
    const conv = row ? getConv(ctx, row.conversation_id) : undefined;
    if (!row || !conv) return;
    ctx.db.run("UPDATE shared_conversations SET status = 'active' WHERE conversation_id = ? AND peer_id = ?", conv.id, peer.id);
    const since = ctx.transient.take<string>('share_since', `${conv.id}:${peer.id}`) ?? conv.last_ts;
    for (const message of ctx.db.all<{ ts: string; user_id: string | null }>(
      "SELECT ts, user_id FROM messages WHERE conversation_id = ? AND ts > ? AND (subtype IS NULL OR subtype IN ('thread_broadcast', 'me_message', 'file_share')) ORDER BY ts",
      conv.id,
      since,
    )) {
      if (!isLocalPerson(message.user_id)) continue;
      const wire = wireMessage(conv, message.ts);
      if (wire) enqueue(peer, { type: 'message.posted', channel: conv.id, message: wire.message, people: wire.people });
    }
    emitConversation(conv);
  };

  // ── Direct messages across servers ───────────────────────────────────────

  /** A person here opened a direct message with someone from a peer: tell the peer. */
  const openToPeer = (conv: ConvRow, actorId: string): void => {
    if (conv.kind !== 'im' || sharedWith(ctx, conv.id)) return;
    const people = memberIds(ctx, conv.id).map((id) => getUser(ctx, id)!);
    const remote = people.find((user) => user.home);
    const local = people.find((user) => !user.home);
    if (!remote || !local || local.id !== actorId) return;
    const peer = peerById(ctx, remote.home);
    if (!peer || peer.status !== 'active') fail('user_not_found');
    ctx.db.run('INSERT OR IGNORE INTO shared_conversations (conversation_id, peer_id, remote_id, host, status, created) VALUES (?, ?, ?, 1, ?, ?)', conv.id, peer.id, '', 'active', nowSeconds());
    enqueue(peer, { type: 'dm.open', channel: conv.id, from: personRef(ctx, local.id), to: personRef(ctx, remote.id), people: profilesFor([local.id]) });
  };

  const openFromPeer = (peer: PeerRow, event: WireEvent, profiles: Map<string, WireProfile>): void => {
    const from = event.from as PersonRef | undefined;
    const to = event.to as PersonRef | undefined;
    if (!from || from.team !== peer.team_id || !to || to.team !== ctx.requireTeam().id || typeof event.channel !== 'string') return;
    const sender = localPerson(ctx, peer, from, profiles.get(`${from.team}/${from.id}`));
    const recipient = getUser(ctx, to.id);
    if (!sender || !recipient || recipient.home || recipient.deleted === 1) return;
    // Only people who already share a channel with the peer's server can be reached this way.
    const connected = ctx.db.get(
      "SELECT 1 FROM shared_conversations s JOIN members m ON m.conversation_id = s.conversation_id WHERE s.peer_id = ? AND s.status = 'active' AND m.user_id = ? LIMIT 1",
      peer.id,
      recipient.id,
    );
    if (!connected) return;
    const { conv } = openDirect(ctx, sender, [recipient.id]);
    const existing = ctx.db.get<{ remote_id: string }>('SELECT remote_id FROM shared_conversations WHERE conversation_id = ? AND peer_id = ?', conv.id, peer.id);
    if (existing) ctx.db.run('UPDATE shared_conversations SET remote_id = ?, status = ? WHERE conversation_id = ? AND peer_id = ?', event.channel, 'active', conv.id, peer.id);
    else ctx.db.run('INSERT INTO shared_conversations (conversation_id, peer_id, remote_id, host, status, created) VALUES (?, ?, ?, 0, ?, ?)', conv.id, peer.id, event.channel, 'active', nowSeconds());
    enqueue(peer, { type: 'dm.linked', channel: conv.id, remote: event.channel });
  };

  const original = registry.get('conversations.open')!;
  registry.add('conversations.open', { auth: original.auth === 'none' ? undefined : original.auth, scopes: original.scopes }, async (callArgs) => {
    const result = (await original.handler(callArgs)) as { channel?: { id?: string } } | undefined;
    const id = result?.channel?.id;
    const conv = id ? getConv(ctx, id) : undefined;
    if (conv) openToPeer(conv, callArgs.actor.userId);
    return result;
  });

  // ── Stopping ──────────────────────────────────────────────────────────────

  /** Stop sharing: both copies stay, people from the other side leave this one. */
  const unshare = (conv: ConvRow, peer: PeerRow, tellPeer: boolean): void => {
    const changed = ctx.db.run("UPDATE shared_conversations SET status = 'disconnected' WHERE conversation_id = ? AND peer_id = ? AND status = 'active'", conv.id, peer.id).changes;
    if (!changed) return;
    if (tellPeer) enqueue(peer, { type: 'conversation.unshared', channel: conv.id });
    for (const userId of memberIds(ctx, conv.id)) {
      if (getUser(ctx, userId)?.home === peer.id) removeMember(ctx, conv, userId);
    }
    emitConversation(conv);
  };

  const emitConversation = (conv: ConvRow): void => {
    const fresh = getConv(ctx, conv.id) ?? conv;
    ctx.bus.emit({ event: { type: 'channel_updated', channel: convToApi(ctx, fresh, null), event_ts: ctx.clock.eventTs() }, audience: { conversation: conv.id }, clientOnly: true });
  };

  // ── HTTP between servers ─────────────────────────────────────────────────

  router.add('GET', /^\/federation\/v1\/server$/, ({ res }) => {
    if (!ctx.team()) {
      sendJson(res, 404, { ok: false, error: 'team_not_set_up' });
      return;
    }
    sendJson(res, 200, { ok: true, server: serverInfo(ctx) });
  });

  /** Answer signed, so the caller knows the answer came from this server. */
  const answer = (res: Parameters<Parameters<typeof router.add>[2]>[0]['res'], path: string, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...signedHeaders(ctx, 'RESPONSE', path, text) });
    res.end(text);
  };

  router.add('POST', /^\/federation\/v1\/accept$/, async ({ req, res }) => {
    const path = '/federation/v1/accept';
    const raw = await readBody(req, MAX_BODY);
    let body: Json;
    try {
      body = JSON.parse(raw.toString('utf8')) as Json;
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_json' });
      return;
    }
    const server = body.server;
    // The caller proves it holds the key it presents.
    if (!validInfo(server) || req.headers['x-federation-server'] !== server.url || !verifySigned(server.public_key, 'POST', path, raw, { date: req.headers['x-federation-date'], signature: req.headers['x-federation-signature'] })) {
      sendJson(res, 401, { ok: false, error: 'invalid_signature' });
      return;
    }
    try {
      const result = acceptHere(server, body);
      answer(res, path, 200, { ok: true, ...result });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      answer(res, path, 200, { ok: false, error: error.code });
    }
  });

  const acceptHere = (server: ServerInfo, body: Json): Json => {
    if (!ctx.team() || !sharingEnabled(ctx)) fail('not_allowed');
    if (server.url === ctx.config.publicUrl || server.team_id === ctx.requireTeam().id) fail('invite_from_same_org');
    const inviteId = typeof body.invite_id === 'string' ? body.invite_id : '';
    const secret = typeof body.secret === 'string' ? body.secret : '';
    const invite = ctx.db.get<{ id: string; conversation_id: string; secret_hash: string; status: string; expires: number }>('SELECT * FROM shared_invites WHERE id = ?', inviteId);
    if (!invite || !sameSecret(invite.secret_hash, sha256(secret))) fail('invite_not_found');
    if (invite.status !== 'sent') fail('invite_used');
    if (invite.expires <= nowSeconds()) fail('invite_not_found');
    const channel = body.channel as { id?: string } | undefined;
    if (!channel?.id || !/^[CDG][A-Z0-9]+$/.test(channel.id) || !validProfile(body.user)) fail('invalid_arguments');
    const remoteId = channel.id;
    const conv = getConv(ctx, invite.conversation_id);
    if (!conv || conv.is_archived === 1) fail('channel_not_found');

    return ctx.db.tx(() => {
      let peer = peerByUrl(ctx, server.url);
      if (peer && (peer.public_key !== server.public_key || peer.team_id !== server.team_id)) fail('invalid_link');
      if (!peer) {
        const id = newId('P');
        ctx.db.run('INSERT INTO peers (id, url, team_id, name, public_key, status, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, server.url, server.team_id, server.name.slice(0, 80), server.public_key, 'active', nowSeconds(), nowSeconds());
        peer = peerById(ctx, id)!;
      } else if (peer.status !== 'active' || peer.name !== server.name) {
        ctx.db.run("UPDATE peers SET status = 'active', name = ?, updated = ? WHERE id = ?", server.name.slice(0, 80), nowSeconds(), peer.id);
        peer = peerById(ctx, peer.id)!;
      }
      const other = sharedWith(ctx, conv.id);
      if (other && other.peer_id !== peer.id) fail('connection_limit_exceeded');
      // Pending until the other side has made its copy and says so: nothing is sent before that.
      ctx.db.run(
        'INSERT INTO shared_conversations (conversation_id, peer_id, remote_id, host, status, created) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT (conversation_id, peer_id) DO UPDATE SET remote_id = excluded.remote_id, status = excluded.status',
        conv.id,
        peer.id,
        remoteId,
        'pending',
        nowSeconds(),
      );
      const profile = body.user as WireProfile;
      const accepter = localPerson(ctx, peer, { team: peer.team_id, id: profile.id }, profile);
      ctx.db.run("UPDATE shared_invites SET status = 'accepted', peer_id = ?, accepted_by = ?, updated = ? WHERE id = ?", peer.id, accepter, nowSeconds(), invite.id);
      const fresh = getConv(ctx, conv.id)!;
      const members = memberIds(ctx, conv.id).filter((id) => !getUser(ctx, id)?.home);
      const messages = ctx.db
        .all<{ ts: string }>("SELECT ts FROM messages WHERE conversation_id = ? AND subtype IS NULL OR (conversation_id = ? AND subtype IN ('thread_broadcast', 'me_message', 'file_share')) ORDER BY ts DESC LIMIT ?", conv.id, conv.id, HISTORY)
        .reverse()
        .map((row) => wireMessage(fresh, row.ts))
        .filter((entry) => entry !== null);
      if (accepter) addMember(ctx, fresh, accepter);
      // What is posted from now until the other side is ready goes after it then.
      ctx.transient.put('share_since', `${conv.id}:${peer.id}`, getConv(ctx, conv.id)!.last_ts, INVITE_TTL_S * 1000);
      return {
        server: serverInfo(ctx),
        channel: { id: fresh.id, name: fresh.name, topic: fresh.topic, purpose: fresh.purpose, is_private: fresh.kind === 'private' },
        members: profilesFor(members),
        messages: messages.map((entry) => entry.message),
        people: profilesFor(messages.flatMap((entry) => entry.people.map((person) => person.id))),
      };
    });
  };

  router.add('POST', /^\/federation\/v1\/events$/, async ({ req, res }) => {
    const path = '/federation/v1/events';
    const raw = await readBody(req, MAX_BODY);
    const peer = peerByUrl(ctx, String(req.headers['x-federation-server'] ?? ''));
    if (!peer || peer.status !== 'active' || !verifySigned(peer.public_key, 'POST', path, raw, { date: req.headers['x-federation-date'], signature: req.headers['x-federation-signature'] })) {
      sendJson(res, 401, { ok: false, error: 'invalid_signature' });
      return;
    }
    let events: WireEvent[];
    try {
      const body = JSON.parse(raw.toString('utf8')) as { events?: unknown };
      events = Array.isArray(body.events) ? (body.events as WireEvent[]).slice(0, 200) : [];
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_json' });
      return;
    }
    let applied = 0;
    for (const event of events) {
      if (!event || typeof event !== 'object' || typeof event.type !== 'string' || typeof event.id !== 'string') continue;
      // A batch sent again (its answer was lost) is not applied twice.
      const seen = `${peer.id}:${event.id}`;
      if (ctx.transient.get('peer_event', seen)) continue;
      try {
        apply(peer, event);
      } catch (error) {
        if (!(error instanceof ApiError)) {
          console.error('[federation] event failed', event.type, error);
          sendJson(res, 500, { ok: false, error: 'internal_error', applied });
          return;
        }
      }
      ctx.transient.put('peer_event', seen, 1, EVENT_TTL_MS);
      applied += 1;
    }
    sendJson(res, 200, { ok: true, applied });
  });

  // ── API ───────────────────────────────────────────────────────────────────

  const requireAdminActor = (actor: Actor): void => {
    if (!['admin', 'owner', 'primary_owner'].includes(actor.role)) fail('restricted_action');
  };

  registry.add('conversations.inviteShared', { scopes: ['conversations.connect:write'] }, ({ actor, args }) => {
    requireAdminActor(actor);
    if (!sharingEnabled(ctx)) fail('no_external_invite_permission');
    const conv = getConv(ctx, args.req('channel', 'channel_not_found'));
    if (!conv || (conv.kind !== 'public' && conv.kind !== 'private') || (conv.kind === 'private' && !getMember(ctx, conv.id, actor.userId))) fail('channel_not_found');
    if (conv.is_archived === 1) fail('channel_archived');
    if (conv.is_general === 1) fail('cannot_share_mandatory_channel');
    if (!getMember(ctx, conv.id, actor.userId)) fail('not_in_channel');
    if (sharedWith(ctx, conv.id)) fail('connection_limit_exceeded');
    const emails = args.has('emails') ? args.list('emails') : [];
    if (emails.length > 1) fail('too_many_emails');
    const id = newId('I');
    const secret = newSecret(24);
    const now = nowSeconds();
    ctx.db.run(
      'INSERT INTO shared_invites (id, conversation_id, secret_hash, created_by, recipient_email, status, created, expires, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      conv.id,
      sha256(secret),
      actor.userId,
      emails[0] ?? null,
      'sent',
      now,
      now + INVITE_TTL_S,
      now,
    );
    return { invite_id: id, is_legacy_shared_channel: false, url: `${ctx.config.publicUrl}/connect/${id}.${secret}` };
  });

  registry.add('conversations.acceptSharedInvite', { scopes: ['conversations.connect:write'] }, async ({ actor, args }) => {
    requireAdminActor(actor);
    if (!sharingEnabled(ctx)) fail('restricted_action');
    // Here the invitation is the link the other server's admin handed over.
    const link = parseLink(args.req('invite_id', 'invalid_link'));
    if (!link) fail('invalid_link');
    const name = args.req('channel_name', 'invalid_name_required');
    const isPrivate = args.bool('is_private');
    if (link.origin === new URL(ctx.config.publicUrl).origin) fail('invite_from_same_org');

    let info: ServerInfo;
    try {
      const response = await httpGet(`${link.origin}/federation/v1/server`, { headers: {}, timeoutMs: TIMEOUT_MS, allowPrivate: allowPrivateTargets(ctx) });
      const parsed = JSON.parse(response.body) as { server?: unknown };
      if (!validInfo(parsed.server) || parsed.server.url !== link.origin) fail('invalid_link');
      info = parsed.server;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      fail('invalid_link');
    }
    const known = peerByUrl(ctx, info.url);
    if (known && known.public_key !== info.public_key) fail('invalid_link');

    const channelId = newId('C');
    const user = getUser(ctx, actor.userId)!;
    const path = '/federation/v1/accept';
    const response = await signedPost(info.url, path, { invite_id: link.inviteId, secret: link.secret, server: serverInfo(ctx), user: wireProfile(ctx, user), channel: { id: channelId } }).catch(() => fail('invalid_link'));
    if (!verifySigned(info.public_key, 'RESPONSE', path, response.body, { date: response.headers['x-federation-date'], signature: response.headers['x-federation-signature'] })) fail('invalid_link');
    const answered = JSON.parse(response.body) as Json & { ok?: boolean; error?: string };
    if (!answered.ok) fail(typeof answered.error === 'string' ? answered.error : 'invalid_link');
    const channel = answered.channel as { id: string; topic?: { value?: string }; purpose?: { value?: string } };

    const conv = ctx.db.tx(() => {
      let peer = peerByUrl(ctx, info.url);
      if (!peer) {
        const id = newId('P');
        ctx.db.run('INSERT INTO peers (id, url, team_id, name, public_key, status, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, info.url, info.team_id, info.name.slice(0, 80), info.public_key, 'active', nowSeconds(), nowSeconds());
        peer = peerById(ctx, id)!;
      } else if (peer.status !== 'active') {
        ctx.db.run("UPDATE peers SET status = 'active', updated = ? WHERE id = ?", nowSeconds(), peer.id);
        peer = peerById(ctx, peer.id)!;
      }
      const created = createChannel(ctx, { name, isPrivate, creator: actor.userId, id: channelId, purpose: channel.purpose?.value?.slice(0, 250) || undefined });
      if (channel.topic?.value) ctx.db.run('UPDATE conversations SET topic = ? WHERE id = ?', channel.topic.value.slice(0, 250), created.id);
      ctx.db.run('INSERT INTO shared_conversations (conversation_id, peer_id, remote_id, host, status, created) VALUES (?, ?, ?, 0, ?, ?)', created.id, peer.id, channel.id, 'active', nowSeconds());
      const profiles = new Map<string, WireProfile>();
      for (const profile of [...(answered.members as unknown[]), ...((answered.people as unknown[]) ?? [])]) {
        if (validProfile(profile) && profile.team === peer.team_id) profiles.set(`${profile.team}/${profile.id}`, profile);
      }
      for (const profile of answered.members as WireProfile[]) {
        if (!validProfile(profile) || profile.team !== peer.team_id) continue;
        const id = localPerson(ctx, peer, { team: profile.team, id: profile.id }, profile);
        if (id) addMember(ctx, created, id, { silent: true });
      }
      // The recent history, as it was: no notifications for old messages.
      const rewrite = incoming(created, peer, profiles);
      for (const message of (answered.messages as WireMessage[]).slice(-HISTORY)) {
        if (!message || message.ref?.team !== peer.team_id) continue;
        const author = message.user?.team === peer.team_id ? localPerson(ctx, peer, message.user, profiles.get(`${message.user.team}/${message.user.id}`)) : null;
        if (!author) continue;
        const threadTs = message.thread ? localTs(ctx, created.id, peer, message.thread) : null;
        // A reply whose thread began before the history sent along has nowhere to go.
        if (message.thread && !threadTs) continue;
        const row = postMessage(ctx, {
          conv: getConv(ctx, created.id)!,
          userId: author,
          text: rewriteText(String(message.text ?? ''), rewrite),
          blocks: Array.isArray(message.blocks) ? rewriteBlocks(message.blocks, rewrite) : null,
          attachments: Array.isArray(message.attachments) ? rewriteBlocks(message.attachments, rewrite) : null,
          threadTs,
          silent: true,
          fromPeer: true,
        });
        ctx.db.run('INSERT INTO remote_messages (conversation_id, ts, peer_id, remote_ts) VALUES (?, ?, ?, ?)', created.id, row.ts, peer.id, message.ref.ts);
      }
      enqueue(peer, { type: 'conversation.ready', channel: created.id });
      return getConv(ctx, created.id)!;
    });
    emitConversation(conv);
    return { implicit_approval: true, channel_id: conv.id, invite_id: link.inviteId };
  });

  registry.add('conversations.listConnectInvites', { scopes: ['conversations.connect:manage'] }, ({ actor }) => {
    requireAdminActor(actor);
    const team = ctx.requireTeam();
    const rows = ctx.db.all<{ id: string; conversation_id: string; created_by: string; status: string; created: number; expires: number; updated: number; recipient_email: string | null }>(
      "SELECT * FROM shared_invites WHERE status = 'sent' AND expires > ? ORDER BY created DESC",
      nowSeconds(),
    );
    return {
      invites: rows.map((row) => {
        const conv = getConv(ctx, row.conversation_id);
        const inviter = getUser(ctx, row.created_by);
        return {
          direction: 'outgoing',
          status: row.status,
          date_last_updated: row.updated,
          invite_type: 'channel',
          invite: {
            id: row.id,
            date_created: row.created,
            date_invalid: row.expires,
            inviting_team: { id: team.id, name: team.name, domain: team.domain, date_created: team.created, is_verified: false },
            inviting_user: inviter ? { id: inviter.id, team_id: team.id, name: inviter.name, updated: inviter.updated } : null,
            ...(row.recipient_email ? { recipient_email: row.recipient_email } : {}),
          },
          channel: conv ? { id: conv.id, is_private: conv.kind === 'private', is_im: false, name: conv.name } : null,
          acceptances: [],
        };
      }),
    };
  });

  registry.add('client.connect.list', { auth: 'admin' }, () => ({
    enabled: sharingEnabled(ctx),
    peers: ctx.db.all<PeerRow>('SELECT * FROM peers ORDER BY name').map((peer) => ({
      id: peer.id,
      url: peer.url,
      team_id: peer.team_id,
      name: peer.name,
      status: peer.status,
      pending: ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM peer_outbox WHERE peer_id = ?', peer.id)?.n ?? 0,
      last_error: ctx.db.get<{ last_error: string | null }>('SELECT last_error FROM peer_outbox WHERE peer_id = ? ORDER BY id LIMIT 1', peer.id)?.last_error ?? null,
      conversations: ctx.db
        .all<{ conversation_id: string; host: number; status: string }>('SELECT conversation_id, host, status FROM shared_conversations WHERE peer_id = ? ORDER BY created', peer.id)
        .map((row) => {
          const conv = getConv(ctx, row.conversation_id);
          return { id: row.conversation_id, name: conv?.name ?? null, is_im: conv?.kind === 'im', is_host: row.host === 1, status: row.status };
        }),
    })),
    invites: ctx.db
      .all<{ id: string; conversation_id: string; created: number; expires: number }>("SELECT id, conversation_id, created, expires FROM shared_invites WHERE status = 'sent' AND expires > ? ORDER BY created DESC", nowSeconds())
      .map((row) => ({ id: row.id, channel: row.conversation_id, channel_name: getConv(ctx, row.conversation_id)?.name ?? null, created: row.created, expires: row.expires })),
  }));

  registry.add('client.connect.revokeInvite', { auth: 'admin' }, ({ args }) => {
    if (ctx.db.run("UPDATE shared_invites SET status = 'revoked', updated = ? WHERE id = ? AND status = 'sent'", nowSeconds(), args.req('invite_id', 'invite_not_found')).changes === 0) fail('invite_not_found');
  });

  registry.add('client.connect.stop', { auth: 'admin' }, ({ args }) => {
    const conv = getConv(ctx, args.req('channel', 'channel_not_found')) ?? fail('channel_not_found');
    const shared = sharedWith(ctx, conv.id) ?? fail('not_shared');
    unshare(conv, shared.peer, true);
  });

  registry.add('client.admin.setSharedChannels', { auth: 'admin' }, ({ args }) => {
    const enabled = args.bool('enabled', true);
    ctx.db.run("UPDATE team SET prefs = json_set(prefs, '$.shared_channels', json(?)) WHERE id = ?", enabled ? 'true' : 'false', ctx.requireTeam().id);
    ctx.invalidateTeam();
    return { enabled };
  });

  // An invitation link opened in a browser: say what it is for.
  router.add('GET', /^\/connect\/(I[A-Z0-9]+)\.([A-Za-z0-9_-]+)$/, ({ res }) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('This is an invitation to share a channel between two servers. An admin of the other server accepts it there: paste this address under Administration → Shared channels.');
  });
}

function displayName(user: UserRow | undefined): string {
  return user ? user.display_name || user.real_name || user.name : 'someone';
}
