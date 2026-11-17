import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../src/app.ts';
import { DataDirInUse } from '../src/core/instances.ts';
import type { Config } from '../src/ctx.ts';
import { CanvasClient, until } from './canvas-client.ts';
import { addMember, callWithToken, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';
import { botOk, createPlatformApp, SocketApp, type TestAppCredentials } from './platform-helpers.ts';

const FAST = { heartbeatMs: 100, deadAfterMs: 800, pollMs: 10 };

/** The same person, signed in, talking to another process. */
function through(test: TestApp, session: Session): Session {
  const other = new Session(test.base);
  other.cookie = session.cookie;
  other.userId = session.userId;
  return other;
}

function config(dataDir: string, overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    publicUrl: '',
    webDir: null,
    maxUploadBytes: 5 * 1024 * 1024,
    cookieSecure: false,
    version: 'test',
    quiet: true,
    linkPreviews: false,
    instanceTimings: FAST,
    ...overrides,
  };
}

describe('several processes sharing one database', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'chat-instances-'));
  let a: TestApp;
  let b: TestApp;
  let owner: Session;
  let member: Session;
  let general: string;

  before(async () => {
    a = await startApp({ dataDir, cluster: true, instanceTimings: FAST, keepData: true });
    b = await startApp({ dataDir, cluster: true, instanceTimings: FAST, keepData: true });
    owner = await setupWorkspace(a);
    member = await addMember(a, owner, 'Mina Member');
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
  });
  after(async () => {
    await b.close();
    await a?.close().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('both are registered and one of them leads', async () => {
    const ids = a.app.ctx.instances.alive();
    assert.equal(ids.length, 2);
    assert.deepEqual([a.app.ctx.instances.isLeader(), b.app.ctx.instances.isLeader()], [true, false]);
  });

  test('a message posted through one process reaches a WebSocket held by the other', async () => {
    const stream = await through(b, member).connect();
    const posted = await owner.ok('chat.postMessage', { channel: general, text: 'hello from a' });
    const event = await stream.next((item) => item.type === 'message' && item.ts === posted.ts);
    assert.equal(event.text, 'hello from a');
    // And the other way round, typing included.
    const ownerStream = await owner.connect();
    stream.send({ type: 'typing', channel: general });
    await ownerStream.next((item) => item.type === 'user_typing' && item.user === member.userId);
    stream.close();
    ownerStream.close();
  });

  test('events from different processes reach every socket in the order they happened', async () => {
    const onA = await member.connect();
    const onB = await through(b, member).connect();
    for (let round = 0; round < 5; round += 1) {
      // Posted through a, changed through b right after: the change must never overtake the message.
      const posted = await owner.ok('chat.postMessage', { channel: general, text: `order ${round}` });
      await through(b, owner).ok('chat.update', { channel: general, ts: posted.ts, text: `order ${round}, edited` });
      for (const stream of [onA, onB]) {
        await stream.next((event) => event.subtype === 'message_changed' && event.message?.ts === posted.ts);
        const created = stream.events.findIndex((event) => event.type === 'message' && event.subtype === undefined && event.ts === posted.ts);
        const changed = stream.events.findIndex((event) => event.subtype === 'message_changed' && event.message?.ts === posted.ts);
        assert.ok(created >= 0 && created < changed, `round ${round}: message ${created}, change ${changed}`);
      }
    }
    onA.close();
    onB.close();
  });

  test('a keyword saved through one process is matched by the other', async () => {
    const onB = through(b, owner);
    // b has already worked out the member's (empty) keywords for a message there.
    await onB.ok('chat.postMessage', { channel: general, text: 'nothing to see' });
    await member.ok('client.prefs.set', { prefs: { highlight_words: 'rollout' } });
    await until(async () => {
      await onB.ok('chat.postMessage', { channel: general, text: 'the rollout starts now' });
      const items = (await member.ok('client.activity.list', { types: 'keyword' })).items as Json[];
      return items.some((item) => item.keyword === 'rollout');
    });
  });

  test('someone connected to one process is active in the other, and away after leaving', async () => {
    const watcher = await owner.connect();
    const stream = await through(b, member).connect();
    await until(async () => (await owner.ok('users.getPresence', { user: member.userId })).presence === 'active');
    stream.close();
    // Away once the reload grace has passed, announced to sockets on the other process.
    await watcher.next((item) => item.type === 'presence_change' && item.user === member.userId && item.presence === 'away', 8000);
    assert.equal((await owner.ok('users.getPresence', { user: member.userId })).presence, 'away');
    watcher.close();
  });

  test('two processes posting at once never hand out the same ts', async () => {
    const onB = through(b, owner);
    const posts = await Promise.all(
      Array.from({ length: 60 }, (_, i) => (i % 2 ? owner : onB).ok('chat.postMessage', { channel: general, text: `burst ${i}` })),
    );
    const stamps = posts.map((post) => post.ts as string);
    assert.equal(new Set(stamps).size, 60);
    const history = (await owner.ok('conversations.history', { channel: general, limit: 200 })).messages.filter((message: Json) => message.text.startsWith('burst '));
    assert.equal(history.length, 60);
  });

  describe('apps', () => {
    let app: TestAppCredentials;
    let socket: SocketApp;

    before(async () => {
      app = await createPlatformApp(owner, 'Relay Bot');
      await owner.ok('conversations.invite', { channel: general, users: app.botUserId });
      await owner.ok('client.apps.commands.set', { app: app.id, command: '/deploy', description: 'Deploy' });
      // The app's Socket Mode connection is held by process b.
      socket = await SocketApp.connect(b.base, app.appToken);
    });
    after(() => socket.close());

    test('a command run through one process reaches the app connected to the other, and its answer comes back', async () => {
      const stream = await member.connect();
      socket.autoAck = (envelope) => (envelope.type === 'slash_commands' ? { text: `Deploying ${envelope.payload.text}` } : undefined);
      assert.deepEqual(await member.call('client.commands.run', { channel: general, command: '/deploy', text: 'build 7' }), { ok: true });
      const envelope = await socket.envelopes.next((entry) => entry.type === 'slash_commands');
      await stream.next((event) => event.is_ephemeral === true && event.text === 'Deploying build 7');
      socket.autoAck = true;

      // The response_url and trigger_id were issued by a; the app uses them through b.
      const url = new URL(envelope.payload.response_url as string);
      const answered = await fetch(`${b.base}${url.pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Done', response_type: 'in_channel' }) });
      assert.equal(answered.status, 200);
      assert.equal((await owner.ok('conversations.history', { channel: general, limit: 1 })).messages[0].text, 'Done');
      const opened = await callWithToken(b.base, app.botToken, 'views.open', {
        trigger_id: envelope.payload.trigger_id,
        view: { type: 'modal', title: { type: 'plain_text', text: 'Deploy' }, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Ready' } }] },
      });
      assert.equal(opened.ok, true, JSON.stringify(opened));
      const again = await callWithToken(a.base, app.botToken, 'views.open', { trigger_id: envelope.payload.trigger_id, view: { type: 'modal', title: { type: 'plain_text', text: 'x' }, blocks: [] } });
      assert.equal(again.error, 'exchanged_trigger_id');
      stream.close();
    });

    test('both processes count the connection: the app shows as connected, and a ticket from one opens a socket on the other', async () => {
      const listed = (await owner.ok('client.apps.list')).apps.find((entry: Json) => entry.id === app.id);
      assert.equal(listed.connected, true);
      const second = await SocketApp.connect(a.base, app.appToken);
      const hello = second.envelopes.items.find((item) => item.type === 'hello');
      assert.equal(hello.num_connections, 2);
      second.close();
    });

    test('a stream started through one process is appended to and stopped through the other', async () => {
      const started = await botOk(a.base, app, 'chat.startStream', { channel: general, markdown_text: 'Step one. ' });
      await botOk(b.base, app, 'chat.appendStream', { channel: general, ts: started.ts, markdown_text: 'Step two.' });
      const stopped = await botOk(b.base, app, 'chat.stopStream', { channel: general, ts: started.ts });
      assert.equal(stopped.message.text, 'Step one. Step two.');
      assert.equal((await callWithToken(a.base, app.botToken, 'chat.appendStream', { channel: general, ts: started.ts, markdown_text: 'late' })).error, 'message_not_in_streaming_state');
    });
  });

  test('a canvas edited through one process changes for someone connected to the other', async () => {
    const created = await owner.ok('canvases.create', { title: 'Plan', document_content: { type: 'markdown', markdown: 'First line' } });
    const left = new CanvasClient(a.base, created.canvas_id, owner.cookie);
    const right = new CanvasClient(b.base, created.canvas_id, owner.cookie);
    await Promise.all([left.synced, right.synced]);
    left.addParagraph('Typed on a');
    await until(() => right.text().includes('Typed on a'));
    right.addParagraph('Typed on b');
    await until(() => left.text().includes('Typed on b'));
    // An edit through the API of one process.
    await through(b, owner).ok('canvases.edit', { canvas_id: created.canvas_id, changes: [{ operation: 'insert_at_end', document_content: { type: 'markdown', markdown: 'From the API' } }] });
    await until(() => left.text().includes('From the API'));
    // Cursors cross too.
    left.awareness.setLocalStateField('user', { name: 'Olive' });
    await until(() => [...right.awareness.getStates().values()].some((state) => (state as Json).user?.name === 'Olive'));
    left.close();
    right.close();
  });

  test('a workflow built through one process is a shortcut, and runs, through the other', async () => {
    // b started before the built-in Workflows app existed; a creates it with the first workflow.
    const saved = await owner.ok('client.workflows.save', {
      name: 'Say hello',
      trigger: { type: 'shortcut' },
      steps: [{ id: 'say', type: 'message', destination: { to: 'trigger_channel' }, text: 'hello from a workflow' }],
    });
    await owner.ok('client.workflows.publish', { workflow: saved.workflow.id });
    const onB = through(b, member);
    const shortcut = ((await onB.ok('client.shortcuts.list')).shortcuts as Json[]).find((entry) => entry.name === 'Say hello');
    assert.ok(shortcut, 'listed through b');
    await onB.ok('client.shortcuts.run', { app: shortcut.app_id, callback_id: shortcut.callback_id, context_channel: general });
    await until(async () => (await owner.ok('conversations.history', { channel: general, limit: 3 })).messages.some((message: Json) => message.text === 'hello from a workflow'));
    assert.equal((a.app.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM apps WHERE json_extract(config, '$.builtin') = 'workflows'"))!.n, 1);
  });

  test('a message scheduled through the other process is sent once, by the leader', async () => {
    const onB = through(b, owner);
    const postAt = Math.floor(Date.now() / 1000) + 1;
    await onB.ok('chat.scheduleMessage', { channel: general, text: 'scheduled across', post_at: postAt });
    await until(async () => (await owner.ok('conversations.history', { channel: general, limit: 5 })).messages.some((message: Json) => message.text === 'scheduled across'), 5000);
    await sleep(1500);
    const sent = (await owner.ok('conversations.history', { channel: general, limit: 20 })).messages.filter((message: Json) => message.text === 'scheduled across');
    assert.equal(sent.length, 1);
  });

  test('workspace changes made through one process are seen by the other', async () => {
    // b has the workspace row cached; the change made through a tells it to read it again.
    assert.equal((await through(b, owner).ok('team.info')).team.name, 'Acme');
    await owner.ok('client.admin.updateTeam', { name: 'Acme Renamed' });
    await until(async () => (await through(b, owner).ok('team.info')).team.name === 'Acme Renamed');
  });

  test('when the leader stops, the other takes over the periodic work', async () => {
    await a.close();
    await until(() => b.app.ctx.instances.isLeader(), 3000);
    const onB = through(b, owner);
    await onB.ok('chat.scheduleMessage', { channel: general, text: 'after the leader left', post_at: Math.floor(Date.now() / 1000) + 1 });
    await until(async () => (await onB.ok('conversations.history', { channel: general, limit: 5 })).messages.some((message: Json) => message.text === 'after the leader left'), 5000);
  });
});

describe('a data directory in use', () => {
  test('a second process that does not share refuses to serve, and starts once the first has stopped', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'chat-instances-'));
    try {
      const first = createApp(config(dataDir));
      await first.listen();
      const second = createApp(config(dataDir));
      await assert.rejects(second.listen(), (error: unknown) => error instanceof DataDirInUse && /CLUSTER=1/.test(error.message));
      await second.close();
      // A shared process cannot join one that does not share either.
      const shared = createApp(config(dataDir, { cluster: true }));
      await assert.rejects(shared.listen(), DataDirInUse);
      await shared.close();
      await first.close();
      const third = createApp(config(dataDir));
      await third.listen();
      await third.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('a heartbeat that stopped (a crash) does not block the next start', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'chat-instances-'));
    try {
      const first = createApp(config(dataDir));
      await first.listen();
      await first.close();
      // A process that crashed a moment ago: its row stays, with a recent heartbeat that no longer advances.
      const db = new DatabaseSync(join(dataDir, 'app.db'));
      db.prepare('INSERT INTO instances (id, host, pid, shared, started, seen) VALUES (?, ?, ?, 0, ?, ?)').run('crashed', 'here', 1, Date.now(), Date.now());
      db.close();
      const next = createApp(config(dataDir));
      const started = Date.now();
      await next.listen();
      assert.ok(Date.now() - started >= FAST.deadAfterMs / 2, 'waited for the old heartbeat to run out');
      await next.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('WORKERS: several worker processes on one port', () => {
  test('workers share the port and the data, deliver each other’s events, and stop together', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'chat-workers-'));
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const chosen = (probe.address() as { port: number }).port;
        probe.close(() => resolve(chosen));
      });
    });
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '../src/main.ts')], {
      env: { ...process.env, WORKERS: '2', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, QUIET: '1', LINK_PREVIEWS: '0', WEB_DIR: '' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const base = `http://127.0.0.1:${port}`;
    try {
      await until(async () => (await fetch(`${base}/healthz`).catch(() => null))?.ok === true, 20_000);
      const db = new DatabaseSync(join(dataDir, 'app.db'), { readOnly: true });
      await until(() => (db.prepare('SELECT count(*) AS n FROM instances WHERE seen > ? AND shared = 1').get(Date.now() - 5000) as { n: number }).n === 2, 10_000);

      const owner = await setupWorkspace({ base } as TestApp);
      const general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
      // Connections are spread over the workers; every one hears the message.
      const streams = await Promise.all(Array.from({ length: 4 }, () => owner.connect()));
      const posted = await owner.ok('chat.postMessage', { channel: general, text: 'to every worker' });
      await Promise.all(streams.map((stream) => stream.next((event) => event.type === 'message' && event.ts === posted.ts, 4000)));
      for (const stream of streams) stream.close();

      child.kill('SIGTERM');
      assert.equal(await exited, 0, stderr);
      const live = db.prepare('SELECT count(*) AS n FROM instances WHERE seen > 0').get() as { n: number };
      assert.equal(live.n, 0);
      db.close();
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
