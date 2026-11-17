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

  test('apps.uninstall revokes the tokens', async () => {
    const row = t.app.ctx.db.get<{ client_id: string; client_secret: string }>('SELECT client_id, client_secret FROM apps WHERE id = ?', created.app.id)!;
    await bot.apps.uninstall({ client_id: row.client_id, client_secret: row.client_secret });
    await assert.rejects(bot.auth.test(), (error: Json) => error.data.error === 'invalid_auth');
  });
});
