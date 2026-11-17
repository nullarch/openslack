import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, callWithToken, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';
import { asBot, botOk, createPlatformApp, type TestAppCredentials } from './platform-helpers.ts';

describe('smaller Web API methods', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let app: TestAppCredentials;
  let general: string;
  let secret: string;
  let ts: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    app = await createPlatformApp(owner, 'Helper');
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    secret = (await owner.ok('conversations.create', { name: 'board', is_private: true })).channel.id;
    ts = (await member.ok('chat.postMessage', { channel: general, text: 'ship it' })).ts;
    await owner.ok('reactions.add', { channel: general, timestamp: ts, name: 'rocket' });
    await owner.ok('reactions.add', { channel: general, timestamp: ts, name: 'tada' });
    const hidden = await owner.ok('chat.postMessage', { channel: secret, text: 'private' });
    await owner.ok('reactions.add', { channel: secret, timestamp: hidden.ts, name: 'eyes' });
  });
  after(() => t.close());

  test('reactions.list: what someone reacted to, once per message, only where the caller can read', async () => {
    const mine = await owner.ok('reactions.list', {});
    assert.equal(mine.items.length, 2);
    assert.equal(mine.items.find((item: Json) => item.channel === general).message.reactions.length, 2);
    const seenByMember = await member.ok('reactions.list', { user: owner.userId });
    assert.deepEqual(seenByMember.items.map((item: Json) => item.channel), [general]);
    const paged = await owner.ok('reactions.list', { limit: 1 });
    assert.equal(paged.items.length, 1);
    assert.ok(paged.response_metadata.next_cursor);
    assert.equal((await owner.call('reactions.list', { user: 'UNOBODY' })).error, 'user_not_found');
    assert.equal((await botOk(t.base, app, 'reactions.list', { user: owner.userId })).items.length, 1, 'a bot sees the public one');
  });

  test('stars: a starred message is saved for later, a starred conversation is in Starred', async () => {
    await member.ok('stars.add', { channel: general, timestamp: ts });
    assert.equal((await member.call('stars.add', { channel: general, timestamp: ts })).error, 'already_starred');
    await member.ok('stars.add', { channel: general });
    const listed = await member.ok('stars.list', {});
    assert.deepEqual(listed.items.map((item: Json) => item.type).sort(), ['channel', 'message']);
    assert.equal(listed.paging.total, 2);
    assert.equal((await member.ok('client.saved.list')).items.length, 1);
    await member.ok('stars.remove', { channel: general, timestamp: ts });
    await member.ok('stars.remove', { channel: general });
    assert.equal((await member.call('stars.remove', { channel: general })).error, 'not_starred');
    assert.equal((await member.call('stars.add', {})).error, 'no_item_specified');
    assert.equal((await member.call('stars.add', { channel: general, timestamp: 'yesterday' })).error, 'bad_timestamp');
    assert.equal((await asBot(t.base, app, 'stars.add', { channel: general })).error, 'missing_scope', 'user tokens only');
  });

  test('users.identity, auth.teams.list, team.preferences.list, migration.exchange', async () => {
    const identity = await owner.ok('users.identity');
    assert.equal(identity.user.id, owner.userId);
    assert.equal(identity.user.email, 'owner@acme.test');
    const team = (await owner.ok('team.info')).team;
    assert.deepEqual(identity.team.id, team.id);
    assert.deepEqual((await botOk(t.base, app, 'auth.teams.list')).teams, [{ name: team.name, id: team.id }]);
    const prefs = await botOk(t.base, app, 'team.preferences.list');
    assert.deepEqual(Object.keys(prefs).filter((key) => key !== 'ok').sort(), ['disable_file_uploads', 'display_real_names', 'msg_edit_window_mins', 'who_can_post_general']);
    assert.equal((await asBot(t.base, app, 'migration.exchange', { users: owner.userId })).error, 'not_enterprise_team');
  });

  test('admins: billable people, access logs and app changes', async () => {
    assert.equal((await member.call('team.billableInfo')).error, 'no_permission');
    const billable = (await owner.ok('team.billableInfo')).billable_info;
    assert.deepEqual(billable[member.userId], { billing_active: true });
    assert.equal(billable[app.botUserId], undefined, 'bots are not billed');
    const logins = (await owner.ok('team.accessLogs')).logins as Json[];
    assert.ok(logins.some((login) => login.user_id === member.userId && login.count >= 1 && login.date_first <= login.date_last));
    const logs = (await owner.ok('team.integrationLogs', { change_type: 'added' })).logs as Json[];
    assert.ok(logs.some((log) => log.app_id === app.id && log.app_type === 'Helper'));
    assert.equal((await asBot(t.base, app, 'team.accessLogs')).error, 'missing_scope');
  });

  test('apps.event.authorizations.list answers for an event this app received', async () => {
    const context = `4-${Buffer.from(JSON.stringify({ et: 'message', tid: (await owner.ok('team.info')).team.id, aid: app.id })).toString('base64url')}`;
    const listed = await callWithToken(t.base, app.appToken, 'apps.event.authorizations.list', { event_context: context });
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.equal(listed.authorizations[0].user_id, app.botUserId);
    const other = await createPlatformApp(owner, 'Other');
    assert.equal((await callWithToken(t.base, other.appToken, 'apps.event.authorizations.list', { event_context: context })).error, 'auth_mismatch');
    assert.equal((await callWithToken(t.base, app.appToken, 'apps.event.authorizations.list', { event_context: 'garbage' })).error, 'invalid_event_context');
    assert.equal((await asBot(t.base, app, 'apps.event.authorizations.list', { event_context: context })).error, 'missing_scope', 'an app-level token only');
  });

  test('apps.uninstall revokes every token of the app', async () => {
    const doomed = await createPlatformApp(owner, 'Short-lived');
    const row = t.app.ctx.db.get<{ client_id: string; client_secret: string }>('SELECT client_id, client_secret FROM apps WHERE id = ?', doomed.id)!;
    assert.equal((await asBot(t.base, doomed, 'apps.uninstall', { client_id: row.client_id, client_secret: 'wrong' })).error, 'bad_client_secret');
    assert.equal((await asBot(t.base, app, 'apps.uninstall', { client_id: row.client_id, client_secret: row.client_secret })).error, 'client_id_token_mismatch');
    await botOk(t.base, doomed, 'apps.uninstall', { client_id: row.client_id, client_secret: row.client_secret });
    assert.equal((await asBot(t.base, doomed, 'auth.test')).error, 'invalid_auth');
    assert.equal((await callWithToken(t.base, doomed.appToken, 'apps.connections.open')).error, 'invalid_auth');
  });
});
