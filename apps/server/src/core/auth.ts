import { addressAllowed } from './network.ts';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Actor, Ctx } from '../ctx.ts';
import { newSecret, newToken, nowSeconds, sha256 } from './ids.ts';
import { getUser, type UserRow } from './users.ts';

const SESSION_COOKIE = 'sid';
const SESSION_TTL = 60 * 60 * 24 * 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, , salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function actorForUser(row: UserRow, kind: Actor['kind'], scopes: Set<string> | null): Actor {
  return {
    userId: row.id,
    kind,
    role: row.role,
    isBot: row.is_bot === 1,
    appId: row.app_id,
    botId: row.bot_id,
    scopes,
  };
}

// ── Browser sessions ────────────────────────────────────────────────────────

/** How long a sign-in lasts: the workspace's setting (`session_duration_days`), 30 days by default. */
/** Session settings an admin set for one person (admin.users.session.setSettings), if any. */
function personalSession(ctx: Ctx, userId: string | undefined): { duration?: number; browserQuit?: boolean } {
  if (!userId) return {};
  try {
    const prefs = JSON.parse(ctx.db.get<{ prefs: string }>('SELECT prefs FROM users WHERE id = ?', userId)?.prefs ?? '{}') as { session_duration?: unknown; session_browser_quit?: unknown };
    return {
      duration: typeof prefs.session_duration === 'number' ? prefs.session_duration : undefined,
      browserQuit: prefs.session_browser_quit === true,
    };
  } catch {
    return {};
  }
}

export function sessionTtl(ctx: Ctx, userId?: string): number {
  const personal = personalSession(ctx, userId).duration;
  if (personal) return personal;
  try {
    const days = (JSON.parse(ctx.team()?.prefs ?? '{}') as { session_duration_days?: unknown }).session_duration_days;
    return typeof days === 'number' && days >= 1 && days <= 365 ? Math.round(days * 86_400) : SESSION_TTL;
  } catch {
    return SESSION_TTL;
  }
}

export function createSession(ctx: Ctx, userId: string, userAgent: string, ip: string | null = null): string {
  const token = newSecret(32);
  const now = nowSeconds();
  ctx.db.run(
    'INSERT INTO sessions (token_hash, user_id, user_agent, created, expires, last_seen, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sha256(token),
    userId,
    userAgent.slice(0, 200),
    now,
    now + sessionTtl(ctx, userId),
    now,
    ip,
  );
  return token;
}

export function destroySession(ctx: Ctx, token: string): void {
  ctx.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

export function sessionCookie(ctx: Ctx, token: string | null, userId?: string): string {
  const flags = `Path=/; HttpOnly; SameSite=Lax${ctx.config.cookieSecure ? '; Secure' : ''}`;
  if (token === null) return `${SESSION_COOKIE}=; ${flags}; Max-Age=0`;
  // "End the session when the browser closes": a cookie without Max-Age.
  if (personalSession(ctx, userId).browserQuit) return `${SESSION_COOKIE}=${token}; ${flags}`;
  return `${SESSION_COOKIE}=${token}; ${flags}; Max-Age=${sessionTtl(ctx, userId)}`;
}

export function readSessionToken(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === SESSION_COOKIE) return part.slice(index + 1).trim();
  }
  return null;
}

function sessionActor(ctx: Ctx, token: string): Actor | null {
  const hash = sha256(token);
  const row = ctx.db.get<{ user_id: string; expires: number; last_seen: number | null }>(
    'SELECT user_id, expires, last_seen FROM sessions WHERE token_hash = ?',
    hash,
  );
  const now = nowSeconds();
  if (!row || row.expires < now) return null;
  // "Last active" for the sessions list; written at most every five minutes.
  if (row.last_seen === null || now - row.last_seen > 300) ctx.db.run('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', now, hash);
  const user = getUser(ctx, row.user_id);
  if (!user || user.deleted === 1) return null;
  return actorForUser(user, 'session', null);
}

// ── API tokens ──────────────────────────────────────────────────────────────

export interface NewToken {
  kind: 'bot' | 'user' | 'app';
  userId: string;
  appId?: string | null;
  scopes: string[];
  /** Seconds until the token stops working; rotating tokens (`xoxe.`) only. */
  expiresIn?: number;
}

/** Create an API token. The plain value is returned once; only its hash is stored. */
export function createToken(ctx: Ctx, input: NewToken): string {
  // Tokens that expire carry Slack's `xoxe.` prefix, as rotating tokens do there.
  const token = input.expiresIn ? `xoxe.${newToken(input.kind, input.appId)}` : newToken(input.kind, input.appId);
  const now = nowSeconds();
  ctx.db.run(
    'INSERT INTO tokens (token_hash, kind, app_id, user_id, scopes, hint, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    sha256(token),
    input.kind,
    input.appId ?? null,
    input.userId,
    input.scopes.join(','),
    `${token.slice(0, 9)}…${token.slice(-4)}`,
    now,
    input.expiresIn ? now + input.expiresIn : null,
  );
  return token;
}

function tokenActor(ctx: Ctx, token: string): Actor | 'expired' | null {
  const hash = sha256(token);
  const row = ctx.db.get<{ kind: Actor['kind']; app_id: string | null; user_id: string; scopes: string; expires: number | null }>(
    'SELECT kind, app_id, user_id, scopes, expires FROM tokens WHERE token_hash = ?',
    hash,
  );
  if (!row) return null;
  if (row.expires !== null && row.expires <= nowSeconds()) return 'expired';
  const user = getUser(ctx, row.user_id);
  if (!user || user.deleted === 1) return null;
  ctx.db.run('UPDATE tokens SET last_used = ? WHERE token_hash = ?', nowSeconds(), hash);
  const actor = actorForUser(user, row.kind, new Set(row.scopes.split(',').filter(Boolean)));
  if (row.app_id) actor.appId = row.app_id;
  return actor;
}

// ── Request authentication ──────────────────────────────────────────────────

export interface AuthResult {
  actor: Actor | null;
  /** A credential was presented but is not valid. */
  invalid: boolean;
  /** The credential was a rotating token past its expiry. */
  expired?: boolean;
  /** The credential is valid but this address is outside the workspace's IP allowlist. */
  addressRefused?: boolean;
}

/**
 * Identify the caller. API tokens arrive as `Authorization: Bearer …` or a
 * `token` argument; the web client sends its session cookie.
 */
export function authenticate(ctx: Ctx, req: IncomingMessage, tokenArg: string | undefined): AuthResult {
  const header = req.headers.authorization;
  const bearer = header && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : undefined;
  const token = bearer || tokenArg;
  if (token) {
    const actor = tokenActor(ctx, token);
    if (actor === 'expired') return { actor: null, invalid: true, expired: true };
    if (actor && !addressAllowed(ctx, req, 'token')) return { actor: null, invalid: true, addressRefused: true };
    return { actor, invalid: actor === null };
  }
  const session = readSessionToken(req);
  if (session) {
    const actor = sessionActor(ctx, session);
    if (actor && !addressAllowed(ctx, req, 'session')) return { actor: null, invalid: true, addressRefused: true };
    return { actor, invalid: actor === null };
  }
  return { actor: null, invalid: false };
}
