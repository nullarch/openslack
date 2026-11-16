import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { Kernel } from '../app.ts';
import type { Ctx } from '../ctx.ts';
import { ApiError, fail } from '../core/errors.ts';
import { newSecret } from '../core/ids.ts';
import { getApp } from './apps.ts';
import type { PlatformOptions } from './options.ts';

interface Connection {
  appId: string;
  socket: WebSocket;
  alive: boolean;
}

type Settlement = { acked: true; payload: unknown } | { acked: false; reason: 'timeout' | 'closed' };

interface Pending {
  connection: Connection;
  timer: NodeJS.Timeout;
  settle: (result: Settlement) => void;
}

export type EnvelopeType = 'events_api' | 'interactive' | 'slash_commands';

const MAX_CONNECTIONS_PER_APP = 10;
const TICKET_TTL_MS = 30_000;
const PING_INTERVAL_MS = 10_000;
/** What `hello` reports; connections are not actually recycled on a schedule. */
const APPROXIMATE_CONNECTION_SECONDS = 18_000;

/**
 * Socket Mode: apps open a WebSocket to this server and receive events,
 * interactions and slash commands over it instead of exposing an HTTP endpoint.
 * The protocol is the one `apps.connections.open` hands out on Slack: a `hello`,
 * then envelopes the app acknowledges by `envelope_id`.
 */
export class SocketHub {
  private readonly ctx: Ctx;
  private readonly options: PlatformOptions;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  private readonly tickets = new Map<string, { appId: string; expires: number }>();
  private readonly connections = new Map<string, Connection[]>();
  private readonly pending = new Map<string, Pending>();
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private readonly cursors = new Map<string, number>();
  private pinger: NodeJS.Timeout | null = null;

  constructor(ctx: Ctx, options: PlatformOptions) {
    this.ctx = ctx;
    this.options = options;
  }

  install(kernel: Kernel): void {
    kernel.registry.add('apps.connections.open', { scopes: ['connections:write'] }, ({ actor }) => {
      if (actor.kind !== 'app' || !actor.appId) fail('not_allowed_token_type');
      const app = getApp(this.ctx, actor.appId) ?? fail('invalid_auth');
      if (this.count(app.id) >= MAX_CONNECTIONS_PER_APP) fail('too_many_websockets');
      const ticket = newSecret(24);
      this.tickets.set(ticket, { appId: app.id, expires: Date.now() + TICKET_TTL_MS });
      const origin = this.ctx.config.publicUrl.replace(/^http/, 'ws');
      return { url: `${origin}/link/?ticket=${ticket}&app_id=${app.id}` };
    });
    kernel.upgrades.push(this.handleUpgrade);
    kernel.onClose.push(() => this.stop());
    this.pinger = setInterval(() => this.ping(), PING_INTERVAL_MS);
    this.pinger.unref();
  }

  isConnected(appId: string): boolean {
    return this.count(appId) > 0;
  }

  private count(appId: string): number {
    return this.connections.get(appId)?.length ?? 0;
  }

  private handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean => {
    if (url.pathname !== '/link/' && url.pathname !== '/link') return false;
    const ticket = url.searchParams.get('ticket') ?? '';
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    const app = entry && entry.expires > Date.now() ? getApp(this.ctx, entry.appId) : undefined;
    if (!app || app.socket_mode !== 1 || this.count(app.id) >= MAX_CONNECTIONS_PER_APP) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, app.id));
    return true;
  };

  private accept(socket: WebSocket, appId: string): void {
    const connection: Connection = { appId, socket, alive: true };
    const list = this.connections.get(appId) ?? [];
    list.push(connection);
    this.connections.set(appId, list);

    socket.on('pong', () => {
      connection.alive = true;
    });
    socket.on('message', (data, isBinary) => {
      if (!isBinary) this.receive(data.toString());
    });
    socket.on('close', () => this.drop(connection));
    socket.on('error', () => this.drop(connection));
    this.send(connection, {
      type: 'hello',
      num_connections: list.length,
      debug_info: {
        host: 'applink-1',
        build_number: 1,
        approximate_connection_time: APPROXIMATE_CONNECTION_SECONDS,
      },
      connection_info: { app_id: appId },
    });
    this.announce(appId);
  }

  private drop(connection: Connection): void {
    const list = this.connections.get(connection.appId);
    const index = list?.indexOf(connection) ?? -1;
    if (!list || index < 0) return;
    list.splice(index, 1);
    if (list.length === 0) this.connections.delete(connection.appId);
    // Whatever this connection had not acknowledged is treated as undelivered.
    for (const [id, pending] of this.pending) {
      if (pending.connection !== connection) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.settle({ acked: false, reason: 'closed' });
    }
    this.announce(connection.appId);
  }

  /** Let admin screens show whether an app is connected. */
  private announce(appId: string): void {
    this.ctx.bus.emit({
      event: { type: 'app_connection_changed', app_id: appId, connected: this.isConnected(appId) },
      audience: { all: true },
      clientOnly: true,
    });
  }

  private receive(text: string): void {
    let message: { envelope_id?: unknown; payload?: unknown };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (typeof message.envelope_id !== 'string') return;
    const pending = this.pending.get(message.envelope_id);
    if (!pending) return;
    this.pending.delete(message.envelope_id);
    clearTimeout(pending.timer);
    pending.settle({ acked: true, payload: message.payload ?? null });
  }

  private send(connection: Connection, body: unknown): void {
    if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(JSON.stringify(body));
  }

  /** Any open connection, round-robin, optionally avoiding the one that just failed. */
  private pick(appId: string, avoid?: Connection): Connection | undefined {
    const open = (this.connections.get(appId) ?? []).filter((entry) => entry.socket.readyState === WebSocket.OPEN);
    if (open.length === 0) return undefined;
    const candidates = open.length > 1 && avoid ? open.filter((entry) => entry !== avoid) : open;
    const cursor = (this.cursors.get(appId) ?? 0) + 1;
    this.cursors.set(appId, cursor);
    return candidates[cursor % candidates.length];
  }

  private dispatch(
    appId: string,
    type: EnvelopeType,
    payload: unknown,
    extra: Record<string, unknown>,
    avoid?: Connection,
  ): Promise<Settlement & { connection?: Connection }> | null {
    const connection = this.pick(appId, avoid);
    if (!connection) return null;
    const envelopeId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(envelopeId);
        resolve({ acked: false, reason: 'timeout', connection });
      }, this.options.ackTimeoutMs);
      timer.unref();
      this.pending.set(envelopeId, { connection, timer, settle: (result) => resolve({ ...result, connection }) });
      this.send(connection, { envelope_id: envelopeId, payload, type, ...extra });
    });
  }

  /**
   * Deliver an Events API payload. Each event goes to exactly one connection.
   * Without an acknowledgement in time it is redelivered (on another connection
   * when there is one) on the retry schedule, then dropped. With no connection
   * open it is dropped at once, as Slack does.
   */
  sendEvent(appId: string, payload: unknown, attempt = 0, avoid?: Connection): void {
    const sent = this.dispatch(
      appId,
      'events_api',
      payload,
      { accepts_response_payload: false, retry_attempt: attempt, retry_reason: attempt === 0 ? '' : 'timeout' },
      avoid,
    );
    if (!sent) return;
    void sent.then((result) => {
      if (result.acked) return;
      const delay = this.options.retryDelaysMs[attempt];
      if (delay === undefined) return;
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        this.sendEvent(appId, payload, attempt + 1, result.connection);
      }, delay);
      timer.unref();
      this.retryTimers.add(timer);
    });
  }

  /**
   * Deliver an interaction or slash command and wait for the app's
   * acknowledgement, whose payload (if any) is the app's immediate response.
   */
  async request(appId: string, type: 'interactive' | 'slash_commands', payload: unknown): Promise<unknown> {
    const sent = this.dispatch(appId, type, payload, { accepts_response_payload: true });
    if (!sent) throw new ApiError('app_unreachable', { detail: 'no_socket_mode_connection' });
    const result = await sent;
    if (!result.acked) throw new ApiError('app_timeout');
    return result.payload;
  }

  /** Close an app's connections, telling it why (`link_disabled` when Socket Mode was switched off). */
  disconnectApp(appId: string, reason: string): void {
    for (const connection of [...(this.connections.get(appId) ?? [])]) {
      this.send(connection, { type: 'disconnect', reason, debug_info: { host: 'applink-1' } });
      connection.socket.close(1000);
    }
  }

  private ping(): void {
    const now = Date.now();
    for (const [ticket, entry] of this.tickets) {
      if (entry.expires <= now) this.tickets.delete(ticket);
    }
    for (const list of this.connections.values()) {
      for (const connection of [...list]) {
        if (!connection.alive) {
          connection.socket.terminate();
          continue;
        }
        connection.alive = false;
        connection.socket.ping();
      }
    }
  }

  stop(): void {
    if (this.pinger) clearInterval(this.pinger);
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    for (const list of this.connections.values()) {
      for (const connection of list) connection.socket.terminate();
    }
    this.connections.clear();
    this.wss.close();
  }
}
