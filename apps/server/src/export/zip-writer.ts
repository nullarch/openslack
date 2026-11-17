import type { Writable } from 'node:stream';
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Writes a zip archive to a stream, one entry at a time. Each entry is
 * compressed in memory first, so the headers carry real sizes and the archive
 * reads with any unzip tool. Switches to zip64 records when the archive grows
 * past 4 GB or 65,535 entries.
 */

interface Written {
  name: Buffer;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
  method: number;
  time: number;
  date: number;
}

const U32 = 0xffffffff;
const U16 = 0xffff;

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

export class ZipWriter {
  private readonly out: Writable;
  private readonly entries: Written[] = [];
  private offset = 0;

  constructor(out: Writable) {
    this.out = out;
  }

  private async write(chunk: Buffer): Promise<void> {
    this.offset += chunk.length;
    if (!this.out.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = (): void => {
          this.out.off('error', onError);
          resolve();
        };
        const onError = (error: Error): void => {
          this.out.off('drain', onDrain);
          reject(error);
        };
        this.out.once('drain', onDrain);
        this.out.once('error', onError);
      });
    }
  }

  async add(path: string, data: Buffer, modified = new Date()): Promise<void> {
    const name = Buffer.from(path, 'utf8');
    const deflated = deflateRawSync(data);
    // Already-compressed data (images, archives) is stored as is.
    const store = deflated.length >= data.length;
    const body = store ? data : deflated;
    const { time, date } = dosTime(modified);
    const entry: Written = {
      name,
      crc: crc32(data),
      compressedSize: body.length,
      size: data.length,
      offset: this.offset,
      method: store ? 0 : 8,
      time,
      date,
    };
    const big = entry.size >= U32 || entry.compressedSize >= U32;
    const extra = big ? Buffer.alloc(20) : Buffer.alloc(0);
    if (big) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(entry.size), 4);
      extra.writeBigUInt64LE(BigInt(entry.compressedSize), 12);
    }
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(big ? 45 : 20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(entry.method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(big ? U32 : entry.compressedSize, 18);
    header.writeUInt32LE(big ? U32 : entry.size, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(extra.length, 28);
    this.entries.push(entry);
    await this.write(Buffer.concat([header, name, extra]));
    await this.write(body);
  }

  async finish(): Promise<void> {
    const start = this.offset;
    for (const entry of this.entries) {
      const needs = { size: entry.size >= U32, compressed: entry.compressedSize >= U32, offset: entry.offset >= U32 };
      const fields = [needs.size ? entry.size : null, needs.compressed ? entry.compressedSize : null, needs.offset ? entry.offset : null].filter(
        (value): value is number => value !== null,
      );
      const extra = Buffer.alloc(fields.length ? 4 + fields.length * 8 : 0);
      if (fields.length) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(fields.length * 8, 2);
        fields.forEach((value, index) => extra.writeBigUInt64LE(BigInt(value), 4 + index * 8));
      }
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(fields.length ? 45 : 20, 4);
      header.writeUInt16LE(fields.length ? 45 : 20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(entry.time, 12);
      header.writeUInt16LE(entry.date, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(needs.compressed ? U32 : entry.compressedSize, 20);
      header.writeUInt32LE(needs.size ? U32 : entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt16LE(extra.length, 30);
      header.writeUInt32LE(needs.offset ? U32 : entry.offset, 42);
      await this.write(Buffer.concat([header, entry.name, extra]));
    }
    const size = this.offset - start;
    const count = this.entries.length;
    const zip64 = count >= U16 || size >= U32 || start >= U32;
    if (zip64) {
      const record = Buffer.alloc(56);
      record.writeUInt32LE(0x06064b50, 0);
      record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE(45, 12);
      record.writeUInt16LE(45, 14);
      record.writeBigUInt64LE(BigInt(count), 24);
      record.writeBigUInt64LE(BigInt(count), 32);
      record.writeBigUInt64LE(BigInt(size), 40);
      record.writeBigUInt64LE(BigInt(start), 48);
      const recordOffset = this.offset;
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(recordOffset), 8);
      locator.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([record, locator]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(count, U16), 8);
    end.writeUInt16LE(Math.min(count, U16), 10);
    end.writeUInt32LE(zip64 ? U32 : size, 12);
    end.writeUInt32LE(zip64 ? U32 : start, 16);
    await this.write(end);
  }
}
