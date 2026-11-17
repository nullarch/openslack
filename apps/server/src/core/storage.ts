import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Where uploaded files live. Keys are opaque, URL-safe identifiers chosen by
 * the caller. Two backends: a local directory (the default) and any
 * S3-compatible bucket.
 */
export interface Storage {
  /** Write a stream to `key`, rejecting with `too_large` once `maxBytes` is exceeded. Resolves with the size. */
  put(key: string, source: Readable, maxBytes: number): Promise<number>;
  putBuffer(key: string, data: Buffer): Promise<void>;
  /** A stream of the stored bytes; `range` is inclusive at both ends. */
  read(key: string, range?: { start: number; end: number }): Readable;
  /** The stored size, or null when the key does not exist. */
  size(key: string): Promise<number | null>;
  remove(key: string): Promise<void>;
}

function checkKey(key: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`invalid storage key: ${key}`);
}

/** Pass bytes through, failing with `too_large` once more than `maxBytes` went by. */
async function* limited(input: Readable, maxBytes: number, counter: { size: number }): AsyncGenerator<Buffer> {
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    counter.size += buffer.length;
    if (counter.size > maxBytes) throw new Error('too_large');
    yield buffer;
  }
}

// ── Local directory ─────────────────────────────────────────────────────────

export class LocalStorage implements Storage {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private path(key: string): string {
    checkKey(key);
    return join(this.root, key.slice(0, 2), key);
  }

  async put(key: string, source: Readable, maxBytes: number): Promise<number> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const counter = { size: 0 };
    try {
      await pipeline(limited(source, maxBytes, counter), createWriteStream(path));
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
    return counter.size;
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

// ── S3-compatible bucket ────────────────────────────────────────────────────

export interface S3Config {
  /** Service address, e.g. `https://s3.eu-central-1.amazonaws.com` or `http://minio:9000`. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Prefix for every object key, e.g. `chat/`. */
  prefix: string;
  /** Address the bucket as `endpoint/bucket` (MinIO and most self-hosted services) rather than `bucket.endpoint`. */
  pathStyle: boolean;
}

const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as Signature Version 4 wants it; `/` is kept in paths. */
function encodeS3(value: string, keepSlash: boolean): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(keepSlash ? /%2F/g : /$^/, '/');
}

interface S3Response {
  status: number;
  headers: IncomingMessage['headers'];
  body: IncomingMessage;
}

/**
 * Objects in an S3-compatible bucket, signed with AWS Signature Version 4.
 * Written against the published protocol, with no SDK, to keep the server's
 * install small. Uploads are spooled to a local temporary file first, because
 * S3 needs the length before the body.
 */
export class S3Storage implements Storage {
  private readonly config: S3Config;
  private readonly base: URL;
  private readonly spool: string;

  constructor(config: S3Config, spoolDir: string) {
    this.config = config;
    this.base = new URL(config.endpoint);
    this.spool = spoolDir;
  }

  /** Host and request path for an object (public for tests). */
  target(key: string): { host: string; path: string } {
    checkKey(key);
    const objectKey = `${this.config.prefix}${key}`;
    const basePath = this.base.pathname.replace(/\/$/, '');
    if (this.config.pathStyle) {
      return { host: this.base.host, path: `${basePath}/${encodeS3(this.config.bucket, false)}/${encodeS3(objectKey, true)}` };
    }
    return { host: `${this.config.bucket}.${this.base.host}`, path: `${basePath}/${encodeS3(objectKey, true)}` };
  }

  /** The headers for a signed request. Public so the signing can be checked against reference implementations. */
  signHeaders(
    method: string,
    host: string,
    path: string,
    extra: Record<string, string>,
    payloadHash: string,
    now = new Date(),
  ): Record<string, string> {
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const day = amzDate.slice(0, 8);
    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...Object.fromEntries(Object.entries(extra).map(([name, value]) => [name.toLowerCase(), value])),
    };
    const names = Object.keys(headers).sort();
    const canonical = [
      method,
      path,
      '',
      ...names.map((name) => `${name}:${headers[name]!.trim()}`),
      '',
      names.join(';'),
      payloadHash,
    ].join('\n');
    const scope = `${day}/${this.config.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
    const key = hmac(hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, day), this.config.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', key).update(toSign).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    return headers;
  }

  private send(method: string, key: string, options: { headers?: Record<string, string>; body?: Readable; length?: number } = {}): Promise<S3Response> {
    const { host, path } = this.target(key);
    const extra = { ...options.headers };
    if (options.length !== undefined) extra['content-length'] = String(options.length);
    const headers = this.signHeaders(method, host, path, extra, options.body ? 'UNSIGNED-PAYLOAD' : sha256Hex(''));
    const request = this.base.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = request(
        { protocol: this.base.protocol, hostname: host.replace(/:\d+$/, ''), port: this.base.port || undefined, method, path, headers, timeout: 60_000 },
        (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res }),
      );
      req.on('timeout', () => req.destroy(new Error('storage request timed out')));
      req.on('error', reject);
      if (options.body) options.body.pipe(req);
      else req.end();
    });
  }

  private static async failure(response: S3Response, action: string): Promise<Error> {
    let text = '';
    for await (const chunk of response.body) text += chunk;
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? `HTTP ${response.status}`;
    return new Error(`storage ${action} failed: ${code}`);
  }

  private async upload(key: string, path: string, size: number): Promise<void> {
    const response = await this.send('PUT', key, { body: createReadStream(path), length: size, headers: { 'content-type': 'application/octet-stream' } });
    if (response.status !== 200) throw await S3Storage.failure(response, 'upload');
    response.body.resume();
  }

  async put(key: string, source: Readable, maxBytes: number): Promise<number> {
    checkKey(key);
    await mkdir(this.spool, { recursive: true });
    const temp = join(this.spool, `${key}.${randomBytes(6).toString('hex')}`);
    const counter = { size: 0 };
    try {
      await pipeline(limited(source, maxBytes, counter), createWriteStream(temp));
      await this.upload(key, temp, counter.size);
      return counter.size;
    } finally {
      await rm(temp, { force: true });
    }
  }

  async putBuffer(key: string, data: Buffer): Promise<void> {
    const response = await this.send('PUT', key, {
      body: Readable.from([data]),
      length: data.length,
      headers: { 'content-type': 'application/octet-stream' },
    });
    if (response.status !== 200) throw await S3Storage.failure(response, 'upload');
    response.body.resume();
  }

  read(key: string, range?: { start: number; end: number }): Readable {
    const out = new PassThrough();
    const headers = range ? { range: `bytes=${range.start}-${range.end}` } : undefined;
    this.send('GET', key, { headers })
      .then(async (response) => {
        if (response.status !== 200 && response.status !== 206) {
          out.destroy(await S3Storage.failure(response, 'read'));
          return;
        }
        response.body.pipe(out);
        response.body.on('error', (error) => out.destroy(error));
      })
      .catch((error: Error) => out.destroy(error));
    return out;
  }

  async size(key: string): Promise<number | null> {
    const response = await this.send('HEAD', key);
    response.body.resume();
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error(`storage size check failed: HTTP ${response.status}`);
    return Number(response.headers['content-length'] ?? 0);
  }

  async remove(key: string): Promise<void> {
    const response = await this.send('DELETE', key);
    response.body.resume();
    if (response.status !== 204 && response.status !== 200 && response.status !== 404) {
      throw new Error(`storage delete failed: HTTP ${response.status}`);
    }
  }
}

/** The configured backend: a bucket when `s3` is given, otherwise `<dataDir>/files`. */
export function createStorage(dataDir: string, s3?: S3Config | null): Storage {
  if (s3) return new S3Storage(s3, join(dataDir, 'tmp'));
  return new LocalStorage(join(dataDir, 'files'));
}
