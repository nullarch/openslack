import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import * as oidc from 'openid-client';
import { WebClient } from '@slack/web-api';
import { setupWorkspace, startApp, type Json, type Session, type TestApp } from '@app/server/test/helpers.ts';
import { saveExercised } from './harness.ts';

/**
 * "Sign in with this workspace" from the outside: a certified OpenID Connect
 * relying-party library (openid-client) discovers the provider, runs the code
 * flow with state and nonce, validates the ID token and reads userinfo; the
 * official Web API client calls the Slack-named methods for the same flow.
 */
describe('OpenID Connect sign-in with openid-client and @slack/web-api', { timeout: 30_000 }, () => {
  let t: TestApp;
  let owner: Session;
  let info: Json;
  const called = new Set<string>();
  const redirect = 'https://wiki.example.com/auth/callback';

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    const created = await owner.ok('client.apps.create', { name: 'Team Wiki' });
    await owner.ok('client.apps.update', { app: created.app.id, redirect_urls: [redirect] });
    info = await owner.ok('client.apps.info', { app: created.app.id });
  });
  after(async () => {
    saveExercised('openid-connect', 'openid-client 6.8.9, @slack/web-api', called, []);
    await t.close();
  });

  /** The person approves in the browser; return the URL the app is sent back to. */
  const approve = async (authorizationUrl: URL): Promise<URL> => {
    const html = await (await fetch(authorizationUrl, { headers: { cookie: owner.cookie } })).text();
    const formToken = /name="form_token" value="([0-9a-f]+)"/.exec(html)![1]!;
    const response = await fetch(authorizationUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: owner.cookie, origin: authorizationUrl.origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ decision: 'allow', form_token: formToken }),
    });
    return new URL(response.headers.get('location')!);
  };

  test('openid-client: discovery, code flow, ID token validation, userinfo', async () => {
    const issuer = new URL(t.app.ctx.config.publicUrl);
    const config = await oidc.discovery(issuer, info.client_id, info.client_secret, undefined, { execute: [oidc.allowInsecureRequests] });
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(config, { redirect_uri: redirect, scope: 'openid profile email', state, nonce });
    const callback = await approve(url);
    const tokens = await oidc.authorizationCodeGrant(config, callback, { expectedState: state, expectedNonce: nonce });
    const claims = tokens.claims()!;
    assert.equal(claims.sub, owner.userId);
    assert.equal(claims.email, 'owner@acme.test');
    const userInfo = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
    assert.equal(userInfo.sub, owner.userId);
    assert.equal(userInfo.email, 'owner@acme.test');
    called.add('openid.connect.token');
    called.add('openid.connect.userInfo');
  });

  test('@slack/web-api: openid.connect.token and openid.connect.userInfo', async () => {
    const url = new URL(`${t.base}/openid/connect/authorize?${new URLSearchParams({ response_type: 'code', scope: 'openid email', client_id: info.client_id, redirect_uri: redirect, state: 's' })}`);
    const code = (await approve(url)).searchParams.get('code')!;
    const api = new WebClient(undefined, { slackApiUrl: `${t.base}/api/` });
    const tokens = await api.openid.connect.token({ client_id: info.client_id, client_secret: info.client_secret, code, redirect_uri: redirect });
    assert.equal(tokens.token_type, 'Bearer');
    assert.ok(tokens.id_token);
    const me = await new WebClient(tokens.access_token, { slackApiUrl: `${t.base}/api/` }).openid.connect.userInfo();
    assert.equal(me.sub, owner.userId);
    assert.equal(me['https://slack.com/user_id' as keyof typeof me], owner.userId);
  });
});
