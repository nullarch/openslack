import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  addMember,
  Session,
  setupWorkspace,
  startApp,
  type Json,
  type Stream,
  type TestApp,
} from '@app/server/test/helpers.ts';
import { createPlatformApp, type TestAppCredentials } from '@app/server/test/platform-helpers.ts';
import { recordTokenCalls, saveExercised } from './harness.ts';

const SCRIPT = fileURLToPath(new URL('../python/bolt_app.py', import.meta.url));
// Bolt for Python is fetched by uv on first use. Without uv this suite is skipped, not faked.
const hasUv = spawnSync('uv', ['--version']).status === 0;

describe('an official Bolt for Python app over Socket Mode', { skip: hasUv ? false : 'uv is not installed' }, () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let general: string;
  let creds: TestAppCredentials;
  let child: ChildProcess;
  let stream: Stream;
  let called: Set<string>;
  const delivered = new Set<string>();
  let output = '';
  let sdk = 'slack_bolt';

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    creds = await createPlatformApp(owner, 'Python Bot');
    await owner.ok('conversations.invite', { channel: general, users: creds.botUserId });
    await owner.ok('client.apps.commands.set', { app: creds.id, command: '/pyecho' });
    called = recordTokenCalls(t);

    child = spawn('uv', ['run', '--no-project', '--quiet', '--with', 'slack_bolt', 'python', SCRIPT], {
      env: { ...process.env, API_URL: `${t.base}/api/`, BOT_TOKEN: creds.botToken, APP_TOKEN: creds.appToken },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Bolt for Python did not start:\n${output}`)), 120_000);
      child.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        for (const match of chunk.toString().matchAll(/^DELIVERED (\S+)$/gm)) delivered.add(match[1]!);
        sdk = /^VERSIONS (.+)$/m.exec(output)?.[1] ?? sdk;
        if (/^READY$/m.test(output)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Bolt for Python exited with ${code}:\n${output}`));
      });
    });
    await ready;
    stream = await member.connect();
  });

  after(async () => {
    stream?.close();
    // Stop only the process this test started.
    if (child && child.exitCode === null) {
      child.removeAllListeners('exit');
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    if (called) saveExercised('bolt-python-socket', sdk, called, delivered);
    await t?.close();
  });

  const fromBot = (match: (event: Json) => boolean): Promise<Json> =>
    stream.next((event) => event.type === 'message' && event.user === creds.botUserId && match(event), 8000);

  test('@app.message with say(): a greeting is answered in a thread', async () => {
    const { ts } = await member.ok('chat.postMessage', { channel: general, text: 'hello python' });
    const reply = await fromBot((event) => event.thread_ts === ts);
    assert.equal(reply.text, `Hey there <@${member.userId}>!`);
  });

  let deployMessage = '';

  test('@app.event(app_mention): reactions_add, users_info and chat_postMessage with blocks', async () => {
    const { ts } = await member.ok('chat.postMessage', { channel: general, text: `<@${creds.botUserId}> please deploy` });
    const reaction = await stream.next((event) => event.type === 'reaction_added' && event.item.ts === ts, 8000);
    assert.equal(reaction.user, creds.botUserId);
    const posted = await fromBot((event) => event.thread_ts === ts && Array.isArray(event.blocks));
    assert.equal(posted.text, 'Deploy requested by Mina Member');
    deployMessage = posted.ts;
  });

  test('@app.action with ack() and respond(): a click replaces the message', async () => {
    assert.deepEqual(
      await member.call('client.interactions.blockAction', { channel: general, message_ts: deployMessage, action: { action_id: 'approve' } }),
      { ok: true },
    );
    const changed = await stream.next((event) => event.subtype === 'message_changed' && event.message.ts === deployMessage, 8000);
    assert.equal(changed.message.text, `Approved build-12 — thanks <@${member.userId}>`);
  });

  test('@app.command: ack(text) answers the person, respond() posts to the channel', async () => {
    assert.deepEqual(await member.call('client.commands.run', { channel: general, command: '/pyecho', text: 'ship it' }), { ok: true });
    await stream.next((event) => event.is_ephemeral === true && event.text === 'Echo: ship it', 8000);
    await fromBot((event) => event.text === `<@${member.userId}> said: ship it`);
  });

  test('files_upload_v2: the three-step upload ends as a message with a file', async () => {
    const { ts } = await member.ok('chat.postMessage', { channel: general, text: 'send the nightly report' });
    const shared = await fromBot((event) => event.thread_ts === ts && Array.isArray(event.files));
    assert.equal(shared.text, 'Here is the report.');
    assert.equal(shared.files[0].title, 'Nightly report');
    const download = await fetch(`${t.base}${new URL(shared.files[0].url_private).pathname}`, { headers: { cookie: member.cookie } });
    assert.equal(await download.text(), 'All 1,205 tests passed.\n');
  });

  test('assistant_threads_setStatus, conversations_history and chat_stream: a streamed answer', async () => {
    const { ts } = await member.ok('chat.postMessage', { channel: general, text: 'summarise the channel' });
    await stream.next((event) => event.type === 'assistant_thread_status' && event.thread_ts === ts, 8000);
    const final = await stream.next(
      (event) => event.subtype === 'message_changed' && event.message.thread_ts === ts && !event.message.streaming,
      8000,
    );
    assert.equal(final.message.text, 'I read the last **3** messages. Nothing is on fire.');
  });
});
