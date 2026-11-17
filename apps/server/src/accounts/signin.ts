import { randomInt } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BRAND } from '@app/shared';
import { isSameOrigin } from '../api/http.ts';
import type { Registry } from '../api/registry.ts';
import { decoyHash, validEmail, validPassword } from '../api/methods/client.ts';
import { createSession, hashPassword, sessionCookie, verifyPassword } from '../core/auth.ts';
import { fail } from '../core/errors.ts';
import { newSecret, nowSeconds, sha256 } from '../core/ids.ts';
import { mailEnabled, sendMail } from '../core/mail.ts';
import { getUser, requireUser, type UserRow } from '../core/users.ts';
import type { Ctx } from '../ctx.ts';
import { guestExpired } from '../core/guests.ts';
import { teamPrefs } from './prefs.ts';
import { newTotpSecret, otpauthUrl, verifyTotp } from './totp.ts';

/**
 * Every way of signing in ends in `finishSignIn`: it refuses inactive
 * accounts, asks for the second factor when the person has one, and otherwise
 * starts a session.
 */

const CHALLENGE_COOKIE = 'tfa';
const CHALLENGE_TTL = 10 * 60;
const CODE_TTL = 10 * 60;
const RESET_TTL = 60 * 60;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_WINDOW = 5;
const BACKUP_CODES = 10;

function cookie(ctx: Ctx, name: string, value: string | null, maxAge: number): string {
  const flags = `Path=/; HttpOnly; SameSite=Lax${ctx.config.cookieSecure ? '; Secure' : ''}`;
  return value === null ? `${name}=; ${flags}; Max-Age=0` : `${name}=${value}; ${flags}; Max-Age=${maxAge}`;
}

function readCookie(req: IncomingMessage, name: string): string | null {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/** The address links in mail should point at: where the request came from, else the configured address. */
export function linkOrigin(ctx: Ctx, req: IncomingMessage): string {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== 'null' && isSameOrigin(req)) return origin.replace(/\/+$/, '');
  return ctx.config.publicUrl;
}

export function activeOrFail(user: UserRow | undefined): UserRow {
  if (!user || user.is_bot === 1) fail('invalid_credentials');
  if (user.deleted === 1 || guestExpired(user)) fail('account_inactive');
  return user;
}

export interface SignInResult {
  user_id?: string;
  two_factor_required?: boolean;
}

/** Start a session, or a second-factor challenge when the person uses one. */
export function finishSignIn(ctx: Ctx, user: UserRow, req: IncomingMessage, res: ServerResponse): SignInResult {
  activeOrFail(user);
  if (user.totp_enabled === 1) {
    const token = newSecret(24);
    const now = nowSeconds();
    ctx.db.run('DELETE FROM login_challenges WHERE expires < ?', now);
    ctx.db.run(
      'INSERT INTO login_challenges (token_hash, user_id, created, expires) VALUES (?, ?, ?, ?)',
      sha256(token),
      user.id,
      now,
      now + CHALLENGE_TTL,
    );
    res.setHeader('set-cookie', cookie(ctx, CHALLENGE_COOKIE, token, CHALLENGE_TTL));
    return { two_factor_required: true };
  }
  const token = createSession(ctx, user.id, String(req.headers['user-agent'] ?? ''));
  res.setHeader('set-cookie', [sessionCookie(ctx, token), cookie(ctx, CHALLENGE_COOKIE, null, 0)]);
  return { user_id: user.id };
}

// ── Second factor ───────────────────────────────────────────────────────────

/** Accept a current authenticator code or an unused backup code. Records what was used. */
export function checkSecondFactor(ctx: Ctx, user: UserRow, code: string): boolean {
  const clean = code.trim();
  if (user.totp_secret && user.totp_enabled === 1) {
    const step = verifyTotp(user.totp_secret, clean, user.totp_last_step);
    if (step !== null) {
      ctx.db.run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, user.id);
      return true;
    }
  }
  const backup = clean.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (backup.length === 10) {
    const used = ctx.db.run(
      'UPDATE backup_codes SET used = 1 WHERE user_id = ? AND code_hash = ? AND used = 0',
      user.id,
      sha256(`${user.id}:${backup}`),
    );
    if (used.changes > 0) return true;
  }
  return false;
}

function newBackupCodes(ctx: Ctx, userId: string): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const codes: string[] = [];
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM backup_codes WHERE user_id = ?', userId);
    for (let n = 0; n < BACKUP_CODES; n += 1) {
      let code = '';
      for (let i = 0; i < 10; i += 1) code += alphabet[randomInt(alphabet.length)];
      ctx.db.run('INSERT INTO backup_codes (user_id, code_hash) VALUES (?, ?)', userId, sha256(`${userId}:${code}`));
      codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
    }
  });
  return codes;
}

/** True when the workspace requires two-factor sign-in and this person has not set it up yet. */
export function twoFactorPending(ctx: Ctx, userId: string): boolean {
  if (!teamPrefs(ctx).require_2fa) return false;
  const user = getUser(ctx, userId);
  return user !== undefined && user.is_bot === 0 && user.totp_enabled === 0;
}

/** Methods a person who still has to set up two-factor sign-in may call. */
export const TWO_FACTOR_SETUP_METHODS = new Set([
  'client.status',
  'client.signout',
  'client.twoFactor.status',
  'client.twoFactor.begin',
  'client.twoFactor.enable',
]);

// ── Mail codes ──────────────────────────────────────────────────────────────

function codeHash(userId: string, code: string): string {
  return sha256(`${userId}:${code}`);
}

function throttled(ctx: Ctx, userId: string, purpose: 'signin' | 'reset'): boolean {
  const recent =
    ctx.db.get<{ n: number }>(
      'SELECT count(*) AS n FROM mail_codes WHERE user_id = ? AND purpose = ? AND created > ?',
      userId,
      purpose,
      nowSeconds() - CODE_TTL,
    )?.n ?? 0;
  return recent >= MAX_CODES_PER_WINDOW;
}

function issueCode(ctx: Ctx, userId: string, purpose: 'signin' | 'reset', secret: string, ttl: number): void {
  const now = nowSeconds();
  ctx.db.run('DELETE FROM mail_codes WHERE expires < ?', now);
  ctx.db.run(
    'INSERT INTO mail_codes (code_hash, purpose, user_id, created, expires) VALUES (?, ?, ?, ?, ?)',
    codeHash(userId, secret),
    purpose,
    userId,
    now,
    now + ttl,
  );
}

function findUserByEmail(ctx: Ctx, email: string): UserRow | undefined {
  return ctx.db.get<UserRow>('SELECT * FROM users WHERE email = ? AND is_bot = 0', email.trim().toLowerCase());
}

export function registerSignIn(registry: Registry): void {
  registry.addPublic('client.signin', async ({ ctx, args, req, res }) => {
    ctx.requireTeam();
    const email = args.req('email').trim().toLowerCase();
    const password = args.req('password');
    const user = findUserByEmail(ctx, email);
    // Always do the hashing work, so response time does not reveal whether the address exists.
    const valid = await verifyPassword(password, user?.password_hash ?? (await decoyHash()));
    if (!user || !valid) fail('invalid_credentials');
    return { ...finishSignIn(ctx, user, req, res) };
  });

  registry.addPublic('client.signin.twoFactor', ({ ctx, args, req, res }) => {
    const token = readCookie(req, CHALLENGE_COOKIE);
    const challenge = token
      ? ctx.db.get<{ token_hash: string; user_id: string; attempts: number; expires: number }>(
          'SELECT * FROM login_challenges WHERE token_hash = ?',
          sha256(token),
        )
      : undefined;
    if (!challenge || challenge.expires < nowSeconds()) fail('challenge_expired');
    if (challenge.attempts >= MAX_ATTEMPTS) {
      ctx.db.run('DELETE FROM login_challenges WHERE token_hash = ?', challenge.token_hash);
      fail('challenge_expired');
    }
    const user = activeOrFail(getUser(ctx, challenge.user_id));
    if (!checkSecondFactor(ctx, user, args.req('code'))) {
      ctx.db.run('UPDATE login_challenges SET attempts = attempts + 1 WHERE token_hash = ?', challenge.token_hash);
      fail('invalid_code');
    }
    ctx.db.run('DELETE FROM login_challenges WHERE token_hash = ?', challenge.token_hash);
    const session = createSession(ctx, user.id, String(req.headers['user-agent'] ?? ''));
    res.setHeader('set-cookie', [sessionCookie(ctx, session), cookie(ctx, CHALLENGE_COOKIE, null, 0)]);
    return { user_id: user.id };
  });

  // Sign in with a code sent by mail. The answer is the same whether or not the address exists.
  registry.addPublic('client.signin.sendCode', async ({ ctx, args }) => {
    ctx.requireTeam();
    if (!mailEnabled(ctx)) fail('mail_not_configured');
    const email = validEmail(args.req('email'));
    const user = findUserByEmail(ctx, email);
    if (!user || user.deleted === 1 || guestExpired(user) || throttled(ctx, user.id, 'signin')) return {};
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    issueCode(ctx, user.id, 'signin', code, CODE_TTL);
    const team = ctx.requireTeam();
    await sendMail(ctx, {
      to: email,
      subject: `${code} is your sign-in code for ${team.name}`,
      text: `Your sign-in code for ${team.name} is:\n\n${code}\n\nIt works for 10 minutes. If you did not ask for it, you can ignore this message.`,
    }).catch(() => fail('mail_failed'));
    return {};
  });

  registry.addPublic('client.signin.withCode', ({ ctx, args, req, res }) => {
    ctx.requireTeam();
    const user = findUserByEmail(ctx, args.req('email'));
    const code = args.req('code').replace(/\s+/g, '');
    if (!user) fail('invalid_code');
    const row = ctx.db.get<{ code_hash: string; attempts: number; expires: number }>(
      "SELECT code_hash, attempts, expires FROM mail_codes WHERE user_id = ? AND purpose = 'signin' ORDER BY created DESC LIMIT 1",
      user.id,
    );
    if (!row || row.expires < nowSeconds() || row.attempts >= MAX_ATTEMPTS) fail('invalid_code');
    if (row.code_hash !== codeHash(user.id, code)) {
      ctx.db.run('UPDATE mail_codes SET attempts = attempts + 1 WHERE code_hash = ?', row.code_hash);
      fail('invalid_code');
    }
    ctx.db.run("DELETE FROM mail_codes WHERE user_id = ? AND purpose = 'signin'", user.id);
    return { ...finishSignIn(ctx, user, req, res) };
  });

  registry.addPublic('client.password.sendReset', async ({ ctx, args, req }) => {
    ctx.requireTeam();
    if (!mailEnabled(ctx)) fail('mail_not_configured');
    const email = validEmail(args.req('email'));
    const user = findUserByEmail(ctx, email);
    if (!user || user.deleted === 1 || guestExpired(user) || throttled(ctx, user.id, 'reset')) return {};
    const token = newSecret(24);
    issueCode(ctx, user.id, 'reset', token, RESET_TTL);
    const team = ctx.requireTeam();
    await sendMail(ctx, {
      to: email,
      subject: `Reset your password for ${team.name}`,
      text: `Someone asked to reset the password for ${email} on ${team.name}. The link works for one hour.\n\nIf it was not you, ignore this message; your password stays the same.`,
      action: { label: 'Choose a new password', url: `${linkOrigin(ctx, req)}/reset/${user.id}-${token}` },
    }).catch(() => fail('mail_failed'));
    return {};
  });

  registry.addPublic('client.password.reset', async ({ ctx, args, req, res }) => {
    // `<user id>-<secret>`: ids never contain a dash, and a dot would read as a file extension in the path.
    const raw = args.req('token');
    const dash = raw.indexOf('-');
    const userId = dash > 0 ? raw.slice(0, dash) : '';
    const token = dash > 0 ? raw.slice(dash + 1) : '';
    const user = getUser(ctx, userId);
    const row = user
      ? ctx.db.get<{ code_hash: string; expires: number }>(
          "SELECT code_hash, expires FROM mail_codes WHERE code_hash = ? AND purpose = 'reset'",
          codeHash(user.id, token),
        )
      : undefined;
    if (!user || !row || row.expires < nowSeconds()) fail('invalid_token');
    const passwordHash = await hashPassword(validPassword(args.req('password')));
    ctx.db.tx(() => {
      ctx.db.run('UPDATE users SET password_hash = ?, updated = ? WHERE id = ?', passwordHash, nowSeconds(), user.id);
      ctx.db.run("DELETE FROM mail_codes WHERE user_id = ? AND purpose = 'reset'", user.id);
      // Everyone holding the old password is signed out.
      ctx.db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
    });
    return { ...finishSignIn(ctx, requireUser(ctx, user.id), req, res) };
  });

  // ── Two-factor settings ───────────────────────────────────────────────────

  registry.add('client.twoFactor.status', { auth: 'session' }, ({ ctx, actor }) => {
    const user = requireUser(ctx, actor.userId);
    const left =
      ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM backup_codes WHERE user_id = ? AND used = 0', user.id)?.n ?? 0;
    return { enabled: user.totp_enabled === 1, required: teamPrefs(ctx).require_2fa === true, backup_codes_left: left };
  });

  registry.add('client.twoFactor.begin', { auth: 'session' }, ({ ctx, actor }) => {
    const user = requireUser(ctx, actor.userId);
    if (user.totp_enabled === 1) fail('already_enabled');
    const secret = newTotpSecret();
    ctx.db.run('UPDATE users SET totp_secret = ? WHERE id = ?', secret, user.id);
    const team = ctx.requireTeam();
    return { secret, otpauth_url: otpauthUrl(secret, user.email ?? user.name, `${team.name} (${BRAND.name})`) };
  });

  registry.add('client.twoFactor.enable', { auth: 'session' }, ({ ctx, actor, args }) => {
    const user = requireUser(ctx, actor.userId);
    if (user.totp_enabled === 1) fail('already_enabled');
    if (!user.totp_secret) fail('not_started');
    const step = verifyTotp(user.totp_secret, args.req('code'), 0);
    if (step === null) fail('invalid_code');
    ctx.db.run('UPDATE users SET totp_enabled = 1, totp_last_step = ?, updated = ? WHERE id = ?', step, nowSeconds(), user.id);
    return { backup_codes: newBackupCodes(ctx, user.id) };
  });

  registry.add('client.twoFactor.regenerateBackupCodes', { auth: 'session' }, ({ ctx, actor, args }) => {
    const user = requireUser(ctx, actor.userId);
    if (user.totp_enabled !== 1) fail('not_enabled');
    if (!checkSecondFactor(ctx, user, args.req('code'))) fail('invalid_code');
    return { backup_codes: newBackupCodes(ctx, user.id) };
  });

  registry.add('client.twoFactor.disable', { auth: 'session' }, ({ ctx, actor, args }) => {
    const user = requireUser(ctx, actor.userId);
    if (user.totp_enabled !== 1) fail('not_enabled');
    if (teamPrefs(ctx).require_2fa) fail('required_by_workspace');
    if (!checkSecondFactor(ctx, user, args.req('code'))) fail('invalid_code');
    ctx.db.tx(() => {
      ctx.db.run('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0 WHERE id = ?', user.id);
      ctx.db.run('DELETE FROM backup_codes WHERE user_id = ?', user.id);
    });
  });
}
