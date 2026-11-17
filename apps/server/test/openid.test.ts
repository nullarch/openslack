import assert from 'node:assert/strict';
import { createPublicKey, createVerify, createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { callWithToken, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

/** Check an RS256 JWT against the provider's published keys and return its claims. */
async function verifyJwt(base: string, jwt: string): Promise<Json> {
  const [head, body, signature] = jwt.split('.') as [string, string, string];
  const header = JSON.parse(Buffer.from(head, 'base64url').toString());
  assert.equal(header.alg, 'RS256');
  const discovery = (await (await fetch(`${base}/.well-known/openid-configuration`)).json()) as Json;
  const { keys } = (await (await fetch(discovery.jwks_uri)).json()) as Json;
  const jwk = keys.find((entry: Json) => entry.kid === header.kid);
  assert.ok(jwk, 'the signing key is published');
  const verifier = createVerify('RSA-SHA256').update(`${head}.${body}`);
  assert.ok(verifier.verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url')), 'the signature verifies');
  return JSON.parse(Buffer.from(body, 'base64url').toString());
}

describe('Sign in with this workspace (OpenID Connect)', () => {
  let t: TestApp;
  let owner: Session;
  let info: Json;
  const redirect = 'https://wiki.example.com/auth/callback';

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    const created = await owner.ok('client.apps.create', { name: 'Team Wiki' });
    await owner.ok('client.apps.update', { app: created.app.id, redirect_urls: [redirect] });
    info = await owner.ok('client.apps.info', { app: created.app.id });
  });
  after(() => t.close());

  const authorizeUrl = (params: Record<string, string> = {}): string =>
    `${t.base}/openid/connect/authorize?${new URLSearchParams({ response_type: 'code', scope: 'openid profile email', client_id: info.client_id, redirect_uri: redirect, state: 'st', nonce: 'n-123', ...params })}`;

  const signIn = async (params: Record<string, string> = {}): Promise<string> => {
    const consent = await fetch(authorizeUrl(params), { headers: { cookie: owner.cookie } });
    // Browsers apply form-action to the redirect after the POST, so the app's address must be allowed.
    assert.match(consent.headers.get('content-security-policy')!, /form-action 'self' https:\/\/wiki\.example\.com;/);
    const html = await consent.text();
    assert.match(html, /Sign in to Team Wiki with your/);
    const token = /name="form_token" value="([0-9a-f]+)"/.exec(html)![1]!;
    const approved = await fetch(authorizeUrl(params), {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: owner.cookie, origin: t.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ decision: 'allow', form_token: token }),
    });
    const back = new URL(approved.headers.get('location')!);
    assert.equal(back.origin + back.pathname, redirect);
    assert.equal(back.searchParams.get('state'), 'st');
    return back.searchParams.get('code')!;
  };

  const exchange = (body: Record<string, string>, headers: Record<string, string> = {}): Promise<Json> =>
    fetch(`${t.base}/api/openid.connect.token`, { method: 'POST', headers, body: new URLSearchParams(body) }).then((r) => r.json() as Promise<Json>);

  test('discovery names this server as the issuer and its endpoints', async () => {
    const doc = (await (await fetch(`${t.base}/.well-known/openid-configuration`)).json()) as Json;
    const issuer = t.app.ctx.config.publicUrl;
    assert.equal(doc.issuer, issuer);
    assert.equal(doc.authorization_endpoint, `${issuer}/openid/connect/authorize`);
    assert.equal(doc.token_endpoint, `${issuer}/api/openid.connect.token`);
    assert.equal(doc.userinfo_endpoint, `${issuer}/api/openid.connect.userInfo`);
    assert.deepEqual(doc.id_token_signing_alg_values_supported, ['RS256']);
  });

  test('a signed-out visitor is sent to the web sign-in, which brings them back', async () => {
    const response = await fetch(authorizeUrl(), { redirect: 'manual' });
    assert.equal(response.status, 302);
    const target = new URL(response.headers.get('location')!, t.base);
    assert.equal(target.pathname, '/signin');
    assert.equal(target.searchParams.get('next'), new URL(authorizeUrl()).pathname + new URL(authorizeUrl()).search);
  });

  test('code → access token and a signed ID token with the asked-for claims', async () => {
    const code = await signIn();
    const basic = `Basic ${Buffer.from(`${info.client_id}:${info.client_secret}`).toString('base64')}`;
    const tokens = await exchange({ code, redirect_uri: redirect, grant_type: 'authorization_code' }, { authorization: basic });
    assert.equal(tokens.ok, true, JSON.stringify(tokens));
    assert.equal(tokens.token_type, 'Bearer');
    assert.match(tokens.access_token, /^xoxp-/);
    const claims = await verifyJwt(t.base, tokens.id_token);
    assert.equal(claims.iss, t.app.ctx.config.publicUrl);
    assert.equal(claims.aud, info.client_id);
    assert.equal(claims.sub, owner.userId);
    assert.equal(claims.nonce, 'n-123');
    assert.equal(claims['https://slack.com/user_id'], owner.userId);
    assert.match(claims['https://slack.com/team_id'], /^T/);
    assert.equal(claims.email, 'owner@acme.test');
    assert.equal(claims.email_verified, false);
    assert.ok(claims.name);
    assert.ok(claims.exp > claims.iat);
    const digest = createHash('sha256').update(tokens.access_token).digest();
    assert.equal(claims.at_hash, digest.subarray(0, 16).toString('base64url'));

    // userInfo answers GET with a bearer token, as OpenID Connect clients call it.
    const viaGet = (await (await fetch(`${t.base}/api/openid.connect.userInfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).json()) as Json;
    assert.equal(viaGet.ok, true, JSON.stringify(viaGet));
    assert.equal(viaGet.sub, owner.userId);
    assert.equal(viaGet.email, 'owner@acme.test');
    // The token is for knowing who someone is, nothing more.
    assert.equal((await callWithToken(t.base, tokens.access_token, 'chat.postMessage', { channel: '#general', text: 'x' })).error, 'missing_scope');
    assert.equal((await exchange({ code, client_id: info.client_id, client_secret: info.client_secret })).error, 'invalid_code', 'a code works once');
  });

  test('without the email scope there is no email; refusals go back to the app', async () => {
    const code = await signIn({ scope: 'openid profile' });
    const tokens = await exchange({ code, client_id: info.client_id, client_secret: info.client_secret });
    const claims = await verifyJwt(t.base, tokens.id_token);
    assert.equal(claims.email, undefined);
    assert.ok(claims.name);

    const bounce = async (params: Record<string, string>): Promise<string | null> => {
      const response = await fetch(authorizeUrl(params), { headers: { cookie: owner.cookie }, redirect: 'manual' });
      return new URL(response.headers.get('location')!).searchParams.get('error');
    };
    assert.equal(await bounce({ scope: 'profile email' }), 'invalid_scope');
    assert.equal(await bounce({ scope: 'openid chat:write' }), 'invalid_scope');
    assert.equal(await bounce({ response_type: 'token' }), 'unsupported_response_type');
    assert.equal((await fetch(authorizeUrl({ redirect_uri: 'https://evil.example/' }), { headers: { cookie: owner.cookie } })).status, 400);
    assert.equal((await exchange({ code: 'nope', client_id: info.client_id, client_secret: 'wrong' })).error, 'bad_client_secret');
  });
});
