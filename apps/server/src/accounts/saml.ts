import { InMemoryCacheProvider, SAML, ValidateInResponseTo, generateServiceProviderMetadata, type Profile as SamlProfile } from '@node-saml/node-saml';
import type { ServerResponse } from 'node:http';
import { readBody } from '../api/http.ts';
import type { Kernel } from '../app.ts';
import { ApiError } from '../core/errors.ts';
import { newSecret, nowSeconds } from '../core/ids.ts';
import type { Ctx, IdentityProviderConfig } from '../ctx.ts';
import { accountFor } from './oauth.ts';
import { finishSignIn } from './signin.ts';

/**
 * Sign in with a SAML 2.0 identity provider (Okta, Microsoft Entra ID, Google
 * Workspace, OneLogin, JumpCloud, Keycloak, ADFS…), service-provider
 * initiated: the button sends an AuthnRequest by redirect, the provider posts
 * a signed response to `/auth/saml/callback`. The XML signature is checked by
 * node-saml (the library behind passport-saml): assertions must be signed by
 * the configured certificate, addressed to this server, unexpired, and in
 * answer to a request this server made in the last ten minutes; each answer
 * is accepted once. Accounts are found or created by the same rules as for
 * OpenID Connect.
 */

const STATE_TTL = 10 * 60;
const SAML_ID = 'saml';

/** Common places an identity provider puts the address and the name. */
const EMAIL_ATTRIBUTES = [
  'email',
  'mail',
  'urn:oid:0.9.2342.19200300.100.1.3',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
  'Email',
  'EmailAddress',
];
const NAME_ATTRIBUTES = [
  'displayName',
  'urn:oid:2.16.840.1.113730.3.1.241',
  'http://schemas.microsoft.com/identity/claims/displayname',
  'name',
  'cn',
  'urn:oid:2.5.4.3',
];
const GIVEN = ['givenName', 'firstName', 'urn:oid:2.5.4.42', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'];
const FAMILY = ['sn', 'surname', 'lastName', 'urn:oid:2.5.4.4', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'];

function attribute(profile: SamlProfile, names: string[]): string {
  const record = profile as unknown as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string' && first.trim()) return first.trim();
  }
  return '';
}

/** The person a verified assertion describes, in the shape OpenID Connect sign-in uses. */
export function samlPerson(profile: SamlProfile): { subject: string; email: string | null; emailVerified: boolean; name: string } {
  let email = attribute(profile, EMAIL_ATTRIBUTES);
  if (!email && /emailAddress$/.test(profile.nameIDFormat ?? '')) email = profile.nameID;
  email = email.toLowerCase();
  const name = attribute(profile, NAME_ATTRIBUTES) || [attribute(profile, GIVEN), attribute(profile, FAMILY)].filter(Boolean).join(' ');
  return {
    subject: `${profile.issuer}|${profile.nameID}`,
    email: /^[^\s@]+@[^\s@]+$/.test(email) ? email : null,
    // The workspace chose to trust this provider's statements about its people.
    emailVerified: true,
    name: name || email,
  };
}

/** `SAML_IDP_CERT`: a PEM certificate, or its base64 body, or several separated by commas (during a rollover). */
function certificates(value: string): string[] {
  return value
    .split(/,(?![^-]*-----END)/)
    .map((part) => part.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, ''))
    .filter(Boolean);
}

/** The sign-in address and certificates from an identity provider's metadata. */
export function parseIdpMetadata(xml: string): { entryPoint: string; certs: string[] } {
  const services = [...xml.matchAll(/<(?:\w+:)?SingleSignOnService\b[^>]*>/g)].map((match) => match[0]);
  const redirect = services.find((tag) => /Binding="urn:oasis:names:tc:SAML:2\.0:bindings:HTTP-Redirect"/.test(tag)) ?? services[0];
  const entryPoint = redirect ? (/Location="([^"]+)"/.exec(redirect)?.[1] ?? '') : '';
  // Signing certificates only (a KeyDescriptor without use="encryption").
  const certs: string[] = [];
  for (const match of xml.matchAll(/<(?:\w+:)?KeyDescriptor\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?KeyDescriptor>/g)) {
    if (/use="encryption"/.test(match[1] ?? '')) continue;
    const cert = /<(?:\w+:)?X509Certificate>([\s\S]*?)<\/(?:\w+:)?X509Certificate>/.exec(match[2] ?? '')?.[1];
    if (cert) certs.push(cert.replace(/\s+/g, ''));
  }
  return { entryPoint: entryPoint.replace(/&amp;/g, '&'), certs };
}

export function samlProviderFromEnv(env: NodeJS.ProcessEnv): IdentityProviderConfig | null {
  if (!env.SAML_IDP_METADATA_URL && !(env.SAML_IDP_SSO_URL && env.SAML_IDP_CERT)) return null;
  return {
    id: SAML_ID,
    label: env.SAML_NAME || 'SAML single sign-on',
    kind: 'saml',
    clientId: '',
    clientSecret: '',
    createAccounts: env.SAML_CREATE_ACCOUNTS !== '0',
    saml: {
      metadataUrl: env.SAML_IDP_METADATA_URL || null,
      entryPoint: env.SAML_IDP_SSO_URL || null,
      certs: env.SAML_IDP_CERT ? certificates(env.SAML_IDP_CERT) : [],
      entityId: env.SAML_SP_ENTITY_ID || null,
    },
  };
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

export function installSaml(kernel: Kernel): void {
  const { ctx, router } = kernel;
  const provider = (): IdentityProviderConfig | undefined => (ctx.config.identityProviders ?? []).find((item) => item.kind === 'saml');
  // Request ids this server issued, each accepted once.
  const requests = new InMemoryCacheProvider({ keyExpirationPeriodMs: STATE_TTL * 1000 });
  let client: { saml: SAML; at: number } | null = null;

  const entityId = (config: IdentityProviderConfig): string => config.saml?.entityId || `${ctx.config.publicUrl}/auth/saml/metadata`;
  const callbackUrl = `${ctx.config.publicUrl}/auth/saml/callback`;

  const samlFor = async (config: IdentityProviderConfig): Promise<SAML> => {
    // Metadata is read again hourly, so a certificate rollover at the provider is picked up.
    if (client && (!config.saml?.metadataUrl || Date.now() - client.at < 3_600_000)) return client.saml;
    let entryPoint = config.saml?.entryPoint ?? '';
    let certs = config.saml?.certs ?? [];
    if (config.saml?.metadataUrl) {
      const response = await fetch(config.saml.metadataUrl, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`metadata: HTTP ${response.status}`);
      const parsed = parseIdpMetadata(await response.text());
      entryPoint ||= parsed.entryPoint;
      if (certs.length === 0) certs = parsed.certs;
    }
    if (!entryPoint || certs.length === 0) throw new Error('SAML identity provider has no sign-in address or certificate');
    const saml = new SAML({
      entryPoint,
      idpCert: certs,
      issuer: entityId(config),
      audience: entityId(config),
      callbackUrl,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: STATE_TTL * 1000,
      cacheProvider: requests,
      acceptedClockSkewMs: 60_000,
      identifierFormat: null,
      disableRequestedAuthnContext: true,
    });
    client = { saml, at: Date.now() };
    return saml;
  };

  router.add('GET', /^\/auth\/saml\/metadata$/, ({ res }) => {
    const config = provider();
    if (!config) {
      res.writeHead(404);
      res.end();
      return;
    }
    const xml = generateServiceProviderMetadata({ issuer: entityId(config), callbackUrl, wantAssertionsSigned: true, identifierFormat: null });
    res.writeHead(200, { 'content-type': 'application/samlmetadata+xml; charset=utf-8', 'cache-control': 'no-store' });
    res.end(xml);
  });

  router.add('GET', /^\/auth\/saml\/start$/, async ({ res, url }) => {
    const config = provider();
    if (!config || !ctx.team()) {
      redirect(res, '/signin?error=provider_not_found');
      return;
    }
    const state = newSecret(24);
    ctx.db.run('DELETE FROM oauth_states WHERE created < ?', nowSeconds() - STATE_TTL);
    ctx.db.run(
      "INSERT INTO oauth_states (state, provider, verifier, nonce, invite_code, created) VALUES (?, ?, '', '', ?, ?)",
      state,
      SAML_ID,
      url.searchParams.get('invite'),
      nowSeconds(),
    );
    try {
      redirect(res, await (await samlFor(config)).getAuthorizeUrlAsync(state, {}));
    } catch (error) {
      if (!ctx.config.quiet) console.error('[auth] SAML provider unavailable', error instanceof Error ? error.message : error);
      redirect(res, '/signin?error=provider_unreachable');
    }
  });

  // The identity provider posts its answer here (HTTP-POST binding).
  router.add('POST', /^\/auth\/saml\/callback$/, async ({ req, res }) => {
    const config = provider();
    const form = new URLSearchParams((await readBody(req, 1024 * 1024)).toString('utf8'));
    const relay = form.get('RelayState') ?? '';
    const state = ctx.db.get<{ state: string; provider: string; invite_code: string | null; created: number }>('SELECT * FROM oauth_states WHERE state = ?', relay);
    if (state) ctx.db.run('DELETE FROM oauth_states WHERE state = ?', state.state);
    const back = (code: string): void => {
      redirect(res, state?.invite_code ? `/join/${encodeURIComponent(state.invite_code)}?error=${code}` : `/signin?error=${code}`);
    };
    // Sign-in starts here, never at the provider: an answer without a fresh request of ours is refused.
    if (!config || !state || state.provider !== SAML_ID || state.created < nowSeconds() - STATE_TTL) {
      back('state_invalid');
      return;
    }
    let person: ReturnType<typeof samlPerson>;
    try {
      const { profile } = await (await samlFor(config)).validatePostResponseAsync({ SAMLResponse: form.get('SAMLResponse') ?? '' });
      if (!profile) throw new Error('no assertion');
      person = samlPerson(profile);
    } catch (error) {
      if (!ctx.config.quiet) console.error('[auth] SAML response refused', error instanceof Error ? error.message : error);
      back('provider_error');
      return;
    }
    try {
      const user = accountFor(ctx, config, person, state.invite_code);
      const result = finishSignIn(ctx, user, req, res);
      redirect(res, result.two_factor_required ? '/signin?step=two-factor' : '/');
    } catch (error) {
      back(error instanceof ApiError ? error.code : 'provider_error');
    }
  });
}
