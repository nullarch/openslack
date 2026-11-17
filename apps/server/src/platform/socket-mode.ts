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
  /** The local connection it went out on, or null when another process holds the connection. */
  connection: Connection | null;
  timer: NodeJS.Timeout;
  settle: (result: Settlement) => void;
}

/** An envelope handed to the process that holds the app's connection. */
interface Forwarded {
  envelopeId: string;
  appId: string;
  type: EnvelopeType;
  payload: unknown;
  extra: Record<string, unknown>;
}

/** Waiting for an answer from another process takes longer than the app's own window by this much. */
const FORWARD_MARGIN_MS = 2000;

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
 *
 * With several processes, the app's connections may be held by another one
 * than the process where an event happens. Each process records how many it
 * holds per app in `instance_sockets`; an envelope with no local connection to
 * go out on is handed to a process that has one, which sends it and passes the
 * acknowledgement (and any response payload) back.
 */
export class SocketHub {
  private readonly ctx: Ctx;
  private readonly options: PlatformOptions;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
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
      // The socket may reach another process than this call.
      this.ctx.transient.put('socket_ticket', ticket, { appId: app.id }, TICKET_TTL_MS);
      const origin = this.ctx.config.publicUrl.replace(/^http/, 'ws');
      return { url: `${origin}/link/?ticket=${ticket}&app_id=${app.id}` };
    });
    kernel.upgrades.push(this.handleUpgrade);
    kernel.onClose.push(() => this.stop());
    this.pinger = setInterval(() => this.ping(), PING_INTERVAL_MS);
    this.pinger.unref();

    const { instances } = this.ctx;
    instances.on('socket.disconnect', (body) => {
      const { appId, reason } = body as { appId: string; reason: string };
      this.disconnectApp(appId, reason, false);
    });
    instances.on('socket.deliver', (body, origin) => this.deliverForwarded(body as Forwarded, origin));
    instances.on('socket.result', (body) => {
      const { envelopeId, ...result } = body as Settlement & { envelopeId: string };
      const pending = this.pending.get(envelopeId);
      if (!pending || pending.connection) return;
      this.pending.delete(envelopeId);
      clearTimeout(pending.timer);
      pending.settle(result);
    });
    // Connections held by a process that is gone no longer count.
    instances.onGone((ids) => {
      const marks = ids.map(() => '?').join(', ');
      for (const row of this.ctx.db.all<{ app_id: string }>(`SELECT DISTINCT app_id FROM instance_sockets WHERE instance IN (${marks})`, ...ids)) {
        setImmediate(() => this.announce(row.app_id));
      }
    });
  }

  isConnected(appId: string): boolean {
    return this.count(appId) > 0;
  }

  /** Open connections for the app, in every process. */
  private count(appId: string): number {
    return this.localCount(appId) + this.remote(appId).reduce((sum, row) => sum + row.connections, 0);
  }

  private localCount(appId: string): number {
    return this.connections.get(appId)?.length ?? 0;
  }

  /** Other live processes holding connections for the app. */
  private remote(appId: string): { instance: string; connections: number }[] {
    const { instances } = this.ctx;
    if (!instances.shared) return [];
    return this.ctx.db.all<{ instance: string; connections: number }>(
      'SELECT s.instance, s.connections FROM instance_sockets s JOIN instances i ON i.id = s.instance WHERE s.app_id = ? AND s.instance != ? AND i.seen > ?',
      appId,
      instances.id,
      instances.cutoff(),
    );
  }

  /** Record this process's count for the app where the others can see it. */
  private record(appId: string): void {
    const { instances } = this.ctx;
    if (!instances.shared) return;
    const count = this.localCount(appId);
    if (count === 0) this.ctx.db.run('DELETE FROM instance_sockets WHERE instance = ? AND app_id = ?', instances.id, appId);
    else {
      this.ctx.db.run(
        'INSERT INTO instance_sockets (instance, app_id, connections) VALUES (?, ?, ?) ON CONFLICT (instance, app_id) DO UPDATE SET connections = excluded.connections',
        instances.id,
        appId,
        count,
      );
    }
  }

  private handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean => {
    if (url.pathname !== '/link/' && url.pathname !== '/link') return false;
    const entry = this.ctx.transient.take<{ appId: string }>('socket_ticket', url.searchParams.get('ticket') ?? '');
    const app = entry ? getApp(this.ctx, entry.appId) : undefined;
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
    this.record(appId);

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
      num_connections: this.count(appId),
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
    this.record(connection.appId);
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
    envelopeId: string = randomUUID(),
    forwardable = true,
  ): Promise<Settlement & { connection?: Connection }> | null {
    const connection = this.pick(appId, avoid);
    if (!connection) return forwardable ? this.forward(appId, type, payload, extra, envelopeId) : null;
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

  /** No local connection: hand the envelope to a process that holds one, and wait for its answer. */
  private forward(appId: string, type: EnvelopeType, payload: unknown, extra: Record<string, unknown>, envelopeId: string): Promise<Settlement> | null {
    const holders = this.remote(appId);
    if (holders.length === 0) return null;
    const target = holders[Math.floor(Math.random() * holders.length)]!.instance;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(envelopeId);
        resolve({ acked: false, reason: 'timeout' });
      }, this.options.ackTimeoutMs + FORWARD_MARGIN_MS);
      timer.unref();
      this.pending.set(envelopeId, { connection: null, timer, settle: resolve });
      const forwarded: Forwarded = { envelopeId, appId, type, payload, extra };
      this.ctx.instances.publish('socket.deliver', forwarded, target);
    });
  }

  /** Another process's envelope for an app connected here: send it and report how it went. */
  private deliverForwarded(forwarded: Forwarded, origin: string): void {
    const reply = (result: Settlement): void => this.ctx.instances.publish('socket.result', { envelopeId: forwarded.envelopeId, ...result }, origin);
    const sent = this.dispatch(forwarded.appId, forwarded.type, forwarded.payload, forwarded.extra, undefined, forwarded.envelopeId, false);
    if (!sent) {
      reply({ acked: false, reason: 'closed' });
      return;
    }
    void sent.then(({ connection: _connection, ...result }) => reply(result as Settlement));
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

  /** Close an app's connections, here and in other processes, telling it why (`link_disabled` when Socket Mode was switched off). */
  disconnectApp(appId: string, reason: string, everywhere = true): void {
    if (everywhere) this.ctx.instances.publish('socket.disconnect', { appId, reason });
    for (const connection of [...(this.connections.get(appId) ?? [])]) {
      this.send(connection, { type: 'disconnect', reason, debug_info: { host: 'applink-1' } });
      connection.socket.close(1000);
    }
  }

  private ping(): void {
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
