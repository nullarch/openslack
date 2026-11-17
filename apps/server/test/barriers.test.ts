import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createToken } from '../src/core/auth.ts';
import { ADMIN_USER_SCOPES } from '../src/admin-api/index.ts';
import { addMember, callWithToken, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

describe('information barriers', () => {
  let t: TestApp;
  let owner: Session;
  let ana: Session;
  let ben: Session;
  let carl: Session;
  let token: string;
  let research: string;
  let sales: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    ana = await addMember(t, owner, 'Ana Research');
    ben = await addMember(t, owner, 'Ben Sales');
    carl = await addMember(t, owner, 'Carl Other');
    research = (await owner.ok('usergroups.create', { name: 'Research', handle: 'research', users: ana.userId })).usergroup.id;
    sales = (await owner.ok('usergroups.create', { name: 'Sales', handle: 'sales', users: ben.userId })).usergroup.id;
    token = createToken(t.app.ctx, { kind: 'user', userId: owner.userId, scopes: ADMIN_USER_SCOPES });
  });
  after(() => t.close());

  const admin = (method: string, args: Json = {}): Promise<Json> => callWithToken(t.base, token, method, args);

  test('people across a barrier cannot open, write in or call a direct conversation', async () => {
    const dm = (await ana.ok('conversations.open', { users: ben.userId })).channel.id;
    const created = await admin('admin.barriers.create', { primary_usergroup_id: research, barriered_from_usergroup_ids: sales, restricted_subjects: 'im,mpim,call' });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.deepEqual(created.barrier.barriered_from_usergroups, [{ id: sales, name: 'Sales' }]);
    assert.equal((await admin('admin.barriers.create', { primary_usergroup_id: research, barriered_from_usergroup_ids: sales })).error, 'barrier_already_exists');

    const refused = await ben.call('conversations.open', { users: ana.userId });
    assert.equal(refused.error, 'restricted_action');
    assert.equal(refused.detail, 'information_barrier');
    assert.equal((await ana.call('conversations.open', { users: `${ben.userId},${carl.userId}` })).error, 'restricted_action');
    assert.equal((await ana.call('chat.postMessage', { channel: dm, text: 'still there?' })).error, 'restricted_action', 'an existing DM is closed to writing');
    assert.equal((await ana.call('client.huddles.join', { channel: dm })).detail, 'information_barrier');
    assert.equal((await ana.ok('conversations.open', { users: carl.userId })).ok, true, 'others are not affected');
    // A shared channel is not a direct conversation: barriers cover DMs, group DMs and calls.
    const general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    assert.equal((await ana.call('chat.postMessage', { channel: general, text: 'hello all' })).ok, true);
  });

  test('changing what it restricts, or the groups, changes who is kept apart', async () => {
    const { barriers } = await admin('admin.barriers.list');
    assert.equal(barriers.length, 1);
    await admin('admin.barriers.update', { barrier_id: barriers[0].id, restricted_subjects: 'call' });
    assert.equal((await ana.ok('conversations.open', { users: ben.userId })).ok, true, 'only calls are restricted now');
    await admin('admin.barriers.update', { barrier_id: barriers[0].id, restricted_subjects: 'im,mpim,call' });
    await owner.ok('usergroups.users.update', { usergroup: sales, users: carl.userId });
    assert.equal((await ana.ok('conversations.open', { users: ben.userId })).ok, true, 'Ben left Sales');
    assert.equal((await ana.call('conversations.open', { users: carl.userId })).error, 'restricted_action', 'Carl joined it');
    await admin('admin.barriers.delete', { barrier_id: barriers[0].id });
    assert.equal((await ana.ok('conversations.open', { users: carl.userId })).ok, true);
    assert.equal((await ana.call('admin.barriers.list')).error, 'not_allowed');
  });
});
