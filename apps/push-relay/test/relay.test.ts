import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createServer as createHttp2Server, type Http2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createRelay, type Relay } from '../src/relay.ts';

const listen = (server: Server | Http2Server): Promise<string> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

/** A server sending notifications: it publishes its key and signs as servers do. */
async function fakeServer(): Promise<{ origin: string; post: (relay: string, body: unknown, options?: { badSignature?: boolean }) => Promise<{ status: number; body: any }>; close: () => void }> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x!;
  let origin = '';
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, server: { url: origin, public_key: raw } }));
  });
  origin = await listen(server);
  return {
    origin,
    post: async (relay, body, options = {}) => {
      const text = JSON.stringify(body);
      const date = String(Date.now());
      const signed = `POST\n/v1/push\n${date}\n${createHash('sha256').update(text).digest('hex')}`;
      const signature = sign(null, Buffer.from(options.badSignature ? `${signed}x` : signed), privateKey).toString('base64url');
      const response = await fetch(`${relay}/v1/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-federation-server': origin, 'x-federation-date': date, 'x-federation-signature': signature },
        body: text,
      });
      return { status: response.status, body: await response.json() };
    },
    close: () => server.close(),
  };
}

describe('push relay', () => {
  const apnsSeen: { headers: Record<string, unknown>; body: any }[] = [];
  const fcmSeen: { headers: Record<string, unknown>; body: any }[] = [];
  let apns: Http2Server;
  let google: Server;
  let relay: Relay;
  let relayUrl: string;
  let sender: Awaited<ReturnType<typeof fakeServer>>;
  const appleKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const googleKey = generateKeyPairSync('rsa', { modulusLength: 2048 });

  before(async () => {
    // Apple: HTTP/2, a bearer JWT; the token `gone…` is no longer registered.
    apns = createHttp2Server((req, res) => {
      let text = '';
      req.on('data', (chunk) => (text += chunk));
      req.on('end', () => {
        apnsSeen.push({ headers: req.headers, body: JSON.parse(text) });
        if (String(req.headers[':path']).includes('/gone')) {
          res.writeHead(410, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ reason: 'Unregistered' }));
        } else {
          res.writeHead(200);
          res.end();
        }
      });
    });
    // Google: an OAuth token endpoint and FCM's send endpoint.
    google = createServer((req, res) => {
      let text = '';
      req.on('data', (chunk) => (text += chunk));
      req.on('end', () => {
        if (req.url === '/token') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }));
          return;
        }
        fcmSeen.push({ headers: req.headers, body: JSON.parse(text) });
        const gone = JSON.parse(text).message.token.startsWith('gone');
        res.writeHead(gone ? 404 : 200, { 'content-type': 'application/json' });
        res.end(gone ? JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }) : JSON.stringify({ name: 'projects/p/messages/1' }));
      });
    });
    const appleOrigin = await listen(apns);
    const googleOrigin = await listen(google);
    relay = createRelay({
      apns: { keyId: 'KEY123', teamId: 'TEAM123', key: appleKey.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), topic: 'dev.example.app', origin: appleOrigin },
      fcm: { projectId: 'p', clientEmail: 'relay@p.iam.example', privateKey: googleKey.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), tokenUrl: `${googleOrigin}/token`, sendOrigin: googleOrigin },
      perServerPerMinute: 5,
      allowPrivateServers: true,
    });
    relayUrl = await listen(relay.server);
    sender = await fakeServer();
  });
  after(async () => {
    await relay.close();
    apns.close();
    google.close();
    sender.close();
  });

  const note = (platform: 'ios' | 'android', token: string) => ({ platform, token, title: 'Maya', body: 'Lunch?', collapse_id: 'D123:1700000000.000100', data: { url: '/c/D123?ts=1700000000.000100', server: 'https://chat.example.com' } });

  test('a signed notification goes to Apple and to Google in their shapes', async () => {
    const answer = await sender.post(relayUrl, { notifications: [note('ios', 'a'.repeat(64)), note('android', 'fcm-token-'.padEnd(40, 'x'))] });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.results.map((result: any) => result.ok), [true, true]);

    const apple = apnsSeen.at(-1)!;
    assert.equal(apple.headers[':path'], `/3/device/${'a'.repeat(64)}`);
    assert.equal(apple.headers['apns-topic'], 'dev.example.app');
    assert.equal(apple.headers['apns-push-type'], 'alert');
    assert.equal(apple.headers['apns-collapse-id'], 'D123:1700000000.000100');
    assert.deepEqual(apple.body.aps.alert, { title: 'Maya', body: 'Lunch?' });
    assert.equal(apple.body.url, '/c/D123?ts=1700000000.000100');
    // The bearer token is an ES256 JWT Apple can check with the key's public half.
    const [header, claims, signature] = String(apple.headers.authorization).replace('bearer ', '').split('.');
    assert.equal(JSON.parse(Buffer.from(header!, 'base64url').toString()).kid, 'KEY123');
    assert.equal(JSON.parse(Buffer.from(claims!, 'base64url').toString()).iss, 'TEAM123');
    assert.ok(verify('sha256', Buffer.from(`${header}.${claims}`), { key: appleKey.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url')));

    const fcm = fcmSeen.at(-1)!;
    assert.equal(fcm.headers.authorization, 'Bearer ya29.test');
    assert.deepEqual(fcm.body.message.notification, { title: 'Maya', body: 'Lunch?' });
    assert.equal(fcm.body.message.data.url, '/c/D123?ts=1700000000.000100');
    assert.equal(fcm.body.message.android.collapse_key, 'D123:1700000000.000100');
  });

  test('tokens Apple or Google no longer know are reported, so the server can forget them', async () => {
    const answer = await sender.post(relayUrl, { notifications: [note('ios', `gone${'b'.repeat(60)}`), note('android', `gone${'c'.repeat(40)}`)] });
    assert.deepEqual(answer.body.results.map((result: any) => result.error), ['unregistered', 'unregistered']);
  });

  test('unsigned, badly signed, malformed and too many notifications are refused', async () => {
    assert.equal((await sender.post(relayUrl, { notifications: [note('ios', 'd'.repeat(64))] }, { badSignature: true })).status, 401);
    const unsigned = await fetch(`${relayUrl}/v1/push`, { method: 'POST', headers: { 'x-federation-server': sender.origin }, body: '{}' });
    assert.equal(unsigned.status, 401);
    assert.equal((await sender.post(relayUrl, { notifications: [{ platform: 'blackberry', token: 'x'.repeat(20), title: 'a', body: 'b' }] })).status, 400);
    // Five a minute in this test: two were sent above, two more fail after a third.
    const results = [];
    for (let i = 0; i < 3; i += 1) results.push((await sender.post(relayUrl, { notifications: [note('ios', 'e'.repeat(64))] })).status);
    assert.deepEqual(results, [200, 429, 429]);
  });

  test('a server on a private address is refused unless allowed', async () => {
    const strict = createRelay({ apns: null, fcm: null, perServerPerMinute: 10, allowPrivateServers: false });
    const strictUrl = await listen(strict.server);
    assert.equal((await sender.post(strictUrl, { notifications: [note('ios', 'f'.repeat(64))] })).status, 401);
    await strict.close();
  });
});
