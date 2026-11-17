import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { addMember, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

/** A solid-colour PNG of the given size, built by hand. */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7f)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe('client-made thumbnails', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
  });
  after(() => t.close());

  const reserve = async (name: string, bytes: Buffer): Promise<Json> => owner.ok('files.getUploadURLExternal', { filename: name, length: bytes.length });
  const thumbUrl = (uploadUrl: string): string => {
    const url = new URL(uploadUrl);
    url.pathname += '/thumb';
    return url.href;
  };

  test('a thumbnail sent before the image is stored, reported and served to people who can see the file', async () => {
    const original = png(2400, 1600);
    const small = png(720, 480);
    const { upload_url, file_id } = await reserve('photo.png', original);
    const sent: Json = await (await fetch(thumbUrl(upload_url), { method: 'POST', body: small })).json();
    assert.deepEqual([sent.ok, sent.w, sent.h], [true, 720, 480]);
    await fetch(upload_url, { method: 'POST', body: original });
    // The thumbnail route closes once the upload is done.
    assert.equal((await fetch(thumbUrl(upload_url), { method: 'POST', body: small })).status, 400);

    const { channel } = await owner.ok('conversations.create', { name: 'photos', is_private: true });
    const done = await owner.ok('files.completeUploadExternal', { files: [{ id: file_id }], channel_id: channel.id });
    const file = done.files[0];
    assert.deepEqual([file.original_w, file.original_h], [2400, 1600]);
    assert.deepEqual([file.thumb_720_w, file.thumb_720_h], [720, 480]);
    assert.deepEqual([file.thumb_360_w, file.thumb_360_h], [360, 240]);
    assert.match(file.thumb_720, /\/files-tmb\//);

    const path = new URL(file.thumb_720).pathname;
    const asOwner = await fetch(`${t.base}${path}`, { headers: { cookie: owner.cookie } });
    assert.equal(asOwner.status, 200);
    assert.equal(asOwner.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await asOwner.arrayBuffer()), small);
    assert.equal((await fetch(`${t.base}${path}`, { headers: { cookie: member.cookie } })).status, 404);
    assert.equal((await fetch(`${t.base}${path}`)).status, 404);
  });

  test('anything but a real, reasonably small image is refused, and images without one still work', async () => {
    const original = png(1000, 800);
    const { upload_url, file_id } = await reserve('photo2.png', original);
    const text: Json = await (await fetch(thumbUrl(upload_url), { method: 'POST', body: '<svg onload=alert(1)>' })).json();
    assert.equal(text.error, 'invalid_thumbnail');
    const huge: Json = await (await fetch(thumbUrl(upload_url), { method: 'POST', body: png(2000, 100) })).json();
    assert.equal(huge.error, 'invalid_thumbnail');
    const wrongSecret: Json = await (await fetch(thumbUrl(upload_url).replace(/secret=[^&]+/, 'secret=nope'), { method: 'POST', body: png(10, 10) })).json();
    assert.equal(wrongSecret.error, 'invalid_upload');
    await fetch(upload_url, { method: 'POST', body: original });
    const info = (await owner.ok('files.completeUploadExternal', { files: [{ id: file_id }], channel_id: '#general' })).files[0];
    assert.equal(info.thumb_720, undefined);
    assert.match(info.thumb_360, /\/files-pri\//);

    const doc = await reserve('notes.txt', Buffer.from('hello'));
    const notImage: Json = await (await fetch(thumbUrl(doc.upload_url), { method: 'POST', body: png(10, 10) })).json();
    assert.equal(notImage.error, 'not_an_image');
  });
});
