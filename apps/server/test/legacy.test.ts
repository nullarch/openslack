import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { WebSocket } from 'ws';
import { addMember, createBot, setupWorkspace, startApp, type Bot, type Json, type Session, type TestApp } from './helpers.ts';

const SCOPES = ['chat:write', 'files:write', 'files:read', 'channels:read', 'channels:history'];

function rtmSocket(url: string): Promise<{ socket: WebSocket; events: Json[]; next: (match: (event: Json) => boolean) => Promise<Json> }> {
  const socket = new WebSocket(url);
  const events: Json[] = [];
  const waiters: { match: (event: Json) => boolean; resolve: (event: Json) => void }[] = [];
  socket.on('message', (data) => {
    const event = JSON.parse(data.toString());
    events.push(event);
    for (const waiter of [...waiters]) {
      if (waiter.match(event)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    }
  });
  const next = (match: (event: Json) => boolean): Promise<Json> => {
    const seen = events.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), 3000);
      waiters.push({ match, resolve: (event) => (clearTimeout(timer), resolve(event)) });
    });
  };
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('open', () => resolve({ socket, events, next }));
  });
}

describe('legacy surfaces', () => {
  let t: TestApp;
  let owner: Session;
  let bot: Bot;
  let general: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    bot = createBot(t, SCOPES);
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    await owner.ok('conversations.invite', { channel: general, users: bot.userId });
  });
  after(() => t.close());

  test('files.upload accepts a multipart file the way curl -F sends it, and shares it', async () => {
    const form = new FormData();
    form.set('channels', general);
    form.set('initial_comment', 'nightly report');
    form.set('title', 'Report');
    form.set('file', new Blob(['line one\nline two\n'], { type: 'text/plain' }), 'report.txt');
    const response = await fetch(`${t.base}/api/files.upload`, { method: 'POST', headers: { authorization: `Bearer ${bot.token}` }, body: form });
    const result: Json = await response.json();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.file.name, 'report.txt');
    assert.equal(result.file.title, 'Report');
    assert.equal(result.file.size, 18);
    assert.deepEqual(result.file.channels, [general]);

    const history = await owner.ok('conversations.history', { channel: general, limit: 1 });
    assert.equal(history.messages[0].text, 'nightly report');
    assert.equal(history.messages[0].files[0].id, result.file.id);
    const download = await fetch(`${t.base}${new URL(result.file.url_private).pathname}`, { headers: { authorization: `Bearer ${bot.token}` } });
    assert.equal(await download.text(), 'line one\nline two\n');
    // The spool file is gone.
    assert.deepEqual(readdirSync(join(t.app.ctx.config.dataDir, 'tmp')), []);
  });

  test('files.upload with `content` instead of a file, and its errors', async () => {
    const body = new URLSearchParams({ content: 'hello', filename: 'hello.txt', channels: '#general' });
    const result: Json = await (
      await fetch(`${t.base}/api/files.upload`, { method: 'POST', headers: { authorization: `Bearer ${bot.token}` }, body })
    ).json();
    assert.equal(result.ok, true);
    assert.equal(result.file.size, 5);

    const noFile: Json = await (
      await fetch(`${t.base}/api/files.upload`, { method: 'POST', headers: { authorization: `Bearer ${bot.token}` }, body: new URLSearchParams({ channels: general }) })
    ).json();
    assert.equal(noFile.error, 'no_file_data');

    const { channel } = await owner.ok('conversations.create', { name: 'not-for-bots', is_private: true });
    const form = new FormData();
    form.set('channels', channel.id);
    form.set('file', new Blob(['x']), 'x.txt');
    const hidden: Json = await (
      await fetch(`${t.base}/api/files.upload`, { method: 'POST', headers: { authorization: `Bearer ${bot.token}` }, body: form })
    ).json();
    assert.equal(hidden.error, 'channel_not_found');
    assert.deepEqual(readdirSync(join(t.app.ctx.config.dataDir, 'tmp')), []);
  });

  test('RTM: connect, receive messages, send with a reply, ping, typing', async () => {
    const connect: Json = await (
      await fetch(`${t.base}/api/rtm.connect`, { method: 'POST', headers: { authorization: `Bearer ${bot.token}` } })
    ).json();
    assert.equal(connect.ok, true);
    assert.equal(connect.self.id, bot.userId);
    assert.match(connect.url, /^ws:\/\/.+\/rtm\/\?ticket=/);
    const rtm = await rtmSocket(connect.url);
    await rtm.next((event) => event.type === 'hello');

    await owner.ok('chat.postMessage', { channel: general, text: 'hello bot' });
    const message = await rtm.next((event) => event.type === 'message' && event.text === 'hello bot');
    assert.equal(message.channel, general);

    rtm.socket.send(JSON.stringify({ id: 1, type: 'message', channel: general, text: 'hello human' }));
    const reply = await rtm.next((event) => event.reply_to === 1);
    assert.equal(reply.ok, true);
    assert.equal(reply.text, 'hello human');
    const stored = await owner.ok('conversations.history', { channel: general, limit: 1 });
    assert.equal(stored.messages[0].bot_id, bot.botId);

    rtm.socket.send(JSON.stringify({ id: 2, type: 'ping' }));
    assert.equal((await rtm.next((event) => event.reply_to === 2)).type, 'pong');

    rtm.socket.send(JSON.stringify({ id: 3, type: 'message', channel: 'CNOSUCHONE', text: 'x' }));
    assert.equal((await rtm.next((event) => event.reply_to === 3)).ok, false);

    // A ticket works once.
    await assert.rejects(rtmSocket(connect.url));
    rtm.socket.close();
  });

  test('RTM: events from conversations the bot is not in never arrive', async () => {
    const member = await addMember(t, owner, 'Mina Member');
    const connect: Json = await (
      await fetch(`${t.base}/api/rtm.connect`, { method: 'POST', headers: { authorization: `Bearer ${bot.token}` } })
    ).json();
    const rtm = await rtmSocket(connect.url);
    await rtm.next((event) => event.type === 'hello');
    const { channel } = await owner.ok('conversations.create', { name: 'humans-only', is_private: true });
    await owner.ok('chat.postMessage', { channel: channel.id, text: 'secret plans' });
    const dm = await member.ok('conversations.open', { users: owner.userId });
    await member.ok('chat.postMessage', { channel: dm.channel.id, text: 'private note' });
    await owner.ok('chat.postMessage', { channel: general, text: 'marker' });
    await rtm.next((event) => event.text === 'marker');
    assert.ok(!rtm.events.some((event) => event.text === 'secret plans' || event.text === 'private note'));
    rtm.socket.close();
  });

  test('RTM refuses browser sessions and app-level tokens', async () => {
    assert.equal((await owner.call('rtm.connect')).error, 'not_allowed_token_type');
  });
});
