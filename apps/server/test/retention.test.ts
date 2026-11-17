import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { getConv } from '../src/core/conversations.ts';
import { postMessage } from '../src/core/messages.ts';
import { addMember, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

const DAY = 86_400;
// One reference time for the whole file: computed per call, a second ticking over between posting and looking up gave a different ts.
const NOW = Math.floor(Date.now() / 1000);
const tsDaysAgo = (days: number, n = 0): string => `${String(NOW - days * DAY).padStart(10, '0')}.${String(n).padStart(6, '0')}`;

describe('retention', () => {
  let t: TestApp;
  let owner: Session;
  let general: string;
  let dm: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    const boot = await owner.ok('client.boot');
    general = boot.channels.find((channel: Json) => channel.is_general).id;
    const mia = await addMember(t, owner, 'Mia Member');
    dm = (await owner.ok('conversations.open', { users: mia.userId })).channel.id;
    const post = (channel: string, ts: string, text: string, threadTs: string | null = null): void => {
      postMessage(t.app.ctx, { conv: getConv(t.app.ctx, channel)!, userId: owner.userId, text, ts, threadTs, silent: true });
    };
    post(general, tsDaysAgo(100), 'very old');
    post(general, tsDaysAgo(95, 1), 'old thread parent');
    post(general, tsDaysAgo(94, 2), 'old reply', tsDaysAgo(95, 1));
    post(general, tsDaysAgo(2, 3), 'recent reply keeps the thread', tsDaysAgo(95, 1));
    post(general, tsDaysAgo(1), 'recent');
    post(dm, tsDaysAgo(40), 'dm from last month');
    await owner.ok('reactions.add', { channel: general, timestamp: tsDaysAgo(100), name: 'tada' });
  });
  after(() => t.close());

  test('only owners set it; a preview counts what would go', async () => {
    const mia = await addMember(t, owner, 'Admin Ann');
    await owner.ok('client.admin.setRole', { user: mia.userId, role: 'admin' });
    assert.equal((await mia.call('client.admin.setRetention', { retention: { messages_days: 30 } })).error, 'not_allowed');
    const preview = await owner.ok('client.admin.retention', { preview: { messages_days: 90, dm_days: 30 } });
    assert.deepEqual(preview.retention, { messages_days: 0, dm_days: null, files_days: 0 });
    assert.equal(preview.would_delete.messages, 4); // three channel messages past 90 days (one becomes a placeholder) and the DM
    assert.equal((await owner.call('client.admin.setRetention', { retention: { messages_days: -3 } })).error, 'invalid_retention');
  });

  test('messages past the limit go; a thread with newer replies keeps a placeholder', async () => {
    const set = await owner.ok('client.admin.setRetention', { retention: { messages_days: 90, dm_days: 30 } });
    assert.deepEqual(set.retention, { messages_days: 90, dm_days: 30, files_days: 0 });
    const texts = (await owner.ok('conversations.history', { channel: general, limit: 50 })).messages.map((m: Json) => m.text);
    assert.ok(!texts.includes('very old'));
    assert.ok(texts.includes('recent'));
    assert.ok(texts.includes('This message was deleted.'));
    const thread = (await owner.ok('conversations.replies', { channel: general, ts: tsDaysAgo(95, 1) })).messages.map((m: Json) => m.text);
    assert.deepEqual(thread, ['This message was deleted.', 'recent reply keeps the thread']);
    assert.equal((await owner.ok('conversations.history', { channel: dm })).messages.length, 0);
    assert.equal((await owner.ok('search.messages', { query: 'very old' })).messages.total, 0, 'gone from search too');
  });

  test('files past the limit are deleted with their bytes', async () => {
    const form = new FormData();
    form.set('channels', general);
    form.set('file', new Blob(['old bytes']), 'old.txt');
    const uploaded = await fetch(`${t.base}/api/files.upload`, { method: 'POST', headers: { cookie: owner.cookie, origin: t.base }, body: form }).then((r) => r.json() as Promise<Json>);
    assert.equal(uploaded.ok, true, JSON.stringify(uploaded));
    t.app.ctx.db.run('UPDATE files SET created = ? WHERE id = ?', Math.floor(Date.now() / 1000) - 10 * DAY, uploaded.file.id);
    await owner.ok('client.admin.setRetention', { retention: { messages_days: 90, dm_days: 30, files_days: 7 } });
    assert.equal((await owner.call('files.info', { file: uploaded.file.id })).error, 'file_not_found');
  });
});
