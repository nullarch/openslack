import type { Ctx } from '../ctx.ts';
import { createToken } from '../core/auth.ts';
import { fail } from '../core/errors.ts';
import { newSecret, nowSeconds, sha256 } from '../core/ids.ts';

/**
 * Token rotation, as Slack does it for apps that turn it on: access tokens
 * (`xoxe.xoxb-…`, `xoxe.xoxp-…`) last twelve hours and come with a single-use
 * refresh token (`xoxe-1-…`) that `oauth.v2.access` (grant_type=refresh_token)
 * trades for a new pair. At most two access tokens of one kind are alive per
 * app and person; the oldest goes when a third is issued.
 */

export const ROTATING_TOKEN_TTL = 43_200;
const ACTIVE_LIMIT = 2;

interface RefreshRow {
  token_hash: string;
  kind: 'bot' | 'user' | 'config';
  app_id: string | null;
  user_id: string;
  scopes: string;
}

export function newRefreshToken(ctx: Ctx, input: { kind: RefreshRow['kind']; appId: string | null; userId: string; scopes: string[] }): string {
  const token = `xoxe-1-${newSecret(36).replace(/[-_]/g, 'x')}`;
  ctx.db.run(
    'INSERT INTO refresh_tokens (token_hash, kind, app_id, user_id, scopes, created) VALUES (?, ?, ?, ?, ?, ?)',
    sha256(token),
    input.kind,
    input.appId,
    input.userId,
    input.scopes.join(','),
    nowSeconds(),
  );
  return token;
}

/** Take a refresh token out of circulation and say what it was for; `invalid_refresh_token` otherwise. */
export function redeemRefreshToken(ctx: Ctx, token: string | undefined, expect: { kind?: RefreshRow['kind']; appId?: string }): RefreshRow {
  if (!token) fail('invalid_refresh_token');
  const row = ctx.db.get<RefreshRow>('SELECT * FROM refresh_tokens WHERE token_hash = ?', sha256(token));
  if (!row) fail('invalid_refresh_token');
  if (expect.kind && row.kind !== expect.kind) fail('invalid_refresh_token');
  if (expect.kind === undefined && row.kind === 'config') fail('invalid_refresh_token');
  if (expect.appId && row.app_id !== expect.appId) fail('invalid_refresh_token');
  ctx.db.run('DELETE FROM refresh_tokens WHERE token_hash = ?', row.token_hash);
  return row;
}

export interface RotatingPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/**
 * Issue an expiring access token and its refresh token. The first rotating
 * token for an app and person retires the long-lived one it replaces; after
 * that, only the newest two stay valid.
 */
export function issueRotating(ctx: Ctx, input: { kind: 'bot' | 'user'; appId: string; userId: string; scopes: string[] }): RotatingPair {
  return ctx.db.tx(() => {
    ctx.db.run('DELETE FROM tokens WHERE app_id = ? AND kind = ? AND user_id = ? AND expires IS NULL', input.appId, input.kind, input.userId);
    const accessToken = createToken(ctx, { ...input, expiresIn: ROTATING_TOKEN_TTL });
    const alive = ctx.db.all<{ token_hash: string }>(
      'SELECT token_hash FROM tokens WHERE app_id = ? AND kind = ? AND user_id = ? ORDER BY created DESC, rowid DESC',
      input.appId,
      input.kind,
      input.userId,
    );
    for (const row of alive.slice(ACTIVE_LIMIT)) ctx.db.run('DELETE FROM tokens WHERE token_hash = ?', row.token_hash);
    const refreshToken = newRefreshToken(ctx, { kind: input.kind, appId: input.appId, userId: input.userId, scopes: input.scopes });
    return { access_token: accessToken, refresh_token: refreshToken, expires_in: ROTATING_TOKEN_TTL };
  });
}

/** Expired tokens are useless; drop them a day after they lapse. */
export function sweepExpiredTokens(ctx: Ctx): void {
  const cutoff = nowSeconds() - 86_400;
  ctx.db.run('DELETE FROM tokens WHERE expires IS NOT NULL AND expires < ?', cutoff);
  ctx.db.run('DELETE FROM config_tokens WHERE expires < ?', cutoff);
}
