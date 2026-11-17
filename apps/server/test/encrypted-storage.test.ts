import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { EncryptedStorage, storageKeysFromEnv } from '../src/core/encrypted-storage.ts';
import { LocalStorage } from '../src/core/storage.ts';
import { setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

const KEY_A = randomBytes(32).toString('base64');
/** Where LocalStorage keeps a key: a folder named after its first two characters. */
const onDisk = (root: string, key: string): string => join(root, key.slice(0, 2), key);
const KEY_B = randomBytes(32).toString('base64');

async function bytes(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

describe('files encrypted at rest', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'enc-storage-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('round trips, ranges across chunks, and nothing readable on disk', async () => {
    const inner = new LocalStorage(dir);
    const storage = new EncryptedStorage(inner, storageKeysFromEnv(KEY_A));
    for (const length of [0, 1, 65_535, 65_536, 65_537, 200_000]) {
      const plain = Buffer.concat([Buffer.from('SECRET-MARKER '), randomBytes(Math.max(0, length - 14))]).subarray(0, length);
      const key = `f${length}`;
      assert.equal(await storage.put(key, Readable.from([plain.subarray(0, 1000), plain.subarray(1000)]), 1_000_000), length);
      assert.equal(await storage.size(key), length);
      assert.ok((await bytes(storage.read(key))).equals(plain), `whole file of ${length}`);
      if (length > 14) assert.ok(!readFileSync(onDisk(dir, key)).includes(Buffer.from('SECRET-MARKER')), 'ciphertext on disk');
      for (const [start, end] of [[0, 9], [65_530, 65_545], [length - 5, length - 1], [100, 150_000], [length - 1, length + 50]]) {
        if (start < 0 || start >= length) continue;
        const want = plain.subarray(start, Math.min(end, length - 1) + 1);
        assert.ok((await bytes(storage.read(key, { start, end }))).equals(want), `range ${start}-${end} of ${length}`);
      }
    }
    await assert.rejects(storage.put('big', Readable.from([randomBytes(2000)]), 1000), /too_large/);
  });

  test('tampering and truncation are caught; files from before encryption still read', async () => {
    const inner = new LocalStorage(dir);
    const storage = new EncryptedStorage(inner, storageKeysFromEnv(KEY_A));
    const plain = randomBytes(150_000);
    await storage.put('t', Readable.from([plain]), 1_000_000);
    const stored = readFileSync(onDisk(dir, 't'));
    const flipped = Buffer.from(stored);
    flipped[70_000] = (flipped[70_000] ?? 0) ^ 1;
    writeFileSync(onDisk(dir, 't'), flipped);
    await assert.rejects(bytes(storage.read('t')));
    writeFileSync(onDisk(dir, 't'), stored.subarray(0, stored.length - 30_000));
    await assert.rejects(bytes(storage.read('t')), 'a cut-short file does not read as a shorter one');
    mkdirSync(join(dir, 'le'), { recursive: true });
    writeFileSync(onDisk(dir, 'legacy'), Buffer.from('stored before encryption'));
    assert.equal((await bytes(storage.read('legacy'))).toString(), 'stored before encryption');
    assert.equal(await storage.size('legacy'), 24);
  });

  test('a new key writes; old keys still read; rewrite moves files to the new key', async () => {
    const inner = new LocalStorage(dir);
    const old = new EncryptedStorage(inner, storageKeysFromEnv(KEY_A));
    await old.putBuffer('r', Buffer.from('rotate me'));
    const rotated = new EncryptedStorage(inner, storageKeysFromEnv(`${KEY_B},${KEY_A}`));
    assert.equal((await bytes(rotated.read('r'))).toString(), 'rotate me');
    assert.equal(await rotated.rewrite('r'), true);
    assert.equal(await rotated.rewrite('r'), false, 'already under the current key');
    const onlyNew = new EncryptedStorage(inner, storageKeysFromEnv(KEY_B));
    assert.equal((await bytes(onlyNew.read('r'))).toString(), 'rotate me');
    await assert.rejects(bytes(old.read('r')), /not in STORAGE_ENCRYPTION_KEYS/);
    assert.throws(() => storageKeysFromEnv('short'), /32 bytes/);
  });
});

describe('a server with encrypted storage', () => {
  let t: TestApp;
  let owner: Session;
  let dataDir: string;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'enc-server-'));
    t = await startApp({ dataDir, storageKeys: storageKeysFromEnv(KEY_A), keepData: true });
    owner = await setupWorkspace(t);
  });
  after(async () => {
    await t.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('uploads, downloads, ranges and image sizes work; the disk holds ciphertext', async () => {
    const general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    const text = 'quarterly numbers: confidential '.repeat(5000);
    const form = new FormData();
    form.set('channels', general);
    form.set('file', new Blob([text]), 'numbers.txt');
    const uploaded = (await (await fetch(`${t.base}/api/files.upload`, { method: 'POST', headers: { cookie: owner.cookie, origin: t.base }, body: form })).json()) as Json;
    assert.equal(uploaded.ok, true, JSON.stringify(uploaded));
    assert.equal(uploaded.file.size, Buffer.byteLength(text));
    const url = `${t.base}${new URL(uploaded.file.url_private).pathname}`;
    assert.equal(await (await fetch(url, { headers: { cookie: owner.cookie } })).text(), text);
    const part = await fetch(url, { headers: { cookie: owner.cookie, range: 'bytes=70000-70031' } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), Buffer.from(text).subarray(70_000, 70_032).toString());
    const stored: Buffer[] = [];
    const walk = (folder: string): void => {
      for (const name of readdirSync(folder)) {
        const path = join(folder, name);
        if (statSync(path).isDirectory()) walk(path);
        else stored.push(readFileSync(path));
      }
    };
    walk(join(dataDir, 'files'));
    assert.ok(stored.length > 0 && stored.every((content) => !content.includes(Buffer.from('confidential'))));

    // A 1×1 PNG: its size is still read from the (decrypted) header.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const imageForm = new FormData();
    imageForm.set('channels', general);
    imageForm.set('file', new Blob([png], { type: 'image/png' }), 'dot.png');
    const image = (await (await fetch(`${t.base}/api/files.upload`, { method: 'POST', headers: { cookie: owner.cookie, origin: t.base }, body: imageForm })).json()) as Json;
    assert.deepEqual([image.file.original_w, image.file.original_h], [1, 1]);
  });
});
