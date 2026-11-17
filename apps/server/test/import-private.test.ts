import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { importSlackExport, type ImportReport } from '../src/importer/slack-export.ts';
import { addMember, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

const DAY = 1_705_300_000; // 2024-01-15
const ts = (n: number): string => `${DAY + n}.000${String(n).padStart(3, '0')}`;

/**
 * A full export (Business+ and Enterprise Grid plans) as Slack documents it:
 * private channels in groups.json, group DMs in mpims.json with folders named
 * after them (mpdm-…), DMs in dms.json with folders named by id.
 */
function writeExport(root: string): void {
  const write = (name: string, value: unknown): void => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), JSON.stringify(value));
  };
  write('users.json', [
    { id: 'UOLDOWNER1', name: 'olive', real_name: 'Olive Owner', is_owner: true, profile: { email: 'owner@acme.test' } },
    { id: 'UANNA00001', name: 'anna', real_name: 'Anna Ito', profile: { email: 'anna@acme.test' } },
    { id: 'UBEN000001', name: 'ben', real_name: 'Ben Park', profile: { email: 'ben@acme.test' } },
  ]);
  write('channels.json', [{ id: 'CGENERAL01', name: 'general', created: DAY - 1000, creator: 'UOLDOWNER1', is_general: true, members: ['UOLDOWNER1', 'UANNA00001', 'UBEN000001'] }]);
  write('groups.json', [
    {
      id: 'GLEAD00001',
      name: 'leadership',
      created: DAY - 900,
      creator: 'UOLDOWNER1',
      is_archived: false,
      members: ['UOLDOWNER1', 'UANNA00001'],
      topic: { value: 'Board prep', creator: 'UOLDOWNER1', last_set: DAY },
      purpose: { value: 'Leads only', creator: 'UOLDOWNER1', last_set: DAY },
    },
    // Same name as a public channel already on this server.
    { id: 'GDESIGN001', name: 'design', created: DAY - 800, creator: 'UANNA00001', members: ['UANNA00001', 'UBEN000001'] },
    { id: 'GOLDSEC001', name: 'old-secrets', created: DAY - 700, creator: 'UANNA00001', is_archived: true, members: ['UANNA00001'] },
  ]);
  write('mpims.json', [
    { id: 'GMPDM00001', name: 'mpdm-anna--ben--olive-1', created: DAY - 600, creator: 'UANNA00001', is_mpim: true, is_archived: false, members: ['UANNA00001', 'UBEN000001', 'UOLDOWNER1'] },
  ]);
  write('dms.json', [{ id: 'DANNABEN01', created: DAY - 500, members: ['UANNA00001', 'UBEN000001'] }]);
  write('general/2024-01-15.json', [{ type: 'message', user: 'UANNA00001', text: 'hello everyone', ts: ts(1) }]);
  write('leadership/2024-01-15.json', [{ type: 'message', user: 'UOLDOWNER1', text: 'Board meeting moved to Tuesday', ts: ts(2) }]);
  write('design/2024-01-15.json', [{ type: 'message', user: 'UANNA00001', text: 'private design crit notes', ts: ts(3) }]);
  write('old-secrets/2024-01-15.json', [{ type: 'message', user: 'UANNA00001', text: 'archived secret plan', ts: ts(4) }]);
  write('mpdm-anna--ben--olive-1/2024-01-15.json', [{ type: 'message', user: 'UBEN000001', text: 'three of us lunch', ts: ts(5) }]);
  write('DANNABEN01/2024-01-15.json', [{ type: 'message', user: 'UBEN000001', text: 'just between anna and ben', ts: ts(6) }]);
}

describe('importing private channels, group DMs and DMs', () => {
  let t: TestApp;
  let owner: Session;
  let mina: Session;
  let exportDir: string;
  let report: ImportReport;
  let publicDesign: string;

  before(async () => {
    exportDir = mkdtempSync(join(tmpdir(), 'chat-export-private-'));
    writeExport(exportDir);
    t = await startApp();
    owner = await setupWorkspace(t);
    mina = await addMember(t, owner, 'Mina Local');
    publicDesign = (await owner.ok('conversations.create', { name: 'design' })).channel.id;
    await mina.ok('conversations.join', { channel: publicDesign });
    report = await importSlackExport(t.app.ctx, exportDir);
  });
  after(async () => {
    await t.close();
    rmSync(exportDir, { recursive: true, force: true });
  });

  test('private channels stay private, with their members, topic and archived state', async () => {
    assert.deepEqual(report.channels, { created: 3, merged: 1 });
    assert.deepEqual(report.directs, { created: 2, matched: 0 });
    assert.equal(report.messages.imported, 6);
    const info = (await owner.ok('conversations.info', { channel: 'GLEAD00001' })).channel;
    assert.equal(info.is_private, true);
    assert.equal(info.name, 'leadership');
    assert.equal(info.topic.value, 'Board prep');
    assert.equal((await owner.ok('conversations.members', { channel: 'GLEAD00001' })).members.length, 2);
    assert.match(JSON.stringify((await owner.ok('conversations.history', { channel: 'GLEAD00001' })).messages), /Board meeting moved to Tuesday/);
    // Someone who was not a member sees nothing of it, by id or by search.
    assert.equal((await mina.call('conversations.history', { channel: 'GLEAD00001' })).error, 'channel_not_found');
    assert.equal((await mina.ok('search.messages', { query: 'Board meeting' })).messages.total, 0);
    assert.equal((await owner.ok('search.messages', { query: 'Board meeting' })).messages.total, 1);
    const archived = t.app.ctx.db.get<{ kind: string; is_archived: number }>('SELECT kind, is_archived FROM conversations WHERE id = ?', 'GOLDSEC001');
    assert.deepEqual({ ...archived }, { kind: 'private', is_archived: 1 });
  });

  test('a private channel named like an existing public one is kept apart, never merged into it', async () => {
    const history = (await mina.ok('conversations.history', { channel: publicDesign })).messages as Json[];
    assert.equal(history.some((message) => String(message.text).includes('private design crit')), false);
    const imported = t.app.ctx.db.get<{ kind: string; name: string }>('SELECT kind, name FROM conversations WHERE id = ?', 'GDESIGN001');
    assert.equal(imported?.kind, 'private');
    assert.notEqual(imported?.name, 'design');
    assert.ok(report.problems.some((line) => line.includes('design') && line.includes(imported!.name)), report.problems.join('\n'));
    assert.equal((await mina.ok('search.messages', { query: 'design crit' })).messages.total, 0);
  });

  test('a group DM arrives from its mpdm folder; a DM between two others stays theirs', async () => {
    const group = (await owner.ok('conversations.info', { channel: 'GMPDM00001' })).channel;
    assert.equal(group.is_mpim, true);
    assert.equal((await owner.ok('conversations.members', { channel: 'GMPDM00001' })).members.length, 3);
    assert.match(JSON.stringify((await owner.ok('conversations.history', { channel: 'GMPDM00001' })).messages), /three of us lunch/);
    assert.equal((await owner.call('conversations.history', { channel: 'DANNABEN01' })).error, 'channel_not_found');
    assert.equal((await mina.call('conversations.history', { channel: 'GMPDM00001' })).error, 'channel_not_found');
    assert.equal((await owner.ok('search.messages', { query: 'between anna' })).messages.total, 0);
  });

  test('running it again changes nothing', async () => {
    const again = await importSlackExport(t.app.ctx, exportDir);
    assert.deepEqual(again.messages, { imported: 0, alreadyPresent: 6, failed: 0 });
    // #general maps onto this server's #general again; everything else is found by its id.
    assert.deepEqual(again.channels, { created: 0, merged: 1 });
  });
});
