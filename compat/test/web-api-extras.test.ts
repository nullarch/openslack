import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { after, before, describe, test } from 'node:test';
import { WebClient } from '@slack/web-api';
import { setupWorkspace, startApp, type Json, type Session, type TestApp } from '@app/server/test/helpers.ts';
import { recordTokenCalls, saveExercised } from './harness.ts';

const require = createRequire(import.meta.url);
const version = (name: string): string => (JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as { version: string }).version;

/** Smaller methods existing apps call, through the official client unmodified. */
describe('@slack/web-api: reactions.list, team.preferences.list, auth.teams.list, apps.event.authorizations.list, apps.uninstall', () => {
  let t: TestApp;
  let owner: Session;
  let bot: WebClient;
  let appLevel: WebClient;
  let created: Json;
  let called: Set<string>;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    called = recordTokenCalls(t);
    created = await owner.ok('client.apps.create', { name: 'Helper' });
    bot = new WebClient(created.bot_token, { slackApiUrl: `${t.base}/api/` });
    appLevel = new WebClient(created.app_token, { slackApiUrl: `${t.base}/api/` });
  });
  after(async () => {
    saveExercised('web-api-extras', `@slack/web-api ${version('@slack/web-api')}`, called, []);
    await t.close();
  });

  test('read-only methods answer in Slack’s shapes', async () => {
    const general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    const posted = await bot.chat.postMessage({ channel: general, text: 'deploy done' });
    await bot.reactions.add({ channel: general, timestamp: posted.ts!, name: 'white_check_mark' });
    const reactions = await bot.reactions.list({});
    assert.equal((reactions.items as Json[])[0].message.ts, posted.ts);
    const prefs = await bot.team.preferences.list();
    assert.equal(typeof prefs.msg_edit_window_mins, 'number');
    const teams = await bot.auth.teams.list();
    assert.equal((teams.teams as Json[]).length, 1);
    const context = `4-${Buffer.from(JSON.stringify({ et: 'message', tid: (teams.teams as Json[])[0].id, aid: created.app.id })).toString('base64url')}`;
    const authorizations = await appLevel.apps.event.authorizations.list({ event_context: context });
    assert.equal((authorizations.authorizations as Json[])[0].user_id, created.app.bot_user_id);
  });

  test('agents.sessions.setStatus and rename: an agent reports its work in a thread', async () => {
    const general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    await owner.ok('conversations.invite', { channel: general, users: created.app.bot_user_id }).catch(() => undefined);
    const parent = await owner.ok('chat.postMessage', { channel: general, text: 'please look at the build' });
    const set = await bot.agents.sessions.setStatus({ channel_id: general, thread_ts: parent.ts, status: 'processing', title: 'Build check' });
    assert.deepEqual([set.status, set.agent_status, set.title], ['processing', 'processing', 'Build check']);
    const renamed = await bot.agents.sessions.rename({ channel_id: general, thread_ts: parent.ts, title: 'Build check (green)' });
    assert.equal(renamed.title, 'Build check (green)');
  });

  test('workflows.featured.* and team.billing.info', async () => {
    const general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    await owner.ok('conversations.invite', { channel: general, users: created.app.bot_user_id }).catch(() => undefined);
    const saved = await owner.ok('client.workflows.save', { name: 'Request access', trigger: { type: 'link' }, steps: [{ id: 'say', type: 'message', destination: { to: 'trigger_channel' }, text: 'hi' }] });
    await owner.ok('client.workflows.publish', { workflow: saved.workflow.id });
    const triggerId = (await owner.ok('client.workflows.get', { workflow: saved.workflow.id })).workflow.trigger_id;
    await bot.workflows.featured.add({ channel_id: general, trigger_ids: [triggerId] });
    const listed = await bot.workflows.featured.list({ channel_ids: [general] });
    assert.deepEqual((listed.featured_workflows as Json[])[0].triggers, [{ id: triggerId, title: 'Request access' }]);
    await bot.workflows.featured.set({ channel_id: general, trigger_ids: [triggerId] });
    await bot.workflows.featured.remove({ channel_id: general, trigger_ids: [triggerId] });
    assert.deepEqual(((await bot.workflows.featured.list({ channel_ids: [general] })).featured_workflows as Json[])[0].triggers, []);
    assert.equal((await bot.team.billing.info({})).plan, 'plus');
  });

  test('agents.conversations.*: a code channel from a message, its context bar, views, commands and canvas, then archived', async () => {
    const general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    const ask = await owner.ok('chat.postMessage', { channel: general, text: 'Fix the flaky login test' });
    const created = await bot.agents.conversations.create({ name: '', origin_channel_id: general, origin_message_ts: ask.ts, session_id: 'sdk-1' });
    const channel = created.channel_id!;
    assert.match(channel, /^C/);
    assert.equal((await bot.agents.conversations.create({ name: 'again', session_id: 'sdk-1' })).channel_id, channel, 'idempotent by session_id');
    const status = await bot.agents.sessions.setStatus({ channel_id: channel, status: 'processing' });
    assert.equal(status.status, 'processing');
    assert.equal((await bot.agents.sessions.rename({ channel_id: channel, title: 'Fix login flake' })).title, 'Fix login flake');

    const props = await bot.agents.conversations.setProperties({
      channel_id: channel,
      code_channel: { context_bar_items: [{ key: 'branch', label: 'fix/login', icon: 'branch' }, { key: 'rerun', label: 'Re-run CI', item_type: 'action' }] },
      agent_resource: { url: 'https://git.example.com/acme/app/issues/7', title: 'Login flake' },
    });
    assert.equal(props.channel_id, channel);
    const info = await bot.conversations.info({ channel });
    const properties = (info.channel as Json).properties;
    assert.equal(properties.record_channel.record_type, 'agent_channel');
    assert.equal(properties.agent_session.title, 'Fix login flake');
    assert.deepEqual(properties.code_channel.context_bar_items.map((item: Json) => item.key), ['branch', 'rerun']);

    const html = await bot.agents.conversations.setView({ channel_id: channel, view_key: 'reports/coverage.html', content: '<h1>91%</h1>', csp: { resource_domains: ['https://cdn.example.com'] } });
    assert.deepEqual([html.type, html.content_version], ['html', 1]);
    await bot.agents.conversations.setView({ channel_id: channel, type: 'diff', content: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b\n', base_branch: 'main', head_branch: 'fix/login' });
    await bot.agents.conversations.setView({ channel_id: channel, type: 'block_kit', view_key: 'controls', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Deploy*' } }] });
    const canvas = await bot.canvases.create({ title: 'Plan', document_content: { type: 'markdown', markdown: '# Plan\n\nStep one.' } });
    const canvasView = await bot.agents.conversations.setView({ channel_id: channel, type: 'canvas', view_key: 'plan', canvas_id: canvas.canvas_id!, access_level: 'comment' });
    assert.equal(canvasView.canvas_id, canvas.canvas_id);
    const listed = await bot.agents.conversations.listViews({ channel_id: channel });
    assert.deepEqual(listed.views!.map((view) => view.label), ['coverage', 'Diff', 'controls', 'plan']);
    const removed = await bot.agents.conversations.removeView({ channel_id: channel, view_key: 'controls' });
    assert.equal(removed.channel_id, channel);

    const got = await bot.agents.conversations.getCanvas({ channel, canvas_id: canvas.canvas_id! });
    assert.equal(got.content, '# Plan\n\nStep one.');
    const same = await bot.agents.conversations.setCanvasContent({ channel, canvas_id: canvas.canvas_id!, content: '# Plan\n\nStep one.' });
    assert.equal(same.sections_changed_count, 0);
    const changed = await bot.agents.conversations.setCanvasContent({ channel, canvas_id: canvas.canvas_id!, content: '# Plan\n\nStep one, done.' });
    assert.equal(changed.sections_changed_count, 1);

    const commands = await bot.agents.conversations.setCommands({ channel_id: channel, commands: [{ name: 'create-pr', description: 'Open a pull request', argument_hint: '[title]' }] });
    assert.equal(commands.command_count, 1);
    await assert.rejects(bot.agents.conversations.setCommands({ channel_id: channel, commands: [{ name: 'remind', description: 'x' }] }), (error: Json) => error.data.error === 'colliding_with_builtin');

    const summary = await bot.chat.postMessage({ channel, text: 'Done: stable now.' });
    await bot.agents.conversations.archive({ channel_id: channel, summary_message_ts: summary.ts });
    assert.equal(((await bot.conversations.info({ channel })).channel as Json).is_archived, true);
    await assert.rejects(bot.agents.conversations.archive({ channel_id: channel }), (error: Json) => error.data.error === 'already_archived');
  });

  test('apps.uninstall revokes the tokens', async () => {
    const row = t.app.ctx.db.get<{ client_id: string; client_secret: string }>('SELECT client_id, client_secret FROM apps WHERE id = ?', created.app.id)!;
    await bot.apps.uninstall({ client_id: row.client_id, client_secret: row.client_secret });
    await assert.rejects(bot.auth.test(), (error: Json) => error.data.error === 'invalid_auth');
  });
});
