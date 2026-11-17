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
import { freePort, recordTokenCalls, saveExercised } from './harness.ts';

const SCRIPT = fileURLToPath(new URL('../python/bolt_app.py', import.meta.url));
// Bolt for Python is fetched by uv on first use. Without uv this suite is skipped, not faked.
const hasUv = spawnSync('uv', ['--version']).status === 0;

for (const transport of ['socket', 'http'] as const) defineSuite(transport);

function defineSuite(transport: 'socket' | 'http'): void {
describe(`an official Bolt for Python app over ${transport === 'socket' ? 'Socket Mode' : 'HTTP'}`, { skip: hasUv ? false : 'uv is not installed' }, () => {
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
    creds = await createPlatformApp(owner, 'Python Bot', { socket_mode: transport === 'socket' });
    await owner.ok('conversations.invite', { channel: general, users: creds.botUserId });
    await owner.ok('client.apps.update', { app: creds.id, shortcuts: [{ type: 'global', name: 'File a bug', callback_id: 'file_bug' }] });
    called = recordTokenCalls(t);

    const port = await freePort();
    const env: NodeJS.ProcessEnv = { ...process.env, API_URL: `${t.base}/api/`, BOT_TOKEN: creds.botToken, BUG_CHANNEL: general };
    if (transport === 'socket') env.APP_TOKEN = creds.appToken;
    else Object.assign(env, { SIGNING_SECRET: creds.signingSecret, PORT: String(port) });
    child = spawn('uv', ['run', '--no-project', '--quiet', '--with', 'slack_bolt', 'python', SCRIPT], {
      env,
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
    const url = `http://127.0.0.1:${port}/slack/events`;
    if (transport === 'http') {
      // Saving the URLs runs the verification handshake against Bolt's own server; retry while it starts listening.
      for (let attempt = 0; ; attempt += 1) {
        const saved = await owner.call('client.apps.update', { app: creds.id, events_url: url, interactivity_url: url });
        if (saved.ok) break;
        if (attempt > 50) throw new Error(`could not verify ${url}: ${JSON.stringify(saved)} ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    await owner.ok('client.apps.commands.set', { app: creds.id, command: '/pyecho', ...(transport === 'http' ? { url } : {}) });
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
    if (called) saveExercised(`bolt-python-${transport}`, sdk, called, delivered);
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

  test('@app.shortcut, views_open and @app.view with response_action errors', async () => {
    await member.ok('client.shortcuts.run', { app: creds.id, callback_id: 'file_bug' });
    const opened = await stream.next((event) => event.type === 'view_stack' && event.stack[0]?.callback_id === 'bug_form', 8000);
    const view = opened.stack[0];
    const values = (title: string): Json => ({
      title: { value: { type: 'plain_text_input', value: title } },
      due: { date: { type: 'datepicker', selected_date: '2026-12-01' } },
    });
    const refused = await member.ok('client.views.submit', { view_id: view.id, state: { values: values('Slow') } });
    assert.deepEqual(refused.errors, { title: 'Use at least five characters' });
    const filed = await member.ok('client.views.submit', { view_id: view.id, state: { values: values('Search is slow') } });
    assert.deepEqual(filed.stack, []);
    await fromBot((event) => event.text === `Bug filed by <@${member.userId}>: Search is slow (due 2026-12-01)`);
  });

  test('@app.event(app_home_opened) with views_publish', async () => {
    await member.ok('client.apps.homeOpened', { app: creds.id, tab: 'home' });
    const home = await stream.next((event) => event.type === 'app_home' && event.app_id === creds.id, 8000);
    assert.equal(home.view.blocks[0].text.text, '*Hello from Python*');
  });
});
}
