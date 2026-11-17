import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { Kernel } from '../app.ts';
import type { BusEvent } from '../core/bus.ts';
import { getConv, getMember, memberIds, resolveConv } from '../core/conversations.ts';
import { ApiError, fail } from '../core/errors.ts';
import { eventVisibleToGuest, guestIds } from '../core/guests.ts';
import { newSecret } from '../core/ids.ts';
import { canPost, MAX_TEXT_LENGTH, postMessage } from '../core/messages.ts';
import { getUser, requireUser, userToApi } from '../core/users.ts';
import type { Actor, Ctx } from '../ctx.ts';
import { teamToApi } from '../api/methods/client.ts';

/**
 * The Real Time Messaging API, for older bots (Hubot adapters, early SDKs)
 * that predate the Events API: `rtm.connect` / `rtm.start` hand out a
 * WebSocket URL; the socket carries the events the token's user can see, and
 * the bot sends `message`, `typing`, `ping` and `presence_sub` over it.
 * Slack has retired RTM for new apps; it is kept here so old bots keep working.
 */

interface Ticket {
  actor: Actor;
  expires: number;
}

interface Connection {
  socket: WebSocket;
  actor: Actor;
  alive: boolean;
  presence: Set<string>;
}

const TICKET_TTL_MS = 30_000;
const PING_INTERVAL_MS = 30_000;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** Events meant for first-party clients that RTM clients also receive, as on Slack. */
const CLIENT_EVENTS_FOR_RTM = new Set(['user_typing', 'channel_marked', 'channel_joined', 'channel_left', 'presence_change']);

export class RtmHub {
  private readonly ctx: Ctx;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly tickets = new Map<string, Ticket>();
  private readonly connections = new Set<Connection>();
  private pinger: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  install(kernel: Kernel): void {
    const open = (actor: Actor): { url: string } => {
      if (actor.kind === 'app' || actor.kind === 'session') fail('not_allowed_token_type');
      const ticket = newSecret(24);
      this.tickets.set(ticket, { actor, expires: Date.now() + TICKET_TTL_MS });
      return { url: `${this.ctx.config.publicUrl.replace(/^http/, 'ws')}/rtm/?ticket=${ticket}` };
    };
    const identity = (actor: Actor): Record<string, unknown> => {
      const user = requireUser(this.ctx, actor.userId);
      const team = teamToApi(this.ctx);
      return {
        self: { id: user.id, name: user.name },
        team: { id: team.id, name: team.name, domain: team.domain },
      };
    };

    kernel.registry.add('rtm.connect', {}, ({ actor }) => ({ ...open(actor), ...identity(actor) }));

    // The older, heavier form: the same, plus the people and conversations the caller can see.
    kernel.registry.add('rtm.start', {}, ({ ctx, actor }) => {
      const result: Record<string, unknown> = { ...open(actor), ...identity(actor) };
      const users = ctx.db.all<{ id: string }>('SELECT id FROM users ORDER BY created');
      result.users = users.map((row) => userToApi(ctx, getUser(ctx, row.id)!, actor));
      const memberships = ctx.db.all<{ conversation_id: string }>('SELECT conversation_id FROM members WHERE user_id = ?', actor.userId);
      const conversations = memberships.map((row) => getConv(ctx, row.conversation_id)).filter((conv) => conv !== undefined);
      const shape = (conv: NonNullable<ReturnType<typeof getConv>>): Record<string, unknown> => ({
        id: conv.id,
        name: conv.name ?? undefined,
        is_member: true,
        is_archived: conv.is_archived === 1,
        created: conv.created,
      });
      result.channels = conversations.filter((conv) => conv.kind === 'public').map(shape);
      result.groups = conversations.filter((conv) => conv.kind === 'private' || conv.kind === 'mpim').map(shape);
      result.ims = conversations
        .filter((conv) => conv.kind === 'im')
        .map((conv) => ({ id: conv.id, user: (conv.im_key ?? '').split(',').find((id) => id !== actor.userId) ?? actor.userId, is_im: true }));
      return result;
    });

    kernel.upgrades.push(this.handleUpgrade);
    this.unsubscribe = this.ctx.bus.subscribe((event) => this.deliver(event));
    this.pinger = setInterval(() => this.ping(), PING_INTERVAL_MS);
    this.pinger.unref();
    kernel.onClose.push(() => this.stop());
  }

  private stop(): void {
    this.unsubscribe?.();
    if (this.pinger) clearInterval(this.pinger);
    for (const connection of this.connections) connection.socket.terminate();
    this.connections.clear();
    this.wss.close();
  }

  private handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean => {
    if (url.pathname !== '/rtm/' && url.pathname !== '/rtm') return false;
    const ticket = this.tickets.get(url.searchParams.get('ticket') ?? '');
    this.tickets.delete(url.searchParams.get('ticket') ?? '');
    if (!ticket || ticket.expires < Date.now() || getUser(this.ctx, ticket.actor.userId)?.deleted !== 0) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, ticket.actor));
    return true;
  };

  private accept(socket: WebSocket, actor: Actor): void {
    const connection: Connection = { socket, actor, alive: true, presence: new Set() };
    this.connections.add(connection);
    socket.on('pong', () => {
      connection.alive = true;
    });
    socket.on('message', (data) => this.receive(connection, data.toString()));
    socket.on('close', () => this.connections.delete(connection));
    socket.on('error', () => this.connections.delete(connection));
    this.send(connection, { type: 'hello' });
  }

  private send(connection: Connection, body: unknown): void {
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    if (connection.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      connection.socket.terminate();
      return;
    }
    connection.socket.send(JSON.stringify(body));
  }

  private receive(connection: Connection, text: string): void {
    let message: { id?: number; type?: string; channel?: string; text?: string; thread_ts?: string; ids?: string[] };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    const replyTo = message.id;
    const reply = (body: Record<string, unknown>): void => {
      if (replyTo !== undefined) this.send(connection, { ...body, reply_to: replyTo });
    };
    try {
      switch (message.type) {
        case 'ping':
          this.send(connection, { type: 'pong', reply_to: replyTo });
          return;
        case 'message': {
          const conv = resolveConv(this.ctx, connection.actor, message.channel);
          if (conv.is_archived === 1) fail('is_archived');
          if (!canPost(this.ctx, conv, connection.actor.userId, connection.actor.isBot)) fail('not_in_channel');
          const body = String(message.text ?? '');
          if (!body) fail('no_text');
          if (body.length > MAX_TEXT_LENGTH) fail('msg_too_long');
          const row = postMessage(this.ctx, {
            conv,
            userId: connection.actor.userId,
            botId: connection.actor.botId,
            appId: connection.actor.isBot ? connection.actor.appId : null,
            text: body,
            threadTs: message.thread_ts ?? null,
          });
          reply({ ok: true, ts: row.ts, text: row.text });
          return;
        }
        case 'typing': {
          const conv = message.channel ? getConv(this.ctx, message.channel) : undefined;
          if (!conv || !getMember(this.ctx, conv.id, connection.actor.userId)) return;
          this.ctx.bus.emit({
            event: { type: 'user_typing', channel: conv.id, user: connection.actor.userId },
            audience: { conversation: conv.id },
            exceptUser: connection.actor.userId,
            clientOnly: true,
          });
          return;
        }
        case 'presence_sub':
          connection.presence = new Set((message.ids ?? []).map(String));
          return;
        default:
          reply({ ok: false, error: { code: 3, msg: 'unknown message type' } });
      }
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'internal_error';
      reply({ ok: false, error: { code: 2, msg: code } });
    }
  }

  private deliver(busEvent: BusEvent): void {
    if (this.connections.size === 0) return;
    const { event } = busEvent;
    if (busEvent.clientOnly && !CLIENT_EVENTS_FOR_RTM.has(event.type)) return;
    // Ephemeral messages are for one person's screen only.
    if (event.is_ephemeral === true) return;
    const { audience } = busEvent;
    const recipients = 'all' in audience ? null : new Set('users' in audience ? audience.users : memberIds(this.ctx, audience.conversation));
    const payload = JSON.stringify(event);
    // Workspace-wide events reach guests only when they concern what a guest may see.
    const guests = recipients ? null : guestIds(this.ctx);
    for (const connection of this.connections) {
      const userId = connection.actor.userId;
      if (recipients && !recipients.has(userId)) continue;
      if (guests?.has(userId) && !eventVisibleToGuest(this.ctx, userId, event)) continue;
      if (busEvent.exceptUser === userId) continue;
      if (event.type === 'presence_change' && !connection.presence.has(String(event.user))) continue;
      if (connection.socket.readyState !== WebSocket.OPEN) continue;
      if (connection.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        connection.socket.terminate();
        continue;
      }
      connection.socket.send(payload);
    }
  }

  private ping(): void {
    const now = Date.now();
    for (const [ticket, entry] of this.tickets) {
      if (entry.expires <= now) this.tickets.delete(ticket);
    }
    for (const connection of this.connections) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }
}
