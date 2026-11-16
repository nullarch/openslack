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

export function createSession(ctx: Ctx, userId: string, userAgent: string): string {
  const token = newSecret(32);
  const now = nowSeconds();
  ctx.db.run(
    'INSERT INTO sessions (token_hash, user_id, user_agent, created, expires) VALUES (?, ?, ?, ?, ?)',
    sha256(token),
    userId,
    userAgent.slice(0, 200),
    now,
    now + SESSION_TTL,
  );
  return token;
}

export function destroySession(ctx: Ctx, token: string): void {
  ctx.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

export function sessionCookie(ctx: Ctx, token: string | null): string {
  const flags = `Path=/; HttpOnly; SameSite=Lax${ctx.config.cookieSecure ? '; Secure' : ''}`;
  if (token === null) return `${SESSION_COOKIE}=; ${flags}; Max-Age=0`;
  return `${SESSION_COOKIE}=${token}; ${flags}; Max-Age=${SESSION_TTL}`;
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
  const row = ctx.db.get<{ user_id: string; expires: number }>(
    'SELECT user_id, expires FROM sessions WHERE token_hash = ?',
    sha256(token),
  );
  if (!row || row.expires < nowSeconds()) return null;
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
}

/** Create an API token. The plain value is returned once; only its hash is stored. */
export function createToken(ctx: Ctx, input: NewToken): string {
  const token = newToken(input.kind);
  ctx.db.run(
    'INSERT INTO tokens (token_hash, kind, app_id, user_id, scopes, hint, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sha256(token),
    input.kind,
    input.appId ?? null,
    input.userId,
    input.scopes.join(','),
    `${token.slice(0, 9)}…${token.slice(-4)}`,
    nowSeconds(),
  );
  return token;
}

function tokenActor(ctx: Ctx, token: string): Actor | null {
  const hash = sha256(token);
  const row = ctx.db.get<{ kind: Actor['kind']; app_id: string | null; user_id: string; scopes: string }>(
    'SELECT kind, app_id, user_id, scopes FROM tokens WHERE token_hash = ?',
    hash,
  );
  if (!row) return null;
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
    return { actor, invalid: actor === null };
  }
  const session = readSessionToken(req);
  if (session) {
    const actor = sessionActor(ctx, session);
    return { actor, invalid: actor === null };
  }
  return { actor: null, invalid: false };
}
