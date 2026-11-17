import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

describe('an organisation with several workspaces, and admin roles', () => {
  let t: TestApp;
  let owner: Session;
  let eng: Session; // will be in the Engineering workspace
  let sales: Session; // stays in the organisation's first workspace only
  let org: string;
  let engineering: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    eng = await addMember(t, owner, 'Erin Engineer');
    sales = await addMember(t, owner, 'Sam Sales');
    org = (await owner.ok('team.info')).team.id;
  });
  after(() => t.close());

  test('an admin creates a workspace; it is listed and has its own settings', async () => {
    assert.equal((await eng.call('admin.teams.create', { team_name: 'Engineering', team_domain: 'eng' })).error, 'not_allowed');
    engineering = (await owner.ok('admin.teams.create', { team_name: 'Engineering', team_domain: 'eng', team_description: 'Builders' })).team;
    assert.match(engineering, /^T[A-Z0-9]+$/);
    assert.equal((await owner.call('admin.teams.create', { team_name: 'Other', team_domain: 'eng' })).error, 'domain_taken');
    const teams = (await owner.ok('admin.teams.list')).teams as Json[];
    assert.deepEqual(teams.map((team) => team.id), [org, engineering]);
    const info = (await owner.ok('admin.teams.settings.info', { team_id: engineering })).team;
    assert.deepEqual([info.name, info.domain, info.description, info.enterprise_id], ['Engineering', 'eng', 'Builders', org]);
    await owner.ok('admin.teams.settings.setName', { team_id: engineering, name: 'Engineering Org' });
    assert.equal((await owner.ok('admin.teams.settings.info', { team_id: engineering })).team.name, 'Engineering Org');
  });

  test('people are added to a workspace; its channels are theirs alone, until a channel is made org-wide', async () => {
    await owner.ok('admin.users.assign', { team_id: engineering, user_id: eng.userId });
    assert.equal((await owner.call('admin.users.assign', { team_id: engineering, user_id: eng.userId })).error, 'user_already_team_member');
    assert.deepEqual(((await eng.ok('client.boot')).workspaces as Json[]).map((entry) => entry.id), [org, engineering]);
    assert.deepEqual(((await sales.ok('client.boot')).workspaces as Json[]).map((entry) => entry.id), [org]);
    const inEngineering = ((await owner.ok('admin.users.list', { team_id: engineering })).users as Json[]).map((user) => user.id).sort();
    assert.deepEqual(inEngineering, [owner.userId, eng.userId].sort());

    // Someone outside the workspace cannot create a channel in it.
    assert.equal((await sales.call('conversations.create', { name: 'sneaky', team_id: engineering })).error, 'team_not_found');
    const channel = (await eng.ok('conversations.create', { name: 'builds', team_id: engineering })).channel;
    assert.equal(channel.context_team_id, engineering);
    await eng.ok('chat.postMessage', { channel: channel.id, text: 'nightly build is green' });

    // Erin sees it; Sam does not find it anywhere.
    assert.ok(((await eng.ok('conversations.list', { limit: 200 })).channels as Json[]).some((entry) => entry.id === channel.id));
    assert.ok(!((await sales.ok('conversations.list', { limit: 200 })).channels as Json[]).some((entry) => entry.id === channel.id));
    assert.equal((await sales.call('conversations.info', { channel: channel.id })).error, 'channel_not_found');
    assert.equal((await sales.call('conversations.join', { channel: channel.id })).error, 'channel_not_found');
    assert.equal((await sales.ok('search.messages', { query: 'nightly' })).messages.total, 0);
    assert.equal((await eng.ok('search.messages', { query: 'nightly' })).messages.total, 1);
    // Listing one workspace's channels.
    const engList = ((await eng.ok('conversations.list', { team_id: engineering, limit: 200 })).channels as Json[]).map((entry) => entry.name);
    assert.deepEqual(engList, ['builds']);

    // Made org-wide: everyone sees it, in every workspace.
    await owner.ok('admin.conversations.setTeams', { channel_id: channel.id, org_channel: true });
    assert.deepEqual([...(await owner.ok('admin.conversations.getTeams', { channel_id: channel.id })).team_ids].sort(), [org, engineering].sort());
    const seen = (await sales.ok('conversations.info', { channel: channel.id })).channel;
    assert.equal(seen.is_org_shared, true);
    assert.deepEqual([...seen.shared_team_ids].sort(), [org, engineering].sort());
    // And back into the one workspace.
    await owner.ok('admin.conversations.setTeams', { channel_id: channel.id, target_team_ids: engineering });
    await owner.ok('conversations.archive', { channel: channel.id }).catch(() => undefined);
  });

  test('admin.conversations.create can put a channel in a workspace or make it org-wide', async () => {
    const local = (await owner.ok('admin.conversations.create', { name: 'eng-only', is_private: false, team_id: engineering })).channel_id;
    assert.deepEqual((await owner.ok('admin.conversations.getTeams', { channel_id: local })).team_ids, [engineering]);
    const everywhere = (await owner.ok('admin.conversations.create', { name: 'company-news', is_private: false, org_wide: true })).channel_id;
    assert.equal((await sales.ok('conversations.info', { channel: everywhere })).channel.is_org_shared, true);
  });

  test('removing someone from a workspace takes them out of its channels', async () => {
    const extra = await addMember(t, owner, 'Eve Extra');
    await owner.ok('admin.users.assign', { team_id: engineering, user_id: extra.userId });
    const room = (await owner.ok('conversations.create', { name: 'eng-room', team_id: engineering })).channel.id;
    await owner.ok('conversations.invite', { channel: room, users: extra.userId });
    await owner.ok('admin.users.remove', { team_id: engineering, user_id: extra.userId });
    assert.equal((await extra.call('conversations.info', { channel: room })).error, 'channel_not_found');
    assert.deepEqual(((await extra.ok('client.boot')).workspaces as Json[]).map((entry) => entry.id), [org]);
    // Without a workspace, admin.users.remove still deactivates.
    await owner.ok('admin.users.remove', { user_id: extra.userId });
    assert.equal((await owner.ok('users.info', { user: extra.userId })).user.deleted, true);
  });

  test('admin roles open parts of the administration to people who are not admins', async () => {
    const general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    const scratch = (await owner.ok('conversations.create', { name: 'scratch' })).channel.id;
    assert.equal((await sales.call('admin.conversations.archive', { channel_id: scratch })).error, 'not_allowed');
    assert.equal((await sales.call('admin.roles.addAssignments', { role_id: 'Rl01', entity_ids: org, user_ids: sales.userId })).error, 'not_allowed');

    // Channel Admin for the organisation: the channel methods open, the people methods do not.
    await owner.ok('admin.roles.addAssignments', { role_id: 'Rl01', entity_ids: org, user_ids: sales.userId });
    await sales.ok('admin.conversations.archive', { channel_id: scratch });
    assert.equal((await sales.call('admin.users.list')).error, 'not_allowed');
    assert.equal((await sales.call('admin.roles.listAssignments')).error, 'not_allowed');
    const listed = (await owner.ok('admin.roles.listAssignments', { role_ids: 'Rl01' })).role_assignments as Json[];
    assert.deepEqual(listed.map((entry) => [entry.role_id, entry.entity_id, entry.user_id]), [['Rl01', org, sales.userId]]);
    assert.equal(typeof listed[0]!.date_create, 'number');
    assert.ok(((await sales.ok('client.boot')).admin_roles as Json[]).some((entry) => entry.role_id === 'Rl01'));

    // User Admin held for one workspace: only calls naming that workspace.
    await owner.ok('admin.roles.addAssignments', { role_id: 'Rl03', entity_ids: engineering, user_ids: eng.userId });
    const newcomer = await addMember(t, owner, 'Nia Newcomer');
    await eng.ok('admin.users.assign', { team_id: engineering, user_id: newcomer.userId });
    assert.equal((await eng.call('admin.users.assign', { team_id: org, user_id: newcomer.userId })).error, 'not_allowed');
    assert.equal((await eng.call('admin.users.remove', { user_id: newcomer.userId })).error, 'not_allowed');

    // Role Admin manages roles, but cannot hand out Role Admin.
    await owner.ok('admin.roles.addAssignments', { role_id: 'Rl02', entity_ids: org, user_ids: eng.userId });
    await eng.ok('admin.roles.addAssignments', { role_id: 'Rl0L', entity_ids: org, user_ids: newcomer.userId });
    assert.equal((await eng.call('admin.roles.addAssignments', { role_id: 'Rl02', entity_ids: org, user_ids: newcomer.userId })).error, 'cannot_modify_role_admin');
    await newcomer.ok('client.admin.stats', { days: 7 });

    // Channel Manager for one channel makes its holder a manager of that channel.
    await owner.ok('admin.roles.addAssignments', { role_id: 'Rl0A', entity_ids: general, user_ids: newcomer.userId });
    assert.ok(((await owner.ok('conversations.info', { channel: general })).channel.managers as string[]).includes(newcomer.userId));
    await owner.ok('admin.roles.removeAssignments', { role_id: 'Rl0A', entity_ids: general, user_ids: newcomer.userId });
    assert.ok(!(((await owner.ok('conversations.info', { channel: general })).channel.managers as string[] | undefined) ?? []).includes(newcomer.userId));

    // Errors in Slack's words.
    assert.equal((await owner.call('admin.roles.addAssignments', { role_id: 'Rl99', entity_ids: org, user_ids: sales.userId })).error, 'invalid_role_id');
    assert.equal((await owner.call('admin.roles.addAssignments', { role_id: 'Rl09', entity_ids: engineering, user_ids: sales.userId })).error, 'no_valid_entities');

    // Deactivated people keep no roles.
    await owner.ok('admin.users.remove', { user_id: newcomer.userId });
    assert.ok(!((await owner.ok('admin.roles.listAssignments')).role_assignments as Json[]).some((entry) => entry.user_id === newcomer.userId));
  });
});
