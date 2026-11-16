import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Blob storage on the local disk. The interface is small so a bucket backend can replace it. */
export class Storage {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private path(key: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`invalid storage key: ${key}`);
    return join(this.root, key.slice(0, 2), key);
  }

  /** Write a stream to `key`, rejecting with `too_large` once `maxBytes` is exceeded. */
  async put(key: string, source: Readable, maxBytes: number): Promise<number> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    let size = 0;
    const limited = async function* (input: Readable): AsyncGenerator<Buffer> {
      for await (const chunk of input) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        size += buffer.length;
        if (size > maxBytes) throw new Error('too_large');
        yield buffer;
      }
    };
    try {
      await pipeline(limited(source), createWriteStream(path));
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
    return size;
  }

  async putBuffer(key: string, data: Buffer): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await pipeline([data], createWriteStream(path));
  }

  read(key: string, range?: { start: number; end: number }): Readable {
    return createReadStream(this.path(key), range);
  }

  async size(key: string): Promise<number | null> {
    try {
      return (await stat(this.path(key))).size;
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
