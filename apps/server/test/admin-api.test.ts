import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createToken } from '../src/core/auth.ts';
import { ADMIN_USER_SCOPES } from '../src/admin-api/index.ts';
import { addMember, callWithToken, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

describe("Slack's admin API", () => {
  let t: TestApp;
  let owner: Session;
  let mia: Session;
  let token: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    mia = await addMember(t, owner, 'Mia Member');
    // The token an OAuth install with admin user scopes gives an admin.
    token = createToken(t.app.ctx, { kind: 'user', userId: owner.userId, scopes: ADMIN_USER_SCOPES });
  });
  after(() => t.close());

  const admin = (method: string, args: Json = {}): Promise<Json> => callWithToken(t.base, token, method, args);

  test('users: list with paging, change roles, invite, remove', async () => {
    const first = await admin('admin.users.list', { limit: 1 });
    assert.equal(first.users.length, 1);
    assert.ok(first.response_metadata.next_cursor);
    const all = await admin('admin.users.list', { limit: 100 });
    const listed = all.users.find((user: Json) => user.id === mia.userId);
    assert.deepEqual([listed.is_admin, listed.is_active, listed.username], [false, true, 'mia.member']);
    assert.deepEqual(await admin('admin.users.setAdmin', { user_id: mia.userId }), { ok: true });
    assert.equal((await admin('admin.users.list')).users.find((user: Json) => user.id === mia.userId).is_admin, true);
    await admin('admin.users.setRegular', { user_id: mia.userId });
    assert.deepEqual(await admin('admin.users.invite', { email: 'new.person@acme.test', channel_ids: '' }), { ok: true });
    await admin('admin.users.remove', { user_id: mia.userId });
    assert.equal((await mia.call('auth.test')).error, 'invalid_auth');
    assert.equal((await admin('admin.users.remove', { user_id: owner.userId })).error, 'cannot_change_primary_owner');
  });

  test('conversations: search, rename, archive, set who can post, delete — private ones included', async () => {
    const secret = (await owner.ok('conversations.create', { name: 'secret-plans', is_private: true })).channel.id;
    await owner.ok('conversations.leave', { channel: secret }).catch(() => undefined);
    const found = await admin('admin.conversations.search', { query: 'secret' });
    assert.equal(found.conversations[0].id, secret);
    assert.equal(found.conversations[0].is_private, true);
    await admin('admin.conversations.rename', { channel_id: secret, name: 'Old Plans' });
    assert.equal((await admin('admin.conversations.search', { query: 'old-plans' })).conversations[0].name, 'old-plans');
    await admin('admin.conversations.archive', { channel_id: secret });
    assert.equal((await admin('admin.conversations.archive', { channel_id: secret })).error, 'already_archived');
    await admin('admin.conversations.unarchive', { channel_id: secret });
    await admin('admin.conversations.setConversationPrefs', { channel_id: secret, prefs: JSON.stringify({ who_can_post: 'type:admin' }) });
    assert.equal(t.app.ctx.db.get<{ post_policy: string }>('SELECT post_policy FROM conversations WHERE id = ?', secret)!.post_policy, 'admins');
    await admin('admin.conversations.delete', { channel_id: secret });
    assert.equal((await admin('admin.conversations.search', { query: 'old-plans' })).conversations.length, 0);
    const general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    assert.equal((await admin('admin.conversations.delete', { channel_id: general })).error, 'cant_delete_general');
  });

  test('team settings; scopes and roles are both required', async () => {
    await admin('admin.teams.settings.setName', { name: 'Acme Corp' });
    assert.equal((await owner.ok('team.info')).team.name, 'Acme Corp');
    const ops = (await owner.ok('conversations.create', { name: 'ops' })).channel.id;
    await admin('admin.teams.settings.setDefaultChannels', { channel_ids: ops });
    const narrow = createToken(t.app.ctx, { kind: 'user', userId: owner.userId, scopes: ['admin.users:read'] });
    assert.equal((await callWithToken(t.base, narrow, 'admin.conversations.search')).error, 'missing_scope');
    const bo = await addMember(t, owner, 'Bo Member');
    const memberToken = createToken(t.app.ctx, { kind: 'user', userId: bo.userId, scopes: ADMIN_USER_SCOPES });
    assert.equal((await callWithToken(t.base, memberToken, 'admin.users.list')).error, 'not_allowed', 'a member with admin scopes is still a member');
    const { entries } = await owner.ok('client.admin.audit.list', { limit: 200 });
    assert.ok(entries.some((entry: Json) => entry.details.method === 'admin.conversations.delete'));
  });
});
