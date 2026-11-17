import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { S3Storage } from '../src/core/storage.ts';
import { setupWorkspace, type Json, type TestApp } from './helpers.ts';

const EXAMPLE_KEYS = { region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', prefix: '' };
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const signature = (headers: Record<string, string>): string => /Signature=(\w+)/.exec(headers.authorization!)![1]!;

describe('S3 storage', () => {
  test('Signature Version 4 matches botocore for the same requests', () => {
    // Expected values computed with botocore's S3SigV4Auth (AWS's own signing code) on 2026-11-17.
    const now = new Date('2026-11-17T04:53:26Z');
    const virtualHost = new S3Storage({ ...EXAMPLE_KEYS, endpoint: 'https://s3.amazonaws.com', bucket: 'examplebucket', pathStyle: false }, '/tmp');
    const pathStyle = new S3Storage({ ...EXAMPLE_KEYS, endpoint: 'http://localhost:19000', bucket: 'chat-files', pathStyle: true }, '/tmp');
    assert.equal(
      signature(virtualHost.signHeaders('GET', 'examplebucket.s3.amazonaws.com', '/test.txt', { range: 'bytes=0-9' }, EMPTY_SHA256, now)),
      '0b0b403ded3e964a62f9c511a474d8169af5abd99a192d538c1b50cacd052a1f',
    );
    assert.equal(
      signature(
        pathStyle.signHeaders('PUT', 'localhost:19000', '/chat-files/uploads/FABC123', { 'content-length': '11', 'content-type': 'application/octet-stream' }, EMPTY_SHA256, now),
      ),
      '66e530ea0ea1106b361efce5c465d00990ea7ba5de384c7e505a77bfdd3f3147',
    );
    assert.equal(
      signature(pathStyle.signHeaders('DELETE', 'localhost:19000', '/chat-files/FABC123', {}, EMPTY_SHA256, now)),
      'a94932fe6f927a7102b8a7d60fbed7dcedeeedb7a8daf8b8927c8c26a5103f1b',
    );
    assert.deepEqual(pathStyle.target('FABC123'), { host: 'localhost:19000', path: '/chat-files/FABC123' });
    assert.deepEqual(virtualHost.target('FABC123'), { host: 'examplebucket.s3.amazonaws.com', path: '/FABC123' });
  });

  describe('files go to the bucket instead of the data directory', () => {
    // A stand-in bucket: stores objects in memory and records each request.
    const objects = new Map<string, Buffer>();
    const seen: { method: string; url: string; authorization: string }[] = [];
    let bucket: Server;
    let t: TestApp;
    let dataDir: string;

    before(async () => {
      bucket = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          seen.push({ method: req.method!, url: req.url!, authorization: String(req.headers.authorization ?? '') });
          const key = req.url!;
          if (req.method === 'PUT') {
            const body = Buffer.concat(chunks);
            assert.equal(Number(req.headers['content-length']), body.length);
            objects.set(key, body);
            res.writeHead(200).end();
            return;
          }
          const object = objects.get(key);
          if (req.method === 'DELETE') {
            objects.delete(key);
            res.writeHead(204).end();
            return;
          }
          if (!object) {
            res.writeHead(404, { 'content-type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>');
            return;
          }
          if (req.method === 'HEAD') {
            res.writeHead(200, { 'content-length': object.length }).end();
            return;
          }
          const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
          if (range) {
            const part = object.subarray(Number(range[1]), Number(range[2]) + 1);
            res.writeHead(206, { 'content-length': part.length }).end(part);
            return;
          }
          res.writeHead(200, { 'content-length': object.length }).end(object);
        });
      });
      await new Promise<void>((resolve) => bucket.listen(0, '127.0.0.1', resolve));
      const endpoint = `http://127.0.0.1:${(bucket.address() as AddressInfo).port}`;

      dataDir = mkdtempSync(join(tmpdir(), 'chat-s3-'));
      const app = createApp({
        port: 0,
        host: '127.0.0.1',
        dataDir,
        publicUrl: '',
        webDir: null,
        maxUploadBytes: 1024 * 1024,
        s3: { ...EXAMPLE_KEYS, endpoint, bucket: 'chat-files', prefix: 'team/', pathStyle: true },
        cookieSecure: false,
        version: 'test',
        quiet: true,
      });
      const port = await app.listen();
      t = {
        app,
        base: `http://127.0.0.1:${port}`,
        async close() {
          await app.close();
          rmSync(dataDir, { recursive: true, force: true });
        },
      };
    });
    after(async () => {
      await t.close();
      bucket.close();
    });

    test('upload, download, byte ranges and delete all go through the bucket', async () => {
      const owner = await setupWorkspace(t);
      const content = Buffer.from('hello from the bucket');
      const { upload_url, file_id } = await owner.ok('files.getUploadURLExternal', { filename: 'notes.txt', length: content.length });
      assert.equal(await (await fetch(upload_url, { method: 'POST', body: content })).text(), `OK - ${content.length}`);
      await owner.ok('files.completeUploadExternal', { files: [{ id: file_id }], channel_id: '#general' });

      assert.deepEqual(objects.get(`/chat-files/team/${file_id}`), content);
      assert.ok(seen.every((request) => request.authorization.startsWith('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/')));
      // Nothing was written to the local files directory; the spool file is gone.
      assert.deepEqual(readdirSync(dataDir).filter((name) => name === 'files'), []);
      assert.deepEqual(readdirSync(join(dataDir, 'tmp')), []);

      const info: Json = await owner.ok('files.info', { file: file_id });
      const path = new URL(info.file.url_private).pathname;
      const whole = await fetch(`${t.base}${path}`, { headers: { cookie: owner.cookie } });
      assert.equal(await whole.text(), 'hello from the bucket');
      const part = await fetch(`${t.base}${path}`, { headers: { cookie: owner.cookie, range: 'bytes=6-9' } });
      assert.equal(part.status, 206);
      assert.equal(await part.text(), 'from');

      await owner.ok('files.delete', { file: file_id });
      assert.equal(objects.has(`/chat-files/team/${file_id}`), false);
    });

    test('an upload over the limit never reaches the bucket', async () => {
      const before = seen.filter((request) => request.method === 'PUT').length;
      const storage = t.app.ctx.storage;
      await assert.rejects(storage.put('FTOOBIG', Readable.from([Buffer.alloc(2048)]), 1024), /too_large/);
      assert.equal(seen.filter((request) => request.method === 'PUT').length, before);
    });
  });
});
