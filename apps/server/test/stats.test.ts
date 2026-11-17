import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

describe('workspace analytics', () => {
  let t: TestApp;
  let owner: Session;
  let mia: Session;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    mia = await addMember(t, owner, 'Mia Member');
  });
  after(() => t.close());

  test('activity, posting and messages per day, channel and person', async () => {
    const boot = await owner.ok('client.boot');
    const general = boot.channels.find((channel: Json) => channel.is_general).id;
    await owner.ok('chat.postMessage', { channel: general, text: 'hello' });
    await owner.ok('chat.postMessage', { channel: general, text: 'again' });
    const dm = (await mia.ok('conversations.open', { users: owner.userId })).channel.id;
    await mia.ok('chat.postMessage', { channel: dm, text: 'psst' });
    const app = await owner.ok('client.apps.create', { name: 'Noisy Bot' });
    await fetch(`${t.base}/api/chat.postMessage`, { method: 'POST', headers: { authorization: `Bearer ${app.bot_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ channel: general, text: 'bots do not count' }) });

    assert.equal((await mia.call('client.admin.stats')).error, 'not_allowed');
    assert.equal((await owner.call('client.admin.stats', { days: 12 })).error, 'invalid_arguments');
    const stats = await owner.ok('client.admin.stats', { days: 7 });
    assert.equal(stats.series.length, 7);
    const today = stats.series.at(-1);
    assert.equal(today.day, new Date().toISOString().slice(0, 10));
    assert.deepEqual(today.messages, { public: 2, private: 0, direct: 1 });
    assert.equal(today.posting, 2);
    assert.equal(today.active, 2, 'posting makes a person active that day');
    assert.equal(stats.summary.members, 2);
    assert.equal(stats.summary.messages, 3);
    assert.equal(stats.summary.public_share, 67);
    const row = stats.channels.find((channel: Json) => channel.id === general);
    assert.equal(row.messages, 2);
    assert.equal(row.posters, 1);
    const me = stats.members.find((member: Json) => member.id === owner.userId);
    assert.equal(me.messages, 2);
    assert.equal(me.days_active, 1);
  });
});
