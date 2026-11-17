import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import type { Actor, Ctx } from '../ctx.ts';
import { authenticate } from '../core/auth.ts';
import { ApiError } from '../core/errors.ts';
import { isAdmin } from '../core/users.ts';
import { Args, type MethodDef, type Registry } from './registry.ts';

export interface RouteCall {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** Capture groups of the route pattern. */
  params: string[];
}

type RouteHandler = (call: RouteCall) => void | Promise<void>;

/** Plain HTTP routes outside `/api/*`: uploads, downloads, webhooks. */
export class Router {
  private readonly routes: { method: string | null; pattern: RegExp; handler: RouteHandler }[] = [];

  add(method: string | null, pattern: RegExp, handler: RouteHandler): void {
    this.routes.push({ method, pattern, handler });
  }

  match(method: string, path: string): { handler: RouteHandler; params: string[] } | null {
    for (const route of this.routes) {
      if (route.method && route.method !== method) continue;
      const match = route.pattern.exec(path);
      if (match) return { handler: route.handler, params: match.slice(1) };
    }
    return null;
  }
}

/** Returns true when it took over the socket. */
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) => boolean;

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new ApiError('request_too_large', {}, 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON or form-encoded body into a flat record. */
export function parseBody(contentType: string, body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  if (contentType.includes('application/json')) {
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      throw new ApiError('invalid_json');
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(body.toString('utf8'))) out[key] = value;
  return out;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

/**
 * Whether a browser request comes from this server's own pages. Requests
 * without an Origin header (non-browser clients, same-origin navigations) pass;
 * an Origin that is malformed, opaque ("null") or for another host does not.
 */
export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function requestOrigin(req: IncomingMessage): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ?? 'http';
  return `${proto}://${req.headers.host ?? 'localhost'}`;
}

// ── Rate limiting ───────────────────────────────────────────────────────────

/** Fixed one-minute windows per caller. Defaults are generous; the point is to stop runaway loops. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly limit: number;

  constructor(limitPerMinute: number) {
    this.limit = limitPerMinute;
    setInterval(() => this.sweep(), 60_000).unref();
  }

  /** Seconds to wait, or 0 when the call may proceed. */
  check(key: string, limit = this.limit): number {
    const now = Date.now();
    const window = this.windows.get(key);
    if (!window || now - window.start >= 60_000) {
      this.windows.set(key, { start: now, count: 1 });
      return 0;
    }
    window.count += 1;
    if (window.count <= limit) return 0;
    return Math.max(1, Math.ceil((window.start + 60_000 - now) / 1000));
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, window] of this.windows) {
      if (now - window.start >= 60_000) this.windows.delete(key);
    }
  }
}

// ── API dispatch ────────────────────────────────────────────────────────────

/** Check that an authenticated caller may use a method: credential type, role and token scopes. */
export function authorize(def: MethodDef, actor: Actor): void {
  if (def.auth === 'session' && actor.kind !== 'session') throw new ApiError('not_allowed_token_type');
  if (def.auth === 'admin' && !isAdmin(actor)) throw new ApiError('not_allowed');
  if (actor.kind === 'app' && !def.scopes.includes('connections:write')) {
    throw new ApiError('not_allowed_token_type');
  }
  if (actor.scopes && def.scopes.length > 0 && !def.scopes.some((scope) => actor.scopes!.has(scope))) {
    throw new ApiError('missing_scope', { needed: def.scopes.join(','), provided: [...actor.scopes].join(',') });
  }
}

const SIGN_IN_METHODS = new Set([
  'client.signin',
  'client.signup',
  'client.setup',
  'client.signin.twoFactor',
  'client.signin.sendCode',
  'client.signin.withCode',
  'client.password.sendReset',
  'client.password.reset',
]);

async function handleApi(
  ctx: Ctx,
  registry: Registry,
  limiter: RateLimiter,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const name = url.pathname.slice('/api/'.length);
  try {
    const raw: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams) raw[key] = value;
    if (req.method === 'POST') {
      const contentType = String(req.headers['content-type'] ?? '');
      Object.assign(raw, parseBody(contentType, await readBody(req)));
    }
    const args = new Args(raw);

    const def = registry.get(name);
    if (!def) {
      registry.onUnknown?.(name);
      throw new ApiError('unknown_method', { req_method: name });
    }

    const { actor, invalid } = authenticate(ctx, req, args.str('token'));
    if (def.auth !== 'none') {
      if (!actor) throw new ApiError(invalid ? 'invalid_auth' : 'not_authed');
      if (actor.kind === 'session') {
        // Cookie-authenticated calls must be same-origin POSTs.
        if (req.method !== 'POST' || !isSameOrigin(req)) throw new ApiError('invalid_auth');
      }
      authorize(def, actor);
      for (const guard of registry.guards) guard(name, actor);
    }

    const ip = req.socket.remoteAddress ?? 'unknown';
    const wait = SIGN_IN_METHODS.has(name)
      ? limiter.check(`signin:${ip}:${name}`, 20)
      : limiter.check(actor ? `actor:${actor.userId}:${actor.kind}` : `ip:${ip}`);
    if (wait > 0) {
      sendJson(res, 429, { ok: false, error: 'ratelimited' }, { 'retry-after': String(wait) });
      return;
    }

    const result = await def.handler({ ctx, actor: actor as never, args, req, res });
    if (res.writableEnded) return;
    sendJson(res, 200, { ok: true, ...(result ?? {}) });
  } catch (error) {
    if (res.writableEnded) return;
    if (error instanceof ApiError) {
      sendJson(res, error.status, { ok: false, error: error.code, ...error.extra });
      return;
    }
    console.error(`[api] ${name} failed`, error);
    sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
}

// ── Static web client ───────────────────────────────────────────────────────

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg',
  '.map': 'application/json',
};

async function serveStatic(webDir: string, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  const safe = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  let file = join(webDir, safe);
  if (!file.startsWith(webDir.endsWith(sep) ? webDir : webDir + sep) && file !== webDir) return false;
  let info = await stat(file).catch(() => null);
  if (!info || info.isDirectory()) {
    // Single-page app: unknown paths get the shell.
    if (extname(safe)) return false;
    file = join(webDir, 'index.html');
    info = await stat(file).catch(() => null);
    if (!info) return false;
  }
  const hashed = /\/assets\//.test(file);
  res.writeHead(200, {
    'content-type': STATIC_TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
  return true;
}

// ── Server ──────────────────────────────────────────────────────────────────

export interface HttpParts {
  registry: Registry;
  router: Router;
  upgrades: UpgradeHandler[];
  rateLimitPerMinute: number;
}

export function createHttpServer(ctx: Ctx, parts: HttpParts): Server {
  const limiter = new RateLimiter(parts.rateLimitPerMinute);

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      try {
        if (url.pathname.startsWith('/api/')) {
          if (method !== 'GET' && method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
            return;
          }
          await handleApi(ctx, parts.registry, limiter, req, res, url);
          return;
        }
        if (url.pathname === '/healthz') {
          sendJson(res, 200, { ok: true, version: ctx.config.version });
          return;
        }
        const route = parts.router.match(method, url.pathname);
        if (route) {
          await route.handler({ req, res, url, params: route.params });
          return;
        }
        if (ctx.config.webDir && (method === 'GET' || method === 'HEAD')) {
          if (await serveStatic(ctx.config.webDir, req, res, url.pathname)) return;
        }
        sendJson(res, 404, { ok: false, error: 'not_found' });
      } catch (error) {
        if (res.writableEnded) return;
        if (error instanceof ApiError) {
          sendJson(res, error.status === 200 ? 400 : error.status, { ok: false, error: error.code, ...error.extra });
          return;
        }
        console.error(`[http] ${method} ${url.pathname} failed`, error);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal_error' });
        else res.end();
      }
    })();
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      for (const handler of parts.upgrades) {
        if (handler(req, socket, head, url)) return;
      }
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    } catch (error) {
      console.error('[http] upgrade failed', error);
    }
    socket.destroy();
  });

  return server;
}
