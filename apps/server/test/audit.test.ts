import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';

describe('audit log', () => {
  let t: TestApp;
  let owner: Session;
  let mia: Session;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    mia = await addMember(t, owner, 'Mia Member');
  });
  after(() => t.close());

  test('changes and sign-ins are recorded with who, what and where; secrets are not', async () => {
    await owner.ok('client.admin.setRole', { user: mia.userId, role: 'admin' });
    await owner.ok('client.admin.setActive', { user: mia.userId, active: false });
    await owner.ok('client.admin.setActive', { user: mia.userId, active: true });
    const app = await owner.ok('client.apps.create', { name: 'Deploy Bot' });
    const rotated = await owner.ok('client.apps.rotateToken', { app: app.app.id, kind: 'bot' });
    await owner.ok('conversations.create', { name: 'audited' });
    const stranger = new Session(t.base);
    assert.equal((await stranger.call('client.signin', { email: 'owner@acme.test', password: 'wrong password!' })).ok, false);
    await owner.ok('client.admin.stats', { days: 7 }); // reading is not recorded

    const { entries } = await owner.ok('client.admin.audit.list', { limit: 50 });
    const actions = entries.map((entry: Json) => entry.action);
    for (const action of ['role_change_to_admin', 'user_deactivated', 'user_reactivated', 'app_installed', 'app_token_rotated', 'channel_created', 'user_login_failed']) {
      assert.ok(actions.includes(action), `${action} in ${actions.join(', ')}`);
    }
    assert.ok(!actions.includes('client.admin.stats'));
    const role = entries.find((entry: Json) => entry.action === 'role_change_to_admin');
    assert.deepEqual(role.actor, { type: 'user', user: { id: owner.userId, name: 'owner', email: 'owner@acme.test' } });
    assert.equal(role.entity.type, 'user');
    assert.equal(role.entity.user.id, mia.userId);
    assert.equal(role.context.ip_address, '127.0.0.1');
    const installed = entries.find((entry: Json) => entry.action === 'app_installed');
    assert.equal(installed.entity.app.id, app.app.id, 'a creation names what was created');
    const failed = entries.find((entry: Json) => entry.action === 'user_login_failed');
    assert.equal(failed.actor.user.id, owner.userId);
    assert.ok(!JSON.stringify(entries).includes(rotated.token), 'tokens never reach the log');
    assert.ok(!JSON.stringify(entries).includes('wrong password!'), 'passwords never reach the log');
  });

  test('admins only; the Audit Logs API shape with its own token, paged by cursor', async () => {
    const member = await addMember(t, owner, 'Bo Member');
    assert.equal((await member.call('client.admin.audit.list')).error, 'not_allowed');
    const { token } = await owner.ok('client.admin.auditToken');
    const get = async (query: string, bearer = token): Promise<{ status: number; body: Json }> => {
      const response = await fetch(`${t.base}/audit/v1/logs${query}`, { headers: { authorization: `Bearer ${bearer}` } });
      return { status: response.status, body: (await response.json()) as Json };
    };
    assert.equal((await get('', 'xoxp-nope')).status, 401);
    const first = await get('?limit=2');
    assert.equal(first.status, 200);
    assert.equal(first.body.entries.length, 2);
    assert.ok(first.body.response_metadata.next_cursor);
    const second = await get(`?limit=2&cursor=${first.body.response_metadata.next_cursor}`);
    assert.ok(Number(second.body.entries[0].id) < Number(first.body.entries[1].id));
    const filtered = await get('?action=user_deactivated');
    assert.ok(filtered.body.entries.length >= 1);
    assert.ok(filtered.body.entries.every((entry: Json) => entry.action === 'user_deactivated'));
    // The audit token is for reading the log only.
    const api = await fetch(`${t.base}/api/chat.postMessage`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ channel: '#general', text: 'x' }) });
    assert.equal(((await api.json()) as Json).error, 'missing_scope');
  });
});
