import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';
import { asBot, botOk, createPlatformApp, SocketApp, type TestAppCredentials } from './platform-helpers.ts';

process.env.EVENT_ACK_TIMEOUT_MS = '250';
process.env.EVENT_RETRY_DELAYS_MS = '20';

const BUTTONS = [
  { type: 'section', text: { type: 'mrkdwn', text: 'Deploy build 12?' } },
  {
    type: 'actions',
    block_id: 'deploy',
    elements: [
      { type: 'button', action_id: 'approve', text: { type: 'plain_text', text: 'Approve' }, value: 'build-12', style: 'primary' },
      {
        type: 'static_select',
        action_id: 'environment',
        placeholder: { type: 'plain_text', text: 'Where' },
        options: [
          { text: { type: 'plain_text', text: 'Staging' }, value: 'staging' },
          { text: { type: 'plain_text', text: 'Production' }, value: 'production' },
        ],
      },
    ],
  },
];

async function respond(url: string, body: Json): Promise<[number, Json]> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return [response.status, (await response.json()) as Json];
}

describe('interactivity and slash commands over Socket Mode', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let general: string;
  let app: TestAppCredentials;
  let socket: SocketApp;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    app = await createPlatformApp(owner, 'Deploy Bot');
    await owner.ok('conversations.invite', { channel: general, users: app.botUserId });
    socket = await SocketApp.connect(t.base, app.appToken);
  });
  after(async () => {
    socket.close();
    await t.close();
  });

  const postButtons = (): Promise<Json> => botOk(t.base, app, 'chat.postMessage', { channel: general, text: 'Deploy?', blocks: BUTTONS });
  const click = (messageTs: string, action: Json, extra: Json = {}): Promise<Json> =>
    member.call('client.interactions.blockAction', { channel: general, message_ts: messageTs, action, ...extra });
  const interaction = (messageTs: string): Promise<Json> =>
    socket.envelopes.next((entry) => entry.type === 'interactive' && entry.payload.container.message_ts === messageTs);
  const latest = async (ts: string): Promise<Json> =>
    (await owner.ok('conversations.history', { channel: general, latest: ts, inclusive: true, limit: 1 })).messages[0];

  test('a click reaches the app as a block_actions payload with everything Bolt reads', async () => {
    const posted = await postButtons();
    assert.deepEqual(await click(posted.ts, { action_id: 'approve', block_id: 'deploy' }), { ok: true });
    const envelope = await interaction(posted.ts);
    assert.equal(envelope.accepts_response_payload, true);
    const payload = envelope.payload;
    const team = (await owner.ok('team.info')).team;

    assert.equal(payload.type, 'block_actions');
    assert.deepEqual(payload.user, { id: member.userId, username: 'mina.member', name: 'mina.member', team_id: team.id });
    assert.deepEqual(payload.team, { id: team.id, domain: 'acme' });
    assert.equal(payload.api_app_id, app.id);
    assert.equal(typeof payload.token, 'string');
    assert.deepEqual(payload.container, { type: 'message', message_ts: posted.ts, channel_id: general, is_ephemeral: false });
    assert.deepEqual(payload.channel, { id: general, name: 'general' });
    assert.match(payload.trigger_id, /^\d+\.\d+\.[0-9a-f]+$/);
    assert.match(payload.response_url, /^http:\/\/localhost:\d+\/hooks\/actions\/A[A-Z0-9]+\/[A-Z0-9]+\/[\w-]+$/);
    assert.deepEqual(payload.state, { values: {} });
    assert.equal(payload.is_enterprise_install, false);

    assert.equal(payload.message.ts, posted.ts);
    assert.equal(payload.message.bot_id, app.botId);
    assert.equal(payload.message.text, 'Deploy?');
    // Every block has an id, as on Slack; blocks posted without one get a positional id.
    assert.deepEqual(payload.message.blocks.map((block: Json) => block.block_id), ['b0', 'deploy']);

    assert.equal(payload.actions.length, 1);
    const action = payload.actions[0];
    assert.deepEqual(
      { ...action, action_ts: 'x' },
      { action_id: 'approve', block_id: 'deploy', type: 'button', text: { type: 'plain_text', text: 'Approve' }, value: 'build-12', style: 'primary', action_ts: 'x' },
    );
    assert.match(action.action_ts, /^\d{10}\.\d{6}$/);
  });

  test('a menu choice is checked against the options the app defined', async () => {
    const posted = await postButtons();
    await click(posted.ts, { action_id: 'environment', selected_option: { value: 'production' } }, { state: { values: { deploy: { environment: { type: 'static_select' } } } } });
    const payload = (await interaction(posted.ts)).payload;
    assert.equal(payload.actions[0].type, 'static_select');
    assert.deepEqual(payload.actions[0].selected_option, { text: { type: 'plain_text', text: 'Production' }, value: 'production' });
    assert.deepEqual(payload.state, { values: { deploy: { environment: { type: 'static_select' } } } });

    assert.equal((await click(posted.ts, { action_id: 'environment', selected_option: { value: 'moon' } })).error, 'invalid_action_value');
    assert.equal((await click(posted.ts, { action_id: 'missing' })).error, 'action_not_found');
    assert.equal((await click(posted.ts, { action_id: 'approve', block_id: 'elsewhere' })).error, 'action_not_found');
    assert.equal((await click('1000000000.000001', { action_id: 'approve' })).error, 'message_not_found');
    // A message a person wrote has no app behind it.
    const human = await owner.ok('chat.postMessage', { channel: general, text: 'no app here' });
    assert.equal((await click(human.ts, { action_id: 'approve' })).error, 'app_not_found');
  });

  test('the usual pattern works: acknowledge, then chat.update the message to remove the buttons', async () => {
    const posted = await postButtons();
    await click(posted.ts, { action_id: 'approve' });
    const payload = (await interaction(posted.ts)).payload;
    const updated = await botOk(t.base, app, 'chat.update', {
      channel: payload.channel.id,
      ts: payload.message.ts,
      text: `Approved by <@${payload.user.id}>`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark: Approved by <@${payload.user.id}>` } }],
    });
    assert.equal(updated.message.blocks.length, 1);
    assert.equal((await latest(posted.ts)).text, `Approved by <@${member.userId}>`);
  });

  test('response_url replaces the message by default, or adds a new one, or deletes it', async () => {
    const posted = await postButtons();
    await click(posted.ts, { action_id: 'approve' });
    const url = (await interaction(posted.ts)).payload.response_url;
    const memberStream = await member.connect();
    const ownerStream = await owner.connect();

    // 1. A plain payload overwrites the message the button was on.
    assert.deepEqual(await respond(url, { text: 'Working on it' }), [200, { ok: true }]);
    assert.equal((await latest(posted.ts)).text, 'Working on it');
    assert.equal((await latest(posted.ts)).blocks, undefined);

    // 2. replace_original false: a new message, visible only to the person who clicked.
    await respond(url, { text: 'Only you see this', replace_original: false });
    const ephemeral = await memberStream.next((event) => event.is_ephemeral === true);
    assert.equal(ephemeral.text, 'Only you see this');
    assert.equal(ephemeral.app_id, app.id);
    assert.equal((await latest(posted.ts)).text, 'Working on it');

    // 3. …or in the channel, optionally in a thread.
    await respond(url, { text: 'Deployed', replace_original: 'false', response_type: 'in_channel', thread_ts: posted.ts });
    const thread = await owner.ok('conversations.replies', { channel: general, ts: posted.ts });
    assert.equal(thread.messages[1].text, 'Deployed');
    assert.equal(thread.messages[1].bot_id, app.botId);

    // 4. delete_original removes the message.
    await respond(url, { delete_original: 'true' });
    assert.equal((await latest(posted.ts)).subtype, 'tombstone'); // it had a reply, so a placeholder stays

    // 5. Five uses, then the URL is spent. Nothing ephemeral ever reached the other person.
    assert.deepEqual(await respond(url, { text: 'fifth', replace_original: false }), [200, { ok: true }]);
    assert.deepEqual(await respond(url, { text: 'sixth', replace_original: false }), [404, { ok: false, error: 'used_url' }]);
    await owner.ok('chat.postMessage', { channel: general, text: 'marker' });
    await ownerStream.next((event) => event.text === 'marker');
    assert.ok(!ownerStream.events.some((event) => event.is_ephemeral));

    assert.deepEqual(await respond(url.replace(/[\w-]+$/, 'wrong'), { text: 'x' }), [404, { ok: false, error: 'expired_url' }]);
    memberStream.close();
    ownerStream.close();
  });

  test('buttons on an ephemeral message work, and the app can replace or remove that message', async () => {
    const stream = await member.connect();
    const { message_ts } = await botOk(t.base, app, 'chat.postEphemeral', { channel: general, user: member.userId, text: 'Confirm?', blocks: BUTTONS });
    await stream.next((event) => event.is_ephemeral === true && event.ts === message_ts);

    // Only the person who can see it can act on it.
    assert.equal((await owner.call('client.interactions.blockAction', { channel: general, message_ts, action: { action_id: 'approve' } })).error, 'message_not_found');
    await click(message_ts, { action_id: 'approve' });
    const payload = (await interaction(message_ts)).payload;
    assert.equal(payload.container.is_ephemeral, true);
    assert.equal(payload.message.text, 'Confirm?');

    await respond(payload.response_url, { text: 'Confirmed' });
    const changed = await stream.next((event) => event.subtype === 'message_changed' && event.is_ephemeral === true);
    assert.equal(changed.message.ts, message_ts);
    assert.equal(changed.message.text, 'Confirmed');
    assert.equal(changed.message.is_ephemeral, true);

    await respond(payload.response_url, { delete_original: true });
    const deleted = await stream.next((event) => event.subtype === 'message_deleted' && event.is_ephemeral === true);
    assert.equal(deleted.deleted_ts, message_ts);
    stream.close();
  });

  test('an app that does not acknowledge, or is not connected, fails the click', async () => {
    const posted = await postButtons();
    socket.autoAck = (envelope) => (envelope.type === 'interactive' ? false : undefined);
    assert.equal((await click(posted.ts, { action_id: 'approve' })).error, 'app_timeout');
    socket.autoAck = true;

    const offline = await createPlatformApp(owner, 'Offline Bot');
    await owner.ok('conversations.invite', { channel: general, users: offline.botUserId });
    const lonely = await botOk(t.base, offline, 'chat.postMessage', { channel: general, text: 'x', blocks: BUTTONS });
    const failed = await click(lonely.ts, { action_id: 'approve' });
    assert.equal(failed.error, 'app_unreachable');
    assert.equal(failed.detail, 'no_socket_mode_connection');
  });

  test('a slash command arrives as a slash_commands envelope; the acknowledgement payload is the answer', async () => {
    await owner.ok('client.apps.commands.set', { app: app.id, command: '/deploy', description: 'Deploy a build', usage_hint: '[build]' });
    const stream = await member.connect();
    socket.autoAck = (envelope) =>
      envelope.type === 'slash_commands' ? { text: `Deploying ${envelope.payload.text}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Deploying*' } }] } : undefined;
    assert.deepEqual(await member.call('client.commands.run', { channel: general, command: '/deploy', text: 'build 12' }), { ok: true });

    const envelope = await socket.envelopes.next((entry) => entry.type === 'slash_commands');
    assert.equal(envelope.accepts_response_payload, true);
    const team = (await owner.ok('team.info')).team;
    assert.deepEqual(
      { ...envelope.payload, token: 'x', response_url: 'x', trigger_id: 'x' },
      {
        token: 'x',
        team_id: team.id,
        team_domain: 'acme',
        channel_id: general,
        channel_name: 'general',
        user_id: member.userId,
        user_name: 'mina.member',
        command: '/deploy',
        text: 'build 12',
        api_app_id: app.id,
        is_enterprise_install: 'false',
        response_url: 'x',
        trigger_id: 'x',
      },
    );
    const answer = await stream.next((event) => event.is_ephemeral === true && event.text === 'Deploying build 12');
    assert.equal(answer.blocks.length, 1);

    // Later, through response_url: ephemeral by default, in_channel on request; no original to replace.
    const url = envelope.payload.response_url;
    await respond(url, { text: 'Still deploying', replace_original: true });
    await stream.next((event) => event.is_ephemeral === true && event.text === 'Still deploying');
    await respond(url, { text: 'Deploy finished', response_type: 'in_channel' });
    const last = (await owner.ok('conversations.history', { channel: general, limit: 1 })).messages[0];
    assert.equal(last.text, 'Deploy finished');
    assert.equal(last.user, app.botUserId);

    // A person who is not in the conversation cannot run commands there.
    const { channel: other } = await owner.ok('conversations.create', { name: 'no-mina-here' });
    assert.equal((await member.call('client.commands.run', { channel: other.id, command: '/deploy', text: '' })).error, 'not_in_channel');
    socket.autoAck = true;
    stream.close();
  });

  test('ephemeral messages from one app cannot be touched through another app', async () => {
    const rival = await createPlatformApp(owner, 'Rival Bot');
    assert.equal((await asBot(t.base, rival, 'chat.postEphemeral', { channel: general, user: member.userId, text: 'x' })).ok, true);
    const { message_ts } = await botOk(t.base, app, 'chat.postEphemeral', { channel: general, user: member.userId, text: 'Mine', blocks: BUTTONS });
    await click(message_ts, { action_id: 'approve' });
    const payload = (await interaction(message_ts)).payload;
    assert.equal(payload.api_app_id, app.id);
  });
});
