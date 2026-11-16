import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { isPrivateAddress } from '../src/platform/net.ts';
import { addMember, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';
import { botOk, createPlatformApp, Receiver, sleep, verifySignature, type TestAppCredentials } from './platform-helpers.ts';

process.env.EVENT_ACK_TIMEOUT_MS = '250';
process.env.EVENT_RETRY_DELAYS_MS = '20,40,60';

describe('Events API over HTTP, HTTP interactivity and incoming webhooks', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let general: string;
  let app: TestAppCredentials;
  let receiver: Receiver;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    receiver = await Receiver.start();
    app = await createPlatformApp(owner, 'Http Bot', { socket_mode: false });
    await owner.ok('conversations.invite', { channel: general, users: app.botUserId });
  });
  after(async () => {
    await receiver.close();
    await t.close();
  });

  test('a request URL is accepted only after it echoes the signed challenge', async () => {
    const liar = await Receiver.start();
    liar.reply = () => ({ body: 'not the challenge' });
    const refused = await owner.call('client.apps.update', { app: app.id, events_url: liar.url });
    assert.equal(refused.error, 'url_verification_failed');
    assert.equal(refused.detail, 'challenge_mismatch');
    assert.equal((await owner.ok('client.apps.info', { app: app.id })).app.events_url, null);
    await liar.close();

    const unreachable = await owner.call('client.apps.update', { app: app.id, events_url: 'http://127.0.0.1:9/slack/events' });
    assert.equal(unreachable.error, 'url_verification_failed');
    assert.equal(unreachable.detail, 'connection_failed');
    assert.equal((await owner.call('client.apps.update', { app: app.id, events_url: 'ftp://example.com/x' })).error, 'invalid_url');

    const updated = await owner.ok('client.apps.update', { app: app.id, events_url: receiver.url, interactivity_url: receiver.url });
    assert.equal(updated.app.events_url, receiver.url);
    const challenge = receiver.requests.items[0]!;
    assert.equal(challenge.body.type, 'url_verification');
    assert.equal(typeof challenge.body.challenge, 'string');
    assert.equal(typeof challenge.body.token, 'string');
    assert.equal(challenge.headers['content-type'], 'application/json');
    assert.ok(verifySignature(app.signingSecret, challenge));

    // JSON and form-encoded answers are accepted as well.
    for (const format of ['json', 'form']) {
      const other = await Receiver.start();
      other.reply = (request) =>
        format === 'json'
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challenge: request.body.challenge }) }
          : { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `challenge=${request.body.challenge}` };
      const extra = await createPlatformApp(owner, `Verify ${format}`, { socket_mode: false });
      await owner.ok('client.apps.update', { app: extra.id, events_url: other.url });
      await other.close();
    }
  });

  test('events arrive as signed JSON that verifies the way Bolt verifies it', async () => {
    const { ts } = await member.ok('chat.postMessage', { channel: general, text: 'over http' });
    const request = await receiver.nextEvent('message', (entry) => entry.body.event.ts === ts);
    assert.equal(request.headers['content-type'], 'application/json');
    assert.ok(verifySignature(app.signingSecret, request));
    assert.ok(!verifySignature('another-secret', request));
    assert.equal(request.headers['x-slack-retry-num'], undefined);

    assert.equal(request.body.type, 'event_callback');
    assert.equal(request.body.api_app_id, app.id);
    assert.equal(request.body.authorizations[0].user_id, app.botUserId);
    assert.equal(request.body.event.channel, general);
    assert.equal(request.body.event.channel_type, 'channel');
    assert.equal(request.body.event.text, 'over http');
    await sleep(150);
    assert.equal(receiver.events('message').filter((entry) => entry.body.event.ts === ts).length, 1);
  });

  test('a failed delivery is retried with the retry number and reason, then stops on success', async () => {
    const attempts: Json[] = [];
    receiver.reply = (request) => {
      if (request.body.event?.text !== 'retry me') return undefined;
      attempts.push({ num: request.headers['x-slack-retry-num'], reason: request.headers['x-slack-retry-reason'] });
      if (attempts.length === 1) return { status: 500 };
      if (attempts.length === 2) return { delayMs: 500 }; // slower than the acknowledgement window
      return {};
    };
    await member.ok('chat.postMessage', { channel: general, text: 'retry me' });
    await sleep(1200);
    assert.deepEqual(attempts, [
      { num: undefined, reason: undefined },
      { num: '1', reason: 'http_error' },
      { num: '2', reason: 'http_timeout' },
    ]);
    const deliveries = receiver.events('message').filter((entry) => entry.body.event.text === 'retry me');
    // Every attempt carries the same event and a fresh, valid signature.
    assert.equal(deliveries.length, 3);
    assert.equal(new Set(deliveries.map((entry) => entry.body.event_id)).size, 1);
    assert.ok(deliveries.every((entry) => verifySignature(app.signingSecret, entry)));
    receiver.reply = () => undefined;
  });

  test('retries end after three, or at once when the app answers x-slack-no-retry', async () => {
    let failing = '';
    let noRetry = '';
    receiver.reply = (request) => {
      if (request.body.event?.text === failing) return { status: 503 };
      if (request.body.event?.text === noRetry) return { status: 500, headers: { 'x-slack-no-retry': '1' } };
      return undefined;
    };
    failing = 'always failing';
    noRetry = 'do not retry this';
    await member.ok('chat.postMessage', { channel: general, text: failing });
    await member.ok('chat.postMessage', { channel: general, text: noRetry });
    await sleep(900);
    const retryNums = (text: string): unknown[] =>
      receiver.events('message').filter((entry) => entry.body.event.text === text).map((entry) => entry.headers['x-slack-retry-num']);
    assert.deepEqual(retryNums(failing), [undefined, '1', '2', '3']);
    assert.deepEqual(retryNums(noRetry), [undefined]);
    // Nothing is left queued.
    assert.equal(t.app.ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM outbox')?.n, 0);
    receiver.reply = () => undefined;
  });

  test('private addresses are refused unless the server itself is local or the admin allows them', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      assert.equal(isPrivateAddress(address), true, address);
    }
    for (const address of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
      assert.equal(isPrivateAddress(address), false, address);
    }
    process.env.ALLOW_PRIVATE_APP_URLS = '0';
    try {
      const blocked = await owner.call('client.apps.update', { app: app.id, interactivity_url: receiver.url, events_url: `${receiver.url}?again` });
      assert.equal(blocked.error, 'url_verification_failed');
      assert.equal(blocked.detail, 'blocked_address');
    } finally {
      delete process.env.ALLOW_PRIVATE_APP_URLS;
    }
  });

  test('a button click is POSTed as a signed form with a payload field, and response_url works', async () => {
    const posted = await botOk(t.base, app, 'chat.postMessage', {
      channel: general,
      text: 'Deploy?',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: 'Deploy build 12?' } },
        { type: 'actions', block_id: 'deploy', elements: [{ type: 'button', action_id: 'approve', text: { type: 'plain_text', text: 'Approve' }, value: 'build-12', style: 'primary' }] },
      ],
    });
    await member.ok('client.interactions.blockAction', { channel: general, message_ts: posted.ts, action: { action_id: 'approve', block_id: 'deploy' } });
    const request = await receiver.requests.next((entry) => entry.body.payload?.type === 'block_actions');
    // Bolt compares this header for equality, so no charset suffix.
    assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.ok(request.raw.startsWith('payload='));
    assert.ok(verifySignature(app.signingSecret, request));
    const payload = request.body.payload;
    assert.equal(payload.user.id, member.userId);
    assert.equal(payload.actions[0].value, 'build-12');

    const response = await fetch(payload.response_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Approved by Mina' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    const history = await owner.ok('conversations.history', { channel: general, latest: posted.ts, inclusive: true, limit: 1 });
    assert.equal(history.messages[0].text, 'Approved by Mina');
    assert.equal(history.messages[0].blocks, undefined);

    // An app that does not answer in time, or is not there at all.
    receiver.reply = (entry) => (entry.body.payload ? { delayMs: 600 } : undefined);
    assert.equal((await member.call('client.interactions.blockAction', { channel: general, message_ts: posted.ts, action: { action_id: 'approve' } })).error, 'action_not_found');
    const again = await botOk(t.base, app, 'chat.postMessage', {
      channel: general,
      text: 'Again?',
      blocks: [{ type: 'actions', elements: [{ type: 'button', action_id: 'again', text: { type: 'plain_text', text: 'Again' } }] }],
    });
    assert.equal((await member.call('client.interactions.blockAction', { channel: general, message_ts: again.ts, action: { action_id: 'again' } })).error, 'app_timeout');
    receiver.reply = (entry) => (entry.body.payload ? { status: 500 } : undefined);
    const failed = await member.call('client.interactions.blockAction', { channel: general, message_ts: again.ts, action: { action_id: 'again' } });
    assert.equal(failed.error, 'app_unreachable');
    receiver.reply = () => undefined;
  });

  test('a slash command is POSTed as form fields and its immediate response is shown', async () => {
    assert.equal((await member.call('client.apps.commands.set', { app: app.id, command: '/weather' })).error, 'not_allowed');
    assert.equal((await owner.call('client.apps.commands.set', { app: app.id, command: '/bad name' })).error, 'invalid_command');
    const set = await owner.ok('client.apps.commands.set', {
      app: app.id,
      command: 'Weather',
      description: 'Current weather',
      usage_hint: '[city]',
      url: receiver.url,
    });
    assert.equal(set.command.command, '/weather');
    const other = await createPlatformApp(owner, 'Rival Bot');
    assert.equal((await owner.call('client.apps.commands.set', { app: other.id, command: '/weather' })).error, 'command_taken');
    assert.deepEqual((await member.ok('client.commands.list')).commands, [
      { command: '/weather', description: 'Current weather', usage_hint: '[city]', url: receiver.url, app_id: app.id, app_name: 'Http Bot' },
    ]);

    const stream = await member.connect();
    receiver.reply = (request) =>
      request.body.command === '/weather'
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `It is sunny in ${request.body.text}.` }) }
        : undefined;
    await member.ok('client.commands.run', { channel: general, command: '/weather', text: 'Seoul' });
    const request = await receiver.requests.next((entry) => entry.body.command === '/weather');
    assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.ok(verifySignature(app.signingSecret, request));
    assert.equal(request.body.text, 'Seoul');
    assert.equal(request.body.user_id, member.userId);
    assert.equal(request.body.channel_id, general);
    assert.equal(request.body.channel_name, 'general');
    assert.equal(request.body.api_app_id, app.id);
    assert.equal(request.body.team_domain, 'acme');
    assert.match(request.body.response_url, /\/hooks\/commands\//);
    assert.match(request.body.trigger_id, /^\d+\.\d+\.[0-9a-f]+$/);

    // The default visibility is ephemeral: only the person who ran it sees the answer.
    const answer = await stream.next((event) => event.is_ephemeral === true && event.text === 'It is sunny in Seoul.');
    assert.equal(answer.user, app.botUserId);
    assert.equal(answer.channel, general);

    // A plain-text body is an ephemeral answer too; in_channel posts for everyone.
    receiver.reply = (entry) => (entry.body.command === '/weather' ? { body: 'Plain answer' } : undefined);
    await member.ok('client.commands.run', { channel: general, command: '/weather', text: '' });
    await stream.next((event) => event.is_ephemeral === true && event.text === 'Plain answer');
    receiver.reply = (entry) =>
      entry.body.command === '/weather'
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response_type: 'in_channel', text: 'For everyone' }) }
        : undefined;
    await member.ok('client.commands.run', { channel: general, command: '/weather', text: '' });
    const latest = (await owner.ok('conversations.history', { channel: general, limit: 1 })).messages[0];
    assert.equal(latest.text, 'For everyone');
    assert.equal(latest.bot_id, app.botId);

    assert.equal((await member.call('client.commands.run', { channel: general, command: '/nothing', text: '' })).error, 'command_not_found');
    await owner.ok('client.apps.commands.delete', { app: app.id, command: '/weather' });
    assert.deepEqual((await member.ok('client.commands.list')).commands, []);
    receiver.reply = () => undefined;
    stream.close();
  });

  test('an incoming webhook posts into its channel and answers in plain text', async () => {
    assert.equal((await member.call('client.apps.webhooks.create', { app: app.id, channel: general })).error, 'not_allowed');
    const { webhook } = await owner.ok('client.apps.webhooks.create', { app: app.id, channel: general });
    assert.match(webhook.url, new RegExp(`/services/T[A-Z0-9]+/${app.botId}/[A-Za-z0-9]+$`));
    assert.equal(webhook.channel, general);
    assert.equal(webhook.channel_name, 'general');

    const send = async (init: RequestInit): Promise<[number, string]> => {
      const response = await fetch(webhook.url, { method: 'POST', ...init });
      return [response.status, await response.text()];
    };
    const json = (body: unknown): RequestInit => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    assert.deepEqual(await send(json({ text: 'Build finished', username: 'CI', icon_emoji: ':robot_face:' })), [200, 'ok']);
    const first = (await owner.ok('conversations.history', { channel: general, limit: 1 })).messages[0];
    assert.equal(first.text, 'Build finished');
    assert.equal(first.bot_id, app.botId);
    assert.equal(first.username, 'CI');
    assert.equal(first.icons.emoji, ':robot_face:');

    // The legacy form: a form-encoded body with the JSON in `payload`.
    const form = new URLSearchParams({ payload: JSON.stringify({ blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*From a form*' } }] }) });
    assert.deepEqual(await send({ headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form }), [200, 'ok']);
    assert.deepEqual(await send(json({ text: 'in thread', thread_ts: first.ts })), [200, 'ok']);
    assert.equal((await owner.ok('conversations.replies', { channel: general, ts: first.ts })).messages[1].text, 'in thread');

    assert.deepEqual(await send(json({})), [400, 'no_text']);
    assert.deepEqual(await send({ headers: { 'content-type': 'application/json' }, body: '{not json' }), [400, 'invalid_payload']);
    const wrong = await fetch(webhook.url.replace(/[A-Za-z0-9]+$/, 'wrongsecret'), { method: 'POST', ...json({ text: 'x' }) });
    assert.deepEqual([wrong.status, await wrong.text()], [404, 'no_service']);

    assert.equal((await owner.ok('client.apps.webhooks.list', { app: app.id })).webhooks.length, 1);
    await owner.ok('client.apps.webhooks.delete', { app: app.id, id: webhook.id });
    assert.deepEqual(await send(json({ text: 'gone' })), [404, 'no_service']);
  });
});
