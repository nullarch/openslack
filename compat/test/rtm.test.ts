import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { after, before, describe, test } from 'node:test';
import { LogLevel, RTMClient } from '@slack/rtm-api';
import { WebClient } from '@slack/web-api';
import { setupWorkspace, startApp, type Json, type Session, type TestApp } from '@app/server/test/helpers.ts';
import { createPlatformApp, type TestAppCredentials } from '@app/server/test/platform-helpers.ts';
import { recordTokenCalls, saveExercised } from './harness.ts';

const require = createRequire(import.meta.url);
const rtmVersion = (JSON.parse(readFileSync(require.resolve('@slack/rtm-api/package.json'), 'utf8')) as { version: string }).version;
const webApiVersion = (JSON.parse(readFileSync(require.resolve('@slack/web-api/package.json'), 'utf8')) as { version: string }).version;

/**
 * Older bots (Hubot adapters and the like) use the Real Time Messaging API and
 * the one-request `files.upload`. Both run here through the official packages,
 * with only the API address changed.
 */
describe('an official RTM client and the legacy files.upload', { timeout: 20_000 }, () => {
  let t: TestApp;
  let owner: Session;
  let creds: TestAppCredentials;
  let general: string;
  let rtm: RTMClient;
  let called: Set<string>;
  const delivered = new Set<string>();

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    creds = await createPlatformApp(owner, 'Old Bot');
    await owner.ok('conversations.invite', { channel: general, users: creds.botUserId });
    called = recordTokenCalls(t);
    rtm = new RTMClient(creds.botToken, { slackApiUrl: `${t.base}/api/`, logLevel: LogLevel.ERROR });
    rtm.on('slack_event', (type: string) => delivered.add(type));
    // start() resolves once rtm.connect answers; the socket is usable after the server's hello.
    const ready = new Promise((resolve) => rtm.once('ready', resolve));
    await rtm.start();
    await ready;
  });
  after(async () => {
    // @slack/rtm-api 7.0.4 keeps awaited replies in a sparse array indexed by message id and calls
    // .cancel() on every slot, holes included, when it disconnects; drop the holes first.
    const client = rtm as unknown as { awaitingReplyList: unknown[] };
    client.awaitingReplyList = client.awaitingReplyList.filter(Boolean);
    await rtm.disconnect().catch(() => undefined);
    saveExercised('rtm-node', `@slack/rtm-api ${rtmVersion}, @slack/web-api ${webApiVersion}`, called, delivered);
    await t.close();
  });

  test('rtm.connect identifies the bot and the client reaches the connected state', () => {
    assert.equal(rtm.activeUserId, creds.botUserId);
    assert.equal(rtm.connected, true);
  });

  test('a message in a channel arrives, and sendMessage answers it with a reply', async () => {
    const heard = new Promise<Json>((resolve) => {
      rtm.on('message', (event: Json) => {
        if (event.text === 'ping the old bot') resolve(event);
      });
    });
    await owner.ok('chat.postMessage', { channel: general, text: 'ping the old bot' });
    const event = await heard;
    const reply = (await rtm.sendMessage(`pong for <@${event.user}>`, event.channel)) as Json;
    assert.equal(reply.ok, true);
    const history = await owner.ok('conversations.history', { channel: general, limit: 1 });
    assert.equal(history.messages[0].text, `pong for <@${owner.userId}>`);
    assert.equal(history.messages[0].bot_id, creds.botId);
  });

  test('typing indicators reach people in the channel', async () => {
    const stream = await owner.connect();
    await rtm.sendTyping(general);
    const typing = await stream.next((event) => event.type === 'user_typing');
    assert.equal(typing.user, creds.botUserId);
    stream.close();
  });

  test('files.upload through the official Web API client', async () => {
    const web = new WebClient(creds.botToken, { slackApiUrl: `${t.base}/api/` });
    const result = (await web.apiCall('files.upload', {
      channels: general,
      content: 'build 1482: 1,205 tests passed',
      filename: 'build.txt',
      initial_comment: 'Build log',
    })) as Json;
    assert.equal(result.ok, true);
    assert.equal(result.file.name, 'build.txt');
    const history = await owner.ok('conversations.history', { channel: general, limit: 1 });
    assert.equal(history.messages[0].text, 'Build log');
    assert.equal(history.messages[0].files[0].id, result.file.id);
  });
});
