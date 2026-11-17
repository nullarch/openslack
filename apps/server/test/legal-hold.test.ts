import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { getConv } from '../src/core/conversations.ts';
import { postMessage } from '../src/core/messages.ts';
import { sweepRetention } from '../src/retention/index.ts';
import { addMember, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

/** Read the entries of a zip (stored or deflated) into memory. */
function unzip(bytes: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end -= 1;
  let offset = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i += 1) {
    const method = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return out;
}

describe('legal hold and eDiscovery', () => {
  let t: TestApp;
  let owner: Session;
  let mia: Session;
  let general: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    mia = await addMember(t, owner, 'Mia Member');
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
  });
  after(() => t.close());

  test('only owners manage holds', async () => {
    const admin = await addMember(t, owner, 'Ada Admin');
    await owner.ok('client.admin.setRole', { user: admin.userId, role: 'admin' });
    assert.equal((await admin.call('client.admin.holds.list')).error, 'not_allowed');
    assert.equal((await fetch(`${t.base}/admin/discovery.zip?users=${mia.userId}`, { headers: { cookie: admin.cookie } })).status, 404);
  });

  test('under hold, edits, deletions and deleted files are kept, retention skips, and the export has it all', async () => {
    const hold = (await owner.ok('client.admin.holds.create', { name: 'Case 42', users: [mia.userId] })).hold;
    assert.equal(hold.is_active, true);
    const first = await mia.ok('chat.postMessage', { channel: general, text: 'the original wording' });
    await mia.ok('chat.update', { channel: general, ts: first.ts, text: 'a softer wording' });
    const second = await mia.ok('chat.postMessage', { channel: general, text: 'regrettable message' });
    await mia.ok('chat.delete', { channel: general, ts: second.ts });

    const form = new FormData();
    form.set('channels', general);
    form.set('file', new Blob(['contract terms v1']), 'contract.txt');
    const uploaded = (await (await fetch(`${t.base}/api/files.upload`, { method: 'POST', headers: { cookie: mia.cookie, origin: t.base }, body: form })).json()) as Json;
    await mia.ok('files.delete', { file: uploaded.file.id });

    // Old messages by Mia survive a retention sweep while the hold lasts.
    const longAgo = `${String(Math.floor(Date.now() / 1000) - 400 * 86_400).padStart(10, '0')}.000100`;
    postMessage(t.app.ctx, { conv: getConv(t.app.ctx, general)!, userId: mia.userId, text: 'from last year', ts: longAgo, silent: true });
    await sweepRetention(t.app.ctx, { messages_days: 30, dm_days: null, files_days: 0 });
    assert.ok(t.app.ctx.db.get('SELECT 1 FROM messages WHERE ts = ?', longAgo), 'held messages are not swept');

    const response = await fetch(`${t.base}/admin/discovery.zip?users=${mia.userId}`, { headers: { cookie: owner.cookie } });
    assert.equal(response.status, 200);
    const files = unzip(Buffer.from(await response.arrayBuffer()));
    const lines = files.get('messages.ndjson')!.toString().trim().split('\n').map((line) => JSON.parse(line) as Json);
    assert.ok(lines.some((line) => line.type === 'message' && line.text === 'a softer wording'));
    assert.ok(lines.some((line) => line.type === 'kept_version' && line.change === 'edited' && line.text === 'the original wording'));
    assert.ok(lines.some((line) => line.type === 'kept_version' && line.change === 'deleted' && line.text === 'regrettable message'));
    assert.ok(lines.some((line) => line.text === 'from last year'));
    assert.equal(files.get(`files/${uploaded.file.id}/contract.txt`)?.toString(), 'contract terms v1', 'the deleted file is in the export');
    const manifest = JSON.parse(files.get('manifest.json')!.toString()) as Json;
    assert.deepEqual(manifest.criteria.users, [mia.userId]);

    await owner.ok('client.admin.holds.release', { hold: hold.id });
    await sweepRetention(t.app.ctx, { messages_days: 30, dm_days: null, files_days: 0 });
    assert.equal(t.app.ctx.db.get('SELECT 1 FROM messages WHERE ts = ?', longAgo), undefined, 'released: retention applies again');
    const { entries } = await owner.ok('client.admin.audit.list');
    assert.ok(entries.some((entry: Json) => entry.action === 'discovery_export'));
  });
});
