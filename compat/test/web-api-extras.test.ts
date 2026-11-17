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

  test('apps.uninstall revokes the tokens', async () => {
    const row = t.app.ctx.db.get<{ client_id: string; client_secret: string }>('SELECT client_id, client_secret FROM apps WHERE id = ?', created.app.id)!;
    await bot.apps.uninstall({ client_id: row.client_id, client_secret: row.client_secret });
    await assert.rejects(bot.auth.test(), (error: Json) => error.data.error === 'invalid_auth');
  });
});
