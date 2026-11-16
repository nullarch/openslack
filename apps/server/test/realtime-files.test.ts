import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('realtime and files', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let general: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
  });
  after(() => t.close());

  test('members receive message, edit, reaction and delete events', async () => {
    const stream = await member.connect();
    const { ts } = await owner.ok('chat.postMessage', { channel: general, text: 'live' });
    const message = await stream.next((event) => event.type === 'message' && event.text === 'live');
    assert.equal(message.channel, general);
    assert.equal(message.channel_type, 'channel');
    assert.equal(message.user, owner.userId);

    await owner.ok('chat.update', { channel: general, ts, text: 'live!' });
    const changed = await stream.next((event) => event.subtype === 'message_changed');
    assert.equal(changed.message.text, 'live!');
    assert.equal(changed.previous_message.text, 'live');

    await owner.ok('reactions.add', { channel: general, timestamp: ts, name: 'rocket' });
    const reaction = await stream.next((event) => event.type === 'reaction_added');
    assert.deepEqual(reaction.item, { type: 'message', channel: general, ts });

    await owner.ok('chat.delete', { channel: general, ts });
    const deleted = await stream.next((event) => event.subtype === 'message_deleted');
    assert.equal(deleted.deleted_ts, ts);
    stream.close();
  });

  test('events from a private channel reach only its members', async () => {
    const { channel } = await owner.ok('conversations.create', { name: 'private-live', is_private: true });
    const outsider = await member.connect();
    const insider = await owner.connect();
    await owner.ok('chat.postMessage', { channel: channel.id, text: 'for members only' });
    await insider.next((event) => event.type === 'message' && event.text === 'for members only');
    await owner.ok('chat.postMessage', { channel: general, text: 'marker' });
    await outsider.next((event) => event.type === 'message' && event.text === 'marker');
    assert.ok(!outsider.events.some((event) => event.channel === channel.id));
    outsider.close();
    insider.close();
  });

  test('typing indicators, presence and an unauthenticated connection attempt', async () => {
    const ownerStream = await owner.connect();
    const memberStream = await member.connect();
    // Someone who has never been connected becomes active when their first tab opens.
    const newcomer = await addMember(t, owner, 'Pia Presence');
    const newcomerStream = await newcomer.connect();
    await ownerStream.next((event) => event.type === 'presence_change' && event.user === newcomer.userId && event.presence === 'active');
    newcomerStream.close();
    memberStream.send({ type: 'typing', channel: general });
    const typing = await ownerStream.next((event) => event.type === 'user_typing');
    assert.equal(typing.user, member.userId);
    assert.ok(!memberStream.events.some((event) => event.type === 'user_typing'));
    ownerStream.close();
    memberStream.close();

    const anonymous = new Session(t.base);
    await assert.rejects(anonymous.connect());
  });

  test('cookie-authenticated requests from another origin are refused, and the server survives odd Origin headers', async () => {
    const call = async (origin: string): Promise<Json> => {
      const response = await fetch(`${t.base}/api/conversations.list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: owner.cookie, origin },
        body: '{}',
      });
      return response.json();
    };
    assert.equal((await call('https://evil.example')).error, 'invalid_auth');
    assert.equal((await call('null')).error, 'invalid_auth');
    assert.equal((await call(t.base)).ok, true);

    const { WebSocket } = await import('ws');
    for (const origin of ['null', 'https://evil.example']) {
      const socket = new WebSocket(`${t.base.replace('http', 'ws')}/ws`, { headers: { cookie: owner.cookie }, origin });
      const outcome = await new Promise((resolve) => {
        socket.once('open', () => resolve('open'));
        socket.once('error', () => resolve('refused'));
      });
      assert.equal(outcome, 'refused');
    }
    assert.equal((await owner.call('auth.test')).ok, true);
    assert.equal((await fetch(`${t.base}/%E0%A4%A`)).status, 404);
  });

  test('ephemeral messages reach one person and are not stored', async () => {
    const memberStream = await member.connect();
    const ownerStream = await owner.connect();
    await owner.ok('chat.postEphemeral', { channel: general, user: member.userId, text: 'only you' });
    const event = await memberStream.next((entry) => entry.is_ephemeral === true);
    assert.equal(event.text, 'only you');
    await owner.ok('chat.postMessage', { channel: general, text: 'marker 2' });
    await ownerStream.next((entry) => entry.text === 'marker 2');
    assert.ok(!ownerStream.events.some((entry) => entry.is_ephemeral));
    const history = await member.ok('conversations.history', { channel: general, limit: 5 });
    assert.ok(!history.messages.some((message: Json) => message.text === 'only you'));
    memberStream.close();
    ownerStream.close();
  });

  test('a file is uploaded in two steps, shared as a message, and readable only by people who can see it', async () => {
    const { channel } = await owner.ok('conversations.create', { name: 'file-vault', is_private: true });
    const { upload_url, file_id } = await owner.ok('files.getUploadURLExternal', { filename: 'pixel.png', length: PNG.length });
    assert.equal((await owner.call('files.completeUploadExternal', { files: [{ id: file_id }] })).error, 'file_not_uploaded');

    const upload = await fetch(upload_url, { method: 'POST', body: PNG });
    assert.equal(await upload.text(), `OK - ${PNG.length}`);
    // The upload URL works once.
    assert.equal((await fetch(upload_url, { method: 'POST', body: PNG })).status, 400);

    const stream = await owner.connect();
    const done = await owner.ok('files.completeUploadExternal', {
      files: [{ id: file_id, title: 'One pixel' }],
      channel_id: channel.id,
      initial_comment: 'see attached',
    });
    const file = done.files[0];
    assert.equal(file.title, 'One pixel');
    assert.equal(file.mimetype, 'image/png');
    assert.deepEqual([file.original_w, file.original_h], [1, 1]);
    const event = await stream.next((entry) => entry.type === 'message' && entry.subtype === 'file_share');
    assert.equal(event.files[0].id, file_id);
    assert.equal(event.text, 'see attached');
    stream.close();

    const path = new URL(file.url_private).pathname;
    const asOwner = await fetch(`${t.base}${path}`, { headers: { cookie: owner.cookie } });
    assert.equal(asOwner.status, 200);
    assert.equal(asOwner.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await asOwner.arrayBuffer()), PNG);
    assert.equal((await fetch(`${t.base}${path}`, { headers: { cookie: member.cookie } })).status, 404);
    assert.equal((await fetch(`${t.base}${path}`)).status, 404);
    assert.equal((await member.call('files.info', { file: file_id })).error, 'file_not_found');

    // Multipart uploads (what some SDKs send) work too.
    const second = await owner.ok('files.getUploadURLExternal', { filename: 'notes.txt', length: 5 });
    const form = new FormData();
    form.set('file', new Blob(['hello']), 'notes.txt');
    assert.equal(await (await fetch(second.upload_url, { method: 'POST', body: form })).text(), 'OK - 5');
  });

  test('avatars are generated for people without a photo', async () => {
    const response = await fetch(`${t.base}/avatars/${owner.userId}/72`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/svg+xml');
    assert.match(await response.text(), />OO</);
  });
});
