import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/** Read-only view of an export: a zip file or an unpacked directory. */
export interface Archive {
  /** Entry names with `/` separators, files only. */
  names(): string[];
  read(name: string): Buffer;
  close(): void;
}

export function openArchive(path: string): Archive {
  return statSync(path).isDirectory() ? new DirectoryArchive(path) : new ZipArchive(path);
}

class DirectoryArchive implements Archive {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  names(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) out.push(relative(this.root, full).split(sep).join('/'));
      }
    };
    walk(this.root);
    return out;
  }

  read(name: string): Buffer {
    return readFileSync(join(this.root, ...name.split('/')));
  }

  close(): void {}
}

interface ZipEntry {
  method: number;
  compressedSize: number;
  headerOffset: number;
}

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * A minimal zip reader: stored and deflated entries, with zip64 so large
 * exports (over 4 GB or 65,535 files) work. No encryption, no multi-disk.
 */
class ZipArchive implements Archive {
  private readonly fd: number;
  private readonly entries = new Map<string, ZipEntry>();

  constructor(path: string) {
    this.fd = openSync(path, 'r');
    try {
      this.readDirectory(statSync(path).size);
    } catch (error) {
      closeSync(this.fd);
      throw error;
    }
  }

  private readAt(position: number, length: number): Buffer {
    const buffer = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const read = readSync(this.fd, buffer, done, length - done, position + done);
      if (read === 0) throw new Error('unexpected end of zip file');
      done += read;
    }
    return buffer;
  }

  private readDirectory(fileSize: number): void {
    // The end-of-central-directory record sits at the end, before an optional comment.
    const tailLength = Math.min(fileSize, 65_557);
    const tail = this.readAt(fileSize - tailLength, tailLength);
    let at = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD) {
        at = i;
        break;
      }
    }
    if (at < 0) throw new Error('not a zip file');
    let count = tail.readUInt16LE(at + 10);
    let size = tail.readUInt32LE(at + 12);
    let offset = tail.readUInt32LE(at + 16);

    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
      const locatorAt = fileSize - tailLength + at - 20;
      const locator = this.readAt(locatorAt, 20);
      if (locator.readUInt32LE(0) !== EOCD64_LOCATOR) throw new Error('zip64 locator missing');
      const record = this.readAt(Number(locator.readBigUInt64LE(8)), 56);
      if (record.readUInt32LE(0) !== EOCD64) throw new Error('zip64 record missing');
      count = Number(record.readBigUInt64LE(32));
      size = Number(record.readBigUInt64LE(40));
      offset = Number(record.readBigUInt64LE(48));
    }

    const directory = this.readAt(offset, size);
    let cursor = 0;
    for (let i = 0; i < count; i += 1) {
      if (directory.readUInt32LE(cursor) !== CENTRAL) throw new Error('corrupt zip directory');
      const method = directory.readUInt16LE(cursor + 10);
      let compressedSize = directory.readUInt32LE(cursor + 20);
      let uncompressedSize = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      let headerOffset = directory.readUInt32LE(cursor + 42);
      const name = directory.toString('utf8', cursor + 46, cursor + 46 + nameLength);

      // The zip64 extra field carries, in this order, only the values that overflowed.
      let extra = cursor + 46 + nameLength;
      const extraEnd = extra + extraLength;
      while (extra + 4 <= extraEnd) {
        const id = directory.readUInt16LE(extra);
        const length = directory.readUInt16LE(extra + 2);
        if (id === 0x0001) {
          let field = extra + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = Number(directory.readBigUInt64LE(field));
            field += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(directory.readBigUInt64LE(field));
            field += 8;
          }
          if (headerOffset === 0xffffffff) headerOffset = Number(directory.readBigUInt64LE(field));
        }
        extra += 4 + length;
      }

      if (!name.endsWith('/')) this.entries.set(name, { method, compressedSize, headerOffset });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  read(name: string): Buffer {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`no such entry: ${name}`);
    const header = this.readAt(entry.headerOffset, 30);
    if (header.readUInt32LE(0) !== LOCAL) throw new Error(`corrupt entry: ${name}`);
    const dataAt = entry.headerOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const data = entry.compressedSize > 0 ? this.readAt(dataAt, entry.compressedSize) : Buffer.alloc(0);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRawSync(data);
    throw new Error(`unsupported compression method ${entry.method} in ${name}`);
  }

  close(): void {
    closeSync(this.fd);
  }
}
