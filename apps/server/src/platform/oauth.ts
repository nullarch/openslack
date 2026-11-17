import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BRAND } from '@app/shared';
import { isSameOrigin, parseBody, readBody } from '../api/http.ts';
import type { Kernel } from '../app.ts';
import { actorForUser, createToken, readSessionToken, authenticate } from '../core/auth.ts';
import { fail } from '../core/errors.ts';
import { newSecret, sha256 } from '../core/ids.ts';
import { getUser, isAdmin, type UserRow } from '../core/users.ts';
import type { Actor, Ctx } from '../ctx.ts';
import { appConfig, DEFAULT_BOT_SCOPES, issueToken, type AppRow } from './apps.ts';
import { issueRotating, redeemRefreshToken } from './rotation.ts';

/**
 * The OAuth v2 install flow ("Add to Slack"), so apps distributed to many
 * workspaces install here the way they install on Slack:
 *
 *   GET  /oauth/v2/authorize?client_id&scope&user_scope&redirect_uri&state
 *        → a page where a signed-in person reviews the scopes and approves
 *   → redirect_uri?code&state
 *   POST /api/oauth.v2.access (client_id, client_secret, code, redirect_uri)
 *        → bot token for the app, and a user token when user scopes were asked
 *
 * Bot scopes can be approved by workspace admins only; user scopes by anyone,
 * for themselves. Codes are single-use and live ten minutes, in memory.
 */

/** Scopes a user token may hold: reading and acting as that person. */
export const USER_SCOPES = new Set([
  'channels:history', 'channels:read', 'channels:write', 'chat:write', 'emoji:read', 'files:read', 'files:write',
  'groups:history', 'groups:read', 'groups:write', 'im:history', 'im:read', 'im:write', 'mpim:history', 'mpim:read',
  'mpim:write', 'pins:read', 'pins:write', 'reactions:read', 'reactions:write', 'reminders:read', 'reminders:write',
  'search:read', 'stars:read', 'team:read', 'users.profile:read', 'users.profile:write', 'users:read', 'users:read.email',
  'users:write', 'dnd:read', 'dnd:write', 'bookmarks:read', 'bookmarks:write', 'identify', 'calls:read', 'calls:write',
  'remote_files:read', 'remote_files:share',
  // Admin API scopes: only an admin can approve them, for their own token.
  'admin.users:read', 'admin.users:write', 'admin.conversations:read', 'admin.conversations:write', 'admin.teams:read', 'admin.teams:write', 'admin.invites:read', 'admin.invites:write', 'admin.barriers:read', 'admin.barriers:write',
]);
export const BOT_SCOPES = new Set([...DEFAULT_BOT_SCOPES, 'usergroups:read', 'bookmarks:read', 'bookmarks:write', 'reminders:write', 'dnd:read']);

const CODE_TTL_MS = 10 * 60_000;

interface Grant {
  appId: string;
  userId: string;
  botScopes: string[];
  userScopes: string[];
  redirectUri: string;
  expires: number;
}

function scopeList(value: string | null | undefined): string[] {
  return [...new Set((value ?? '').split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean))];
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/**
 * A small server-rendered page. `formTargets` are origins a form on it may end up at: the app's
 * redirect URL, since browsers apply `form-action` to the redirect that follows the POST too.
 */
export function page(res: ServerResponse, status: number, title: string, body: string, formTargets: string[] = []): void {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(BRAND.name)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f6f4; --card:#fff; --ink:#1b1b19; --muted:#5d5c57; --line:#e2e0d8; --accent:#1a5bd6; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111214; --card:#1b1c21; --ink:#ececf0; --muted:#9a9ca6; --line:#2c2d35; --accent:#6d9cff; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--ink); font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { width:min(440px, calc(100vw - 32px)); background:var(--card); border:1px solid var(--line); border-radius:14px; padding:24px; }
  h1 { font-size:20px; margin:0 0 6px; } p { margin:0 0 12px; color:var(--muted); }
  ul { margin:0 0 16px; padding-left:18px; } li { margin:2px 0; } code { font-size:13px; }
  label { display:block; font-size:13px; margin:10px 0 4px; color:var(--muted); }
  input { width:100%; box-sizing:border-box; padding:9px 10px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; font:inherit; }
  .row { display:flex; gap:10px; margin-top:16px; } button { flex:1; padding:10px; border-radius:8px; border:1px solid var(--line); background:transparent; color:inherit; font:inherit; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
  .error { color:#c2412d; }
</style></head><body><main>${body}</main></body></html>`;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formTargets.map((origin) => ` ${origin}`).join('')}; frame-ancestors 'none'`,
  });
  res.end(html);
}

function errorPage(res: ServerResponse, message: string): void {
  page(res, 400, 'Cannot install', `<h1>This app cannot be installed</h1><p class="error">${escapeHtml(message)}</p>`);
}

/** A token tying the approval form to the browser session that loaded it. */
export function formToken(sessionToken: string): string {
  return createHash('sha256').update(`oauth-form:${sessionToken}`).digest('hex');
}

export function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function redirectTo(res: ServerResponse, target: string, extra: Record<string, string> = {}): void {
  res.writeHead(302, { location: target, 'cache-control': 'no-store', ...extra });
  res.end();
}

export function installOauth(kernel: Kernel): void {
  const { ctx } = kernel;
  const grants = new Map<string, Grant>();

  /** Validate the request parameters; returns what the page needs, or writes an error page. */
  const inspect = (
    params: URLSearchParams,
    res: ServerResponse,
  ): { app: AppRow; botScopes: string[]; userScopes: string[]; redirectUri: string; state: string } | null => {
    const app = ctx.db.get<AppRow>('SELECT * FROM apps WHERE client_id = ?', params.get('client_id') ?? '');
    if (!app) {
      errorPage(res, 'Unknown client_id.');
      return null;
    }
    const registered = appConfig(app).redirect_urls;
    const wanted = params.get('redirect_uri') ?? registered[0] ?? '';
    if (!wanted || !registered.includes(wanted)) {
      errorPage(res, 'The redirect_uri does not match one registered for this app (Administration → Apps).');
      return null;
    }
    const botScopes = scopeList(params.get('scope'));
    const userScopes = scopeList(params.get('user_scope'));
    const unknown = [...botScopes.filter((scope) => !BOT_SCOPES.has(scope)), ...userScopes.filter((scope) => !USER_SCOPES.has(scope))];
    if (unknown.length) {
      redirectTo(res, `${wanted}${wanted.includes('?') ? '&' : '?'}${new URLSearchParams({ error: 'invalid_scope', state: params.get('state') ?? '' })}`);
      return null;
    }
    if (botScopes.length === 0 && userScopes.length === 0) {
      errorPage(res, 'The install link asks for no scopes.');
      return null;
    }
    return { app, botScopes, userScopes, redirectUri: wanted, state: params.get('state') ?? '' };
  };

  const signedIn = (req: IncomingMessage): { user: UserRow; session: string } | null => {
    const session = readSessionToken(req);
    if (!session) return null;
    const { actor } = authenticate(ctx, req, undefined);
    if (!actor || actor.kind !== 'session') return null;
    const user = getUser(ctx, actor.userId);
    return user ? { user, session } : null;
  };

  const renderConsent = (res: ServerResponse, query: string, who: UserRow, session: string, details: NonNullable<ReturnType<typeof inspect>>): void => {
    const actor: Actor = actorForUser(who, 'session', null);
    const canApproveBot = isAdmin(actor);
    const team = ctx.requireTeam();
    const list = (scopes: string[]): string => scopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join('');
    const adminScopes = details.userScopes.some((scope) => scope.startsWith('admin.'));
    const blocked = (details.botScopes.length > 0 || adminScopes) && !canApproveBot;
    page(
      res,
      200,
      `Install ${details.app.name}`,
      `<h1>${escapeHtml(details.app.name)} wants to join ${escapeHtml(team.name)}</h1>
       <p>Signed in as ${escapeHtml(who.real_name || who.name)}.</p>
       ${details.botScopes.length ? `<p>As a bot, it will be able to:</p><ul>${list(details.botScopes)}</ul>` : ''}
       ${details.userScopes.length ? `<p>On your behalf, it will be able to:</p><ul>${list(details.userScopes)}</ul>` : ''}
       ${blocked ? '<p class="error">Only workspace admins can install an app with a bot or admin access. Ask an admin to open this link.</p>' : ''}
       <form method="post" action="/oauth/v2/authorize?${escapeHtml(query)}">
         <input type="hidden" name="form_token" value="${formToken(session)}">
         <div class="row">
           <button type="submit" name="decision" value="deny">Cancel</button>
           ${blocked ? '' : '<button class="primary" type="submit" name="decision" value="allow">Allow</button>'}
         </div>
       </form>`,
      [new URL(details.redirectUri).origin],
    );
  };

  /**
   * Not signed in: the web client's own sign-in brings the person back here, so every rule
   * it applies (two-factor, single sign-on, guest expiry) applies to installing an app too.
   */
  const toSignIn = (res: ServerResponse, query: string): void => redirectTo(res, `/signin?${new URLSearchParams({ next: `/oauth/v2/authorize?${query}` })}`);

  kernel.router.add('GET', /^\/oauth\/v2\/authorize$/, ({ req, res, url }) => {
    if (!ctx.team()) return errorPage(res, 'This server has not been set up yet.');
    const details = inspect(url.searchParams, res);
    if (!details) return;
    const who = signedIn(req);
    if (!who) return toSignIn(res, url.searchParams.toString());
    renderConsent(res, url.searchParams.toString(), who.user, who.session, details);
  });

  kernel.router.add('POST', /^\/oauth\/v2\/authorize$/, async ({ req, res, url }) => {
    if (!isSameOrigin(req)) return errorPage(res, 'This form must be sent from this site.');
    if (!ctx.team()) return errorPage(res, 'This server has not been set up yet.');
    const details = inspect(url.searchParams, res);
    if (!details) return;
    const form = parseBody(String(req.headers['content-type'] ?? 'application/x-www-form-urlencoded'), await readBody(req, 64 * 1024));
    const query = url.searchParams.toString();


    const who = signedIn(req);
    if (!who) return toSignIn(res, query);
    if (!sameToken(String(form.form_token ?? ''), formToken(who.session))) return errorPage(res, 'The form expired. Open the install link again.');

    const back = (params: Record<string, string>): void =>
      redirectTo(res, `${details.redirectUri}${details.redirectUri.includes('?') ? '&' : '?'}${new URLSearchParams(params)}`);
    if (form.decision !== 'allow') return back({ error: 'access_denied', state: details.state });
    if ((details.botScopes.length || details.userScopes.some((scope) => scope.startsWith('admin.'))) && !isAdmin(actorForUser(who.user, 'session', null))) {
      return errorPage(res, 'Only workspace admins can approve an app with a bot or admin access.');
    }
    const code = `${Date.now()}.${newSecret(24)}`;
    grants.set(sha256(code), {
      appId: details.app.id,
      userId: who.user.id,
      botScopes: details.botScopes,
      userScopes: details.userScopes,
      redirectUri: details.redirectUri,
      expires: Date.now() + CODE_TTL_MS,
    });
    back({ code, state: details.state });
  });

  kernel.registry.addPublic('oauth.v2.access', ({ args, req }) => {
    // Client credentials arrive as HTTP Basic auth or as arguments.
    let clientId = args.str('client_id');
    let clientSecret = args.str('client_secret');
    const basic = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization ?? ''));
    if (basic) {
      const [id, secret] = Buffer.from(basic[1]!, 'base64').toString('utf8').split(':');
      clientId ??= id;
      clientSecret ??= secret;
    }
    const app = clientId ? ctx.db.get<AppRow>('SELECT * FROM apps WHERE client_id = ?', clientId) : undefined;
    if (!app) fail('invalid_client_id');
    if (!clientSecret || !sameToken(clientSecret, app.client_secret)) fail('bad_client_secret');
    const team = ctx.requireTeam();
    const rotating = appConfig(app).token_rotation_enabled;

    const grantType = args.str('grant_type');
    if (grantType === 'refresh_token') {
      // Trade a refresh token for a new access token and refresh token; the old refresh token is spent.
      if (!rotating) fail('invalid_refresh_token');
      const spent = redeemRefreshToken(ctx, args.str('refresh_token'), { appId: app.id });
      const kind = spent.kind === 'user' ? 'user' : 'bot';
      const scopes = spent.scopes.split(',').filter(Boolean);
      const pair = issueRotating(ctx, { kind, appId: app.id, userId: spent.user_id, scopes });
      return {
        app_id: app.id,
        ...pair,
        token_type: kind,
        scope: scopes.join(','),
        ...(kind === 'bot' ? { bot_user_id: app.bot_user_id } : { user_id: spent.user_id }),
        team: { id: team.id, name: team.name },
        enterprise: null,
        is_enterprise_install: false,
      };
    }
    if (grantType && grantType !== 'authorization_code') fail('invalid_grant_type');

    const code = args.str('code');
    if (!code) fail('invalid_code');
    const key = sha256(code);
    const grant = grants.get(key);
    grants.delete(key);
    if (!grant || grant.appId !== app.id || grant.expires < Date.now()) fail('invalid_code');
    const redirectUri = args.str('redirect_uri');
    if (redirectUri && redirectUri !== grant.redirectUri) fail('bad_redirect_uri');

    const result: Record<string, unknown> = {
      app_id: app.id,
      authed_user: { id: grant.userId },
      team: { id: team.id, name: team.name },
      enterprise: null,
      is_enterprise_install: false,
    };
    if (grant.botScopes.length) {
      ctx.db.run('UPDATE apps SET bot_scopes = ? WHERE id = ?', JSON.stringify(grant.botScopes), app.id);
      const fresh = ctx.db.get<AppRow>('SELECT * FROM apps WHERE id = ?', app.id)!;
      Object.assign(result, {
        ...(rotating
          ? issueRotating(ctx, { kind: 'bot', appId: app.id, userId: app.bot_user_id, scopes: grant.botScopes })
          : { access_token: issueToken(ctx, fresh, 'bot') }),
        token_type: 'bot',
        scope: grant.botScopes.join(','),
        bot_user_id: app.bot_user_id,
      });
    }
    if (grant.userScopes.length) {
      ctx.db.run("DELETE FROM tokens WHERE app_id = ? AND kind = 'user' AND user_id = ?", app.id, grant.userId);
      result.authed_user = {
        id: grant.userId,
        scope: grant.userScopes.join(','),
        ...(rotating
          ? issueRotating(ctx, { kind: 'user', appId: app.id, userId: grant.userId, scopes: grant.userScopes })
          : { access_token: createToken(ctx, { kind: 'user', userId: grant.userId, appId: app.id, scopes: grant.userScopes }) }),
        token_type: 'user',
      };
    }
    return result;
  });

  // Revoke the token used for the call (apps call this when uninstalling or signing a person out).
  kernel.registry.add('auth.revoke', {}, ({ actor, args, req }) => {
    if (actor.kind === 'session') fail('not_allowed_token_type');
    const header = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    const token = header || args.str('token') || '';
    if (args.bool('test')) return { revoked: false };
    const removed = ctx.db.run('DELETE FROM tokens WHERE token_hash = ?', sha256(token)).changes;
    return { revoked: removed > 0 };
  });

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, grant] of grants) if (grant.expires < now) grants.delete(key);
  }, 60_000);
  sweeper.unref();
  kernel.onClose.push(() => clearInterval(sweeper));
}
