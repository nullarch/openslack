import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

describe('OAuth v2 install flow: refusals', () => {
  let t: TestApp;
  let owner: Session;
  let info: Json;
  const redirect = 'https://app.example.com/oauth/callback';

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    const created = await owner.ok('client.apps.create', { name: 'Third Party' });
    await owner.ok('client.apps.update', { app: created.app.id, redirect_urls: [redirect] });
    info = await owner.ok('client.apps.info', { app: created.app.id });
  });
  after(() => t.close());

  const authorizeUrl = (params: Record<string, string>): string =>
    `${t.base}/oauth/v2/authorize?${new URLSearchParams({ client_id: info.client_id, scope: 'chat:write', redirect_uri: redirect, state: 's1', ...params })}`;

  test('only registered redirect URLs, known client ids and known scopes are accepted', async () => {
    const page = await fetch(authorizeUrl({ redirect_uri: 'https://evil.example/steal' }), { headers: { cookie: owner.cookie } });
    assert.equal(page.status, 400);
    assert.match(await page.text(), /redirect_uri does not match/);
    assert.equal((await fetch(authorizeUrl({ client_id: 'nope' }), { headers: { cookie: owner.cookie } })).status, 400);
    const badScope = await fetch(authorizeUrl({ scope: 'chat:write,admin.everything' }), { headers: { cookie: owner.cookie }, redirect: 'manual' });
    assert.equal(badScope.status, 302);
    assert.equal(new URL(badScope.headers.get('location')!).searchParams.get('error'), 'invalid_scope');
    assert.equal((await owner.call('client.apps.update', { app: info.app.id, redirect_urls: ['javascript:alert(1)'] })).error, 'invalid_redirect_urls');
  });

  test('a signed-out visitor is sent to the web sign-in, which brings them back; the consent page cannot be framed', async () => {
    const signedOut = await fetch(authorizeUrl({}), { redirect: 'manual' });
    assert.equal(signedOut.status, 302);
    const target = new URL(signedOut.headers.get('location')!, t.base);
    assert.equal(target.pathname, '/signin');
    assert.equal(target.searchParams.get('next'), `/oauth/v2/authorize?${new URL(authorizeUrl({})).searchParams}`);
    // There is no password form here any more: two-factor and single sign-on rules cannot be skipped.
    const posted = await fetch(authorizeUrl({}), { method: 'POST', redirect: 'manual', headers: { origin: t.base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ decision: 'signin', email: 'owner@acme.test', password: 'x' }) });
    assert.equal(posted.status, 302);
    assert.equal(new URL(posted.headers.get('location')!, t.base).pathname, '/signin');
    const page = await fetch(authorizeUrl({}), { headers: { cookie: owner.cookie } });
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
  });

  test('approval needs the form token from the page and a same-origin POST; denial reports access_denied', async () => {
    const post = (body: Record<string, string>, origin = t.base): Promise<Response> =>
      fetch(authorizeUrl({}), {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie: owner.cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
      });
    assert.equal((await post({ decision: 'allow' })).status, 400); // no form token
    assert.equal((await post({ decision: 'allow', form_token: 'x'.repeat(64) }, 'https://evil.example')).status, 400);
    const html = await (await fetch(authorizeUrl({}), { headers: { cookie: owner.cookie } })).text();
    const token = /name="form_token" value="([0-9a-f]+)"/.exec(html)![1]!;
    const denied = await post({ decision: 'deny', form_token: token });
    const back = new URL(denied.headers.get('location')!);
    assert.equal(back.origin + back.pathname, redirect);
    assert.equal(back.searchParams.get('error'), 'access_denied');
    assert.equal(back.searchParams.get('state'), 's1');
  });

  test('oauth.v2.access checks the client secret, the code and the redirect_uri', async () => {
    const html = await (await fetch(authorizeUrl({}), { headers: { cookie: owner.cookie } })).text();
    const token = /name="form_token" value="([0-9a-f]+)"/.exec(html)![1]!;
    const approved = await fetch(authorizeUrl({}), {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: owner.cookie, origin: t.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ decision: 'allow', form_token: token }),
    });
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    const exchange = async (body: Record<string, string>, headers: Record<string, string> = {}): Promise<Json> =>
      (await fetch(`${t.base}/api/oauth.v2.access`, { method: 'POST', headers, body: new URLSearchParams(body) })).json();
    assert.equal((await exchange({ code, client_id: info.client_id, client_secret: 'wrong' })).error, 'bad_client_secret');
    assert.equal((await exchange({ code, client_id: info.client_id, client_secret: info.client_secret, redirect_uri: 'https://other.example/' })).error, 'bad_redirect_uri');
    // The failed attempt above used the code up, as Slack does; get a new one and exchange with HTTP Basic credentials.
    const html2 = await (await fetch(authorizeUrl({}), { headers: { cookie: owner.cookie } })).text();
    const token2 = /name="form_token" value="([0-9a-f]+)"/.exec(html2)![1]!;
    const approved2 = await fetch(authorizeUrl({}), {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: owner.cookie, origin: t.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ decision: 'allow', form_token: token2 }),
    });
    const code2 = new URL(approved2.headers.get('location')!).searchParams.get('code')!;
    const basic = Buffer.from(`${info.client_id}:${info.client_secret}`).toString('base64');
    const ok = await exchange({ code: code2 }, { authorization: `Basic ${basic}` });
    assert.equal(ok.ok, true);
    assert.equal(ok.token_type, 'bot');
    assert.equal(ok.scope, 'chat:write');
    assert.equal(ok.authed_user.id, owner.userId);
    // auth.revoke ends that token.
    const revoke: Json = await (await fetch(`${t.base}/api/auth.revoke`, { method: 'POST', headers: { authorization: `Bearer ${ok.access_token}` } })).json();
    assert.equal(revoke.revoked, true);
    const after: Json = await (await fetch(`${t.base}/api/auth.test`, { method: 'POST', headers: { authorization: `Bearer ${ok.access_token}` } })).json();
    assert.equal(after.error, 'invalid_auth');
  });
});
