import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, callWithToken, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';
import { asBot, botOk, createPlatformApp, sleep, SocketApp, type TestAppCredentials } from './platform-helpers.ts';

// Short timings so unacknowledged deliveries retry within the test.
process.env.EVENT_ACK_TIMEOUT_MS = '250';
process.env.EVENT_RETRY_DELAYS_MS = '20,40,60';

describe('apps, tokens and Socket Mode', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let general: string;
  let app: TestAppCredentials;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    app = await createPlatformApp(owner, 'Helper Bot');
    await owner.ok('conversations.invite', { channel: general, users: app.botUserId });
  });
  after(() => t.close());

  test('creating an app makes a bot user, a bot token and an app-level token', async () => {
    assert.equal((await member.call('client.apps.create', { name: 'Nope' })).error, 'not_allowed');
    assert.match(app.botToken, /^xoxb-/);
    assert.match(app.appToken, /^xapp-/);
    // Like Slack's, the app-level token names its app; some clients compare it with auth.test.
    assert.equal(app.appToken.split('-')[2], app.id);

    const auth = await asBot(t.base, app, 'auth.test');
    assert.equal(auth.user_id, app.botUserId);
    assert.equal(auth.bot_id, app.botId);
    assert.equal(auth.app_id, app.id);

    const user = (await owner.ok('users.info', { user: app.botUserId })).user;
    assert.equal(user.is_bot, true);
    assert.equal(user.real_name, 'Helper Bot');
    assert.equal(user.profile.api_app_id, app.id);

    // Everyone may see which apps exist; nothing secret is in the listing.
    const listed = (await member.ok('client.apps.list')).apps.find((entry: Json) => entry.id === app.id);
    assert.equal(listed.socket_mode, true);
    assert.equal(listed.connected, false);
    assert.match(listed.token_hints.bot, /^xoxb-.*…/);
    assert.ok(!JSON.stringify(listed).includes(app.botToken));
    assert.ok(!JSON.stringify(listed).includes(app.signingSecret));
    assert.equal((await member.call('client.apps.info', { app: app.id })).error, 'not_allowed');

    // The answer to creating an app already carries the hints of the tokens it issued.
    const created = await owner.ok('client.apps.create', { name: 'Hint Bot' });
    assert.equal(created.app.token_hints.bot, `${created.bot_token.slice(0, 9)}…${created.bot_token.slice(-4)}`);
    assert.equal(created.app.token_hints.app, `${created.app_token.slice(0, 9)}…${created.app_token.slice(-4)}`);
    await owner.ok('client.apps.delete', { app: created.app.id });
    assert.equal((await owner.ok('client.apps.info', { app: app.id })).signing_secret, app.signingSecret);
  });

  test('tokens are limited to what their kind and scopes allow', async () => {
    // An app-level token only opens connections.
    assert.equal((await callWithToken(t.base, app.appToken, 'chat.postMessage', { channel: general, text: 'x' })).error, 'not_allowed_token_type');
    assert.equal((await callWithToken(t.base, app.appToken, 'auth.test')).error, 'not_allowed_token_type');
    // A bot token cannot open connections or do what its scopes do not cover.
    assert.equal((await asBot(t.base, app, 'apps.connections.open')).error, 'missing_scope');
    const denied = await asBot(t.base, app, 'users.profile.set', { profile: { title: 'x' } });
    assert.equal(denied.error, 'missing_scope');
    assert.equal(denied.needed, 'users.profile:write');
    // First-party methods are for browser sessions.
    assert.equal((await asBot(t.base, app, 'client.apps.list')).error, 'not_allowed_token_type');
  });

  test('rotating a token invalidates the old one', async () => {
    const other = await createPlatformApp(owner, 'Rotating Bot');
    const { token } = await owner.ok('client.apps.rotateToken', { app: other.id, kind: 'bot' });
    assert.equal((await callWithToken(t.base, other.botToken, 'auth.test')).error, 'invalid_auth');
    assert.equal((await callWithToken(t.base, token, 'auth.test')).user_id, other.botUserId);

    await owner.ok('client.apps.delete', { app: other.id });
    assert.equal((await callWithToken(t.base, token, 'auth.test')).error, 'invalid_auth');
    assert.equal((await owner.ok('users.info', { user: other.botUserId })).user.deleted, true);
    assert.equal((await owner.call('client.apps.info', { app: other.id })).error, 'app_not_found');
  });

  test('a connection says hello, receives each event in an envelope and acknowledges it', async () => {
    const socket = await SocketApp.connect(t.base, app.appToken);
    const hello = socket.envelopes.items[0]!;
    assert.equal(hello.type, 'hello');
    assert.equal(hello.num_connections, 1);
    assert.equal(hello.connection_info.app_id, app.id);
    assert.equal(typeof hello.debug_info.approximate_connection_time, 'number');
    assert.equal((await owner.ok('client.apps.list')).apps.find((entry: Json) => entry.id === app.id).connected, true);

    const { ts } = await member.ok('chat.postMessage', { channel: general, text: 'hello bots' });
    const envelope = await socket.envelopes.next((entry) => entry.payload?.event?.ts === ts);
    assert.equal(envelope.type, 'events_api');
    assert.equal(envelope.accepts_response_payload, false);
    assert.equal(envelope.retry_attempt, 0);
    assert.equal(envelope.retry_reason, '');
    assert.equal(typeof envelope.envelope_id, 'string');

    const callback = envelope.payload;
    assert.equal(callback.type, 'event_callback');
    assert.equal(callback.api_app_id, app.id);
    assert.match(callback.event_id, /^Ev[A-Z0-9]+$/);
    assert.equal(typeof callback.event_time, 'number');
    assert.equal(typeof callback.token, 'string');
    assert.deepEqual(callback.authorizations, [
      { enterprise_id: null, team_id: callback.team_id, user_id: app.botUserId, is_bot: true, is_enterprise_install: false },
    ]);
    assert.equal(callback.event.type, 'message');
    assert.equal(callback.event.channel, general);
    assert.equal(callback.event.channel_type, 'channel');
    assert.equal(callback.event.user, member.userId);
    assert.equal(callback.event.text, 'hello bots');
    assert.equal(callback.event.event_ts, ts);

    // Acknowledged: no redelivery.
    await sleep(400);
    assert.equal(socket.envelopes.items.filter((entry) => entry.payload?.event?.ts === ts).length, 1);
    socket.close();
  });

  test('an event that is not acknowledged is redelivered with a retry count, then dropped', async () => {
    const socket = await SocketApp.connect(t.base, app.appToken);
    socket.autoAck = false;
    const { ts } = await member.ok('chat.postMessage', { channel: general, text: 'nobody home' });
    await sleep(1600);
    const deliveries = socket.envelopes.items.filter((entry) => entry.payload?.event?.ts === ts);
    assert.deepEqual(deliveries.map((entry) => entry.retry_attempt), [0, 1, 2, 3]);
    assert.deepEqual(deliveries.map((entry) => entry.retry_reason), ['', 'timeout', 'timeout', 'timeout']);
    assert.equal(new Set(deliveries.map((entry) => entry.envelope_id)).size, 4);
    socket.close();
  });

  test('with several connections each event goes to exactly one of them', async () => {
    const first = await SocketApp.connect(t.base, app.appToken);
    const second = await SocketApp.connect(t.base, app.appToken);
    assert.equal(second.envelopes.items[0]!.num_connections, 2);
    const sent: string[] = [];
    for (let i = 0; i < 6; i += 1) sent.push((await member.ok('chat.postMessage', { channel: general, text: `spread ${i}` })).ts);
    await sleep(300);
    const seenBy = (socket: SocketApp): string[] => socket.events('message').map((event) => event.ts).filter((ts) => sent.includes(ts));
    assert.equal(seenBy(first).length + seenBy(second).length, 6);
    assert.equal(new Set([...seenBy(first), ...seenBy(second)]).size, 6);
    assert.ok(seenBy(first).length > 0 && seenBy(second).length > 0);
    first.close();
    second.close();
  });

  test('an app sees a conversation only when its bot belongs to it; a mention in a public channel still reaches it', async () => {
    const socket = await SocketApp.connect(t.base, app.appToken);
    const { channel: secret } = await owner.ok('conversations.create', { name: 'bot-free-private', is_private: true });
    const { channel: open } = await owner.ok('conversations.create', { name: 'bot-free-public' });

    await owner.ok('chat.postMessage', { channel: secret.id, text: `private talk <@${app.botUserId}>` });
    await owner.ok('reactions.add', { channel: secret.id, timestamp: (await owner.ok('chat.postMessage', { channel: secret.id, text: 'react here' })).ts, name: 'eyes' });
    await owner.ok('chat.postMessage', { channel: open.id, text: 'public talk without the bot' });
    const mention = await owner.ok('chat.postMessage', { channel: open.id, text: `<@${app.botUserId}> are you there?` });
    const marker = await owner.ok('chat.postMessage', { channel: general, text: 'marker' });
    await socket.event('message', (event) => event.ts === marker.ts);

    const received = socket.envelopes.items.filter((entry) => entry.type === 'events_api').map((entry) => entry.payload.event);
    assert.ok(!received.some((event) => event.channel === secret.id || event.item?.channel === secret.id));
    assert.ok(!received.some((event) => event.type === 'message' && event.channel === open.id));
    const appMention = received.find((event) => event.type === 'app_mention');
    assert.deepEqual(
      { user: appMention.user, text: appMention.text, ts: appMention.ts, channel: appMention.channel, event_ts: appMention.event_ts },
      { user: owner.userId, text: `<@${app.botUserId}> are you there?`, ts: mention.ts, channel: open.id, event_ts: mention.ts },
    );
    // The app can answer there without joining.
    const reply = await botOk(t.base, app, 'chat.postMessage', { channel: open.id, thread_ts: mention.ts, text: 'here' });
    assert.equal(reply.message.thread_ts, mention.ts);
    socket.close();
  });

  test('a channel the bot belongs to delivers both the message and the mention; a direct message is message.im only', async () => {
    const socket = await SocketApp.connect(t.base, app.appToken);
    const inChannel = await member.ok('chat.postMessage', { channel: general, text: `<@${app.botUserId}> ping` });
    await socket.event('app_mention', (event) => event.ts === inChannel.ts);
    await socket.event('message', (event) => event.ts === inChannel.ts);

    const dm = await member.ok('chat.postMessage', { channel: app.botUserId, text: `<@${app.botUserId}> psst` });
    const direct = await socket.event('message', (event) => event.ts === dm.ts);
    assert.equal(direct.channel_type, 'im');
    await sleep(100);
    assert.ok(!socket.events('app_mention').some((event) => event.ts === dm.ts));

    // An app receives its own messages too; SDKs filter them out (Bolt's ignoreSelf).
    const own = await botOk(t.base, app, 'chat.postMessage', { channel: general, text: 'I said this' });
    const echoed = await socket.event('message', (event) => event.ts === own.ts);
    assert.equal(echoed.user, app.botUserId);
    assert.equal(echoed.bot_id, app.botId);
    socket.close();
  });

  test('other event types follow the same visibility: reactions, membership, new channels', async () => {
    const socket = await SocketApp.connect(t.base, app.appToken);
    const { ts } = await member.ok('chat.postMessage', { channel: general, text: 'react to me' });
    await owner.ok('reactions.add', { channel: general, timestamp: ts, name: 'tada' });
    const reaction = await socket.event('reaction_added');
    assert.deepEqual(reaction.item, { type: 'message', channel: general, ts });
    assert.equal(reaction.reaction, 'tada');

    const { channel } = await owner.ok('conversations.create', { name: 'bot-joins-here' });
    const created = await socket.event('channel_created', (event) => event.channel.id === channel.id);
    assert.equal(created.channel.name, 'bot-joins-here');
    await owner.ok('conversations.invite', { channel: channel.id, users: app.botUserId });
    const joined = await socket.event('member_joined_channel', (event) => event.channel === channel.id);
    assert.equal(joined.user, app.botUserId);
    assert.equal(joined.inviter, owner.userId);
    await owner.ok('conversations.kick', { channel: channel.id, user: app.botUserId });
    const left = await socket.event('member_left_channel', (event) => event.channel === channel.id);
    assert.equal(left.user, app.botUserId);
    socket.close();
  });

  test('bot_events narrows what an app receives', async () => {
    const picky = await createPlatformApp(owner, 'Picky Bot');
    await owner.ok('conversations.invite', { channel: general, users: picky.botUserId });
    assert.equal((await owner.call('client.apps.update', { app: picky.id, bot_events: ['no_such_event'] })).error, 'invalid_event');
    const updated = await owner.ok('client.apps.update', { app: picky.id, bot_events: ['app_mention'] });
    assert.deepEqual(updated.app.bot_events, ['app_mention']);

    const socket = await SocketApp.connect(t.base, picky.appToken);
    await member.ok('chat.postMessage', { channel: general, text: 'not for the picky one' });
    const mention = await member.ok('chat.postMessage', { channel: general, text: `<@${picky.botUserId}> for you` });
    await socket.event('app_mention', (event) => event.ts === mention.ts);
    await sleep(100);
    assert.equal(socket.events('message').length, 0);
    socket.close();
  });

  test('turning Socket Mode off disconnects the app with link_disabled', async () => {
    const temporary = await createPlatformApp(owner, 'Temporary Bot');
    const socket = await SocketApp.connect(t.base, temporary.appToken);
    await owner.ok('client.apps.update', { app: temporary.id, socket_mode: false });
    const notice = await socket.envelopes.next((entry) => entry.type === 'disconnect');
    assert.equal(notice.reason, 'link_disabled');
    await assert.rejects(SocketApp.connect(t.base, temporary.appToken));
  });

  test('a connection ticket works once', async () => {
    const response = await fetch(`${t.base}/api/apps.connections.open`, { method: 'POST', headers: { authorization: `Bearer ${app.appToken}` } });
    const { url } = (await response.json()) as Json;
    assert.match(url, /^ws:\/\/localhost:\d+\/link\/\?ticket=[\w-]+&app_id=A[A-Z0-9]+$/);
    const { WebSocket } = await import('ws');
    const open = (): Promise<string> =>
      new Promise((resolve) => {
        const socket = new WebSocket(url);
        socket.once('message', () => {
          socket.close();
          resolve('accepted');
        });
        socket.once('error', () => resolve('refused'));
      });
    assert.equal(await open(), 'accepted');
    assert.equal(await open(), 'refused');
  });
});
