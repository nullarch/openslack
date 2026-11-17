import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { AccessToken, TokenVerifier } from 'livekit-server-sdk';
import { createApp } from '../src/app.ts';
import { accessToken, verifyWebhook, type LiveKitConfig } from '../src/huddles/livekit.ts';
import { addMember, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';

const LIVEKIT: LiveKitConfig = {
  // Nothing listens here: room API calls fail, and the server must cope.
  url: 'ws://127.0.0.1:9',
  apiUrl: 'http://127.0.0.1:9',
  apiKey: 'APItestkey',
  apiSecret: 'a-test-secret-that-is-long-enough-for-hs256',
};

async function startWithLiveKit(): Promise<TestApp> {
  // The background comparison with LiveKit is tested on its own; keep it out of the way here.
  process.env.HUDDLE_RECONCILE_MS = '0';
  const dataDir = mkdtempSync(join(tmpdir(), 'chat-huddles-'));
  const app = createApp({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    publicUrl: '',
    webDir: null,
    maxUploadBytes: 1024 * 1024,
    livekit: LIVEKIT,
    cookieSecure: false,
    version: 'test',
    quiet: true,
  });
  const port = await app.listen();
  return {
    app,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function webhookAuth(body: string, secret = LIVEKIT.apiSecret): Promise<string> {
  const token = new AccessToken(LIVEKIT.apiKey, secret);
  token.sha256 = createHash('sha256').update(body).digest('base64');
  return token.toJwt();
}

describe('LiveKit tokens and webhooks', () => {
  test('access tokens verify with the official SDK and carry a one-room grant', async () => {
    const token = accessToken(LIVEKIT, {
      identity: 'U123',
      name: 'Maya',
      ttlSeconds: 600,
      video: { room: 'T1-C1', roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
    });
    const claims = await new TokenVerifier(LIVEKIT.apiKey, LIVEKIT.apiSecret).verify(token);
    assert.equal(claims.sub, 'U123');
    assert.equal(claims.name, 'Maya');
    assert.deepEqual(claims.video, { room: 'T1-C1', roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
    assert.ok(claims.exp! - claims.nbf! === 600);
    await assert.rejects(new TokenVerifier(LIVEKIT.apiKey, 'another secret entirely, also long').verify(token));
  });

  test('webhook signatures made by the official SDK are accepted, anything else is not', async () => {
    const body = JSON.stringify({ event: 'room_started', room: { name: 'T1-C1' } });
    const auth = await webhookAuth(body);
    assert.equal(verifyWebhook(LIVEKIT, Buffer.from(body), auth), true);
    assert.equal(verifyWebhook(LIVEKIT, Buffer.from(body), `Bearer ${auth}`), true);
    assert.equal(verifyWebhook(LIVEKIT, Buffer.from(`${body} `), auth), false, 'body changed after signing');
    assert.equal(verifyWebhook(LIVEKIT, Buffer.from(body), await webhookAuth(body, 'not the secret but long enough')), false);
    assert.equal(verifyWebhook(LIVEKIT, Buffer.from(body), undefined), false);
  });
});

describe('huddles without LiveKit', () => {
  let t: TestApp;
  let owner: Session;
  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
  });
  after(() => t.close());

  test('are reported as disabled and cannot be joined', async () => {
    const info = await owner.ok('client.huddles.info');
    assert.equal(info.enabled, false);
    assert.deepEqual(info.huddles, []);
    assert.equal((await owner.call('client.huddles.join', { channel: '#general' })).error, 'huddles_disabled');
  });
});

describe('huddles', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let outsider: Session;
  let team: string;

  before(async () => {
    t = await startWithLiveKit();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    outsider = await addMember(t, owner, 'Otto Outsider');
    team = (await owner.ok('client.boot')).team.id;
  });
  after(() => t.close());

  test('joining starts a huddle with a huddle_thread message and a token for one room', async () => {
    const { channel } = await owner.ok('conversations.create', { name: 'standup' });
    await owner.ok('conversations.invite', { channel: channel.id, users: member.userId });
    const memberStream = await member.connect();
    const outsiderStream = await outsider.connect();

    const joined = await owner.ok('client.huddles.join', { channel: channel.id });
    assert.equal(joined.url, LIVEKIT.url);
    assert.deepEqual(joined.huddle.participants, [owner.userId]);
    assert.equal(joined.huddle.created_by, owner.userId);
    const claims = await new TokenVerifier(LIVEKIT.apiKey, LIVEKIT.apiSecret).verify(joined.token);
    assert.equal(claims.sub, owner.userId);
    assert.equal(claims.video?.room, `${team}-${channel.id}`);
    assert.ok(claims.exp! - claims.nbf! <= 600);

    // The start is a message everyone in the channel sees, carrying the room.
    const history = await member.ok('conversations.history', { channel: channel.id, limit: 1 });
    const starter = history.messages[0];
    assert.equal(starter.subtype, 'huddle_thread');
    assert.equal(starter.ts, joined.huddle.ts);
    assert.equal(starter.user, owner.userId);
    assert.deepEqual(starter.room.participants, [owner.userId]);
    assert.equal(starter.room.has_ended, false);

    // Public channel: anyone in the workspace hears about it, member or not.
    const seen = await memberStream.next((event) => event.type === 'huddle_changed' && event.channel === channel.id);
    assert.deepEqual(seen.huddle.participants, [owner.userId]);
    await outsiderStream.next((event) => event.type === 'huddle_changed' && event.channel === channel.id);
    assert.equal((await outsider.ok('client.huddles.info')).huddles.length, 1);
    // …but only members may join.
    assert.equal((await outsider.call('client.huddles.join', { channel: channel.id })).error, 'not_in_channel');
    memberStream.close();
    outsiderStream.close();
  });

  test('a second person joins, then both leave and the huddle ends with a summary', async () => {
    const { channel } = await owner.ok('conversations.create', { name: 'pairing' });
    await owner.ok('conversations.invite', { channel: channel.id, users: member.userId });
    const started = await owner.ok('client.huddles.join', { channel: channel.id });
    const second = await member.ok('client.huddles.join', { channel: channel.id });
    assert.equal(second.huddle.id, started.huddle.id);
    assert.deepEqual(second.huddle.participants, [owner.userId, member.userId]);
    // Joining twice changes nothing.
    assert.deepEqual((await member.ok('client.huddles.join', { channel: channel.id })).huddle.participants, [owner.userId, member.userId]);

    // Messages posted in the huddle's thread stay there.
    await member.ok('chat.postMessage', { channel: channel.id, thread_ts: started.huddle.ts, text: 'notes: https://example.com/doc' });

    const stream = await owner.connect();
    await owner.ok('client.huddles.leave', { channel: channel.id });
    const afterOne = await stream.next((event) => event.type === 'huddle_changed' && event.huddle.participants.length === 1);
    assert.deepEqual(afterOne.huddle.participants, [member.userId]);
    await member.ok('client.huddles.leave', { channel: channel.id });
    const ended = await stream.next((event) => event.type === 'huddle_changed' && event.huddle.has_ended);
    assert.deepEqual(ended.huddle.participant_history, [owner.userId, member.userId]);
    assert.ok(ended.huddle.date_end >= ended.huddle.date_start);
    const changed = await stream.next((event) => event.subtype === 'message_changed' && event.message.subtype === 'huddle_thread');
    assert.equal(changed.message.text, `Huddle ended after less than a minute. <@${owner.userId}> and <@${member.userId}> joined.`);
    assert.equal(changed.message.edited, undefined);
    stream.close();

    const thread = await owner.ok('conversations.replies', { channel: channel.id, ts: started.huddle.ts });
    assert.equal(thread.messages[0].room.has_ended, true);
    assert.deepEqual(thread.messages[0].room.participants, []);
    assert.equal(thread.messages[1].text, 'notes: https://example.com/doc');
    assert.equal((await owner.ok('client.huddles.info')).huddles.some((h: Json) => h.channel === channel.id), false);

    // A new huddle in the same conversation is a new one.
    const again = await owner.ok('client.huddles.join', { channel: channel.id });
    assert.notEqual(again.huddle.id, started.huddle.id);
    await owner.ok('client.huddles.leave', { channel: channel.id });
  });

  test('a private huddle is invisible and unjoinable for people outside the conversation', async () => {
    const { channel } = await owner.ok('conversations.create', { name: 'board', is_private: true });
    const outsiderStream = await outsider.connect();
    const ownerStream = await owner.connect();
    await owner.ok('client.huddles.join', { channel: channel.id });
    await ownerStream.next((event) => event.type === 'huddle_changed' && event.channel === channel.id);
    // A later public event proves the outsider's stream is live and caught up.
    const { channel: other } = await owner.ok('conversations.create', { name: 'later' });
    await owner.ok('client.huddles.join', { channel: other.id });
    await outsiderStream.next((event) => event.type === 'huddle_changed' && event.channel === other.id);
    assert.ok(!outsiderStream.events.some((event) => event.channel === channel.id));
    assert.ok(!(await outsider.ok('client.huddles.info')).huddles.some((h: Json) => h.channel === channel.id));
    assert.equal((await outsider.call('client.huddles.join', { channel: channel.id })).error, 'channel_not_found');
    await owner.ok('client.huddles.leave', { channel: channel.id });
    await owner.ok('client.huddles.leave', { channel: other.id });
    outsiderStream.close();
    ownerStream.close();
  });

  test('direct messages can have huddles; tokens are only for browser sessions', async () => {
    const { channel } = await owner.ok('conversations.open', { users: member.userId });
    const joined = await member.ok('client.huddles.join', { channel: channel.id });
    assert.deepEqual(joined.huddle.participants, [member.userId]);
    assert.equal((await outsider.call('client.huddles.join', { channel: channel.id })).error, 'channel_not_found');
    await member.ok('client.huddles.leave', { channel: channel.id });
  });

  test('LiveKit webhooks: signed ones update participants and end rooms, unsigned ones are refused', async () => {
    const { channel } = await owner.ok('conversations.create', { name: 'webhooks' });
    await owner.ok('conversations.invite', { channel: channel.id, users: member.userId });
    const started = await owner.ok('client.huddles.join', { channel: channel.id });
    const room = `${team}-${channel.id}`;
    const post = async (payload: unknown, sign = true): Promise<number> => {
      const body = JSON.stringify(payload);
      const response = await fetch(`${t.base}/livekit/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/webhook+json', ...(sign ? { authorization: await webhookAuth(body) } : {}) },
        body,
      });
      return response.status;
    };

    assert.equal(await post({ event: 'participant_joined', room: { name: room }, participant: { identity: member.userId } }, false), 401);
    assert.deepEqual((await owner.ok('client.huddles.info')).huddles.find((h: Json) => h.id === started.huddle.id).participants, [owner.userId]);

    assert.equal(await post({ event: 'participant_joined', room: { name: room }, participant: { identity: member.userId } }), 200);
    assert.deepEqual((await owner.ok('client.huddles.info')).huddles.find((h: Json) => h.id === started.huddle.id).participants, [owner.userId, member.userId]);
    // Someone who is not a member cannot be added, even by a signed webhook.
    assert.equal(await post({ event: 'participant_joined', room: { name: room }, participant: { identity: outsider.userId } }), 200);
    assert.ok(!(await owner.ok('client.huddles.info')).huddles.find((h: Json) => h.id === started.huddle.id).participants.includes(outsider.userId));

    assert.equal(await post({ event: 'room_finished', room: { name: room } }), 200);
    assert.equal((await owner.ok('client.huddles.info')).huddles.some((h: Json) => h.id === started.huddle.id), false);
  });
});
