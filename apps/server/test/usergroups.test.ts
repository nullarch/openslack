import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, callWithToken, createBot, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';

describe('user groups', () => {
  let t: TestApp;
  let owner: Session;
  let mina: Session;
  let theo: Session;
  let general: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    mina = await addMember(t, owner, 'Mina Member');
    theo = await addMember(t, owner, 'Theo Third');
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
  });
  after(() => t.close());

  test('create, list and update in Slack’s shapes', async () => {
    const { channel: design } = await owner.ok('conversations.create', { name: 'design' });
    const created = await mina.ok('usergroups.create', { name: 'Designers', handle: '@design', description: 'Pixels', channels: design.id, include_count: true });
    const group = created.usergroup;
    assert.match(group.id, /^S/);
    assert.equal(group.handle, 'design');
    assert.equal(group.is_usergroup, true);
    assert.deepEqual(group.prefs, { channels: [design.id], groups: [] });
    assert.equal(group.user_count, 0);
    assert.equal(group.created_by, mina.userId);

    assert.equal((await mina.call('usergroups.create', { name: 'Designers', handle: 'other' })).error, 'name_already_exists');
    assert.equal((await mina.call('usergroups.create', { name: 'Other', handle: 'design' })).error, 'handle_already_exists');
    // A handle may not shadow a person's @name or a broadcast.
    assert.equal((await mina.call('usergroups.create', { name: 'Mina fans', handle: 'mina.member' })).error, 'handle_already_exists');
    assert.equal((await mina.call('usergroups.create', { name: 'All', handle: 'here' })).error, 'handle_already_exists');
    assert.equal((await mina.call('usergroups.create', { name: 'Bad', handle: 'two words' })).error, 'invalid_handle');

    const updated = await owner.ok('usergroups.update', { usergroup: group.id, description: 'Pixels and type' });
    assert.equal(updated.usergroup.description, 'Pixels and type');
    assert.equal(updated.usergroup.updated_by, owner.userId);
    assert.equal((await owner.call('usergroups.update', { usergroup: 'SNOPE000000' })).error, 'no_such_subteam');

    const bot = createBot(t, ['usergroups:read']);
    const listed = await callWithToken(t.base, bot.token, 'usergroups.list', { include_count: 'true', include_users: 'true' });
    assert.deepEqual(listed.usergroups.map((item: Json) => item.handle), ['design']);
    assert.deepEqual(listed.usergroups[0].users, []);
    assert.equal((await callWithToken(t.base, bot.token, 'usergroups.create', { name: 'X' })).error, 'missing_scope');
  });

  test('members: updating the list joins new members to the group’s channels and tells them', async () => {
    const group = (await owner.ok('usergroups.list')).usergroups[0];
    const minaStream = await mina.connect();
    const ownerStream = await owner.connect();
    const result = await owner.ok('usergroups.users.update', { usergroup: group.id, users: `${mina.userId},${theo.userId}`, include_count: true });
    assert.equal(result.usergroup.user_count, 2);
    const changed = await ownerStream.next((event) => event.type === 'subteam_members_changed');
    assert.deepEqual(changed.added_users.sort(), [mina.userId, theo.userId].sort());
    assert.equal(changed.added_users_count, '2');
    await minaStream.next((event) => event.type === 'subteam_self_added' && event.subteam_id === group.id);
    minaStream.close();
    ownerStream.close();
    // Both are now in #design, the group's default channel.
    const theoChannels = (await theo.ok('client.boot')).channels.map((channel: Json) => channel.name);
    assert.ok(theoChannels.includes('design'));
    assert.deepEqual((await theo.ok('usergroups.users.list', { usergroup: group.id })).users.sort(), [mina.userId, theo.userId].sort());

    assert.equal((await owner.call('usergroups.users.update', { usergroup: group.id, users: 'UNOPE000000' })).error, 'invalid_users');
    assert.equal((await owner.call('usergroups.users.update', { usergroup: group.id })).error, 'no_users_provided');
  });

  test('a group mention counts as a mention of each member', async () => {
    const group = (await owner.ok('usergroups.list')).usergroups[0];
    await owner.ok('chat.postMessage', { channel: general, text: `<!subteam^${group.id}|@design> review please` });
    const counts = async (session: Session): Promise<number> =>
      (await session.ok('client.counts')).channels.find((entry: Json) => entry.id === general).mention_count;
    assert.equal(await counts(mina), 1);
    assert.equal(await counts(theo), 1);
    assert.equal(await counts(owner), 0);

    // Rich text carries it as a usergroup element.
    const rich = [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'usergroup', usergroup_id: group.id }] }] }];
    await owner.ok('chat.postMessage', { channel: general, text: '@design', blocks: rich });
    assert.equal(await counts(mina), 2);

    // A disabled group reaches nobody.
    await owner.ok('usergroups.disable', { usergroup: group.id });
    await owner.ok('chat.postMessage', { channel: general, text: `<!subteam^${group.id}> anyone?` });
    assert.equal(await counts(mina), 2);
    assert.deepEqual((await owner.ok('usergroups.list')).usergroups, []);
    assert.equal((await owner.ok('usergroups.list', { include_disabled: true })).usergroups[0].date_delete > 0, true);
    await owner.ok('usergroups.enable', { usergroup: group.id });
    assert.equal((await mina.ok('client.boot')).usergroups.length, 1);
  });

  test('when only admins manage groups, members are refused', async () => {
    await owner.ok('client.admin.updateSettings', { who_can_manage_usergroups: 'admins' });
    const group = (await owner.ok('usergroups.list')).usergroups[0];
    assert.equal((await mina.call('usergroups.create', { name: 'Nope' })).error, 'permission_denied');
    assert.equal((await mina.call('usergroups.users.update', { usergroup: group.id, users: mina.userId })).error, 'permission_denied');
    assert.equal((await mina.call('usergroups.disable', { usergroup: group.id })).error, 'permission_denied');
    await mina.ok('usergroups.list');
  });
});
