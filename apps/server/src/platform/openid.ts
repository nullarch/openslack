import { createHash, createPublicKey, generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { isSameOrigin, parseBody, readBody, sendJson } from '../api/http.ts';
import { sharedMap } from '../core/transient.ts';
import type { Kernel } from '../app.ts';
import { authenticate, createToken, readSessionToken } from '../core/auth.ts';
import { fail } from '../core/errors.ts';
import { newSecret, nowSeconds, sha256 } from '../core/ids.ts';
import { getUser, userToApi, type UserRow } from '../core/users.ts';
import { appConfig, type AppRow } from './apps.ts';
import { escapeHtml, formToken, page, redirectTo, sameToken } from './oauth.ts';
import { issueRotating, redeemRefreshToken } from './rotation.ts';

/**
 * "Sign in with this workspace": an OpenID Connect provider shaped like
 * Slack's Sign in with Slack, so apps that offer it, and any app that speaks
 * OpenID Connect (discovery at /.well-known/openid-configuration), can use the
 * workspace's accounts.
 *
 *   GET  /openid/connect/authorize?response_type=code&scope=openid%20profile%20email&client_id&redirect_uri&state&nonce
 *   POST /api/openid.connect.token     → access_token, id_token (RS256)
 *   GET  /api/openid.connect.userInfo  → the same claims
 *
 * The client is an app created under Administration → Apps, with its redirect
 * URLs registered. ID tokens are signed with an RSA key generated on first use
 * and kept in the data directory.
 *
 * Reference: docs.slack.dev/authentication/sign-in-with-slack
 */

const SCOPES = ['openid', 'profile', 'email'];
const CODE_TTL_MS = 10 * 60_000;
const ID_TOKEN_TTL = 3600;
/** Claim names Slack uses; apps written for Sign in with Slack read these. */
const CLAIM = { team: 'https://slack.com/team_id', user: 'https://slack.com/user_id', teamName: 'https://slack.com/team_name', teamDomain: 'https://slack.com/team_domain' };

interface Grant {
  appId: string;
  userId: string;
  scopes: string[];
  redirectUri: string;
  nonce: string | null;
  authTime: number;
  expires: number;
}

const base64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

class SigningKey {
  readonly kid: string;
  private readonly privateKey: string;
  private readonly publicKey: KeyObject;

  constructor(dataDir: string) {
    const file = join(dataDir, 'oidc-signing-key.pem');
    if (!existsSync(file)) {
      mkdirSync(dataDir, { recursive: true });
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      writeFileSync(file, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      chmodSync(file, 0o600);
    }
    this.privateKey = readFileSync(file, 'utf8');
    this.publicKey = createPublicKey(this.privateKey);
    const jwk = this.publicKey.export({ format: 'jwk' });
    this.kid = createHash('sha256').update(`${jwk.n}.${jwk.e}`).digest('base64url').slice(0, 16);
  }

  jwk(): Record<string, unknown> {
    return { ...this.publicKey.export({ format: 'jwk' }), kid: this.kid, use: 'sig', alg: 'RS256' };
  }

  sign(payload: Record<string, unknown>): string {
    const head = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: this.kid }));
    const body = base64url(JSON.stringify(payload));
    const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(this.privateKey);
    return `${head}.${body}.${base64url(signature)}`;
  }
}

export function installOpenId(kernel: Kernel): void {
  const { ctx } = kernel;
  // Codes live in the shared store: the token exchange may reach another process.
  const grants = sharedMap<Grant>(ctx.transient, 'openid_code');
  let key: SigningKey | null = null;
  const signingKey = (): SigningKey => (key ??= new SigningKey(ctx.config.dataDir));
  const issuer = (): string => ctx.config.publicUrl;

  const discovery = (): Record<string, unknown> => ({
    issuer: issuer(),
    authorization_endpoint: `${issuer()}/openid/connect/authorize`,
    token_endpoint: `${issuer()}/api/openid.connect.token`,
    userinfo_endpoint: `${issuer()}/api/openid.connect.userInfo`,
    jwks_uri: `${issuer()}/openid/connect/keys`,
    scopes_supported: SCOPES,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    claims_supported: ['sub', 'aud', 'exp', 'iat', 'iss', 'auth_time', 'nonce', 'at_hash', 'email', 'email_verified', 'name', 'picture', 'given_name', 'family_name', 'locale', CLAIM.team, CLAIM.user, CLAIM.teamName, CLAIM.teamDomain],
    claims_parameter_supported: false,
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
  });

  /** What the scopes let an app know about a person. */
  const claims = (user: UserRow, scopes: string[]): Record<string, unknown> => {
    const team = ctx.requireTeam();
    const api = userToApi(ctx, user, null);
    const out: Record<string, unknown> = { sub: user.id, [CLAIM.user]: user.id, [CLAIM.team]: team.id };
    if (scopes.includes('email') && user.email) {
      out.email = user.email;
      // Addresses are not confirmed by mail on this server, so they are not claimed as verified.
      out.email_verified = false;
    }
    if (scopes.includes('profile')) {
      const [given = '', ...rest] = (user.real_name || user.name).split(/\s+/);
      Object.assign(out, {
        name: user.real_name || user.display_name || user.name,
        picture: api.profile.image_512,
        given_name: given,
        family_name: rest.join(' '),
        locale: 'en-US',
        [CLAIM.teamName]: team.name,
        [CLAIM.teamDomain]: team.domain,
      });
    }
    return out;
  };

  const idToken = (app: AppRow, user: UserRow, scopes: string[], accessToken: string, nonce: string | null, authTime: number): string => {
    const now = nowSeconds();
    const digest = createHash('sha256').update(accessToken).digest();
    return signingKey().sign({
      iss: issuer(),
      aud: app.client_id,
      exp: now + ID_TOKEN_TTL,
      iat: now,
      auth_time: authTime,
      ...(nonce ? { nonce } : {}),
      at_hash: base64url(digest.subarray(0, digest.length / 2)),
      ...claims(user, scopes),
    });
  };

  // ── Discovery ───────────────────────────────────────────────────────────

  kernel.router.add('GET', /^\/\.well-known\/openid-configuration$/, ({ res }) => {
    sendJson(res, 200, discovery(), { 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' });
  });
  kernel.router.add('GET', /^\/openid\/connect\/keys$/, ({ res }) => {
    sendJson(res, 200, { keys: [signingKey().jwk()] }, { 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' });
  });

  // ── The sign-in request ─────────────────────────────────────────────────

  const errorPage = (res: ServerResponse, message: string): void =>
    page(res, 400, 'Cannot sign in', `<h1>This sign-in link does not work</h1><p class="error">${escapeHtml(message)}</p>`);

  /** Check the request; a bad client or redirect URL gets a page, anything else goes back to the app as an error. */
  const inspect = (params: URLSearchParams, res: ServerResponse): { app: AppRow; scopes: string[]; redirectUri: string; state: string; nonce: string | null } | null => {
    const app = ctx.db.get<AppRow>('SELECT * FROM apps WHERE client_id = ?', params.get('client_id') ?? '');
    if (!app) {
      errorPage(res, 'Unknown client_id.');
      return null;
    }
    const registered = appConfig(app).redirect_urls;
    const redirectUri = params.get('redirect_uri') ?? registered[0] ?? '';
    if (!redirectUri || !registered.includes(redirectUri)) {
      errorPage(res, 'The redirect_uri does not match one registered for this app (Administration → Apps).');
      return null;
    }
    const state = params.get('state') ?? '';
    const back = (error: string): null => {
      redirectTo(res, `${redirectUri}${redirectUri.includes('?') ? '&' : '?'}${new URLSearchParams({ error, state })}`);
      return null;
    };
    if (params.get('response_type') !== 'code') return back('unsupported_response_type');
    const scopes = [...new Set((params.get('scope') ?? '').split(/[\s,]+/).filter(Boolean))];
    if (!scopes.includes('openid') || scopes.some((scope) => !SCOPES.includes(scope))) return back('invalid_scope');
    return { app, scopes, redirectUri, state, nonce: params.get('nonce') };
  };

  const signedIn = (req: IncomingMessage): { user: UserRow; session: string } | null => {
    const session = readSessionToken(req);
    if (!session) return null;
    const { actor } = authenticate(ctx, req, undefined);
    if (!actor || actor.kind !== 'session') return null;
    // Whatever keeps a person out of the workspace (an expired guest account,
    // two-factor sign-in still to set up) keeps them out of apps signed into with it.
    try {
      for (const guard of kernel.registry.guards) guard('openid.connect.authorize', actor);
    } catch {
      return null;
    }
    const user = getUser(ctx, actor.userId);
    return user && user.deleted === 0 ? { user, session } : null;
  };

  /** Not signed in: the web client's own sign-in (with every rule it applies) brings the person back here. */
  const toSignIn = (res: ServerResponse, url: URL): void => redirectTo(res, `/signin?${new URLSearchParams({ next: `${url.pathname}${url.search}` })}`);

  kernel.router.add('GET', /^\/openid\/connect\/authorize$/, ({ req, res, url }) => {
    if (!ctx.team()) return errorPage(res, 'This server has not been set up yet.');
    const details = inspect(url.searchParams, res);
    if (!details) return;
    const who = signedIn(req);
    if (!who) return toSignIn(res, url);
    const team = ctx.requireTeam();
    const sees = [
      details.scopes.includes('profile') ? '<li>your name and profile photo</li>' : '',
      details.scopes.includes('email') ? '<li>your email address</li>' : '',
      '<li>which workspace you belong to</li>',
    ].join('');
    page(
      res,
      200,
      `Sign in to ${details.app.name}`,
      `<h1>Sign in to ${escapeHtml(details.app.name)} with your ${escapeHtml(team.name)} account</h1>
       <p>Signed in as ${escapeHtml(who.user.real_name || who.user.name)}. ${escapeHtml(details.app.name)} will see:</p>
       <ul>${sees}</ul>
       <form method="post" action="/openid/connect/authorize?${escapeHtml(url.searchParams.toString())}">
         <input type="hidden" name="form_token" value="${formToken(who.session)}">
         <div class="row">
           <button type="submit" name="decision" value="deny">Cancel</button>
           <button class="primary" type="submit" name="decision" value="allow">Continue</button>
         </div>
       </form>`,
      [new URL(details.redirectUri).origin],
    );
  });

  kernel.router.add('POST', /^\/openid\/connect\/authorize$/, async ({ req, res, url }) => {
    if (!isSameOrigin(req)) return errorPage(res, 'This form must be sent from this site.');
    if (!ctx.team()) return errorPage(res, 'This server has not been set up yet.');
    const details = inspect(url.searchParams, res);
    if (!details) return;
    const who = signedIn(req);
    if (!who) return toSignIn(res, url);
    const form = parseBody(String(req.headers['content-type'] ?? 'application/x-www-form-urlencoded'), await readBody(req, 64 * 1024));
    if (!sameToken(String(form.form_token ?? ''), formToken(who.session))) return errorPage(res, 'The form expired. Open the sign-in link again.');
    const back = (params: Record<string, string>): void =>
      redirectTo(res, `${details.redirectUri}${details.redirectUri.includes('?') ? '&' : '?'}${new URLSearchParams(params)}`);
    if (form.decision !== 'allow') return back({ error: 'access_denied', state: details.state });
    const code = `${Date.now()}.${newSecret(24)}`;
    grants.set(sha256(code), {
      appId: details.app.id,
      userId: who.user.id,
      scopes: details.scopes,
      redirectUri: details.redirectUri,
      nonce: details.nonce,
      authTime: nowSeconds(),
      expires: Date.now() + CODE_TTL_MS,
    });
    back({ code, state: details.state });
  });

  // ── Tokens and claims ───────────────────────────────────────────────────

  kernel.registry.addPublic('openid.connect.token', ({ args, req }) => {
    let clientId = args.str('client_id');
    let clientSecret = args.str('client_secret');
    const basic = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization ?? ''));
    if (basic) {
      const [id, secret] = Buffer.from(basic[1]!, 'base64').toString('utf8').split(':').map((part) => decodeURIComponent(part));
      clientId ??= id;
      clientSecret ??= secret;
    }
    const app = clientId ? ctx.db.get<AppRow>('SELECT * FROM apps WHERE client_id = ?', clientId) : undefined;
    if (!app) fail('invalid_client_id');
    if (!clientSecret || !sameToken(clientSecret, app.client_secret)) fail('bad_client_secret');
    const rotating = appConfig(app).token_rotation_enabled;

    const grantType = args.str('grant_type') ?? 'authorization_code';
    if (grantType === 'refresh_token') {
      if (!rotating) fail('invalid_refresh_token');
      const spent = redeemRefreshToken(ctx, args.str('refresh_token'), { kind: 'user', appId: app.id });
      const user = getUser(ctx, spent.user_id);
      if (!user || user.deleted === 1) fail('invalid_refresh_token');
      const scopes = spent.scopes.split(',').filter(Boolean);
      const pair = issueRotating(ctx, { kind: 'user', appId: app.id, userId: user.id, scopes });
      return { ...pair, token_type: 'Bearer', id_token: idToken(app, user, scopes, pair.access_token, null, nowSeconds()) };
    }
    if (grantType !== 'authorization_code') fail('invalid_grant_type');

    const code = args.str('code');
    if (!code) fail('invalid_code');
    const grant = grants.take(sha256(code));
    if (!grant || grant.appId !== app.id || grant.expires < Date.now()) fail('invalid_code');
    const redirectUri = args.str('redirect_uri');
    if (redirectUri && redirectUri !== grant.redirectUri) fail('bad_redirect_uri');
    const user = getUser(ctx, grant.userId);
    if (!user || user.deleted === 1) fail('invalid_code');

    if (rotating) {
      const pair = issueRotating(ctx, { kind: 'user', appId: app.id, userId: user.id, scopes: grant.scopes });
      return { ...pair, token_type: 'Bearer', id_token: idToken(app, user, grant.scopes, pair.access_token, grant.nonce, grant.authTime) };
    }
    const accessToken = createToken(ctx, { kind: 'user', userId: user.id, appId: app.id, scopes: grant.scopes });
    return { access_token: accessToken, token_type: 'Bearer', id_token: idToken(app, user, grant.scopes, accessToken, grant.nonce, grant.authTime) };
  });

  kernel.registry.add('openid.connect.userInfo', { scopes: ['openid'] }, ({ actor }) => {
    if (actor.kind !== 'user') fail('not_allowed_token_type');
    return claims(getUser(ctx, actor.userId)!, [...(actor.scopes ?? [])]);
  });

}
