import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { after, before, describe, test } from 'node:test';
import bolt from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { setupWorkspace, startApp, type Json, type Session, type TestApp } from '@app/server/test/helpers.ts';
import { freePort, recordTokenCalls, saveExercised } from './harness.ts';

const { App, LogLevel } = bolt;
const require = createRequire(import.meta.url);
const boltVersion = (JSON.parse(readFileSync(require.resolve('@slack/bolt/package.json'), 'utf8')) as { version: string }).version;

/** Installations saved by Bolt's install flow, in memory. */
class MemoryStore {
  readonly installs: Json[] = [];
  async storeInstallation(installation: Json): Promise<void> {
    this.installs.push(installation);
  }
  async fetchInstallation(): Promise<Json> {
    const last = this.installs.at(-1);
    if (!last) throw new Error('no installation');
    return last;
  }
  async deleteInstallation(): Promise<void> {
    this.installs.length = 0;
  }
}

/** The cookie header value for the cookies a response sets. */
function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

/**
 * A distributed app installs the way it installs on Slack: Bolt's built-in
 * OAuth flow ("Add to Slack") with only the authorization page and API address
 * pointed at this server.
 */
describe('an official Bolt app installed through the OAuth v2 flow', { timeout: 30_000 }, () => {
  let t: TestApp;
  let owner: Session;
  let app: InstanceType<typeof App> | undefined;
  let boltBase: string;
  let called: Set<string>;
  const store = new MemoryStore();

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    const created = await owner.ok('client.apps.create', { name: 'Distributed App', socket_mode: false });
    const port = await freePort();
    boltBase = `http://127.0.0.1:${port}`;
    const redirectUri = `${boltBase}/slack/oauth_redirect`;
    await owner.ok('client.apps.update', { app: created.app.id, redirect_urls: [redirectUri] });
    const info = await owner.ok('client.apps.info', { app: created.app.id });
    called = recordTokenCalls(t);

    app = new App({
      signingSecret: info.signing_secret,
      clientId: info.client_id,
      clientSecret: info.client_secret,
      stateSecret: 'a-state-secret-for-tests',
      scopes: ['chat:write', 'channels:read'],
      redirectUri,
      installationStore: store,
      installerOptions: {
        authorizationUrl: `${t.base}/oauth/v2/authorize`,
        directInstall: true,
        redirectUriPath: '/slack/oauth_redirect',
        userScopes: ['search:read'],
      },
      clientOptions: { slackApiUrl: `${t.base}/api/` },
      logLevel: LogLevel.ERROR,
    });
    await app.start(port);
  });
  after(async () => {
    await app?.stop().catch(() => undefined);
    saveExercised('bolt-js-oauth', `@slack/bolt ${boltVersion}`, called, []);
    await t.close();
  });

  test('install → approve → code exchange → the installation holds working, scoped tokens', async () => {
    // 1. Bolt's install path sends the browser to the authorization page, with a state cookie.
    const install = await fetch(`${boltBase}/slack/install`, { redirect: 'manual' });
    assert.equal(install.status, 302);
    const stateCookie = cookiesFrom(install);
    const authorize = new URL(install.headers.get('location')!);
    assert.equal(authorize.origin + authorize.pathname, `${t.base}/oauth/v2/authorize`);

    // 2. A signed-in admin sees what the app asks for.
    const consent = await fetch(authorize, { headers: { cookie: owner.cookie } });
    const html = await consent.text();
    assert.match(html, /Distributed App wants to join/);
    assert.match(html, /chat:write/);
    assert.match(html, /search:read/);
    const formToken = /name="form_token" value="([0-9a-f]+)"/.exec(html)![1]!;

    // 3. Approving sends the browser back to the app with a code.
    const approve = await fetch(authorize, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: owner.cookie, origin: t.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ decision: 'allow', form_token: formToken }),
    });
    assert.equal(approve.status, 302);
    const callback = new URL(approve.headers.get('location')!);
    assert.equal(callback.origin + callback.pathname, `${boltBase}/slack/oauth_redirect`);
    assert.ok(callback.searchParams.get('code'));

    // 4. Bolt exchanges the code (oauth.v2.access, then auth.test) and stores the installation.
    const finish = await fetch(callback, { headers: { cookie: stateCookie } });
    assert.equal(finish.status, 200, await finish.text());
    const installation = store.installs.at(-1)!;
    assert.deepEqual(installation.bot.scopes, ['chat:write', 'channels:read']);
    assert.ok(installation.bot.token.startsWith('xoxb-'));
    assert.ok(installation.bot.id.startsWith('B'));
    assert.equal(installation.user.id, owner.userId);
    assert.ok(installation.user.token.startsWith('xoxp-'));

    // The tokens work, and only within what was approved.
    const botClient = new WebClient(installation.bot.token, { slackApiUrl: `${t.base}/api/` });
    assert.equal((await botClient.auth.test()).ok, true);
    const posted = await botClient.chat.postMessage({ channel: '#general', text: 'installed through OAuth' });
    assert.equal(posted.ok, true);
    await assert.rejects(botClient.reactions.add({ channel: posted.channel!, timestamp: posted.ts!, name: 'tada' }), /missing_scope/);
    const userClient = new WebClient(installation.user.token, { slackApiUrl: `${t.base}/api/` });
    assert.equal((await userClient.search.messages({ query: 'installed' })).ok, true);

    // A code works once.
    const credentials = await owner.ok('client.apps.info', { app: installation.appId });
    const again = await fetch(`${t.base}/api/oauth.v2.access`, {
      method: 'POST',
      body: new URLSearchParams({ code: callback.searchParams.get('code')!, client_id: credentials.client_id, client_secret: credentials.client_secret }),
    });
    assert.equal(((await again.json()) as Json).error, 'invalid_code');
  });

  test('a member who is not an admin cannot install an app with a bot', async () => {
    const { invite } = await owner.ok('client.invites.create', {});
    const { Session } = await import('@app/server/test/helpers.ts');
    const member = new Session(t.base);
    await member.ok('client.signup', { code: invite.code, email: 'member@acme.test', password: 'a long enough password', real_name: 'Mina' });
    const install = await fetch(`${boltBase}/slack/install`, { redirect: 'manual' });
    const consent = await (await fetch(install.headers.get('location')!, { headers: { cookie: member.cookie } })).text();
    assert.match(consent, /Only workspace admins can install/);
    assert.doesNotMatch(consent, /value="allow"/);
  });
});
