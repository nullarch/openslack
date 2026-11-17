import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApp, type App } from '../src/app.ts';
import { createToken } from '../src/core/auth.ts';
import { newId } from '../src/core/ids.ts';
import { createUser } from '../src/core/users.ts';
import type { Config } from '../src/ctx.ts';

// Loose on purpose: tests poke at many response shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface TestApp {
  app: App;
  base: string;
  close(): Promise<void>;
}

export async function startApp(overrides: Partial<Config> = {}): Promise<TestApp> {
  const dataDir = mkdtempSync(join(tmpdir(), 'chat-test-'));
  const app = createApp({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    publicUrl: '',
    webDir: null,
    maxUploadBytes: 5 * 1024 * 1024,
    cookieSecure: false,
    version: 'test',
    quiet: true,
    ...overrides,
  });
  const port = await app.listen();
  return {
    app,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A signed-in browser: keeps the session cookie between calls. */
export class Session {
  readonly base: string;
  cookie = '';
  userId = '';

  constructor(base: string) {
    this.base = base;
  }

  async call(method: string, args: Record<string, unknown> = {}): Promise<Json> {
    const response = await fetch(`${this.base}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: JSON.stringify(args),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0]!;
    return response.json();
  }

  /** Call and fail the test when the response is not ok. */
  async ok(method: string, args: Record<string, unknown> = {}): Promise<Json> {
    const result = await this.call(method, args);
    if (!result.ok) throw new Error(`${method} failed: ${JSON.stringify(result)}`);
    return result;
  }

  /** Open the realtime connection and collect what arrives. */
  async connect(): Promise<Stream> {
    const socket = new WebSocket(`${this.base.replace('http', 'ws')}/ws`, { headers: { cookie: this.cookie } });
    const stream = new Stream(socket);
    await Promise.race([
      stream.next((event) => event.type === 'hello'),
      new Promise((_, reject) => socket.once('error', reject)),
    ]);
    return stream;
  }
}

export class Stream {
  readonly events: Json[] = [];
  /** Resolves with the close code once the server or the test closes the connection. */
  readonly closed: Promise<number>;
  private readonly socket: WebSocket;
  private waiters: { match: (event: Json) => boolean; resolve: (event: Json) => void }[] = [];

  constructor(socket: WebSocket) {
    this.socket = socket;
    this.closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
    socket.on('message', (data) => {
      const event: Json = JSON.parse(data.toString());
      this.events.push(event);
      this.waiters = this.waiters.filter((waiter) => {
        if (!waiter.match(event)) return true;
        waiter.resolve(event);
        return false;
      });
    });
  }

  /** Resolve with the first event (already received or future) that matches. */
  next(match: (event: Json) => boolean, timeoutMs = 2000): Promise<Json> {
    const seen = this.events.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for event')), timeoutMs);
      this.waiters.push({
        match,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      });
    });
  }

  send(body: unknown): void {
    this.socket.send(JSON.stringify(body));
  }

  close(): void {
    this.socket.close();
  }
}

/** Create the workspace and return its owner's session. */
export async function setupWorkspace(test: TestApp): Promise<Session> {
  const owner = new Session(test.base);
  const result = await owner.ok('client.setup', {
    team_name: 'Acme',
    email: 'owner@acme.test',
    password: 'correct horse battery',
    real_name: 'Olive Owner',
    tz: 'Asia/Seoul',
  });
  owner.userId = result.user_id;
  return owner;
}

/** Invite and sign up one more member. */
export async function addMember(test: TestApp, inviter: Session, name: string): Promise<Session> {
  const { invite } = await inviter.ok('client.invites.create', {});
  const member = new Session(test.base);
  const result = await member.ok('client.signup', {
    code: invite.code,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@acme.test`,
    password: 'another long password',
    real_name: name,
  });
  member.userId = result.user_id;
  return member;
}

export interface Bot {
  token: string;
  userId: string;
  botId: string;
}

/** Insert a bot user and token directly, bypassing app management. */
export function createBot(test: TestApp, scopes: string[]): Bot {
  const ctx = test.app.ctx;
  const botId = newId('B');
  const appId = newId('A');
  const user = createUser(ctx, { realName: 'Test Bot', isBot: true, botId, appId });
  const token = createToken(ctx, { kind: 'bot', userId: user.id, appId, scopes });
  return { token, userId: user.id, botId };
}

/** Call the API with a token, form-encoded the way Slack SDKs do. */
export async function callWithToken(
  base: string,
  token: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<Json> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    body.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  return response.json();
}
