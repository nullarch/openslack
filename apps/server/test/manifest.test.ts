import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { addMember, callWithToken, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

const manifest = (overrides: Json = {}): Json => ({
  display_information: { name: 'Standup Bot', description: 'Collects standups', background_color: '#2c2d30' },
  features: {
    bot_user: { display_name: 'Standup', always_online: true },
    app_home: { home_tab_enabled: true, messages_tab_enabled: false },
    slash_commands: [{ command: '/standup', description: 'Post your standup', usage_hint: '[yesterday] [today]', should_escape: false }],
    shortcuts: [{ name: 'Start standup', type: 'global', callback_id: 'start_standup', description: 'Open the standup form' }],
    unfurl_domains: ['standup.example.com'],
  },
  oauth_config: { redirect_urls: ['https://standup.example.com/oauth'], scopes: { bot: ['chat:write', 'commands', 'app_mentions:read'] } },
  settings: {
    event_subscriptions: { bot_events: ['app_mention'] },
    interactivity: { is_enabled: true },
    socket_mode_enabled: true,
    org_deploy_enabled: false,
    token_rotation_enabled: false,
  },
  ...overrides,
});

describe('app manifests', () => {
  let t: TestApp;
  let owner: Session;
  let config: Json;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    config = await owner.ok('client.apps.configToken');
  });
  after(() => t.close());

  test('configuration tokens are for admins, last twelve hours and rotate with their refresh token', async () => {
    assert.match(config.token, /^xoxe\.xoxp-1-/);
    assert.match(config.refresh_token, /^xoxe-1-/);
    assert.equal(config.exp - config.iat, 43_200);
    const member = await addMember(t, owner, 'Mia Member');
    assert.equal((await member.call('client.apps.configToken')).error, 'not_allowed');

    const rotate = (refresh: string): Promise<Json> =>
      fetch(`${t.base}/api/tooling.tokens.rotate`, { method: 'POST', body: new URLSearchParams({ refresh_token: refresh }) }).then((response) => response.json());
    const fresh = await rotate(config.refresh_token);
    assert.equal(fresh.ok, true);
    assert.notEqual(fresh.token, config.token);
    assert.equal(fresh.user_id, owner.userId);
    assert.equal((await rotate(config.refresh_token)).error, 'invalid_refresh_token', 'a refresh token works once');
    config = fresh;
  });

  test('validate reports every problem with a pointer to it', async () => {
    const ok = await callWithToken(t.base, config.token, 'apps.manifest.validate', { manifest: JSON.stringify(manifest()) });
    assert.deepEqual(ok, { ok: true, errors: [] });
    const bad = await callWithToken(t.base, config.token, 'apps.manifest.validate', {
      manifest: JSON.stringify({
        display_information: { name: 'x'.repeat(40) },
        features: { slash_commands: [{ command: 'standup' }] },
        oauth_config: { scopes: { bot: ['chat:write', 'remote_files:share'] } },
        settings: { event_subscriptions: { bot_events: ['message.channels'] }, interactivity: { is_enabled: true } },
        functions: {},
        workflows: {},
      }),
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'invalid_manifest');
    const pointers = bad.errors.map((error: Json) => error.pointer);
    for (const pointer of [
      '/display_information/name',
      '/features/slash_commands/0/description',
      '/oauth_config/scopes/bot/1',
      '/features/bot_user',
      '/settings/event_subscriptions',
      '/settings/interactivity',
      '/settings/function_runtime',
      '/workflows',
    ]) {
      assert.ok(pointers.includes(pointer), `${pointer} in ${JSON.stringify(pointers)}`);
    }
    assert.ok(bad.errors.some((error: Json) => error.message === 'Event Subscription requires either Request URL or Socket Mode Enabled'));
    assert.equal((await callWithToken(t.base, config.token, 'apps.manifest.validate', { manifest: '{not json' })).error, 'invalid_manifest');
  });

  test('only a configuration token (or an admin in the web client) may use the methods', async () => {
    const created = await owner.ok('client.apps.create', { name: 'Plain' });
    assert.equal((await callWithToken(t.base, created.bot_token, 'apps.manifest.validate', { manifest: '{}' })).error, 'not_allowed_token_type');
    assert.equal((await callWithToken(t.base, 'xoxe.xoxp-1-nope', 'apps.manifest.validate', { manifest: '{}' })).error, 'invalid_auth');
    const anonymous = await fetch(`${t.base}/api/apps.manifest.validate`, { method: 'POST', body: new URLSearchParams({ manifest: '{}' }) }).then((r) => r.json() as Promise<Json>);
    assert.equal(anonymous.error, 'not_authed');
    const viaSession = await owner.call('apps.manifest.validate', { manifest: JSON.stringify(manifest()) });
    assert.equal(viaSession.ok, true);
    await owner.ok('client.apps.delete', { app: created.app.id });
  });

  test('create sets the app up from the manifest; export gives it back', async () => {
    const created = await callWithToken(t.base, config.token, 'apps.manifest.create', { manifest: JSON.stringify(manifest()) });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.match(created.app_id, /^A/);
    for (const key of ['client_id', 'client_secret', 'verification_token', 'signing_secret']) assert.equal(typeof created.credentials[key], 'string');
    const authorize = new URL(created.oauth_authorize_url);
    assert.equal(authorize.pathname, '/oauth/v2/authorize');
    assert.equal(authorize.searchParams.get('client_id'), created.credentials.client_id);
    assert.equal(authorize.searchParams.get('scope'), 'chat:write,commands,app_mentions:read');

    const apps = (await owner.ok('client.apps.list')).apps;
    const app = apps.find((entry: Json) => entry.id === created.app_id);
    assert.equal(app.name, 'Standup Bot');
    assert.equal(app.socket_mode, true);
    assert.deepEqual(app.bot_events, ['app_mention']);
    assert.deepEqual(app.unfurl_domains, ['standup.example.com']);
    assert.equal(app.shortcuts[0].callback_id, 'start_standup');
    const commands = (await owner.ok('client.commands.list')).commands;
    assert.ok(commands.some((entry: Json) => entry.command === '/standup' && entry.app_id === created.app_id));
    const users = (await owner.ok('users.list')).members;
    assert.equal(users.find((user: Json) => user.id === app.bot_user_id).real_name, 'Standup');

    const exported = await callWithToken(t.base, config.token, 'apps.manifest.export', { app_id: created.app_id });
    assert.equal(exported.ok, true);
    const back = exported.manifest;
    assert.deepEqual(Object.keys(back).slice(0, 5), ['_metadata', 'display_information', 'features', 'oauth_config', 'settings']);
    assert.deepEqual(back.display_information, manifest().display_information);
    assert.deepEqual(back.features.slash_commands, manifest().features.slash_commands);
    assert.deepEqual(back.features.bot_user, { display_name: 'Standup', always_online: true });
    assert.deepEqual(back.features.app_home, { home_tab_enabled: true, messages_tab_enabled: false });
    assert.deepEqual(back.oauth_config, manifest().oauth_config);
    assert.equal(back.settings.socket_mode_enabled, true);
    assert.deepEqual(back.settings.event_subscriptions, { bot_events: ['app_mention'] });

    // A command name another app already uses is refused, and nothing is left behind.
    const before = (await owner.ok('client.apps.list')).apps.length;
    const clash = await callWithToken(t.base, config.token, 'apps.manifest.create', { manifest: JSON.stringify(manifest({ display_information: { name: 'Clash' } })) });
    assert.equal(clash.error, 'invalid_manifest');
    assert.equal(clash.errors[0].pointer, '/features/slash_commands/0/command');
    assert.equal((await owner.ok('client.apps.list')).apps.length, before);
  });

  test('update replaces the whole configuration and says whether permissions changed', async () => {
    const created = await callWithToken(t.base, config.token, 'apps.manifest.create', {
      manifest: JSON.stringify(manifest({ display_information: { name: 'Polls' }, features: { bot_user: { display_name: 'Polls' }, slash_commands: [{ command: '/poll', description: 'Ask' }] } })),
    });
    const same = await callWithToken(t.base, config.token, 'apps.manifest.update', {
      app_id: created.app_id,
      manifest: JSON.stringify(manifest({ display_information: { name: 'Polls 2' }, features: { bot_user: { display_name: 'Polls' }, slash_commands: [{ command: '/vote', description: 'Vote' }] } })),
    });
    assert.deepEqual(same, { ok: true, app_id: created.app_id, permissions_updated: false });
    const commands = (await owner.ok('client.commands.list')).commands.filter((entry: Json) => entry.app_id === created.app_id).map((entry: Json) => entry.command);
    assert.deepEqual(commands, ['/vote'], 'commands the manifest no longer lists are removed');
    const widened = await callWithToken(t.base, config.token, 'apps.manifest.update', {
      app_id: created.app_id,
      manifest: JSON.stringify(manifest({ display_information: { name: 'Polls 2' }, features: { bot_user: { display_name: 'Polls' } }, oauth_config: { scopes: { bot: ['chat:write', 'reactions:write'] } } })),
    });
    assert.equal(widened.permissions_updated, true);
    assert.equal((await callWithToken(t.base, config.token, 'apps.manifest.update', { app_id: 'ANOPE', manifest: JSON.stringify(manifest()) })).error, 'app_not_found');

    // Token rotation cannot be switched off once on.
    const on = manifest({ display_information: { name: 'Polls 2' }, features: { bot_user: { display_name: 'Polls' } } });
    (on.settings as Json).token_rotation_enabled = true;
    assert.equal((await callWithToken(t.base, config.token, 'apps.manifest.update', { app_id: created.app_id, manifest: JSON.stringify(on) })).ok, true);
    const off = structuredClone(on);
    (off.settings as Json).token_rotation_enabled = false;
    const refused = await callWithToken(t.base, config.token, 'apps.manifest.update', { app_id: created.app_id, manifest: JSON.stringify(off) });
    assert.equal(refused.error, 'invalid_manifest');
    assert.equal(refused.errors[0].pointer, '/settings/token_rotation_enabled');

    assert.deepEqual(await callWithToken(t.base, config.token, 'apps.manifest.delete', { app_id: created.app_id }), { ok: true });
    assert.equal((await callWithToken(t.base, config.token, 'apps.manifest.export', { app_id: created.app_id })).error, 'app_not_found');
  });

  test('functions in the manifest become custom workflow steps the app runs', async () => {
    const spec = manifest({ display_information: { name: 'Steps' }, features: { bot_user: { display_name: 'Steps' } } });
    spec.functions = {
      approve_request: {
        title: 'Approve a request',
        description: 'Asks a manager',
        input_parameters: { properties: { manager: { type: 'slack#/types/user_id', title: 'Manager' }, amount: { type: 'number', title: 'Amount' } }, required: ['manager'] },
        output_parameters: { properties: { approved: { type: 'boolean', title: 'Approved' } }, required: ['approved'] },
      },
    };
    (spec.settings as Json).function_runtime = 'remote';
    const created = await callWithToken(t.base, config.token, 'apps.manifest.create', { manifest: JSON.stringify(spec) });
    assert.equal(created.ok, true, JSON.stringify(created));
    const app = (await owner.ok('client.apps.list')).apps.find((entry: Json) => entry.id === created.app_id);
    assert.deepEqual(app.functions, [
      {
        callback_id: 'approve_request',
        title: 'Approve a request',
        description: 'Asks a manager',
        input_parameters: [
          { name: 'manager', title: 'Manager', type: 'user_id', required: true },
          { name: 'amount', title: 'Amount', type: 'number', required: false },
        ],
        output_parameters: [{ name: 'approved', title: 'Approved', type: 'boolean', required: true }],
      },
    ]);
    const exported = (await callWithToken(t.base, config.token, 'apps.manifest.export', { app_id: created.app_id })).manifest;
    assert.deepEqual(exported.functions, spec.functions);
    assert.equal(exported.settings.function_runtime, 'remote');
    const bad = structuredClone(spec);
    ((bad.functions as Json).approve_request as Json).input_parameters = { properties: { when: { type: 'slack#/types/timestamp' } } };
    const refused = await callWithToken(t.base, config.token, 'apps.manifest.validate', { manifest: JSON.stringify(bad) });
    assert.equal(refused.errors[0].pointer, '/functions');
  });

  test('a request URL is used once it answers the verification handshake', async () => {
    let answering = false;
    const received: Json[] = [];
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const payload = JSON.parse(body || '{}');
        received.push(payload);
        if (!answering) {
          res.writeHead(500).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ challenge: payload.challenge }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/slack/events`;
    try {
      const http = manifest({ display_information: { name: 'Hooks' }, features: { bot_user: { display_name: 'Hooks' } } });
      http.settings = { event_subscriptions: { request_url: url, bot_events: ['app_mention'] }, socket_mode_enabled: false };
      const created = await callWithToken(t.base, config.token, 'apps.manifest.create', { manifest: JSON.stringify(http) });
      assert.equal(created.ok, true, JSON.stringify(created));
      const listed = (await owner.ok('client.apps.list')).apps.find((entry: Json) => entry.id === created.app_id);
      assert.equal(listed.events_url, null, 'not used before it answers');
      const exported = await callWithToken(t.base, config.token, 'apps.manifest.export', { app_id: created.app_id });
      assert.equal(exported.manifest.settings.event_subscriptions.request_url, url, 'the export still names it');

      answering = true;
      await callWithToken(t.base, config.token, 'apps.manifest.update', { app_id: created.app_id, manifest: JSON.stringify(http) });
      const verified = (await owner.ok('client.apps.list')).apps.find((entry: Json) => entry.id === created.app_id);
      assert.equal(verified.events_url, url);
      assert.ok(received.every((payload) => payload.type === 'url_verification'));
    } finally {
      server.close();
    }
  });
});

describe('token rotation', () => {
  let t: TestApp;
  let owner: Session;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
  });
  after(() => t.close());

  const install = async (clientId: string, redirect: string): Promise<string> => {
    const authorize = `${t.base}/oauth/v2/authorize?${new URLSearchParams({ client_id: clientId, scope: 'chat:write', user_scope: 'reactions:write', redirect_uri: redirect, state: 's' })}`;
    const html = await (await fetch(authorize, { headers: { cookie: owner.cookie } })).text();
    const formToken = /name="form_token" value="([0-9a-f]+)"/.exec(html)![1]!;
    const approved = await fetch(authorize, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: owner.cookie, origin: t.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ decision: 'allow', form_token: formToken }),
    });
    return new URL(approved.headers.get('location')!).searchParams.get('code')!;
  };

  test('an app with rotation on gets twelve-hour tokens and refresh tokens, and can trade them in', async () => {
    const redirect = 'https://rotating.example.com/oauth';
    const config = await owner.ok('client.apps.configToken');
    const spec = manifest({ display_information: { name: 'Rotating' }, features: { bot_user: { display_name: 'Rotating' } } });
    spec.oauth_config = { redirect_urls: [redirect], scopes: { bot: ['chat:write'], user: ['reactions:write'] } };
    (spec.settings as Json).token_rotation_enabled = true;
    const created = await callWithToken(t.base, config.token, 'apps.manifest.create', { manifest: JSON.stringify(spec) });
    const { client_id: clientId, client_secret: clientSecret } = created.credentials;
    const access = (body: Record<string, string>): Promise<Json> =>
      fetch(`${t.base}/api/oauth.v2.access`, { method: 'POST', body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...body }) }).then((r) => r.json());

    const installed = await access({ code: await install(clientId, redirect), redirect_uri: redirect });
    assert.equal(installed.ok, true, JSON.stringify(installed));
    assert.match(installed.access_token, /^xoxe\.xoxb-/);
    assert.match(installed.refresh_token, /^xoxe-1-/);
    assert.equal(installed.expires_in, 43_200);
    assert.match(installed.authed_user.access_token, /^xoxe\.xoxp-/);
    assert.match(installed.authed_user.refresh_token, /^xoxe-1-/);
    assert.equal((await callWithToken(t.base, installed.access_token, 'auth.test')).ok, true);

    const refreshed = await access({ grant_type: 'refresh_token', refresh_token: installed.refresh_token });
    assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
    assert.equal(refreshed.token_type, 'bot');
    assert.equal(refreshed.expires_in, 43_200);
    assert.notEqual(refreshed.access_token, installed.access_token);
    assert.equal(refreshed.bot_user_id, installed.bot_user_id);
    assert.equal((await access({ grant_type: 'refresh_token', refresh_token: installed.refresh_token })).error, 'invalid_refresh_token');
    const user = await access({ grant_type: 'refresh_token', refresh_token: installed.authed_user.refresh_token });
    assert.equal(user.token_type, 'user');
    assert.equal(user.user_id, owner.userId);
    assert.equal((await callWithToken(t.base, user.access_token, 'auth.test')).user_id, owner.userId);

    // Two access tokens stay alive; a third retires the oldest.
    assert.equal((await callWithToken(t.base, installed.access_token, 'auth.test')).ok, true);
    const third = await access({ grant_type: 'refresh_token', refresh_token: refreshed.refresh_token });
    assert.equal((await callWithToken(t.base, third.access_token, 'auth.test')).ok, true);
    assert.equal((await callWithToken(t.base, refreshed.access_token, 'auth.test')).ok, true);
    assert.equal((await callWithToken(t.base, installed.access_token, 'auth.test')).error, 'invalid_auth');

    assert.equal((await access({ grant_type: 'password' })).error, 'invalid_grant_type');
    assert.equal((await access({ grant_type: 'refresh_token', refresh_token: 'xoxe-1-made-up' })).error, 'invalid_refresh_token');
  });

  test('an expired rotating token is refused as token_expired', async () => {
    const created = await owner.ok('client.apps.create', { name: 'Clock' });
    const { issueRotating } = await import('../src/platform/rotation.ts');
    const pair = issueRotating(t.app.ctx, { kind: 'bot', appId: created.app.id, userId: created.app.bot_user_id, scopes: ['chat:write'] });
    assert.equal((await callWithToken(t.base, created.bot_token, 'auth.test')).error, 'invalid_auth', 'the long-lived token is retired');
    t.app.ctx.db.run('UPDATE tokens SET expires = 1 WHERE app_id = ? AND expires IS NOT NULL', created.app.id);
    assert.equal((await callWithToken(t.base, pair.access_token, 'auth.test')).error, 'token_expired');
  });

  test('without rotation, refresh grants are refused', async () => {
    const created = await owner.ok('client.apps.create', { name: 'Plain' });
    const info = await owner.ok('client.apps.info', { app: created.app.id });
    const refused = await fetch(`${t.base}/api/oauth.v2.access`, {
      method: 'POST',
      body: new URLSearchParams({ client_id: info.client_id, client_secret: info.client_secret, grant_type: 'refresh_token', refresh_token: 'xoxe-1-x' }),
    }).then((r) => r.json() as Promise<Json>);
    assert.equal(refused.error, 'invalid_refresh_token');
  });
});
