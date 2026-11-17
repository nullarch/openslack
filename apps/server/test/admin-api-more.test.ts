import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createToken } from '../src/core/auth.ts';
import { ADMIN_USER_SCOPES } from '../src/admin-api/index.ts';
import { addMember, callWithToken, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';

describe("more of Slack's admin API", () => {
  let t: TestApp;
  let owner: Session;
  let mia: Session;
  let token: string;
  let teamId: string;
  const admin = (method: string, args: Json = {}): Promise<Json> => callWithToken(t.base, token, method, args);

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    mia = await addMember(t, owner, 'Mia Member');
    token = createToken(t.app.ctx, { kind: 'user', userId: owner.userId, scopes: ADMIN_USER_SCOPES });
    teamId = (await owner.ok('team.info')).team.id;
  });
  after(() => t.close());

  test('sessions: list, invalidate one, per-person length, reset in bulk', async () => {
    const listed = await admin('admin.users.session.list', { user_id: mia.userId, team_id: teamId });
    assert.ok(listed.active_sessions.length >= 1);
    const session = listed.active_sessions[0];
    assert.equal(typeof session.session_id, 'number');
    assert.equal(session.team_id, teamId);
    assert.equal((await admin('admin.users.session.list', { user_id: mia.userId })).error, 'missing_team');
    await admin('admin.users.session.invalidate', { user_id: mia.userId, session_id: session.session_id });
    assert.equal((await admin('admin.users.session.invalidate', { user_id: mia.userId, session_id: session.session_id })).error, 'session_not_found');

    assert.equal((await admin('admin.users.session.setSettings', { user_ids: [mia.userId] })).error, 'at_least_one_session_setting_required');
    assert.equal((await admin('admin.users.session.setSettings', { user_ids: [mia.userId], duration: 60 })).error, 'invalid_arguments');
    assert.equal((await admin('admin.users.session.setSettings', { user_ids: [mia.userId], duration: 86_400, desktop_app_browser_quit: true })).ok, true);
    const settings = await admin('admin.users.session.getSettings', { user_ids: [mia.userId, owner.userId] });
    assert.deepEqual(settings.session_settings, [{ user_id: mia.userId, desktop_app_browser_quit: true, duration: 86_400 }]);
    assert.deepEqual(settings.no_settings_applied, [owner.userId]);
    // The next sign-in follows them: a browser-session cookie, a one-day session.
    const signin = await fetch(`${t.base}/api/client.signin`, { method: 'POST', headers: { 'content-type': 'application/json', origin: t.base }, body: JSON.stringify({ email: 'mia.member@acme.test', password: 'another long password' }) });
    assert.equal(((await signin.json()) as Json).ok, true);
    const sessionCookie = (signin.headers.getSetCookie?.() ?? [signin.headers.get('set-cookie') ?? '']).find((value) => !value.includes('Max-Age=0')) ?? '';
    assert.ok(sessionCookie.includes('='), 'a session cookie');
    assert.doesNotMatch(sessionCookie, /Max-Age/, 'ends when the browser closes');
    const newest = t.app.ctx.db.get<{ created: number; expires: number }>('SELECT created, expires FROM sessions WHERE user_id = ? ORDER BY created DESC LIMIT 1', mia.userId)!;
    assert.equal(newest.expires - newest.created, 86_400, 'a one-day session');
    await admin('admin.users.session.clearSettings', { user_ids: [mia.userId] });
    assert.deepEqual((await admin('admin.users.session.getSettings', { user_ids: [mia.userId] })).session_settings, []);

    await admin('admin.users.session.resetBulk', { user_ids: [mia.userId] });
    assert.equal((await mia.call('auth.test')).error, 'invalid_auth');
    // Mia signs in again for the tests that follow.
    const again = new Session(t.base);
    again.userId = (await again.ok('client.signin', { email: 'mia.member@acme.test', password: 'another long password' })).user_id;
    mia = again;
  });

  test('guest expiry', async () => {
    const { invite } = await owner.ok('client.invites.create', { email: 'gus@acme.test', guest: 'multi', channels: (await owner.ok('client.boot')).channels.find((c: Json) => c.is_general).id });
    const gus = new Session(t.base);
    const gusId = (await gus.ok('client.signup', { code: invite.code, email: 'gus@acme.test', password: 'a guest password', real_name: 'Gus' })).user_id;
    assert.equal((await admin('admin.users.getExpiration', { user_id: owner.userId })).error, 'user_is_not_guest');
    const at = Math.floor(Date.now() / 1000) + 86_400 * 7;
    await admin('admin.users.setExpiration', { user_id: gusId, expiration_ts: at });
    const read = await admin('admin.users.getExpiration', { user_id: gusId });
    assert.deepEqual(read.user, { id: gusId, email: 'gus@acme.test', is_restricted: true, is_ultra_restricted: false, expiration_ts: at });
    assert.equal((await admin('admin.users.setExpiration', { user_id: gusId, expiration_ts: 5 })).error, 'failed_to_validate_expiration');
  });

  test('custom emoji listed and renamed; aliases follow', async () => {
    t.app.ctx.db.run("INSERT INTO emoji (name, storage_key, mimetype, created_by, created) VALUES ('shipit', 'x', 'image/png', ?, 1700000000)", owner.userId);
    t.app.ctx.db.run("INSERT INTO emoji (name, alias_for, created_by, created) VALUES ('ship', 'shipit', ?, 1700000001)", owner.userId);
    const listed = await admin('admin.emoji.list', { limit: 1 });
    assert.equal(Object.keys(listed.emoji).length, 1);
    assert.ok(listed.response_metadata.next_cursor);
    await admin('admin.emoji.rename', { name: ':shipit:', new_name: 'ship-it' });
    const all = (await admin('admin.emoji.list', {})).emoji;
    assert.deepEqual(Object.keys(all).sort(), ['ship', 'ship-it']);
    assert.equal(all.ship.url, 'alias:ship-it');
    assert.equal((await admin('admin.emoji.rename', { name: 'nope', new_name: 'x' })).error, 'error_invalid_emoji_to_rename');
    assert.equal((await admin('admin.emoji.rename', { name: 'ship', new_name: 'ship-it' })).error, 'error_name_taken');
  });

  test('the workspace: admins, owners, settings, description and discoverability', async () => {
    await owner.ok('client.admin.setRole', { user: mia.userId, role: 'admin' });
    assert.deepEqual((await admin('admin.teams.admins.list', { team_id: teamId })).admin_ids, [mia.userId]);
    assert.deepEqual((await admin('admin.teams.owners.list', { team_id: teamId })).owner_ids, [owner.userId]);
    assert.equal((await admin('admin.teams.owners.list', { team_id: 'T000' })).error, 'team_not_found');
    await admin('admin.teams.settings.setDescription', { team_id: teamId, description: 'Where Acme talks' });
    await admin('admin.teams.settings.setDiscoverability', { team_id: teamId, discoverability: 'closed' });
    assert.equal((await admin('admin.teams.settings.setDiscoverability', { team_id: teamId, discoverability: 'loud' })).error, 'discoverability_setting_invalid');
    const info = (await admin('admin.teams.settings.info', { team_id: teamId })).team;
    assert.deepEqual([info.id, info.description, info.discoverability], [teamId, 'Where Acme talks', 'closed']);
    const teams = (await admin('admin.teams.list')).teams;
    assert.deepEqual([teams[0].id, teams[0].discoverability, teams[0].primary_owner.user_id], [teamId, 'closed', owner.userId]);
    await owner.ok('client.admin.setRole', { user: mia.userId, role: 'member' });
  });

  test('user groups: default channels added, listed and removed', async () => {
    const group = (await owner.ok('usergroups.create', { name: 'Design', handle: 'design' })).usergroup.id;
    const a = (await owner.ok('conversations.create', { name: 'design-crit' })).channel.id;
    const b = (await owner.ok('conversations.create', { name: 'design-private', is_private: true })).channel.id;
    await admin('admin.usergroups.addChannels', { usergroup_id: group, channel_ids: [a, b] });
    const listed = await admin('admin.usergroups.listChannels', { usergroup_id: group, include_num_members: true });
    assert.deepEqual(listed.channels.map((c: Json) => c.id), [a, b]);
    assert.equal(listed.channels[0].num_members, 1);
    const bad = await admin('admin.usergroups.addChannels', { usergroup_id: group, channel_ids: ['CNOPE'] });
    assert.deepEqual([bad.error, bad.invalid_channels], ['channel_not_found', ['CNOPE']]);
    await admin('admin.usergroups.removeChannels', { usergroup_id: group, channel_ids: [a] });
    assert.deepEqual((await admin('admin.usergroups.listChannels', { usergroup_id: group })).channels.map((c: Json) => c.id), [b]);
  });

  test('channels: create, invite, prefs, convert to public, lookup quiet ones', async () => {
    const created = await admin('admin.conversations.create', { name: 'Incident 42', is_private: true, team_id: teamId, description: 'Status of incident 42' });
    assert.ok(created.channel_id);
    assert.equal((await admin('admin.conversations.create', { name: 'x', is_private: false })).error, 'team_id_or_org_required');
    await admin('admin.conversations.invite', { channel_id: created.channel_id, user_ids: [mia.userId] });
    assert.equal((await mia.ok('conversations.info', { channel: created.channel_id })).channel.purpose.value, 'Status of incident 42');
    const prefs = await admin('admin.conversations.getConversationPrefs', { channel_id: created.channel_id });
    assert.deepEqual(prefs.prefs.who_can_post, { type: [], user: [] });
    await admin('admin.conversations.convertToPublic', { channel_id: created.channel_id });
    assert.equal((await owner.ok('conversations.info', { channel: created.channel_id })).channel.is_private, false);
    const quiet = await admin('admin.conversations.lookup', { team_ids: [teamId], last_message_activity_before: Math.floor(Date.now() / 1000) + 60, max_member_count: 1 });
    assert.ok(Array.isArray(quiet.channels));
    assert.equal((await admin('admin.conversations.lookup', { team_ids: ['T000'], last_message_activity_before: 1 })).error, 'no_valid_teams');
  });

  test('decided invite requests', async () => {
    // Requests come from people who may not invite directly; made here as such a request would be stored.
    const ask = (id: string, email: string): void => {
      t.app.ctx.db.run("INSERT INTO invite_requests (id, email, reason, requested_by, created) VALUES (?, ?, 'joins Monday', ?, ?)", id, email, mia.userId, Math.floor(Date.now() / 1000));
    };
    ask('IrANN0001', 'ann@acme.test');
    ask('IrBOB0001', 'bob@elsewhere.test');
    await owner.ok('client.admin.inviteRequests.approve', { id: 'IrANN0001' });
    await owner.ok('client.admin.inviteRequests.deny', { id: 'IrBOB0001' });
    const approved = await admin('admin.inviteRequests.approved.list');
    assert.equal(approved.approved_requests[0].invite_request.email, 'ann@acme.test');
    assert.equal(approved.approved_requests[0].approved_by.actor_id, owner.userId);
    const denied = await admin('admin.inviteRequests.denied.list');
    assert.deepEqual([denied.denied_requests[0].invite_request.email, denied.denied_requests[0].denied_by.actor_id], ['bob@elsewhere.test', owner.userId]);
  });
});
