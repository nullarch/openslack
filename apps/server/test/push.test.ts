import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { addMember, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** A browser's push service: records what arrives and answers with a chosen status. */
class FakePushService {
  readonly received: Received[] = [];
  status = 201;
  private server: Server | null = null;
  base = '';
  private waiters: ((item: Received) => void)[] = [];

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const item = { path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
        this.received.push(item);
        this.waiters.splice(0).forEach((resolve) => resolve(item));
        res.writeHead(this.status);
        res.end();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  next(timeoutMs = 2000): Promise<Received> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no push arrived')), timeoutMs);
      this.waiters.push((item) => {
        clearTimeout(timer);
        resolve(item);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server?.close(() => resolve()));
  }
}

/** A browser's side of a subscription: its keys, and decryption of what arrives (RFC 8291). */
function browserKeys(): { p256dh: string; auth: string; decrypt(body: Buffer): Json } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const uaPublic = ecdh.getPublicKey();
  const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest();
  return {
    p256dh: uaPublic.toString('base64url'),
    auth: auth.toString('base64url'),
    decrypt(body: Buffer): Json {
      const salt = body.subarray(0, 16);
      const idLength = body.readUInt8(20);
      const asPublic = body.subarray(21, 21 + idLength);
      const sealed = body.subarray(21 + idLength);
      const shared = ecdh.computeSecret(asPublic);
      const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
      const prk = hmac(salt, ikm);
      const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
      const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
      assert.equal(plain.at(-1), 2);
      return JSON.parse(plain.subarray(0, -1).toString('utf8'));
    },
  };
}

function checkVapid(header: string, serverKey: string, audience: string): void {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(match, header);
  assert.equal(match[2], serverKey);
  const [head, body, signature] = match[1]!.split('.');
  const raw = Buffer.from(serverKey, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url')));
  const claims = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'));
  assert.equal(claims.aud, audience);
  assert.ok(claims.exp > Date.now() / 1000);
}

describe('web push', () => {
  let t: TestApp;
  let service: FakePushService;
  let owner: Session;
  let mina: Session;
  let general: string;

  before(async () => {
    service = new FakePushService();
    await service.start();
    t = await startApp();
    owner = await setupWorkspace(t);
    mina = await addMember(t, owner, 'Mina Member');
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
  });
  after(async () => {
    await t.close();
    await service.stop();
  });

  test('a subscription must look like one', async () => {
    const keys = browserKeys();
    assert.equal((await mina.call('client.push.subscribe', { subscription: { endpoint: 'ftp://x', keys } })).error, 'invalid_subscription');
    assert.equal((await mina.call('client.push.subscribe', { subscription: { endpoint: `${service.base}/a`, keys: { p256dh: 'short', auth: keys.auth } } })).error, 'invalid_subscription');
    const status = await mina.ok('client.push.status');
    assert.equal(Buffer.from(status.vapid_public_key, 'base64url').length, 65);
    assert.equal((await mina.ok('client.boot')).vapid_public_key, status.vapid_public_key);
  });

  test('a mention reaches an offline person’s device, signed and encrypted', async () => {
    const keys = browserKeys();
    await mina.ok('client.push.subscribe', { subscription: { endpoint: `${service.base}/sub/mina`, keys: { p256dh: keys.p256dh, auth: keys.auth } } });
    const arriving = service.next();
    const posted = await owner.ok('chat.postMessage', { channel: general, text: `deploy at noon, ok <@${mina.userId}>?` });
    const push = await arriving;
    assert.equal(push.path, '/sub/mina');
    assert.equal(push.headers['content-encoding'], 'aes128gcm');
    assert.ok(Number(push.headers.ttl) > 0);
    checkVapid(String(push.headers.authorization), (await mina.ok('client.push.status')).vapid_public_key, service.base);
    const payload = keys.decrypt(push.body);
    assert.equal(payload.title, 'Olive Owner in #general');
    assert.equal(payload.body, 'deploy at noon, ok @mina.member?'.replace('@mina.member', '@Mina Member'));
    assert.equal(payload.url, `/c/${general}?ts=${posted.ts}`);
  });

  test('no push for people with a tab open, for muted conversations, or for unmentioned messages', async () => {
    const before = service.received.length;
    await owner.ok('chat.postMessage', { channel: general, text: 'nobody in particular' });
    const stream = await mina.connect();
    await owner.ok('chat.postMessage', { channel: general, text: `while online <@${mina.userId}>` });
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    await mina.ok('client.conversations.setPrefs', { channel: general, muted: true });
    await owner.ok('chat.postMessage', { channel: general, text: `muted <@${mina.userId}>` });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(service.received.length, before);
    await mina.ok('client.conversations.setPrefs', { channel: general, muted: false });
  });

  test('direct messages push; a gone subscription is removed', async () => {
    const arriving = service.next();
    await owner.ok('chat.postMessage', { channel: mina.userId, text: 'quick question' });
    const push = await arriving;
    assert.equal(push.path, '/sub/mina');
    service.status = 410;
    const gone = service.next();
    await owner.ok('chat.postMessage', { channel: mina.userId, text: 'still there?' });
    await gone;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await mina.ok('client.push.status')).subscriptions, 0);
    service.status = 201;
  });
});
