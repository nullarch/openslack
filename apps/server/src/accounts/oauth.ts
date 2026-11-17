import { createHash, createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Kernel } from '../app.ts';
import { findInvite, joinWithInvite } from './invites.ts';
import { ApiError, fail } from '../core/errors.ts';
import { newSecret, nowSeconds } from '../core/ids.ts';
import { getUser, type UserRow } from '../core/users.ts';
import type { Ctx, IdentityProviderConfig } from '../ctx.ts';
import { domainAllowed, teamPrefs } from './prefs.ts';
import { finishSignIn } from './signin.ts';

/**
 * Sign in with an external identity provider: any OpenID Connect provider
 * (Google, Okta, Microsoft Entra, Keycloak, Authentik…) and GitHub.
 *
 * An identity is linked to an account here the first time it is used: to the
 * account with the same verified address, or to a new account when the
 * provider is allowed to create them or the person arrived with an invite.
 */

const STATE_TTL = 10 * 60;

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface Profile {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string;
}

const discoveries = new Map<string, { doc: Discovery; at: number }>();
const jwksCache = new Map<string, { keys: (JsonWebKey & { kid?: string; alg?: string })[]; at: number }>();

async function getJson(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, headers: { accept: 'application/json', ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  return (await response.json()) as Record<string, unknown>;
}

async function discover(issuer: string): Promise<Discovery> {
  const cached = discoveries.get(issuer);
  if (cached && Date.now() - cached.at < 3_600_000) return cached.doc;
  const doc = (await getJson(`${issuer}/.well-known/openid-configuration`)) as unknown as Discovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new Error('incomplete discovery document');
  discoveries.set(issuer, { doc, at: Date.now() });
  return doc;
}

async function signingKey(jwksUri: string, kid: string | undefined): Promise<KeyObject> {
  for (const refresh of [false, true]) {
    let cached = jwksCache.get(jwksUri);
    if (!cached || refresh || Date.now() - cached.at > 3_600_000) {
      const body = await getJson(jwksUri);
      cached = { keys: (body.keys as (JsonWebKey & { kid?: string })[]) ?? [], at: Date.now() };
      jwksCache.set(jwksUri, cached);
    }
    const jwk = cached.keys.find((key) => (kid ? key.kid === kid : true));
    if (jwk) return createPublicKey({ key: jwk, format: 'jwk' });
  }
  throw new Error('signing key not found');
}

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

/** Verify an ID token's signature and claims; returns the claims. */
async function verifyIdToken(token: string, doc: Discovery, clientId: string, nonce: string): Promise<Record<string, unknown>> {
  const [head, body, signature] = token.split('.');
  if (!head || !body || !signature) throw new Error('malformed id_token');
  const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as { alg?: string; kid?: string };
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  const key = await signingKey(doc.jwks_uri, header.kid);
  const data = Buffer.from(`${head}.${body}`);
  const sig = Buffer.from(signature, 'base64url');
  let valid: boolean;
  switch (header.alg) {
    case 'RS256':
      valid = verifySignature('sha256', data, key, sig);
      break;
    case 'PS256':
      valid = verifySignature('sha256', data, { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 }, sig);
      break;
    case 'ES256':
      valid = verifySignature('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
      break;
    default:
      throw new Error(`unsupported id_token algorithm ${String(header.alg)}`);
  }
  if (!valid) throw new Error('bad id_token signature');
  const now = nowSeconds();
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== doc.issuer) throw new Error('id_token issuer mismatch');
  if (!audience.includes(clientId)) throw new Error('id_token audience mismatch');
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new Error('id_token expired');
  if (claims.nonce !== nonce) throw new Error('id_token nonce mismatch');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('id_token without subject');
  return claims;
}

function callbackUrl(ctx: Ctx, provider: IdentityProviderConfig): string {
  return `${ctx.config.publicUrl}/auth/${provider.id}/callback`;
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

async function authorizeUrl(ctx: Ctx, provider: IdentityProviderConfig, state: string, nonce: string, verifier: string): Promise<string> {
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  if (provider.kind === 'github') {
    const params = new URLSearchParams({
      client_id: provider.clientId,
      redirect_uri: callbackUrl(ctx, provider),
      scope: 'read:user user:email',
      state,
      allow_signup: 'false',
    });
    return `${provider.webUrl}/login/oauth/authorize?${params}`;
  }
  const doc = await discover(provider.issuer!);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: provider.clientId,
    redirect_uri: callbackUrl(ctx, provider),
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${doc.authorization_endpoint}?${params}`;
}

async function profileFromCode(ctx: Ctx, provider: IdentityProviderConfig, code: string, verifier: string, nonce: string): Promise<Profile> {
  if (provider.kind === 'github') {
    const token = await getJson(`${provider.webUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: provider.clientId, client_secret: provider.clientSecret, code, redirect_uri: callbackUrl(ctx, provider) }),
    });
    if (typeof token.access_token !== 'string') throw new Error(`token exchange failed: ${String(token.error ?? 'no token')}`);
    const auth = { authorization: `Bearer ${token.access_token}`, 'user-agent': 'chat-server' };
    const user = await getJson(`${provider.apiUrl}/user`, { headers: auth });
    const emails = (await fetch(`${provider.apiUrl}/user/emails`, { headers: { ...auth, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) }).then((r) =>
      r.ok ? r.json() : [],
    )) as { email: string; primary: boolean; verified: boolean }[];
    const primary = emails.find((entry) => entry.primary && entry.verified) ?? emails.find((entry) => entry.verified);
    return {
      subject: String(user.id),
      email: primary?.email?.toLowerCase() ?? null,
      emailVerified: Boolean(primary),
      name: String(user.name || user.login || ''),
    };
  }
  const doc = await discover(provider.issuer!);
  const token = await getJson(doc.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl(ctx, provider),
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code_verifier: verifier,
    }),
  });
  if (typeof token.id_token !== 'string') throw new Error('token response without id_token');
  const claims = await verifyIdToken(token.id_token, doc, provider.clientId, nonce);
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
  const name = [claims.name, [claims.given_name, claims.family_name].filter(Boolean).join(' '), claims.preferred_username, email?.split('@')[0]]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find(Boolean);
  return { subject: claims.sub as string, email, emailVerified: claims.email_verified === true || claims.email_verified === 'true', name: name ?? 'New member' };
}

function link(ctx: Ctx, provider: IdentityProviderConfig, profile: Profile, userId: string): void {
  ctx.db.run(
    'INSERT OR IGNORE INTO identities (provider, subject, user_id, email, created) VALUES (?, ?, ?, ?, ?)',
    provider.id,
    profile.subject,
    userId,
    profile.email,
    nowSeconds(),
  );
}

/** Find or create the account for an external identity. */
export function accountFor(ctx: Ctx, provider: IdentityProviderConfig, profile: Profile, inviteCode: string | null): UserRow {
  const linked = ctx.db.get<{ user_id: string }>('SELECT user_id FROM identities WHERE provider = ? AND subject = ?', provider.id, profile.subject);
  if (linked) {
    const user = getUser(ctx, linked.user_id);
    if (user) return user;
  }
  if (!profile.email || !profile.emailVerified) fail('email_not_verified');
  const existing = ctx.db.get<UserRow>('SELECT * FROM users WHERE email = ? AND is_bot = 0', profile.email);
  if (existing && (existing.password_hash !== null || ctx.db.get('SELECT 1 FROM identities WHERE user_id = ?', existing.id))) {
    link(ctx, provider, profile, existing.id);
    return existing;
  }
  const invite = inviteCode ? findInvite(ctx, inviteCode) : undefined;
  let allowed = false;
  if (invite) {
    if (invite.email && invite.email !== profile.email) fail('invite_email_mismatch');
    if (!invite.email && !domainAllowed(ctx, profile.email)) fail('domain_not_allowed');
    allowed = true;
  } else if (provider.createAccounts) {
    // Google and GitHub accounts are open to anyone: they create accounts only for approved domains.
    const domains = teamPrefs(ctx).signup_domains ?? [];
    if (!domainAllowed(ctx, profile.email)) fail('domain_not_allowed');
    if (provider.id !== 'oidc' && provider.kind !== 'saml' && domains.length === 0) fail('no_account');
    allowed = true;
  } else if (existing) {
    // An imported account waiting to be claimed.
    allowed = true;
  }
  if (!allowed) fail('no_account');
  const joiner = { email: profile.email, realName: profile.name.slice(0, 80) || profile.email, passwordHash: null, tz: 'UTC' };
  const user = joinWithInvite(
    ctx,
    invite ?? {
      code: '',
      created_by: '',
      email: null,
      max_uses: 0,
      uses: 0,
      revoked: 0,
      created: 0,
      expires: 0,
      guest: '',
      guest_channels: '[]',
      guest_expires: 0,
    },
    joiner,
  );
  link(ctx, provider, profile, user.id);
  return user;
}

export function installOAuth(kernel: Kernel): void {
  const { ctx, router } = kernel;
  const providers = (): IdentityProviderConfig[] => ctx.config.identityProviders ?? [];

  router.add('GET', /^\/auth\/([a-z0-9-]+)\/start$/, async ({ res, url, params }) => {
    const provider = providers().find((item) => item.id === params[0]);
    if (!provider || !ctx.team()) {
      redirect(res, '/signin?error=provider_not_found');
      return;
    }
    const state = newSecret(24);
    const nonce = newSecret(16);
    const verifier = newSecret(32);
    const invite = url.searchParams.get('invite');
    ctx.db.run('DELETE FROM oauth_states WHERE created < ?', nowSeconds() - STATE_TTL);
    ctx.db.run(
      'INSERT INTO oauth_states (state, provider, verifier, nonce, invite_code, created) VALUES (?, ?, ?, ?, ?, ?)',
      state,
      provider.id,
      verifier,
      nonce,
      invite,
      nowSeconds(),
    );
    try {
      redirect(res, await authorizeUrl(ctx, provider, state, nonce, verifier));
    } catch (error) {
      if (!ctx.config.quiet) console.error('[auth] provider unreachable', error instanceof Error ? error.message : error);
      redirect(res, '/signin?error=provider_unreachable');
    }
  });

  router.add('GET', /^\/auth\/([a-z0-9-]+)\/callback$/, async ({ req, res, url, params }) => {
    const provider = providers().find((item) => item.id === params[0]);
    const stateParam = url.searchParams.get('state') ?? '';
    const state = ctx.db.get<{ state: string; provider: string; verifier: string; nonce: string; invite_code: string | null; created: number }>(
      'SELECT * FROM oauth_states WHERE state = ?',
      stateParam,
    );
    // A state is good for one callback.
    if (state) ctx.db.run('DELETE FROM oauth_states WHERE state = ?', state.state);
    const back = (code: string): void => {
      const target = state?.invite_code ? `/join/${encodeURIComponent(state.invite_code)}?error=${code}` : `/signin?error=${code}`;
      redirect(res, target);
    };
    if (!provider || !state || state.provider !== provider.id || state.created < nowSeconds() - STATE_TTL) {
      back('state_invalid');
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      back(url.searchParams.get('error') === 'access_denied' ? 'access_denied' : 'provider_error');
      return;
    }
    let profile: Profile;
    try {
      profile = await profileFromCode(ctx, provider, code, state.verifier, state.nonce);
    } catch (error) {
      if (!ctx.config.quiet) console.error('[auth] sign-in failed', error instanceof Error ? error.message : error);
      back('provider_error');
      return;
    }
    try {
      const user = accountFor(ctx, provider, profile, state.invite_code);
      const result = finishSignIn(ctx, user, req, res);
      redirect(res, result.two_factor_required ? '/signin?step=two-factor' : '/');
    } catch (error) {
      back(error instanceof ApiError ? error.code : 'provider_error');
    }
  });
}
