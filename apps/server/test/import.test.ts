import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { importSlackExport } from '../src/importer/slack-export.ts';
import { Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';

const DAY = 1_705_300_000; // 2024-01-15
const ts = (n: number): string => `${DAY + n}.000${String(n).padStart(3, '0')}`;

/** Write a small but representative export to a folder. `fileUrl` is where the one attached file can be fetched. */
function writeExport(root: string, fileUrl: string): void {
  const write = (name: string, value: unknown): void => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), JSON.stringify(value));
  };
  write('users.json', [
    // Same email as the workspace owner: maps onto the existing account.
    { id: 'UOLDOWNER1', name: 'olive', real_name: 'Olive Owner', is_owner: true, profile: { email: 'owner@acme.test' } },
    { id: 'UANNA00001', name: 'anna', real_name: 'Anna Ito', tz: 'Asia/Tokyo', profile: { email: 'anna@acme.test', title: 'Designer', display_name: 'anna' } },
    { id: 'UGONE00001', name: 'gone', real_name: 'Gone Person', deleted: true, profile: {} },
    { id: 'UBOT000001', name: 'buildbot', real_name: 'Build Bot', is_bot: true, profile: { bot_id: 'BBUILD0001' } },
  ]);
  write('channels.json', [
    { id: 'CGENERAL01', name: 'general', created: DAY - 1000, creator: 'UOLDOWNER1', is_general: true, members: ['UOLDOWNER1', 'UANNA00001'] },
    {
      id: 'CPROJECT01',
      name: 'project-x',
      created: DAY - 500,
      creator: 'UANNA00001',
      members: ['UOLDOWNER1', 'UANNA00001', 'UGONE00001'],
      topic: { value: 'Ship it', creator: 'UANNA00001', last_set: DAY },
      purpose: { value: 'Project X', creator: 'UANNA00001', last_set: DAY },
      pins: [{ id: ts(1), type: 'C', user: 'UANNA00001', created: DAY + 50 }],
    },
  ]);
  write('dms.json', [{ id: 'DDIRECT001', created: DAY, members: ['UOLDOWNER1', 'UANNA00001'] }]);
  write('general/2024-01-15.json', [{ type: 'message', user: 'UANNA00001', text: 'hello from the old workspace', ts: ts(1) }]);
  write('project-x/2024-01-15.json', [
    {
      type: 'message',
      user: 'UANNA00001',
      text: 'Kickoff notes for <@UOLDOWNER1> — see <#CGENERAL01|general>',
      ts: ts(1),
      thread_ts: ts(1),
      reply_count: 2,
      reactions: [{ name: 'tada', users: ['UOLDOWNER1', 'UGONE00001'], count: 2 }],
      edited: { user: 'UANNA00001', ts: ts(2) },
    },
    { type: 'message', user: 'UOLDOWNER1', text: 'first reply', ts: ts(3), thread_ts: ts(1) },
    { type: 'message', subtype: 'thread_broadcast', user: 'UGONE00001', text: 'reply shown in channel', ts: ts(4), thread_ts: ts(1) },
    { type: 'message', user: 'UANNA00001', text: 'orphaned reply', ts: ts(5), thread_ts: `${DAY - 99}.000001` },
    { type: 'message', subtype: 'bot_message', bot_id: 'BBUILD0001', username: 'Build Bot', text: 'Build 7 passed', ts: ts(6) },
    {
      type: 'message',
      user: 'UANNA00001',
      text: 'design attached',
      ts: ts(7),
      files: [{ id: 'FDESIGN001', name: 'design.txt', title: 'Design', mimetype: 'text/plain', filetype: 'text', url_private: fileUrl, permalink: fileUrl }],
    },
    { type: 'message', user: 'UUNKNOWN01', text: 'from someone missing in users.json', ts: ts(8) },
  ]);
  write('project-x/2024-01-16.json', [{ type: 'message', user: 'UANNA00001', text: '다음 날 메시지', ts: `${DAY + 86_400}.000001` }]);
  write('DDIRECT001/2024-01-15.json', [{ type: 'message', user: 'UANNA00001', text: 'private hello', ts: ts(1) }]);
}

describe('Slack export import', () => {
  let t: TestApp;
  let owner: Session;
  let files: Server;
  let exportDir: string;
  let fileUrl: string;

  before(async () => {
    files = createServer((req, res) => {
      if (req.url === '/design.txt') res.end('the design');
      else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => files.listen(0, '127.0.0.1', resolve));
    fileUrl = `http://127.0.0.1:${(files.address() as AddressInfo).port}/design.txt`;
    exportDir = mkdtempSync(join(tmpdir(), 'chat-export-'));
    writeExport(exportDir, fileUrl);
    t = await startApp();
    owner = await setupWorkspace(t);
  });
  after(async () => {
    await t.close();
    files.close();
    rmSync(exportDir, { recursive: true, force: true });
  });

  test('imports people, channels, threads, reactions and pins with their original ids', async () => {
    const report = await importSlackExport(t.app.ctx, exportDir);
    assert.deepEqual(report.users, { created: 4, matched: 1 }); // 3 from users.json + 1 placeholder; the owner matched
    assert.deepEqual(report.channels, { created: 1, merged: 1 });
    assert.deepEqual(report.directs, { created: 1, matched: 0 });
    assert.deepEqual(report.messages, { imported: 10, alreadyPresent: 0, failed: 0 });
    assert.equal(report.reactions, 2);
    assert.equal(report.pins, 1);
    assert.deepEqual(report.files, { stored: 0, linked: 1, failed: 0 });
    assert.ok(report.problems.some((line) => line.includes('lost its thread')));
    assert.ok(report.problems.some((line) => line.includes('UUNKNOWN01')));

    const boot = await owner.ok('client.boot');
    const project = boot.channels.find((channel: Json) => channel.name === 'project-x');
    assert.equal(project.id, 'CPROJECT01');
    assert.equal(project.unread_count, 0);
    assert.equal(project.topic.value, 'Ship it');
    const general = boot.channels.find((channel: Json) => channel.is_general);

    const history = await owner.ok('conversations.history', { channel: 'CPROJECT01', limit: 50 });
    const texts = history.messages.map((message: Json) => message.text);
    // The reply to a missing parent became a top-level message; real replies stay in their thread.
    assert.ok(texts.includes('orphaned reply'));
    assert.ok(texts.includes('reply shown in channel'));
    assert.ok(!texts.includes('first reply'));
    const kickoff = history.messages.find((message: Json) => message.ts === ts(1));
    // The owner's old id was rewritten to the existing account; the merged channel link too.
    assert.equal(kickoff.text, `Kickoff notes for <@${owner.userId}> — see <#${general.id}|general>`);
    assert.equal(kickoff.reply_count, 2);
    assert.deepEqual(kickoff.reactions, [{ name: 'tada', users: [owner.userId, 'UGONE00001'], count: 2 }]);
    assert.equal(kickoff.edited.user, 'UANNA00001');
    assert.deepEqual(kickoff.pinned_to, ['CPROJECT01']);
    const withFile = history.messages.find((message: Json) => message.text === 'design attached');
    assert.equal(withFile.attachments[0].title, 'Design');
    const bot = history.messages.find((message: Json) => message.text === 'Build 7 passed');
    assert.equal(bot.subtype, 'bot_message');
    assert.equal(bot.username, 'Build Bot');

    const thread = await owner.ok('conversations.replies', { channel: 'CPROJECT01', ts: ts(1) });
    assert.deepEqual(thread.messages.map((message: Json) => message.text).slice(1), ['first reply', 'reply shown in channel']);

    const users = (await owner.ok('users.list')).members;
    const anna = users.find((user: Json) => user.id === 'UANNA00001');
    assert.equal(anna.profile.title, 'Designer');
    assert.equal(anna.tz, 'Asia/Tokyo');
    assert.equal(users.find((user: Json) => user.id === 'UGONE00001').deleted, true);

    assert.equal((await owner.ok('search.messages', { query: '다음 날' })).messages.total, 1);
    assert.equal((await owner.ok('search.messages', { query: 'old workspace in:#general' })).messages.total, 1);
    const dm = boot.channels.find((channel: Json) => channel.id === 'DDIRECT001');
    assert.equal(dm.user, 'UANNA00001');
  });

  test('running the import again changes nothing', async () => {
    const report = await importSlackExport(t.app.ctx, exportDir);
    assert.deepEqual(report.messages, { imported: 0, alreadyPresent: 10, failed: 0 });
    assert.deepEqual(report.users, { created: 0, matched: 4 }); // every entry of users.json already exists
    assert.equal(report.reactions, 0);
    const history = await owner.ok('conversations.history', { channel: 'CPROJECT01', limit: 50 });
    assert.equal(history.messages.length, 7);
  });

  test('an imported person claims their account through an invite and keeps their history', async () => {
    const { invite } = await owner.ok('client.invites.create', {});
    const anna = new Session(t.base);
    const signup = await anna.ok('client.signup', { code: invite.code, email: 'anna@acme.test', password: 'a long enough password', real_name: 'Anna Ito' });
    assert.equal(signup.user_id, 'UANNA00001');
    const dm = await anna.ok('conversations.history', { channel: 'DDIRECT001' });
    assert.equal(dm.messages[0].text, 'private hello');
    // Claiming twice is refused.
    const second = await new Session(t.base).call('client.signup', { code: invite.code, email: 'anna@acme.test', password: 'a long enough password', real_name: 'Anna' });
    assert.equal(second.error, 'email_taken');
  });

  test('a zip archive imports the same way, and files can be downloaded into storage', async () => {
    const zipDir = mkdtempSync(join(tmpdir(), 'chat-zip-'));
    const zipPath = join(zipDir, 'export.zip');
    try {
      execFileSync('zip', ['-q', '-r', zipPath, '.'], { cwd: exportDir });
    } catch {
      rmSync(zipDir, { recursive: true, force: true });
      return; // No zip tool on this machine: the folder path above covers the importer itself.
    }
    const fresh = await startApp();
    try {
      const freshOwner = await setupWorkspace(fresh);
      const report = await importSlackExport(fresh.app.ctx, zipPath, { downloadFiles: true });
      assert.deepEqual(report.messages, { imported: 10, alreadyPresent: 0, failed: 0 });
      assert.deepEqual(report.files, { stored: 1, linked: 0, failed: 0 });
      const history = await freshOwner.ok('conversations.history', { channel: 'CPROJECT01', limit: 50 });
      const file = history.messages.find((message: Json) => message.text === 'design attached').files[0];
      assert.equal(file.id, 'FDESIGN001');
      const download = await fetch(`${fresh.base}${new URL(file.url_private).pathname}`, { headers: { cookie: freshOwner.cookie } });
      assert.equal(await download.text(), 'the design');
    } finally {
      await fresh.close();
      rmSync(zipDir, { recursive: true, force: true });
    }
  });
});
