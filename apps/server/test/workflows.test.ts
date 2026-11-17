import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { regexProblem } from '../src/workflows/responses.ts';
import { nextFire } from '../src/workflows/vars.ts';
import { addMember, callWithToken, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `check` returns something truthy. */
async function until<T>(check: () => Promise<T> | T, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(25);
  }
}

describe('workflows', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let general: string;
  let random: string;

  const runs = async (workflow: string): Promise<Json[]> => (await owner.ok('client.workflows.runs', { workflow })).runs;
  const latestText = async (channel: string, as: Session = owner): Promise<string> => (await as.ok('conversations.history', { channel, limit: 1 })).messages[0]?.text ?? '';
  const build = async (name: string, trigger: Json, steps: Json[], as: Session = owner): Promise<Json> => {
    const saved = await as.ok('client.workflows.save', { name, trigger, steps });
    return (await as.ok('client.workflows.publish', { workflow: saved.workflow.id })).workflow;
  };

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    const boot = await owner.ok('client.boot');
    general = boot.channels.find((channel: Json) => channel.name === 'general').id;
    random = boot.channels.find((channel: Json) => channel.name === 'random').id;
  });
  after(() => t.close());

  test('validation: shapes, publishing rules, and channels the builder cannot see', async () => {
    assert.equal((await owner.call('client.workflows.save', { name: 'x', trigger: { type: 'nope' }, steps: [] })).error, 'invalid_workflow');
    const formOnSchedule = await owner.ok('client.workflows.save', {
      name: 'Bad',
      trigger: { type: 'schedule', schedule: { frequency: 'daily', time: '09:00', tz: 'Asia/Seoul' } },
      steps: [{ id: 'ask', type: 'form', fields: [{ key: 'q', label: 'Q', type: 'text' }] }],
    });
    const refused = await owner.call('client.workflows.publish', { workflow: formOnSchedule.workflow.id });
    assert.equal(refused.error, 'cannot_publish');
    assert.match(refused.problems[0], /person to fill it in/);
    // A private channel the builder is not in is "not found".
    const { channel } = await owner.ok('conversations.create', { name: 'owners-only', is_private: true });
    const hidden = await member.call('client.workflows.save', {
      name: 'Peek',
      trigger: { type: 'shortcut' },
      steps: [{ id: 'say', type: 'message', destination: { to: 'channel', channel: channel.id }, text: 'hi' }],
    });
    assert.equal(hidden.error, 'channel_not_found');
    const addPrivate = await owner.call('client.workflows.save', {
      name: 'Add',
      trigger: { type: 'shortcut' },
      steps: [{ id: 'add', type: 'add_to_channel', channel: channel.id, user: 'trigger.user' }],
    });
    assert.equal(addPrivate.error, 'invalid_workflow');
    // Someone else's workflow is invisible.
    assert.equal((await member.call('client.workflows.get', { workflow: formOnSchedule.workflow.id })).error, 'workflow_not_found');
  });

  test('a shortcut runs in the channel it was started from, with variables, and is recorded', async () => {
    const workflow = await build('Say hello', { type: 'shortcut' }, [
      { id: 'greet', type: 'message', destination: { to: 'trigger_channel' }, text: 'Hello {{trigger.user}} in {{trigger.channel}}' },
      { id: 'dm', type: 'message', destination: { to: 'user', user: 'trigger.user' }, text: 'Your greeting went out at {{steps.greet.ts}}' },
    ]);
    const shortcuts = (await member.ok('client.shortcuts.list')).shortcuts;
    const entry = shortcuts.find((item: Json) => item.name === 'Say hello');
    assert.equal(entry.type, 'global');
    assert.equal(entry.app_name, 'Workflows');
    await member.ok('client.shortcuts.run', { app: entry.app_id, callback_id: entry.callback_id, context_channel: random });
    await until(async () => (await runs(workflow.id))[0]?.status === 'completed');
    assert.equal(await latestText(random), `Hello <@${member.userId}> in <#${random}>`);
    const history = await runs(workflow.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].runner, member.userId);
    assert.deepEqual(history[0].log.map((entry: Json) => [entry.step, entry.ok]), [['greet', true], ['dm', true]]);
    // The built-in app is not on the Apps screen.
    assert.ok(!(await owner.ok('client.apps.list')).apps.some((app: Json) => app.name === 'Workflows'));
  });

  test('a form pauses the run, checks required fields, and its answers flow to later steps', async () => {
    const workflow = await build('Request', { type: 'shortcut' }, [
      {
        id: 'ask',
        type: 'form',
        title: 'Request',
        fields: [
          { key: 'what', label: 'What do you need?', type: 'text', required: true },
          { key: 'urgency', label: 'Urgency', type: 'select', options: ['low', 'high'], required: true },
        ],
        post_to: 'trigger_channel',
      },
      {
        id: 'route',
        type: 'branch',
        variable: 'steps.ask.urgency',
        operator: 'equals',
        value: 'high',
        then: [{ id: 'page', type: 'message', destination: { to: 'channel', channel: general }, text: 'URGENT from {{steps.ask.user}}: {{steps.ask.what}}' }],
        else: [{ id: 'queue', type: 'message', destination: { to: 'channel', channel: general }, text: 'Queued: {{steps.ask.what}}' }],
      },
    ]);
    const start = async (): Promise<Json> => {
      const entry = (await member.ok('client.shortcuts.list')).shortcuts.find((item: Json) => item.name === 'Request');
      await member.ok('client.shortcuts.run', { app: entry.app_id, callback_id: entry.callback_id, context_channel: random });
      return until(async () => (await member.ok('client.views.stack')).stack[0]);
    };

    // 1. Missing answers come back as errors; the run keeps waiting.
    let view = await start();
    assert.equal(view.title.text, 'Request');
    const missing = await member.ok('client.views.submit', { view_id: view.id, state: { values: {} } });
    assert.ok(missing.errors.what && missing.errors.urgency);
    assert.equal((await runs(workflow.id))[0].status, 'waiting');

    // 2. A complete answer resumes the run; the else-branch runs.
    const answer = (what: string, urgency: string): Json => ({
      values: { what: { value: { type: 'plain_text_input', value: what } }, urgency: { value: { type: 'static_select', selected_option: { value: urgency } } } },
    });
    const done = await member.ok('client.views.submit', { view_id: view.id, state: answer('a new laptop', 'low') });
    assert.deepEqual(done.stack, []);
    await until(async () => (await runs(workflow.id))[0].status === 'completed');
    assert.equal(await latestText(general), 'Queued: a new laptop');
    const posted = (await owner.ok('conversations.history', { channel: random, limit: 1 })).messages[0];
    assert.match(posted.text, /\*Request\* — submitted by/);
    assert.match(posted.text, /a new laptop/);

    // 3. The then-branch.
    view = await start();
    await member.ok('client.views.submit', { view_id: view.id, state: answer('the database is down', 'high') });
    await until(async () => (await runs(workflow.id))[0].status === 'completed');
    assert.equal(await latestText(general), `URGENT from <@${member.userId}>: the database is down`);
    const log = (await runs(workflow.id))[0].log;
    assert.ok(log.some((entry: Json) => entry.step === 'route' && entry.detail === 'then'));

    // 4. Closing the form cancels the run.
    view = await start();
    await member.ok('client.views.close', { view_id: view.id, clear: true });
    await until(async () => (await runs(workflow.id))[0].status === 'cancelled');
  });

  test('a run cannot post where the person who started it cannot, even when the creator can', async () => {
    const { channel } = await owner.ok('conversations.create', { name: 'leads', is_private: true });
    const workflow = await build('Into leads', { type: 'shortcut' }, [
      { id: 'say', type: 'message', destination: { to: 'channel', channel: channel.id }, text: 'from {{trigger.user}}' },
    ]);
    const entry = (await member.ok('client.shortcuts.list')).shortcuts.find((item: Json) => item.name === 'Into leads');
    await member.ok('client.shortcuts.run', { app: entry.app_id, callback_id: entry.callback_id });
    const run = await until(async () => {
      const latest = (await runs(workflow.id))[0];
      return latest?.status === 'failed' ? latest : null;
    });
    assert.match(run.error, /person who started the workflow is not in that conversation/);
    assert.equal((await owner.ok('conversations.history', { channel: channel.id })).messages.some((message: Json) => message.text.startsWith('from')), false);
    // The creator may run it.
    await owner.ok('client.shortcuts.run', { app: entry.app_id, callback_id: entry.callback_id });
    await until(async () => (await runs(workflow.id))[0].status === 'completed');
    assert.equal(await latestText(channel.id), `from <@${owner.userId}>`);
    // The trigger channel is ignored when the person cannot see it.
    const where = await build('Where am I', { type: 'shortcut' }, [{ id: 'say', type: 'message', destination: { to: 'trigger_channel' }, text: 'here' }]);
    const whereEntry = (await member.ok('client.shortcuts.list')).shortcuts.find((item: Json) => item.name === 'Where am I');
    await member.ok('client.shortcuts.run', { app: whereEntry.app_id, callback_id: whereEntry.callback_id, context_channel: channel.id });
    const failed = await until(async () => {
      const latest = (await runs(where.id))[0];
      return latest?.status === 'failed' ? latest : null;
    });
    assert.match(failed.error, /not started from a channel/);
  });

  test('an emoji reaction fires only in the chosen channel and replies in the thread; joining a channel fires too', async () => {
    const workflow = await build('Triage', { type: 'reaction', channel: general, reaction: 'eyes' }, [
      { id: 'ack', type: 'message', destination: { to: 'thread' }, text: '{{trigger.user}} is looking at “{{trigger.message_text}}”' },
    ]);
    const { ts } = await owner.ok('chat.postMessage', { channel: general, text: 'the build is red' });
    const elsewhere = await owner.ok('chat.postMessage', { channel: random, text: 'not watched' });
    await member.ok('reactions.add', { channel: random, timestamp: elsewhere.ts, name: 'eyes' });
    await member.ok('reactions.add', { channel: general, timestamp: ts, name: 'thumbsup' });
    await member.ok('reactions.add', { channel: general, timestamp: ts, name: 'eyes' });
    await until(async () => (await runs(workflow.id)).length === 1 && (await runs(workflow.id))[0].status === 'completed');
    await sleep(100);
    assert.equal((await runs(workflow.id)).length, 1);
    const thread = await owner.ok('conversations.replies', { channel: general, ts });
    assert.equal(thread.messages[1].text, `<@${member.userId}> is looking at “the build is red”`);

    const { channel } = await owner.ok('conversations.create', { name: 'welcome-desk' });
    const welcome = await build('Welcome', { type: 'member_joined', channel: channel.id }, [
      { id: 'hi', type: 'message', destination: { to: 'trigger_channel' }, text: 'Welcome {{trigger.user}}!' },
    ]);
    await member.ok('conversations.join', { channel: channel.id });
    await until(async () => (await runs(welcome.id))[0]?.status === 'completed');
    assert.equal(await latestText(channel.id), `Welcome <@${member.userId}>!`);

    // Turned off, it stops.
    await owner.ok('client.workflows.publish', { workflow: workflow.id, published: false });
    await member.ok('reactions.remove', { channel: general, timestamp: ts, name: 'eyes' });
    await member.ok('reactions.add', { channel: general, timestamp: ts, name: 'eyes' });
    await sleep(150);
    assert.equal((await runs(workflow.id)).length, 1);
  });

  test('a webhook trigger checks its secret and turns JSON keys into variables', async () => {
    const workflow = await build('Deploys', { type: 'webhook', variables: ['service', 'version'] }, [
      { id: 'say', type: 'message', destination: { to: 'channel', channel: general }, text: '{{webhook.service}} {{webhook.version}} is out <b>' },
    ]);
    const full = (await owner.ok('client.workflows.get', { workflow: workflow.id })).workflow;
    const url = new URL(full.webhook_url);
    const send = (path: string, body: unknown): Promise<Response> => fetch(`${t.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await send(url.pathname.replace(/[0-9a-f]+$/, 'deadbeef'), { service: 'api' })).status, 404);
    assert.equal((await send(url.pathname, { service: 'api', version: 'v1.2', ignored: 'x' })).status, 200);
    await until(async () => (await runs(workflow.id))[0]?.status === 'completed');
    assert.equal(await latestText(general), 'api v1.2 is out <b>');
    assert.equal((await runs(workflow.id))[0].runner, null);
  });

  test('an outgoing webhook step posts JSON, and refuses private addresses when the server is public', async () => {
    const received: Json[] = [];
    const sink: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
    const target = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/hook`;
    try {
      const workflow = await build('Notify', { type: 'shortcut' }, [
        { id: 'call', type: 'webhook', url: target, body: { who: '{{trigger.user}}', note: 'started' } },
        { id: 'say', type: 'message', destination: { to: 'channel', channel: general }, text: 'webhook said {{steps.call.status}}' },
      ]);
      const entry = (await owner.ok('client.shortcuts.list')).shortcuts.find((item: Json) => item.name === 'Notify');
      await owner.ok('client.shortcuts.run', { app: entry.app_id, callback_id: entry.callback_id });
      await until(async () => (await runs(workflow.id))[0]?.status === 'completed');
      assert.deepEqual(received, [{ who: owner.userId, note: 'started' }]);
      assert.equal(await latestText(general), 'webhook said 200');

      process.env.ALLOW_PRIVATE_APP_URLS = '0';
      await owner.ok('client.shortcuts.run', { app: entry.app_id, callback_id: entry.callback_id });
      const failed = await until(async () => {
        const latest = (await runs(workflow.id))[0];
        return latest?.status === 'failed' ? latest : null;
      });
      assert.match(failed.error, /private network/);
      assert.equal(received.length, 1);
    } finally {
      delete process.env.ALLOW_PRIVATE_APP_URLS;
      sink.close();
    }
  });

  test('an app step waits for the app, which completes it with its own token', async () => {
    const created = await owner.ok('client.apps.create', { name: 'Ticketing', socket_mode: false });
    await owner.ok('client.apps.update', {
      app: created.app.id,
      functions: [
        {
          callback_id: 'create_ticket',
          title: 'Create a ticket',
          input_parameters: [{ name: 'summary', type: 'string', required: true }],
          output_parameters: [{ name: 'ticket_id', type: 'string' }],
        },
      ],
    });
    const types = await owner.ok('client.workflows.stepTypes');
    assert.equal(types.apps[0].functions[0].callback_id, 'create_ticket');
    const workflow = await build('Ticket', { type: 'shortcut' }, [
      { id: 'ticket', type: 'app', app_id: created.app.id, callback_id: 'create_ticket', inputs: { summary: 'from {{trigger.user}}' } },
      { id: 'say', type: 'message', destination: { to: 'channel', channel: general }, text: 'Ticket {{steps.ticket.ticket_id}} created' },
    ]);
    const entry = (await owner.ok('client.shortcuts.list')).shortcuts.find((item: Json) => item.name === 'Ticket');
    await owner.ok('client.shortcuts.run', { app: entry.app_id, callback_id: entry.callback_id });
    await until(async () => (await runs(workflow.id))[0]?.status === 'waiting');
    const row = t.app.ctx.db.get<{ waiting: string }>("SELECT waiting FROM workflow_runs WHERE status = 'waiting'")!;
    const executionId = (JSON.parse(row.waiting) as Json).execution_id;

    // Another app cannot complete it.
    const other = await owner.ok('client.apps.create', { name: 'Other', socket_mode: false });
    assert.equal((await callWithToken(t.base, other.bot_token, 'functions.completeSuccess', { function_execution_id: executionId, outputs: {} })).error, 'function_execution_not_found');
    const ok = await callWithToken(t.base, created.bot_token, 'functions.completeSuccess', { function_execution_id: executionId, outputs: { ticket_id: 'T-42' } });
    assert.equal(ok.ok, true);
    await until(async () => (await runs(workflow.id))[0].status === 'completed');
    assert.equal(await latestText(general), 'Ticket T-42 created');

    // completeError fails the run with the app's message.
    await owner.ok('client.shortcuts.run', { app: entry.app_id, callback_id: entry.callback_id });
    await until(async () => (await runs(workflow.id))[0]?.status === 'waiting');
    const second = (JSON.parse(t.app.ctx.db.get<{ waiting: string }>("SELECT waiting FROM workflow_runs WHERE status = 'waiting'")!.waiting) as Json).execution_id;
    await callWithToken(t.base, created.bot_token, 'functions.completeError', { function_execution_id: second, error: 'queue full' });
    const failed = await until(async () => {
      const latest = (await runs(workflow.id))[0];
      return latest?.status === 'failed' ? latest : null;
    });
    assert.match(failed.error, /queue full/);
  });

  test('custom responses: admins only, matching rules, channel scope, unsafe patterns refused', async () => {
    assert.equal((await member.call('client.responses.save', { match_type: 'contains', pattern: 'x', reply: 'y' })).error, 'not_allowed');
    assert.equal((await owner.call('client.responses.save', { match_type: 'regex', pattern: '(a+)+$', reply: 'y' })).error, 'invalid_pattern');
    await owner.ok('client.responses.save', { match_type: 'contains', pattern: 'wifi password', reply: 'It is on the fridge.', channels: [random] });
    await owner.ok('client.responses.save', { match_type: 'regex', pattern: '^how do i (deploy|ship)\\b', reply: 'See the deploy guide.' });
    await member.ok('chat.postMessage', { channel: random, text: 'what is the WiFi password?' });
    await until(async () => (await latestText(random)) === 'It is on the fridge.');
    await member.ok('chat.postMessage', { channel: general, text: 'wifi password please' });
    await member.ok('chat.postMessage', { channel: general, text: 'How do I deploy this?' });
    await until(async () => (await latestText(general)) === 'See the deploy guide.');
    const recent = (await owner.ok('conversations.history', { channel: general, limit: 3 })).messages.map((message: Json) => message.text);
    assert.ok(!recent.includes('It is on the fridge.'));
  });

  test('pattern safety and schedule arithmetic', () => {
    assert.match(regexProblem('(a|aa)*b') ?? '', /Repeated alternatives/);
    assert.match(regexProblem('(x+)+y') ?? '', /Nested repeats/);
    assert.match(regexProblem('(a)\\1') ?? '', /Backreferences/);
    assert.equal(regexProblem('^on ?call\\b'), null);
    // 2026-11-16 is a Monday. 09:00 in Seoul is 00:00 UTC.
    const monday = Date.UTC(2026, 10, 16, 12, 0) / 1000;
    assert.equal(nextFire({ frequency: 'daily', time: '09:00', tz: 'Asia/Seoul' }, monday), Date.UTC(2026, 10, 17, 0, 0) / 1000);
    assert.equal(nextFire({ frequency: 'weekly', time: '09:00', tz: 'Asia/Seoul', weekdays: [5] }, monday), Date.UTC(2026, 10, 20, 0, 0) / 1000);
    assert.equal(nextFire({ frequency: 'monthly', time: '09:00', tz: 'Asia/Seoul', day: 31 }, monday), Date.UTC(2026, 10, 30, 0, 0) / 1000);
    assert.equal(nextFire({ frequency: 'once', time: '09:00', tz: 'UTC', date: '2026-01-01' }, monday), null);
  });
});

describe('scheduled workflows survive a restart', () => {
  test('a schedule that fell due while the server was down fires once at start-up', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'chat-wf-'));
    try {
      let t = await startApp({ dataDir, keepData: true });
      const owner = await setupWorkspace(t);
      const general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.name === 'general').id;
      const saved = await owner.ok('client.workflows.save', {
        name: 'Standup',
        trigger: { type: 'schedule', schedule: { frequency: 'daily', time: '09:00', tz: 'UTC' } },
        steps: [{ id: 'say', type: 'message', destination: { to: 'channel', channel: general }, text: 'Standup time ({{trigger.time}})' }],
      });
      const published = (await owner.ok('client.workflows.publish', { workflow: saved.workflow.id })).workflow;
      assert.ok(published.next_run > Date.now() / 1000);
      await t.close();

      // While the server is down, the time passes.
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(join(dataDir, 'app.db'));
      db.prepare('UPDATE workflows SET next_run = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 60, saved.workflow.id);
      db.close();

      t = await startApp({ dataDir, keepData: true });
      const again = new Session(t.base);
      again.cookie = owner.cookie;
      const history = await until(async () => {
        const list = (await again.ok('client.workflows.runs', { workflow: saved.workflow.id })).runs;
        return list.length && list[0].status === 'completed' ? list : null;
      });
      await sleep(300);
      assert.equal((await again.ok('client.workflows.runs', { workflow: saved.workflow.id })).runs.length, 1);
      assert.equal(history[0].runner, null);
      assert.match((await again.ok('conversations.history', { channel: general, limit: 1 })).messages[0].text, /^Standup time/);
      const after = (await again.ok('client.workflows.get', { workflow: saved.workflow.id })).workflow;
      assert.ok(after.next_run > Date.now() / 1000, 'the next run moved on to tomorrow');
      await t.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
