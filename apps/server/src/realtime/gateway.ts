import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { isSameOrigin } from '../api/http.ts';
import type { Ctx, Presence } from '../ctx.ts';
import { authenticate, readSessionToken } from '../core/auth.ts';
import { sha256 } from '../core/ids.ts';
import { twoFactorPending } from '../accounts/signin.ts';
import type { BusEvent } from '../core/bus.ts';
import { eventVisibleToGuest, guestExpired, guestIds } from '../core/guests.ts';
import { getConv, getMember, memberIds } from '../core/conversations.ts';
import { getUser, presenceOf } from '../core/users.ts';

interface Client {
  socket: WebSocket;
  userId: string;
  alive: boolean;
  /** Hash of the session cookie the connection was opened with, so a revoked session can be closed. */
  session: string | null;
}

const HEARTBEAT_MS = 30_000;
const AWAY_GRACE_MS = 5_000;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/**
 * The first-party client connection. Each browser tab holds one WebSocket and
 * receives the events it is allowed to see; presence is derived from who is
 * connected.
 */
export class Gateway implements Presence {
  private ctx!: Ctx;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly byUser = new Map<string, Set<Client>>();
  private readonly awayTimers = new Map<string, NodeJS.Timeout>();
  private heartbeat: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  start(ctx: Ctx): void {
    this.ctx = ctx;
    this.unsubscribe = ctx.bus.subscribe((event) => this.deliver(event));
    this.heartbeat = setInterval(() => this.checkAlive(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const timer of this.awayTimers.values()) clearTimeout(timer);
    for (const clients of this.byUser.values()) {
      for (const client of clients) client.socket.terminate();
    }
    this.byUser.clear();
    this.wss.close();
  }

  /**
   * Connected now, or disconnected so recently that "away" has not been
   * announced yet (a reload). Reporting the same thing the announcements say
   * keeps `client.boot` from showing someone away who never went away.
   */
  isOnline(userId: string): boolean {
    return (this.byUser.get(userId)?.size ?? 0) > 0 || this.awayTimers.has(userId);
  }

  onlineUsers(): string[] {
    return [...this.byUser.keys()];
  }

  /** Take over the socket for `GET /ws`; returns false for any other path. */
  handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean => {
    if (url.pathname !== '/ws') return false;
    const { actor } = authenticate(this.ctx, req, undefined);
    const user = actor ? getUser(this.ctx, actor.userId) : undefined;
    const refused = !user || guestExpired(user) || twoFactorPending(this.ctx, user.id);
    if (!isSameOrigin(req) || !actor || actor.kind !== 'session' || refused) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }
    const cookie = readSessionToken(req);
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, actor.userId, cookie ? sha256(cookie) : null));
    return true;
  };

  private accept(socket: WebSocket, userId: string, session: string | null): void {
    const client: Client = { socket, userId, alive: true, session };
    const wasOnline = this.isOnline(userId);
    let clients = this.byUser.get(userId);
    if (!clients) {
      clients = new Set();
      this.byUser.set(userId, clients);
    }
    clients.add(client);
    const pending = this.awayTimers.get(userId);
    if (pending) {
      clearTimeout(pending);
      this.awayTimers.delete(userId);
    } else if (!wasOnline) {
      this.announcePresence(userId);
    }

    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('message', (data) => this.receive(client, data.toString()));
    socket.on('close', () => this.drop(client));
    socket.on('error', () => this.drop(client));
    this.send(client, { type: 'hello', user_id: userId, server_version: this.ctx.config.version });
  }

  private drop(client: Client): void {
    const clients = this.byUser.get(client.userId);
    if (!clients?.delete(client)) return;
    if (clients.size > 0) return;
    this.byUser.delete(client.userId);
    if (this.awayTimers.has(client.userId)) return;
    // A reload reconnects within moments; do not flap to away in between.
    const timer = setTimeout(() => {
      this.awayTimers.delete(client.userId);
      if (!this.isOnline(client.userId)) this.announcePresence(client.userId);
    }, AWAY_GRACE_MS);
    timer.unref();
    this.awayTimers.set(client.userId, timer);
  }

  private announcePresence(userId: string): void {
    const user = getUser(this.ctx, userId);
    if (!user) return;
    this.ctx.bus.emit({
      event: { type: 'presence_change', user: userId, presence: presenceOf(this.ctx, user) },
      audience: { all: true },
      clientOnly: true,
    });
  }

  private receive(client: Client, text: string): void {
    let message: { type?: string; id?: number; channel?: string; thread_ts?: string };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (message.type === 'ping') {
      this.send(client, { type: 'pong', reply_to: message.id });
      return;
    }
    if (message.type === 'typing' && typeof message.channel === 'string') {
      const conv = getConv(this.ctx, message.channel);
      if (!conv || !getMember(this.ctx, conv.id, client.userId)) return;
      const event: BusEvent['event'] = { type: 'user_typing', channel: conv.id, user: client.userId };
      if (typeof message.thread_ts === 'string') event.thread_ts = message.thread_ts;
      this.ctx.bus.emit({ event, audience: { conversation: conv.id }, exceptUser: client.userId, clientOnly: true });
    }
  }

  private deliver(busEvent: BusEvent): void {
    if (this.byUser.size === 0) return;
    const { audience } = busEvent;
    let recipients: Iterable<string>;
    if ('all' in audience) recipients = this.byUser.keys();
    else if ('users' in audience) recipients = audience.users;
    else recipients = memberIds(this.ctx, audience.conversation);

    const payload = JSON.stringify(busEvent.event);
    // Workspace-wide events reach guests only when they concern what a guest may see.
    const guests = 'all' in audience ? guestIds(this.ctx) : null;
    for (const userId of recipients) {
      if (userId === busEvent.exceptUser) continue;
      const clients = this.byUser.get(userId);
      if (!clients) continue;
      if (guests?.has(userId) && !eventVisibleToGuest(this.ctx, userId, busEvent.event)) continue;
      for (const client of clients) this.sendRaw(client, payload);
    }

    // Signed out elsewhere: the browsers holding those sessions lose their connections.
    if (busEvent.event.type === 'sessions_revoked' && Array.isArray(busEvent.event.sessions)) {
      const revoked = new Set(busEvent.event.sessions as string[]);
      for (const client of this.byUser.get(String(busEvent.event.user ?? '')) ?? []) {
        if (client.session && revoked.has(client.session)) client.socket.close(4401, 'signed_out');
      }
    }
    // A deactivated account loses its open connections, right after hearing why.
    if (busEvent.event.type === 'user_change') {
      const user = busEvent.event.user as { id?: string; deleted?: boolean } | undefined;
      if (user?.id && user.deleted) this.disconnectUser(user.id);
    }
  }

  /** Close every connection a user holds. Their session is already gone, so they cannot reconnect. */
  private disconnectUser(userId: string): void {
    const clients = this.byUser.get(userId);
    if (!clients) return;
    for (const client of [...clients]) client.socket.close(4001, 'account_inactive');
  }

  private send(client: Client, body: unknown): void {
    this.sendRaw(client, JSON.stringify(body));
  }

  private sendRaw(client: Client, payload: string): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    if (client.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      client.socket.terminate();
      return;
    }
    client.socket.send(payload);
  }

  private checkAlive(): void {
    for (const clients of this.byUser.values()) {
      for (const client of clients) {
        if (!client.alive) {
          client.socket.terminate();
          continue;
        }
        client.alive = false;
        client.socket.ping();
      }
    }
  }
}
