import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import type { Storage } from './storage.ts';

/**
 * Uploaded files encrypted with keys you hold (STORAGE_ENCRYPTION_KEYS): what
 * sits on disk or in the bucket is unreadable without them. Each file is
 * AES-256-GCM in 64 KiB chunks, so a range (a video seek, an image header)
 * decrypts only the chunks it needs. Every chunk carries its index and
 * whether it is the last, so chunks cannot be reordered, swapped or the file
 * cut short without the read failing.
 *
 * Layout: "OSE1" | key id (8 bytes) | chunk size (4 bytes) | chunks of
 * nonce (12) + ciphertext + tag (16). A file without the "OSE1" header was
 * stored before encryption was turned on and is read as it is.
 *
 * The first key encrypts; all of them decrypt, so a new key can be put first
 * and files re-encrypted at leisure (`encrypt-files`).
 */

const MAGIC = Buffer.from('OSE1');
const HEADER = 16;
const CHUNK = 64 * 1024;
const NONCE = 12;
const TAG = 16;
const OVERHEAD = NONCE + TAG;

export interface StorageKey {
  id: Buffer;
  key: Buffer;
}

/** `STORAGE_ENCRYPTION_KEYS`: base64 32-byte keys, comma-separated, the one to write with first. */
export function storageKeysFromEnv(value: string | undefined): StorageKey[] {
  if (!value?.trim()) return [];
  return value.split(',').map((entry) => {
    const key = Buffer.from(entry.trim(), 'base64');
    if (key.length !== 32) throw new Error('STORAGE_ENCRYPTION_KEYS: each key must be 32 bytes, base64 encoded (openssl rand -base64 32)');
    return { id: createHash('sha256').update(key).digest().subarray(0, 8), key };
  });
}

function aad(index: number, last: boolean): Buffer {
  const out = Buffer.alloc(9);
  out.writeBigUInt64BE(BigInt(index));
  out[8] = last ? 1 : 0;
  return out;
}

function sealChunk(key: Buffer, index: number, last: boolean, plain: Buffer): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(index, last));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

function openChunk(key: Buffer, index: number, last: boolean, sealed: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, NONCE));
  decipher.setAAD(aad(index, last));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
  return Buffer.concat([decipher.update(sealed.subarray(NONCE, sealed.length - TAG)), decipher.final()]);
}

/** Plaintext size from the stored size of an encrypted file. */
function plainSize(stored: number, chunk: number): number {
  const body = stored - HEADER;
  const sealed = chunk + OVERHEAD;
  const chunks = Math.max(1, Math.ceil(body / sealed));
  return (chunks - 1) * chunk + (body - (chunks - 1) * sealed - OVERHEAD);
}

async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

/** Encrypt a plaintext stream chunk by chunk; the last chunk is marked, an empty one if the size is a multiple of the chunk. */
async function* sealStream(source: AsyncIterable<Buffer | string> | Iterable<Buffer>, key: StorageKey, counter: { size: number }, maxBytes: number): AsyncGenerator<Buffer> {
  const header = Buffer.alloc(HEADER);
  MAGIC.copy(header, 0);
  key.id.copy(header, 4);
  header.writeUInt32BE(CHUNK, 12);
  yield header;
  let pending: Buffer = Buffer.alloc(0);
  let index = 0;
  for await (const part of source) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
    counter.size += buffer.length;
    if (counter.size > maxBytes) throw new Error('too_large');
    pending = pending.length ? Buffer.concat([pending, buffer]) : buffer;
    // Keep at least one byte back so the final chunk is known when the input ends.
    while (pending.length > CHUNK) {
      yield sealChunk(key.key, index, false, pending.subarray(0, CHUNK));
      pending = pending.subarray(CHUNK);
      index += 1;
    }
  }
  yield sealChunk(key.key, index, true, pending);
}

export class EncryptedStorage implements Storage {
  private readonly inner: Storage;
  private readonly keys: StorageKey[];

  constructor(inner: Storage, keys: StorageKey[]) {
    if (keys.length === 0) throw new Error('EncryptedStorage needs at least one key');
    this.inner = inner;
    this.keys = keys;
  }

  private keyFor(id: Buffer): Buffer {
    const found = this.keys.find((entry) => entry.id.equals(id));
    if (!found) throw new Error('this file was encrypted with a key that is not in STORAGE_ENCRYPTION_KEYS');
    return found.key;
  }

  async put(key: string, source: Readable, maxBytes: number): Promise<number> {
    const counter = { size: 0 };
    const sealedMax = maxBytes + HEADER + (Math.ceil(maxBytes / CHUNK) + 1) * OVERHEAD;
    await this.inner.put(key, Readable.from(sealStream(source, this.keys[0]!, counter, maxBytes)), sealedMax);
    return counter.size;
  }

  async putBuffer(key: string, data: Buffer): Promise<void> {
    const sealed = await readAll(Readable.from(sealStream([data], this.keys[0]!, { size: 0 }, Number.MAX_SAFE_INTEGER)));
    await this.inner.putBuffer(key, sealed);
  }

  /** The header, or null for a file stored before encryption (or an empty one). */
  private async header(key: string): Promise<{ id: Buffer; chunk: number } | null> {
    const head = await readAll(this.inner.read(key, { start: 0, end: HEADER - 1 })).catch(() => Buffer.alloc(0));
    if (head.length < HEADER || !head.subarray(0, 4).equals(MAGIC)) return null;
    return { id: head.subarray(4, 12), chunk: head.readUInt32BE(12) };
  }

  async size(key: string): Promise<number | null> {
    const stored = await this.inner.size(key);
    if (stored === null) return null;
    const header = await this.header(key);
    return header ? plainSize(stored, header.chunk) : stored;
  }

  read(key: string, range?: { start: number; end: number }): Readable {
    const out = new PassThrough();
    void (async () => {
      const header = await this.header(key);
      if (!header) {
        // Stored before encryption was turned on.
        const plain = this.inner.read(key, range);
        plain.on('error', (error) => out.destroy(error));
        plain.pipe(out);
        return;
      }
      const secret = this.keyFor(header.id);
      const stored = (await this.inner.size(key)) ?? HEADER;
      const total = plainSize(stored, header.chunk);
      const sealed = header.chunk + OVERHEAD;
      const lastIndex = Math.max(0, Math.ceil((stored - HEADER) / sealed) - 1);
      const start = range ? Math.max(0, range.start) : 0;
      const end = range ? Math.min(range.end, total - 1) : total - 1;
      if (end < start) {
        out.end();
        return;
      }
      const first = Math.floor(start / header.chunk);
      const last = Math.min(lastIndex, Math.floor(end / header.chunk));
      const from = HEADER + first * sealed;
      const to = Math.min(stored - 1, HEADER + (last + 1) * sealed - 1);
      // Each sealed chunk has a known size: full ones are chunk + overhead, the last is what remains.
      const sizeOf = (index: number): number => (index === lastIndex ? stored - HEADER - lastIndex * sealed : sealed);
      let buffer: Buffer = Buffer.alloc(0);
      let index = first;
      for await (const part of this.inner.read(key, { start: from, end: to })) {
        buffer = buffer.length ? Buffer.concat([buffer, part as Buffer]) : (part as Buffer);
        while (index <= last && buffer.length >= sizeOf(index)) {
          const plain = openChunk(secret, index, index === lastIndex, buffer.subarray(0, sizeOf(index)));
          buffer = buffer.subarray(sizeOf(index));
          const offset = index * header.chunk;
          const slice = plain.subarray(Math.max(0, start - offset), Math.min(plain.length, end - offset + 1));
          if (slice.length && !out.write(slice)) await new Promise((resume) => out.once('drain', resume));
          index += 1;
        }
        if (index > last) break;
      }
      if (index <= last) throw new Error('encrypted file is shorter than its chunks say');
      out.end();
    })().catch((error: unknown) => out.destroy(error instanceof Error ? error : new Error(String(error))));
    return out;
  }

  remove(key: string): Promise<void> {
    return this.inner.remove(key);
  }

  /** Re-encrypt one stored object with the current key (or encrypt one stored before). Returns false when nothing changed. */
  async rewrite(key: string): Promise<boolean> {
    const header = await this.header(key);
    if (header && header.id.equals(this.keys[0]!.id)) return false;
    if ((await this.inner.size(key)) === null) return false;
    const plain = await readAll(this.read(key));
    await this.putBuffer(key, plain);
    return true;
  }
}

/** Every object the server stores: uploads, their thumbnails and link-preview images. */
export function storedKeys(db: { all<T>(sql: string, ...params: unknown[]): T[] }): string[] {
  const keys = new Set<string>();
  for (const row of db.all<{ storage_key: string; thumb: string | null }>("SELECT storage_key, thumb FROM files WHERE state != 'pending'")) {
    keys.add(row.storage_key);
    if (row.thumb) keys.add(`${row.storage_key}_t`);
  }
  const walk = (value: unknown): void => {
    if (typeof value === 'string' && /^lp[0-9a-f]{40}$/.test(value)) keys.add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  for (const row of db.all<{ data: string | null }>('SELECT data FROM link_previews WHERE data IS NOT NULL')) {
    try {
      walk(JSON.parse(row.data!));
    } catch {
      // unreadable preview: skip
    }
  }
  return [...keys];
}
