import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';

describe('session management', () => {
  let t: TestApp;
  let owner: Session;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
  });
  after(() => t.close());

  const signIn = async (email: string, password: string, agent: string): Promise<Session> => {
    const session = new Session(t.base);
    const response = await fetch(`${t.base}/api/client.signin`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': agent, origin: t.base }, body: JSON.stringify({ email, password }) });
    session.cookie = response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
    session.userId = ((await response.json()) as Json).user_id ?? '';
    return session;
  };

  test('people see where they are signed in and sign out other browsers, which disconnect at once', async () => {
    const mia = await addMember(t, owner, 'Mia Member');
    const phone = await signIn('mia.member@acme.test', 'another long password', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1');
    assert.equal((await phone.call('auth.test')).ok, true);
    const { sessions } = await mia.ok('client.sessions.list');
    assert.equal(sessions.length, 2);
    assert.equal(sessions.filter((entry: Json) => entry.current).length, 1);
    const other = sessions.find((entry: Json) => !entry.current);
    assert.equal(other.device, 'Safari on iOS');
    assert.equal(other.ip, '127.0.0.1');
    assert.equal((await mia.call('client.sessions.revoke', { id: sessions.find((entry: Json) => entry.current).id })).error, 'cannot_revoke_current');

    const stream = await phone.connect();
    await mia.ok('client.sessions.revoke', { id: other.id });
    assert.equal(await stream.closed, 4401, 'the live connection of that browser is closed');
    assert.equal((await phone.call('auth.test')).error, 'invalid_auth');
    assert.equal((await mia.ok('client.sessions.list')).sessions.length, 1);

    const again = await signIn('mia.member@acme.test', 'another long password', 'curl/8');
    assert.equal((await mia.ok('client.sessions.revokeOthers')).revoked, 1);
    assert.equal((await again.call('auth.test')).error, 'invalid_auth');
    assert.equal((await mia.call('auth.test')).ok, true, 'this browser stays signed in');
  });

  test('admins sign a person out everywhere; owners can sign everyone out; the workspace sets the length', async () => {
    const bo = await addMember(t, owner, 'Bo Member');
    const admin = await addMember(t, owner, 'Ada Admin');
    await owner.ok('client.admin.setRole', { user: admin.userId, role: 'admin' });
    assert.equal((await admin.call('admin.users.session.reset', { user_id: owner.userId })).error, 'not_allowed', 'admins cannot sign out owners');
    await admin.ok('admin.users.session.reset', { user_id: bo.userId });
    assert.equal((await bo.call('auth.test')).error, 'invalid_auth');
    assert.equal((await admin.call('client.admin.sessions.resetAll')).error, 'not_allowed');
    await owner.ok('client.admin.sessions.resetAll');
    assert.equal((await admin.call('auth.test')).error, 'invalid_auth');
    assert.equal((await owner.call('auth.test')).ok, true);

    await owner.ok('client.admin.setSessionDuration', { days: 7 });
    const fresh = await signIn('owner@acme.test', 'correct horse battery', 'test');
    const row = (await fresh.ok('client.sessions.list')).sessions.find((entry: Json) => entry.current);
    assert.equal(row.expires - row.created, 7 * 86_400);
    assert.equal((await owner.call('client.admin.setSessionDuration', { days: 0 })).error, 'invalid_arguments');
    const { entries } = await owner.ok('client.admin.audit.list');
    assert.ok(entries.some((entry: Json) => entry.action === 'user_session_reset'));
  });
});
