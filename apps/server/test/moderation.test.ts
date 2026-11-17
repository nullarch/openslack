import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

describe('reporting messages and hiding people', () => {
  let t: TestApp;
  let owner: Session;
  let mia: Session;
  let bo: Session;
  let general: string;
  let ts: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    mia = await addMember(t, owner, 'Mia Member');
    bo = await addMember(t, owner, 'Bo Member');
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    for (const session of [mia, bo]) await session.ok('conversations.join', { channel: general });
    ts = (await bo.ok('chat.postMessage', { channel: general, text: 'buy cheap pills at example.test' })).ts;
  });
  after(() => t.close());

  test('members report once; admins are told and see one entry per message', async () => {
    const stream = await owner.connect();
    assert.deepEqual(await mia.ok('client.messages.report', { channel: general, ts, reason: 'spam', note: 'link farm' }), { ok: true, reported: true });
    const told = await stream.next((event) => event.type === 'message_reported');
    assert.equal(told.report.reason, 'spam: link farm');
    stream.close();
    await mia.ok('client.messages.report', { channel: general, ts, reason: 'spam' }); // a second time changes nothing
    await owner.ok('client.messages.report', { channel: general, ts, reason: 'inappropriate' });
    assert.equal((await bo.call('client.messages.report', { channel: general, ts })).error, 'cannot_report_own_message');
    assert.equal((await mia.call('client.messages.report', { channel: general, ts, reason: 'boring' })).error, 'invalid_reason');
    assert.equal((await mia.call('client.admin.reports.list')).error, 'not_allowed');

    const list = await owner.ok('client.admin.reports.list');
    assert.equal(list.open, 1);
    assert.equal(list.reports.length, 1);
    assert.equal(list.reports[0].reports, 2);
    assert.equal(list.reports[0].excerpt, 'buy cheap pills at example.test');
    assert.equal(list.reports[0].author, bo.userId);
  });

  test('removing the message settles every report about it', async () => {
    const report = (await owner.ok('client.admin.reports.list')).reports[0];
    const resolved = await owner.ok('client.admin.reports.resolve', { report: report.id, action: 'remove' });
    assert.equal(resolved.report.status, 'removed');
    assert.equal(resolved.report.message_exists, false);
    assert.equal((await owner.ok('client.admin.reports.list')).open, 0);
    assert.equal((await owner.ok('client.admin.reports.list', { status: 'removed' })).reports[0].reports, 2);
    const history = (await owner.ok('conversations.history', { channel: general })).messages.map((m: Json) => m.text);
    assert.ok(!history.includes('buy cheap pills at example.test'));
  });

  test('hiding a person is kept per viewer', async () => {
    const result = await mia.ok('client.users.setHidden', { user: bo.userId, hidden: true });
    assert.deepEqual(result.hidden_users, [bo.userId]);
    assert.equal((await mia.call('client.users.setHidden', { user: mia.userId })).error, 'user_not_found');
    const after = await mia.ok('client.users.setHidden', { user: bo.userId, hidden: false });
    assert.deepEqual(after.hidden_users, []);
  });
});
