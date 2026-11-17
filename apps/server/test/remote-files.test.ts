import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { addMember, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';
import { asBot, botOk, createPlatformApp, type TestAppCredentials } from './platform-helpers.ts';

// A 1×1 PNG and a 1000×500 one's header are enough for the size check.
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** A minimal zip archive (stored with deflate), enough for an Office document. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(content));
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.byteLength(content), 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(Buffer.byteLength(content), 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** files.remote.* with multipart parts, as the official SDK sends preview_image and indexable_file_contents. */
async function multipart(base: string, token: string, method: string, fields: Record<string, string>, files: Record<string, { name: string; data: Buffer; type: string }>): Promise<Json> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  for (const [key, file] of Object.entries(files)) form.set(key, new Blob([file.data], { type: file.type }), file.name);
  const response = await fetch(`${base}/api/${method}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  return (await response.json()) as Json;
}

describe('remote files (files.remote.*)', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let drive: TestAppCredentials;
  let other: TestAppCredentials;
  let channel: string;
  let secret: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    drive = await createPlatformApp(owner, 'Drive');
    other = await createPlatformApp(owner, 'Other app');
    channel = (await owner.ok('conversations.create', { name: 'docs' })).channel.id;
    await owner.ok('conversations.invite', { channel, users: `${drive.botUserId},${member.userId}` });
    secret = (await owner.ok('conversations.create', { name: 'board', is_private: true })).channel.id;
  });
  after(() => t.close());

  test('add registers a document with a preview image and searchable text; adding the same id again updates it', async () => {
    const added = await multipart(
      t.base,
      drive.botToken,
      'files.remote.add',
      { external_id: 'doc-1', external_url: 'https://drive.example.test/d/1', title: 'Q3 plan', filetype: 'gdoc' },
      {
        preview_image: { name: 'preview.png', data: PNG_1x1, type: 'image/png' },
        indexable_file_contents: { name: 'terms.txt', data: Buffer.from('roadmap okr hiring budget'), type: 'text/plain' },
      },
    );
    assert.equal(added.ok, true, JSON.stringify(added));
    const file = added.file;
    assert.deepEqual(
      { mode: file.mode, is_external: file.is_external, external_type: file.external_type, external_id: file.external_id, url_private: file.url_private, title: file.title, mimetype: file.mimetype },
      { mode: 'external', is_external: true, external_type: 'app', external_id: 'doc-1', url_private: 'https://drive.example.test/d/1', title: 'Q3 plan', mimetype: 'application/vnd.slack-remote' },
    );
    assert.equal(file.url_private_download, undefined);
    assert.ok(file.thumb_360, 'the preview image becomes the thumbnail');
    const again = await botOk(t.base, drive, 'files.remote.add', { external_id: 'doc-1', external_url: 'https://drive.example.test/d/1', title: 'Q3 plan (final)' });
    assert.equal(again.file.id, file.id);
    assert.equal(again.file.title, 'Q3 plan (final)');
  });

  test('not shared, it exists only for its app; shared, the channel sees it, finds it and opens its preview', async () => {
    const info = await botOk(t.base, drive, 'files.remote.info', { external_id: 'doc-1' });
    const id = info.file.id;
    assert.equal((await member.call('files.info', { file: id })).error, 'file_not_found');
    assert.equal((await asBot(t.base, other, 'files.remote.info', { file: id })).error, 'file_not_found');
    assert.equal((await asBot(t.base, other, 'files.remote.info', { external_id: 'doc-1' })).error, 'file_not_found', "another app's ids are its own");
    assert.equal((await asBot(t.base, drive, 'files.remote.info', { file: id, external_id: 'doc-1' })).error, 'too_many_ids');

    const shared = await botOk(t.base, drive, 'files.remote.share', { channels: channel, external_id: 'doc-1' });
    assert.deepEqual(shared.file.channels, [channel]);
    const history = await member.ok('conversations.history', { channel, limit: 1 });
    assert.equal(history.messages[0].files[0].id, id);
    assert.equal(history.messages[0].files[0].external_url, 'https://drive.example.test/d/1');
    assert.equal((await member.ok('search.files', { query: 'hiring budget' })).files.total, 1);
    const thumb = await fetch(`${t.base}${new URL(shared.file.thumb_360).pathname}`, { headers: { cookie: member.cookie } });
    assert.equal(thumb.status, 200);
    // The document itself is not here.
    const bytes = await fetch(`${t.base}/files-pri/${(await owner.ok('team.info')).team.id}-${id}/x`, { headers: { cookie: member.cookie } });
    assert.equal(bytes.status, 404);

    // Sharing needs the app in the channel (private) and a channel that exists.
    assert.equal((await asBot(t.base, drive, 'files.remote.share', { channels: secret, file: id })).error, 'channel_not_found');
  });

  test('list pages through what the caller can see, newest first, by channel', async () => {
    for (const n of [2, 3, 4]) await botOk(t.base, drive, 'files.remote.add', { external_id: `doc-${n}`, external_url: `https://drive.example.test/d/${n}`, title: `Doc ${n}` });
    const first = await botOk(t.base, drive, 'files.remote.list', { limit: 2 });
    assert.equal(first.files.length, 2);
    assert.ok(first.response_metadata.next_cursor);
    const second = await botOk(t.base, drive, 'files.remote.list', { limit: 2, cursor: first.response_metadata.next_cursor });
    assert.equal(second.files.length, 2);
    assert.equal(second.response_metadata.next_cursor, '');
    assert.equal(new Set([...first.files, ...second.files].map((file: Json) => file.id)).size, 4);
    const inChannel = await botOk(t.base, drive, 'files.remote.list', { channel });
    assert.deepEqual(inChannel.files.map((file: Json) => file.external_id), ['doc-1']);
    // Another app sees only what was shared where it can look (a public channel), not the unshared ones.
    assert.deepEqual((await asBot(t.base, other, 'files.remote.list', {})).files.map((file: Json) => file.external_id), ['doc-1']);
    assert.equal((await asBot(t.base, drive, 'files.remote.list', { cursor: 'nonsense' })).error, 'invalid_cursor');
  });

  test('update changes title and address; only the app that added a file changes or removes it', async () => {
    const updated = await botOk(t.base, drive, 'files.remote.update', { external_id: 'doc-1', title: 'Q3 plan v2', external_url: 'https://drive.example.test/d/1?v=2' });
    assert.equal(updated.file.title, 'Q3 plan v2');
    assert.equal(updated.file.url_private, 'https://drive.example.test/d/1?v=2');
    assert.equal((await asBot(t.base, drive, 'files.remote.update', { external_id: 'doc-1', external_url: 'javascript:alert(1)' })).error, 'invalid_url');
    assert.equal((await asBot(t.base, other, 'files.remote.update', { file: updated.file.id, title: 'mine now' })).error, 'file_not_found');
    assert.equal((await asBot(t.base, other, 'files.remote.remove', { file: updated.file.id })).error, 'file_not_found');
    assert.equal((await member.call('files.remote.add', { external_id: 'x', external_url: 'https://x.test', title: 'x' })).error, 'bot_user_required');
    await botOk(t.base, drive, 'files.remote.remove', { external_id: 'doc-1' });
    assert.equal((await asBot(t.base, drive, 'files.remote.info', { external_id: 'doc-1' })).error, 'file_not_found');
  });

  test('bad input is refused with Slack’s errors', async () => {
    const add = (args: Json) => asBot(t.base, drive, 'files.remote.add', { external_id: 'e', external_url: 'https://x.test', title: 't', ...args });
    assert.equal((await add({ external_id: 'é' })).error, 'invalid_external_id');
    assert.equal((await add({ external_id: 'x'.repeat(256) })).error, 'invalid_external_id');
    assert.equal((await add({ title: 'x'.repeat(300) })).error, 'bad_title');
    assert.equal((await add({ external_url: 'file:///etc/passwd' })).error, 'invalid_url');
    const badImage = await multipart(t.base, drive.botToken, 'files.remote.add', { external_id: 'img', external_url: 'https://x.test', title: 'x' }, { preview_image: { name: 'p.png', data: Buffer.from('not an image'), type: 'image/png' } });
    assert.equal(badImage.error, 'bad_image');
  });
});

describe('office documents shown as text', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let outsider: Session;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    outsider = await addMember(t, owner, 'Otto Outsider');
  });
  after(() => t.close());

  test('a Word document reads as its text for people who can see it', async () => {
    const channel = (await owner.ok('conversations.create', { name: 'plans', is_private: true })).channel.id;
    await owner.ok('conversations.invite', { channel, users: member.userId });
    const docx = zip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Offsite agenda</w:t></w:r></w:p><w:p><w:r><w:t>Day one: planning</w:t></w:r></w:p></w:body></w:document>' });
    const { upload_url, file_id } = await owner.ok('files.getUploadURLExternal', { filename: 'agenda.docx', length: docx.length });
    await fetch(upload_url, { method: 'POST', body: docx });
    await owner.ok('files.completeUploadExternal', { files: JSON.stringify([{ id: file_id }]), channel_id: channel });
    const preview = await member.ok('client.files.textPreview', { file: file_id });
    assert.match(preview.text, /Offsite agenda[\s\S]*Day one: planning/);
    assert.equal(preview.truncated, false);
    assert.equal((await outsider.call('client.files.textPreview', { file: file_id })).error, 'file_not_found');
    const { upload_url: textUrl, file_id: textId } = await owner.ok('files.getUploadURLExternal', { filename: 'notes.txt', length: 5 });
    await fetch(textUrl, { method: 'POST', body: 'notes' });
    assert.equal((await owner.call('client.files.textPreview', { file: textId })).error, 'no_preview');
  });
});
