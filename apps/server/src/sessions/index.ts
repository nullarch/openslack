import type { Kernel } from '../app.ts';
import { readSessionToken, sessionTtl } from '../core/auth.ts';
import { allowlistPolicy, clientIp, inRanges, parseCidr } from '../core/network.ts';
import { fail } from '../core/errors.ts';
import { sha256 } from '../core/ids.ts';
import { getUser } from '../core/users.ts';
import type { Actor, Ctx } from '../ctx.ts';

/**
 * Session management: people see where they are signed in and sign out other
 * browsers; admins sign a person out everywhere (Slack's
 * `admin.users.session.reset`), owners everyone; the workspace sets how long a
 * sign-in lasts. Revoked sessions lose their live connection at once.
 */

interface SessionRow {
  token_hash: string;
  user_id: string;
  user_agent: string;
  created: number;
  expires: number;
  last_seen: number | null;
  ip: string | null;
}

/** A public handle for a session: a prefix of the token's hash, never the token. */
const sessionId = (hash: string): string => hash.slice(0, 20);

function describe(agent: string): string {
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? (/Electron\//.test(agent) ? 'Desktop app' : 'Chrome') : /Safari\//.test(agent) ? 'Safari' : agent ? 'Browser' : 'Unknown';
  const system = /iPhone|iPad/.test(agent) ? 'iOS' : /Android/.test(agent) ? 'Android' : /Mac OS X/.test(agent) ? 'macOS' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : '';
  return system ? `${browser} on ${system}` : browser;
}

export function revokeSessions(ctx: Ctx, userId: string, hashes: string[]): number {
  if (hashes.length === 0) return 0;
  for (const hash of hashes) ctx.db.run('DELETE FROM sessions WHERE token_hash = ?', hash);
  ctx.bus.emit({ event: { type: 'sessions_revoked', user: userId, sessions: hashes }, audience: { users: [userId] }, clientOnly: true });
  return hashes.length;
}

export function installSessions(kernel: Kernel): void {
  const { ctx } = kernel;
  const own = (userId: string): SessionRow[] => ctx.db.all<SessionRow>('SELECT * FROM sessions WHERE user_id = ? AND expires > unixepoch() ORDER BY coalesce(last_seen, created) DESC', userId);

  kernel.registry.add('client.sessions.list', { auth: 'session' }, ({ actor, req }) => {
    const current = sha256(readSessionToken(req) ?? '');
    return {
      sessions: own(actor.userId).map((row) => ({
        id: sessionId(row.token_hash),
        device: describe(row.user_agent),
        user_agent: row.user_agent,
        ip: row.ip,
        created: row.created,
        last_seen: row.last_seen ?? row.created,
        expires: row.expires,
        current: row.token_hash === current,
      })),
    };
  });

  kernel.registry.add('client.sessions.revoke', { auth: 'session' }, ({ actor, args, req }) => {
    const id = args.req('id', 'session_not_found');
    const current = sha256(readSessionToken(req) ?? '');
    const target = own(actor.userId).find((row) => sessionId(row.token_hash) === id);
    if (!target) fail('session_not_found');
    if (target.token_hash === current) fail('cannot_revoke_current', { detail: 'Use client.signout for this browser.' });
    revokeSessions(ctx, actor.userId, [target.token_hash]);
  });

  /** Sign out every other browser and app session of mine. */
  kernel.registry.add('client.sessions.revokeOthers', { auth: 'session' }, ({ actor, req }) => {
    const current = sha256(readSessionToken(req) ?? '');
    const others = own(actor.userId).filter((row) => row.token_hash !== current).map((row) => row.token_hash);
    return { revoked: revokeSessions(ctx, actor.userId, others) };
  });

  const canReset = (actor: Actor, userId: string): void => {
    const target = getUser(ctx, userId);
    if (!target || target.is_bot === 1) fail('user_not_found');
    const ownerLevel = actor.role === 'owner' || actor.role === 'primary_owner';
    if ((target.role === 'owner' || target.role === 'primary_owner') && !ownerLevel) fail('not_allowed');
  };

  /** Slack's admin method: sign a person out of every session. */
  kernel.registry.add('admin.users.session.reset', { auth: 'admin', scopes: ['admin.users:write'] }, ({ actor, args }) => {
    const userId = args.req('user_id', 'user_not_found');
    canReset(actor, userId);
    revokeSessions(ctx, userId, own(userId).map((row) => row.token_hash));
  });

  /** Sign everyone out (owners only), for example after a suspected compromise. The caller's own session stays. */
  kernel.registry.add('client.admin.sessions.resetAll', { auth: 'admin' }, ({ actor, req }) => {
    if (actor.role !== 'owner' && actor.role !== 'primary_owner') fail('not_allowed');
    const current = sha256(readSessionToken(req) ?? '');
    let revoked = 0;
    for (const { user_id } of ctx.db.all<{ user_id: string }>('SELECT DISTINCT user_id FROM sessions')) {
      revoked += revokeSessions(ctx, user_id, own(user_id).filter((row) => row.token_hash !== current).map((row) => row.token_hash));
    }
    return { revoked };
  });

  kernel.registry.add('client.admin.sessionSettings', { auth: 'admin' }, () => ({ session_duration_days: Math.round(sessionTtl(ctx) / 86_400) }));

  /** The IP allowlist, and the address this request comes from (to see what to allow). */
  kernel.registry.add('client.admin.ipAllowlist', { auth: 'admin' }, ({ req }) => ({ ...allowlistPolicy(ctx), your_address: clientIp(ctx, req), disabled_by_server: Boolean(ctx.config.ipAllowlistDisabled) }));

  /** Owners set it; a list that would shut out the owner setting it is refused. Empty turns it off. */
  kernel.registry.add('client.admin.setIpAllowlist', { auth: 'admin' }, ({ actor, args, req }) => {
    if (actor.role !== 'owner' && actor.role !== 'primary_owner') fail('not_allowed');
    const cidrs = args.list('cidrs').map((value) => value.trim()).filter(Boolean);
    if (cidrs.length > 100) fail('invalid_arguments', { arg: 'cidrs' });
    const bad = cidrs.find((cidr) => !parseCidr(cidr));
    if (bad) fail('invalid_cidr', { cidr: bad });
    const here = clientIp(ctx, req);
    if (cidrs.length && !inRanges(cidrs, here)) fail('would_lock_out', { your_address: here });
    const policy = { cidrs, applies_to_tokens: args.bool('applies_to_tokens') };
    ctx.db.run("UPDATE team SET prefs = json_set(prefs, '$.ip_allowlist', json(?)) WHERE id = ?", JSON.stringify(policy), ctx.requireTeam().id);
    ctx.invalidateTeam();
    return policy;
  });

  /** How long a sign-in lasts, 1–365 days; shortening it also shortens sessions already open. */
  kernel.registry.add('client.admin.setSessionDuration', { auth: 'admin' }, ({ args }) => {
    const days = args.int('days', 0);
    if (days < 1 || days > 365) fail('invalid_arguments', { arg: 'days', min: 1, max: 365 });
    const team = ctx.requireTeam();
    ctx.db.run("UPDATE team SET prefs = json_set(prefs, '$.session_duration_days', ?) WHERE id = ?", days, team.id);
    ctx.invalidateTeam();
    ctx.db.run('UPDATE sessions SET expires = min(expires, created + ?)', days * 86_400);
    return { session_duration_days: days };
  });
}
