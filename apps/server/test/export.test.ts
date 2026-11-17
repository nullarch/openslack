import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { importSlackExport } from '../src/importer/slack-export.ts';
import { openArchive } from '../src/importer/archive.ts';
import { addMember, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('export', () => {
  let source: TestApp;
  let target: TestApp | undefined;
  let owner: Session;
  let mina: Session;
  let dir: string;
  let archivePath: string;
  const ids: Record<string, string> = {};

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-export-test-'));
    source = await startApp();
    owner = await setupWorkspace(source);
    mina = await addMember(source, owner, 'Mina Member');
    const theo = await addMember(source, owner, 'Theo Third');
    ids.general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    ids.secret = (await owner.ok('conversations.create', { name: 'secret', is_private: true })).channel.id;
    await owner.ok('conversations.invite', { channel: ids.secret, users: mina.userId });
    await owner.ok('conversations.setTopic', { channel: ids.secret, topic: 'Quiet plans' });

    const parent = await owner.ok('chat.postMessage', { channel: ids.general, text: `Kickoff for <@${mina.userId}>` });
    ids.parent = parent.ts;
    await mina.ok('chat.postMessage', { channel: ids.general, text: 'first reply', thread_ts: parent.ts });
    await owner.ok('reactions.add', { channel: ids.general, timestamp: parent.ts, name: 'tada' });
    await owner.ok('pins.add', { channel: ids.general, timestamp: parent.ts });
    const edited = await mina.ok('chat.postMessage', { channel: ids.general, text: 'tpyo' });
    await mina.ok('chat.update', { channel: ids.general, ts: edited.ts, text: 'typo fixed' });
    await owner.ok('chat.postMessage', { channel: ids.secret, text: 'the private plan' });
    ids.dm = (await owner.ok('conversations.open', { users: mina.userId })).channel.id;
    await owner.ok('chat.postMessage', { channel: ids.dm, text: 'a direct word' });
    ids.group = (await owner.ok('conversations.open', { users: `${mina.userId},${theo.userId}` })).channel.id;
    await theo.ok('chat.postMessage', { channel: ids.group, text: 'group hello' });
    const { upload_url, file_id } = await owner.ok('files.getUploadURLExternal', { filename: 'dot.png', length: PNG.length });
    await fetch(upload_url, { method: 'POST', body: PNG });
    await owner.ok('files.completeUploadExternal', { files: [{ id: file_id, title: 'Dot' }], channel_id: ids.secret, initial_comment: 'see file' });
    ids.file = file_id;
  });
  after(async () => {
    await source.close();
    await target?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('only owners can download it', async () => {
    assert.equal((await fetch(`${source.base}/admin/export.zip`)).status, 404);
    assert.equal((await fetch(`${source.base}/admin/export.zip`, { headers: { cookie: mina.cookie } })).status, 404);
    const response = await fetch(`${source.base}/admin/export.zip`, { headers: { cookie: owner.cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename=".+-export-\d{4}-\d{2}-\d{2}\.zip"/);
    archivePath = join(dir, 'export.zip');
    writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
  });

  test('the archive has Slack’s layout, private conversations included', () => {
    const archive = openArchive(archivePath);
    const names = archive.names();
    for (const name of ['users.json', 'channels.json', 'groups.json', 'dms.json', 'mpims.json']) assert.ok(names.includes(name), name);
    const groups = JSON.parse(archive.read('groups.json').toString('utf8'));
    assert.equal(groups[0].name, 'secret');
    assert.equal(groups[0].topic.value, 'Quiet plans');
    const mpims = JSON.parse(archive.read('mpims.json').toString('utf8'));
    assert.ok(names.some((name) => name.startsWith(`${mpims[0].name}/`)));
    assert.ok(names.some((name) => name.startsWith(`${ids.dm}/`)));
    assert.ok(names.includes(`__uploads/${ids.file}/dot.png`));
    assert.deepEqual(archive.read(`__uploads/${ids.file}/dot.png`), PNG);
    const general = names.find((name) => name.startsWith('general/'))!;
    const day = JSON.parse(archive.read(general).toString('utf8'));
    assert.ok(day.some((message: Json) => message.text === 'first reply' && message.thread_ts === ids.parent));
    archive.close();
  });

  test('our own importer reads it back into a new workspace, files and all', async () => {
    target = await startApp();
    const newOwner = await setupWorkspace(target);
    const report = await importSlackExport(target.app.ctx, archivePath);
    assert.equal(report.messages.failed, 0);
    assert.equal(report.files.stored, 1);
    assert.equal(report.problemCount, 0, report.problems.join('\n'));

    const boot = await newOwner.ok('client.boot');
    const names = boot.channels.filter((channel: Json) => channel.is_channel).map((channel: Json) => channel.name).sort();
    assert.deepEqual(names, ['general', 'random', 'secret']);
    const general = boot.channels.find((channel: Json) => channel.is_general).id;
    const history = await newOwner.ok('conversations.history', { channel: general, limit: 50 });
    const kickoff = history.messages.find((message: Json) => message.text.startsWith('Kickoff'));
    assert.equal(kickoff.reply_count, 1);
    assert.deepEqual(kickoff.reactions.map((reaction: Json) => reaction.name), ['tada']);
    assert.ok(kickoff.pinned_to);
    const fixed = history.messages.find((message: Json) => message.text === 'typo fixed');
    assert.ok(fixed.edited);
    const thread = await newOwner.ok('conversations.replies', { channel: general, ts: kickoff.ts });
    assert.equal(thread.messages[1].text, 'first reply');

    const secret = boot.channels.find((channel: Json) => channel.name === 'secret');
    const secretHistory = await newOwner.ok('conversations.history', { channel: secret.id });
    const withFile = secretHistory.messages.find((message: Json) => message.text === 'see file');
    const download = await fetch(`${target.base}${new URL(withFile.files[0].url_private).pathname}`, { headers: { cookie: newOwner.cookie } });
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), PNG);

    // Direct conversations came along, between the same people.
    const dm = boot.channels.find((channel: Json) => channel.is_im);
    assert.equal((await newOwner.ok('conversations.history', { channel: dm.id })).messages[0].text, 'a direct word');
    const users = (await newOwner.ok('users.list')).members.map((user: Json) => user.real_name).sort();
    assert.ok(users.includes('Mina Member') && users.includes('Theo Third'));
  });
});
