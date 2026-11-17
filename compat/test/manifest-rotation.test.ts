import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { after, before, describe, test } from 'node:test';
import bolt from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { setupWorkspace, startApp, type Json, type Session, type TestApp } from '@app/server/test/helpers.ts';
import { freePort, saveExercised } from './harness.ts';

const { App, LogLevel } = bolt;
const require = createRequire(import.meta.url);
const version = (name: string): string => (JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as { version: string }).version;

/** Methods called with an API credential, including the ones that take no ordinary token (config tokens, refresh grants). */
function recordCalls(t: TestApp): Set<string> {
  const called = new Set<string>();
  for (const name of t.app.registry.names()) {
    const def = t.app.registry.get(name)!;
    const original = def.handler;
    def.handler = (call) => {
      const credential = Boolean(call.req.headers.authorization) || Boolean(call.args.str('token')) || call.args.has('refresh_token') || call.args.has('client_id');
      if ((call.actor && call.actor.kind !== 'session') || (!call.actor && credential)) called.add(name);
      return original(call);
    };
  }
  return called;
}

class MemoryStore {
  readonly installs: Json[] = [];
  async storeInstallation(installation: Json): Promise<void> {
    this.installs.push(structuredClone(installation));
  }
  async fetchInstallation(): Promise<Json> {
    const last = this.installs.at(-1);
    if (!last) throw new Error('no installation');
    return structuredClone(last);
  }
  async deleteInstallation(): Promise<void> {
    this.installs.length = 0;
  }
}

/**
 * An app set up from its manifest with the official Web API client and an app
 * configuration token, then installed by Bolt with token rotation on: Bolt's
 * own installer refreshes the twelve-hour token when it is close to expiry.
 */
describe('app manifests and token rotation with the official SDKs', { timeout: 30_000 }, () => {
  let t: TestApp;
  let owner: Session;
  let called: Set<string>;
  let app: InstanceType<typeof App> | undefined;
  let boltBase: string;
  let tooling: WebClient;
  let appId: string;
  const store = new MemoryStore();

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    called = recordCalls(t);
    const port = await freePort();
    boltBase = `http://127.0.0.1:${port}`;
    const config = await owner.ok('client.apps.configToken');

    // The configuration token is short-lived; rotate it the way tooling does before using it.
    const rotated = await new WebClient(undefined, { slackApiUrl: `${t.base}/api/` }).tooling.tokens.rotate({ refresh_token: config.refresh_token });
    assert.match(String(rotated.token), /^xoxe\.xoxp-/);
    tooling = new WebClient(String(rotated.token), { slackApiUrl: `${t.base}/api/` });

    const manifest = {
      display_information: { name: 'Rotating Bolt App' },
      features: { bot_user: { display_name: 'rotating', always_online: false } },
      oauth_config: { redirect_urls: [`${boltBase}/slack/oauth_redirect`], scopes: { bot: ['chat:write'] } },
      settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: true },
    };
    const validated = await tooling.apps.manifest.validate({ manifest: manifest as never });
    assert.equal(validated.ok, true);
    const created = await tooling.apps.manifest.create({ manifest: manifest as never });
    appId = String(created.app_id);
    const credentials = created.credentials as Json;

    app = new App({
      signingSecret: credentials.signing_secret,
      clientId: credentials.client_id,
      clientSecret: credentials.client_secret,
      stateSecret: 'a-state-secret-for-tests',
      scopes: ['chat:write'],
      redirectUri: `${boltBase}/slack/oauth_redirect`,
      installationStore: store,
      installerOptions: { authorizationUrl: `${t.base}/oauth/v2/authorize`, directInstall: true, redirectUriPath: '/slack/oauth_redirect' },
      clientOptions: { slackApiUrl: `${t.base}/api/` },
      logLevel: LogLevel.ERROR,
    });
    await app.start(port);
  });
  after(async () => {
    await app?.stop().catch(() => undefined);
    saveExercised('web-api-manifest', `@slack/web-api ${version('@slack/web-api')}, @slack/bolt ${version('@slack/bolt')}`, called, []);
    await t.close();
  });

  test('the manifest comes back out of apps.manifest.export', async () => {
    const exported = await tooling.apps.manifest.export({ app_id: appId });
    const manifest = exported.manifest as Json;
    assert.equal(manifest.display_information.name, 'Rotating Bolt App');
    assert.equal(manifest.settings.token_rotation_enabled, true);
    assert.deepEqual(manifest.oauth_config.scopes.bot, ['chat:write']);
  });

  test('Bolt stores a refresh token at install and refreshes the token near expiry', async () => {
    const install = await fetch(`${boltBase}/slack/install`, { redirect: 'manual' });
    const stateCookie = install.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
    const authorize = new URL(install.headers.get('location')!);
    const html = await (await fetch(authorize, { headers: { cookie: owner.cookie } })).text();
    const formToken = /name="form_token" value="([0-9a-f]+)"/.exec(html)![1]!;
    const approve = await fetch(authorize, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: owner.cookie, origin: t.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ decision: 'allow', form_token: formToken }),
    });
    const finish = await fetch(new URL(approve.headers.get('location')!), { headers: { cookie: stateCookie } });
    assert.equal(finish.status, 200, await finish.text());

    const installed = store.installs.at(-1)!;
    assert.match(installed.bot.token, /^xoxe\.xoxb-/);
    assert.match(installed.bot.refreshToken, /^xoxe-1-/);
    const now = Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(installed.bot.expiresAt - (now + 43_200)) < 60, `expiresAt ${installed.bot.expiresAt}`);

    // Pretend the token is about to expire; Bolt's installer refreshes it when it authorizes.
    store.installs[store.installs.length - 1]!.bot.expiresAt = now + 60;
    const installer = (app as unknown as { receiver: { installer: { authorize(query: Json): Promise<Json> } } }).receiver.installer;
    const authorized = await installer.authorize({ teamId: installed.team.id, isEnterpriseInstall: false });
    assert.match(authorized.botToken, /^xoxe\.xoxb-/);
    assert.notEqual(authorized.botToken, installed.bot.token);
    const refreshed = store.installs.at(-1)!;
    assert.equal(refreshed.bot.token, authorized.botToken, 'the refreshed installation was stored');
    assert.notEqual(refreshed.bot.refreshToken, installed.bot.refreshToken);

    const client = new WebClient(authorized.botToken, { slackApiUrl: `${t.base}/api/` });
    assert.equal((await client.chat.postMessage({ channel: '#general', text: 'posted with a refreshed token' })).ok, true);
  });

  test('apps.manifest.delete removes the app', async () => {
    assert.equal((await tooling.apps.manifest.delete({ app_id: appId })).ok, true);
    await assert.rejects(tooling.apps.manifest.export({ app_id: appId }), /app_not_found/);
  });
});
