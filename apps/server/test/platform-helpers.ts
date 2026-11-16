import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { callWithToken, type Json, type Session } from './helpers.ts';

export interface TestAppCredentials {
  id: string;
  botUserId: string;
  botId: string;
  botToken: string;
  appToken: string;
  signingSecret: string;
}

/** Create an app through the admin API, the way the web client does. */
export async function createPlatformApp(admin: Session, name: string, options: Json = {}): Promise<TestAppCredentials> {
  const result = await admin.ok('client.apps.create', { name, ...options });
  return {
    id: result.app.id,
    botUserId: result.app.bot_user_id,
    botId: result.app.bot_id,
    botToken: result.bot_token,
    appToken: result.app_token,
    signingSecret: result.signing_secret,
  };
}

/** Resolve with the first item (already collected or future) that matches. */
class Collector<T> {
  readonly items: T[] = [];
  private waiters: { match: (item: T) => boolean; resolve: (item: T) => void }[] = [];

  push(item: T): void {
    this.items.push(item);
    this.waiters = this.waiters.filter((waiter) => {
      if (!waiter.match(item)) return true;
      waiter.resolve(item);
      return false;
    });
  }

  next(match: (item: T) => boolean, timeoutMs = 2000): Promise<T> {
    const seen = this.items.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting')), timeoutMs);
      this.waiters.push({
        match,
        resolve: (item) => {
          clearTimeout(timer);
          resolve(item);
        },
      });
    });
  }
}

/**
 * A bare Socket Mode client: `apps.connections.open`, connect, collect
 * envelopes. Acknowledges automatically unless told not to.
 */
export class SocketApp {
  readonly envelopes = new Collector<Json>();
  autoAck: boolean | ((envelope: Json) => Json | undefined | false) = true;
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data) => {
      const message: Json = JSON.parse(data.toString());
      this.envelopes.push(message);
      if (!message.envelope_id || this.autoAck === false) return;
      if (this.autoAck === true) {
        this.ack(message.envelope_id);
        return;
      }
      const payload = this.autoAck(message);
      if (payload !== false) this.ack(message.envelope_id, payload);
    });
  }

  static async connect(base: string, appToken: string): Promise<SocketApp> {
    const response = await fetch(`${base}/api/apps.connections.open`, {
      method: 'POST',
      headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/x-www-form-urlencoded' },
    });
    const opened: Json = await response.json();
    if (!opened.ok) throw new Error(`apps.connections.open failed: ${JSON.stringify(opened)}`);
    const socket = new WebSocket(opened.url);
    const app = new SocketApp(socket);
    await Promise.race([
      app.envelopes.next((message) => message.type === 'hello'),
      new Promise((_, reject) => socket.once('error', reject)),
    ]);
    return app;
  }

  ack(envelopeId: string, payload?: Json): void {
    this.socket.send(JSON.stringify(payload === undefined ? { envelope_id: envelopeId } : { envelope_id: envelopeId, payload }));
  }

  /** The next event of this type (the inner event, without its envelopes). */
  async event(type: string, match: (event: Json) => boolean = () => true, timeoutMs = 2000): Promise<Json> {
    const envelope = await this.envelopes.next(
      (entry) => entry.type === 'events_api' && entry.payload?.event?.type === type && match(entry.payload.event),
      timeoutMs,
    );
    return envelope.payload.event;
  }

  /** Events of one type received so far. */
  events(type: string): Json[] {
    return this.envelopes.items
      .filter((envelope) => envelope.type === 'events_api' && envelope.payload?.event?.type === type)
      .map((envelope) => envelope.payload.event);
  }

  close(): void {
    this.socket.close();
  }
}

export interface Captured {
  headers: IncomingHttpHeaders;
  raw: string;
  /** The body parsed as JSON, or as a form (with a `payload` field parsed as JSON when present). */
  body: Json;
}

export interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  delayMs?: number;
}

/** An app's HTTP endpoint: records what the server sends and answers as told. */
export class Receiver {
  readonly requests = new Collector<Captured>();
  /** Decide the answer for a request; the default is an empty 200 (and the challenge for URL verification). */
  reply: (request: Captured, index: number) => Reply | undefined = () => undefined;
  readonly url: string;
  private readonly server: Server;

  private constructor(server: Server) {
    this.server = server;
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/slack/events`;
  }

  static async start(): Promise<Receiver> {
    let receiver: Receiver | undefined;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Json;
        if (String(req.headers['content-type']).includes('json')) {
          body = JSON.parse(raw);
        } else {
          body = Object.fromEntries(new URLSearchParams(raw));
          if (typeof body.payload === 'string') body.payload = JSON.parse(body.payload);
        }
        const captured: Captured = { headers: req.headers, raw, body };
        const index = receiver!.requests.items.length;
        const fallback: Reply = body.type === 'url_verification' ? { body: body.challenge } : {};
        const reply: Reply = receiver!.reply(captured, index) ?? fallback;
        receiver!.requests.push(captured);
        setTimeout(() => {
          res.writeHead(reply.status ?? 200, reply.headers ?? {});
          res.end(reply.body ?? '');
        }, reply.delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    receiver = new Receiver(server);
    return receiver;
  }

  /** Requests carrying an Events API callback for this event type. */
  events(type: string): Captured[] {
    return this.requests.items.filter((request) => request.body.event?.type === type);
  }

  nextEvent(type: string, match: (request: Captured) => boolean = () => true, timeoutMs = 2000): Promise<Captured> {
    return this.requests.next((request) => request.body.event?.type === type && match(request), timeoutMs);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }
}

/**
 * Verify a request signature the way `@slack/bolt` does (`verifySlackRequest`):
 * timestamp no older than five minutes, `v0` scheme, HMAC-SHA256 of
 * `v0:<timestamp>:<raw body>` compared in constant time.
 */
export function verifySignature(signingSecret: string, request: Captured): boolean {
  const timestamp = Number(request.headers['x-slack-request-timestamp']);
  const header = String(request.headers['x-slack-signature'] ?? '');
  if (!Number.isFinite(timestamp) || timestamp < Math.floor(Date.now() / 1000) - 300) return false;
  const [version, hash] = header.split('=');
  if (version !== 'v0' || !hash) return false;
  const expected = createHmac('sha256', signingSecret).update(`v0:${timestamp}:${request.raw}`).digest('hex');
  return hash.length === expected.length && timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
}

/** Call the API as a bot, form-encoded like the SDKs. */
export function asBot(base: string, app: TestAppCredentials, method: string, args: Json = {}): Promise<Json> {
  return callWithToken(base, app.botToken, method, args);
}

export async function botOk(base: string, app: TestAppCredentials, method: string, args: Json = {}): Promise<Json> {
  const result = await asBot(base, app, method, args);
  if (!result.ok) throw new Error(`${method} failed: ${JSON.stringify(result)}`);
  return result;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
