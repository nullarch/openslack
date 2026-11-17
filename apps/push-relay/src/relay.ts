import { createHash, createPrivateKey, createPublicKey, createSign, verify, type KeyObject } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as http2Connect, type ClientHttp2Session } from 'node:http2';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

/**
 * The push relay for the native apps.
 *
 * A phone's push token can only be used with the credentials of whoever
 * published the app (an Apple key, a Firebase service account), which a
 * self-hosted server does not have. Servers send each notification here,
 * signed with their own Ed25519 key (the same key and scheme as server to
 * server requests: `X-Federation-Server`, `-Date`, `-Signature`); the relay
 * checks the signature against the key the server publishes at
 * `/federation/v1/server`, limits how much each server may send, and passes
 * the notification to Apple (APNs) or Google (FCM). It stores nothing.
 */

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** The .p8 key, PEM. */
  key: string;
  /** The app's bundle id. */
  topic: string;
  /** https://api.push.apple.com (production) or https://api.sandbox.push.apple.com. */
  origin: string;
}

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  /** The service account's private key, PEM. */
  privateKey: string;
  tokenUrl: string;
  sendOrigin: string;
}

export interface RelayConfig {
  apns?: ApnsConfig | null;
  fcm?: FcmConfig | null;
  /** Notifications one server may send per minute. */
  perServerPerMinute: number;
  /** Fetch keys from servers on private addresses (tests, a relay for one network). */
  allowPrivateServers: boolean;
  /** Only these server origins, when set. */
  allowedServers?: string[] | null;
}

interface Notification {
  platform: 'ios' | 'android';
  token: string;
  title: string;
  body: string;
  collapse_id?: string;
  data?: Record<string, string>;
}

interface Result {
  token: string;
  ok: boolean;
  error?: 'unregistered' | 'rejected' | 'unavailable' | 'not_configured';
}

const MAX_BODY = 256 * 1024;
const MAX_NOTIFICATIONS = 100;
const KEY_TTL_MS = 3600_000;
const MAX_SKEW_MS = 5 * 60_000;

// ── Signatures (the scheme of apps/server/src/federation/keys.ts) ───────────

function signingString(method: string, path: string, date: string, body: Buffer): string {
  return `${method}\n${path}\n${date}\n${createHash('sha256').update(body).digest('hex')}`;
}

function publicKey(raw: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
}

export function signatureValid(raw: string, method: string, path: string, body: Buffer, date: string, signature: string): boolean {
  if (!/^\d{10,16}$/.test(date) || Math.abs(Date.now() - Number(date)) > MAX_SKEW_MS) return false;
  try {
    return verify(null, Buffer.from(signingString(method, path, date, body)), publicKey(raw), Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

// ── Small HTTP helpers ───────────────────────────────────────────────────────

function isPrivate(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) return isPrivate(lower.slice(7));
  if (lower.includes(':')) return lower === '::1' || lower === '::' || /^f[cd]/.test(lower) || lower.startsWith('fe80');
  const [a = 0, b = 0] = lower.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

async function publicAddress(host: string): Promise<boolean> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) return !isPrivate(bare);
  const addresses = await lookup(bare, { all: true }).catch(() => []);
  return addresses.length > 0 && addresses.every((entry) => !isPrivate(entry.address));
}

function send(url: string, options: { method: string; headers: Record<string, string>; body?: string }, timeoutMs = 10_000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: options.method, headers: options.headers, timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_BODY) chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end(options.body);
  });
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function jwt(header: Record<string, string>, claims: Record<string, unknown>, key: string, algorithm: 'ES256' | 'RS256'): string {
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign('SHA256');
  signer.update(unsigned);
  const signature = algorithm === 'ES256' ? signer.sign({ key: createPrivateKey(key), dsaEncoding: 'ieee-p1363' }) : signer.sign(createPrivateKey(key));
  return `${unsigned}.${base64url(signature)}`;
}

// ── Apple ────────────────────────────────────────────────────────────────────

class Apns {
  private readonly config: ApnsConfig;
  private session: ClientHttp2Session | null = null;
  private token: { value: string; at: number } | null = null;

  constructor(config: ApnsConfig) {
    this.config = config;
  }

  private bearer(): string {
    // Apple wants a new token at most once every 20 minutes and refuses one older than an hour.
    if (!this.token || Date.now() - this.token.at > 40 * 60_000) {
      const now = Math.floor(Date.now() / 1000);
      this.token = { value: jwt({ alg: 'ES256', kid: this.config.keyId }, { iss: this.config.teamId, iat: now }, this.config.key, 'ES256'), at: Date.now() };
    }
    return this.token.value;
  }

  private connection(): ClientHttp2Session {
    if (!this.session || this.session.closed || this.session.destroyed) {
      this.session = http2Connect(this.config.origin);
      this.session.on('error', () => {
        this.session = null;
      });
      this.session.unref();
    }
    return this.session;
  }

  send(notification: Notification): Promise<Result> {
    const payload = JSON.stringify({
      aps: { alert: { title: notification.title, body: notification.body }, sound: 'default', ...(notification.collapse_id ? { 'thread-id': notification.collapse_id } : {}) },
      ...(notification.data ?? {}),
    });
    return new Promise((resolve) => {
      let stream;
      try {
        stream = this.connection().request({
          ':method': 'POST',
          ':path': `/3/device/${notification.token}`,
          authorization: `bearer ${this.bearer()}`,
          'apns-topic': this.config.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': String(Math.floor(Date.now() / 1000) + 24 * 3600),
          ...(notification.collapse_id ? { 'apns-collapse-id': notification.collapse_id } : {}),
          'content-type': 'application/json',
        });
      } catch {
        resolve({ token: notification.token, ok: false, error: 'unavailable' });
        return;
      }
      let status = 0;
      let text = '';
      stream.setTimeout(10_000, () => stream.close());
      stream.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
      });
      stream.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8');
      });
      stream.on('close', () => {
        if (status === 200) resolve({ token: notification.token, ok: true });
        else {
          let reason = '';
          try {
            reason = String((JSON.parse(text) as { reason?: string }).reason ?? '');
          } catch {
            reason = '';
          }
          const gone = status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'DeviceTokenNotForTopic';
          resolve({ token: notification.token, ok: false, error: gone ? 'unregistered' : status >= 500 || status === 0 ? 'unavailable' : 'rejected' });
        }
      });
      stream.on('error', () => undefined);
      stream.end(payload);
    });
  }

  close(): void {
    this.session?.close();
  }
}

// ── Google ───────────────────────────────────────────────────────────────────

class Fcm {
  private readonly config: FcmConfig;
  private access: { token: string; expires: number } | null = null;

  constructor(config: FcmConfig) {
    this.config = config;
  }

  private async bearer(): Promise<string> {
    if (this.access && this.access.expires - 60_000 > Date.now()) return this.access.token;
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt(
      { alg: 'RS256', typ: 'JWT' },
      { iss: this.config.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: this.config.tokenUrl, iat: now, exp: now + 3600 },
      this.config.privateKey,
      'RS256',
    );
    const response = await send(this.config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    const body = JSON.parse(response.body) as { access_token?: string; expires_in?: number };
    if (response.status !== 200 || !body.access_token) throw new Error(`token ${response.status}`);
    this.access = { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return this.access.token;
  }

  async send(notification: Notification): Promise<Result> {
    let bearer: string;
    try {
      bearer = await this.bearer();
    } catch {
      return { token: notification.token, ok: false, error: 'unavailable' };
    }
    const message = {
      message: {
        token: notification.token,
        notification: { title: notification.title, body: notification.body },
        data: notification.data ?? {},
        android: {
          priority: 'HIGH',
          ...(notification.collapse_id ? { collapse_key: notification.collapse_id, notification: { tag: notification.collapse_id } } : {}),
        },
      },
    };
    try {
      const response = await send(`${this.config.sendOrigin}/v1/projects/${encodeURIComponent(this.config.projectId)}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify(message),
      });
      if (response.status === 200) return { token: notification.token, ok: true };
      const text = response.body;
      const gone = response.status === 404 || /UNREGISTERED|registration-token-not-registered/.test(text) || (response.status === 400 && /token/i.test(text));
      return { token: notification.token, ok: false, error: gone ? 'unregistered' : response.status >= 500 ? 'unavailable' : 'rejected' };
    } catch {
      return { token: notification.token, ok: false, error: 'unavailable' };
    }
  }
}

// ── The relay ────────────────────────────────────────────────────────────────

function valid(entry: unknown): entry is Notification {
  const item = entry as Notification | undefined;
  return (
    !!item &&
    (item.platform === 'ios' || item.platform === 'android') &&
    typeof item.token === 'string' &&
    /^[A-Za-z0-9_:.\-]{16,4096}$/.test(item.token) &&
    typeof item.title === 'string' &&
    typeof item.body === 'string' &&
    (item.collapse_id === undefined || (typeof item.collapse_id === 'string' && item.collapse_id.length <= 64)) &&
    (item.data === undefined || (typeof item.data === 'object' && item.data !== null && Object.values(item.data).every((value) => typeof value === 'string')))
  );
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

export interface Relay {
  server: Server;
  close(): Promise<void>;
}

export function createRelay(config: RelayConfig): Relay {
  const apns = config.apns ? new Apns(config.apns) : null;
  const fcm = config.fcm ? new Fcm(config.fcm) : null;
  const keys = new Map<string, { key: string; at: number }>();
  const windows = new Map<string, { start: number; count: number }>();

  /** The key a server publishes, fetched now and then. */
  const keyOf = async (origin: string, fresh: boolean): Promise<string | null> => {
    const known = keys.get(origin);
    if (known && !fresh && Date.now() - known.at < KEY_TTL_MS) return known.key;
    const url = new URL(origin);
    if (!config.allowPrivateServers && !(await publicAddress(url.hostname))) return null;
    try {
      const response = await send(`${origin}/federation/v1/server`, { method: 'GET', headers: { accept: 'application/json' } }, 5000);
      const body = JSON.parse(response.body) as { server?: { url?: string; public_key?: string } };
      const key = body.server?.public_key;
      if (response.status !== 200 || typeof key !== 'string' || body.server?.url !== origin) return null;
      keys.set(origin, { key, at: Date.now() });
      return key;
    } catch {
      return null;
    }
  };

  const allowance = (origin: string, count: number): boolean => {
    const now = Date.now();
    const window = windows.get(origin);
    if (!window || now - window.start >= 60_000) {
      windows.set(origin, { start: now, count });
      return count <= config.perServerPerMinute;
    }
    window.count += count;
    return window.count <= config.perServerPerMinute;
  };

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://relay').pathname;
    if (req.method === 'GET' && path === '/healthz') {
      json(res, 200, { ok: true, apns: Boolean(apns), fcm: Boolean(fcm) });
      return;
    }
    if (req.method !== 'POST' || path !== '/v1/push') {
      json(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    const body = await readBody(req);
    if (!body) {
      json(res, 413, { ok: false, error: 'too_large' });
      return;
    }
    const origin = String(req.headers['x-federation-server'] ?? '');
    const date = String(req.headers['x-federation-date'] ?? '');
    const signature = String(req.headers['x-federation-signature'] ?? '');
    let parsedOrigin: string | null = null;
    try {
      parsedOrigin = new URL(origin).origin === origin && /^https?:$/.test(new URL(origin).protocol) ? origin : null;
    } catch {
      parsedOrigin = null;
    }
    if (!parsedOrigin || (config.allowedServers && !config.allowedServers.includes(parsedOrigin))) {
      json(res, 403, { ok: false, error: 'server_not_allowed' });
      return;
    }
    let key = await keyOf(parsedOrigin, false);
    let signed = key !== null && signatureValid(key, 'POST', '/v1/push', body, date, signature);
    // The server may have a new key: look once more before refusing.
    if (!signed && key !== null) {
      key = await keyOf(parsedOrigin, true);
      signed = key !== null && signatureValid(key, 'POST', '/v1/push', body, date, signature);
    }
    if (!signed) {
      json(res, 401, { ok: false, error: 'invalid_signature' });
      return;
    }
    let notifications: unknown[];
    try {
      const parsed = JSON.parse(body.toString('utf8')) as { notifications?: unknown };
      notifications = Array.isArray(parsed.notifications) ? parsed.notifications : [];
    } catch {
      json(res, 400, { ok: false, error: 'invalid_json' });
      return;
    }
    if (notifications.length === 0 || notifications.length > MAX_NOTIFICATIONS || !notifications.every(valid)) {
      json(res, 400, { ok: false, error: 'invalid_notifications' });
      return;
    }
    if (!allowance(parsedOrigin, notifications.length)) {
      json(res, 429, { ok: false, error: 'ratelimited' });
      return;
    }
    const results = await Promise.all(
      (notifications as Notification[]).map((notification) => {
        const transport = notification.platform === 'ios' ? apns : fcm;
        return transport ? transport.send({ ...notification, title: notification.title.slice(0, 200), body: notification.body.slice(0, 1000) }) : Promise.resolve<Result>({ token: notification.token, ok: false, error: 'not_configured' });
      }),
    );
    json(res, 200, { ok: true, results });
  });

  return {
    server,
    close: () =>
      new Promise((resolve) => {
        apns?.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Configuration from the environment (see README.md). */
export async function configFromEnv(env: NodeJS.ProcessEnv): Promise<RelayConfig> {
  const { readFileSync } = await import('node:fs');
  const read = (inline: string | undefined, file: string | undefined): string | null => (inline ? inline.replace(/\\n/g, '\n') : file ? readFileSync(file, 'utf8') : null);
  const apnsKey = read(env.APNS_KEY, env.APNS_KEY_FILE);
  const account = read(env.FCM_SERVICE_ACCOUNT_JSON, env.FCM_SERVICE_ACCOUNT_FILE);
  const parsedAccount = account ? (JSON.parse(account) as { project_id: string; client_email: string; private_key: string; token_uri?: string }) : null;
  return {
    apns:
      apnsKey && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC
        ? { keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, key: apnsKey, topic: env.APNS_TOPIC, origin: env.APNS_ORIGIN ?? 'https://api.push.apple.com' }
        : null,
    fcm: parsedAccount
      ? {
          projectId: parsedAccount.project_id,
          clientEmail: parsedAccount.client_email,
          privateKey: parsedAccount.private_key,
          tokenUrl: parsedAccount.token_uri ?? 'https://oauth2.googleapis.com/token',
          sendOrigin: env.FCM_ORIGIN ?? 'https://fcm.googleapis.com',
        }
      : null,
    perServerPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 600),
    allowPrivateServers: env.ALLOW_PRIVATE_SERVERS === '1',
    allowedServers: env.ALLOWED_SERVERS ? env.ALLOWED_SERVERS.split(',').map((value) => value.trim()).filter(Boolean) : null,
  };
}
