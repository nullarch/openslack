import assert from 'node:assert/strict';
import { createServer as createHttp2Server, type Http2Server } from 'node:http2';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createRelay, type Relay } from '../../push-relay/src/relay.ts';
import { until } from './canvas-client.ts';
import { addMember, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

/** The native apps' notifications: server → relay (signed) → Apple, here a stand-in. */
describe('push to the native apps through the relay', () => {
  const seen: { path: string; body: Json }[] = [];
  let apple: Http2Server;
  let relay: Relay;
  let t: TestApp;
  let owner: Session;
  let mina: Session;

  before(async () => {
    apple = createHttp2Server((req, res) => {
      let text = '';
      req.on('data', (chunk) => (text += chunk));
      req.on('end', () => {
        seen.push({ path: String(req.headers[':path']), body: JSON.parse(text) });
        const gone = String(req.headers[':path']).includes('/gone');
        res.writeHead(gone ? 410 : 200);
        res.end(gone ? JSON.stringify({ reason: 'Unregistered' }) : '');
      });
    });
    await new Promise<void>((resolve) => apple.listen(0, '127.0.0.1', resolve));
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    relay = createRelay({
      apns: { keyId: 'K', teamId: 'T', key, topic: 'dev.example.app', origin: `http://127.0.0.1:${(apple.address() as AddressInfo).port}` },
      fcm: null,
      perServerPerMinute: 100,
      allowPrivateServers: true,
    });
    await new Promise<void>((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
    t = await startApp({ pushRelayUrl: `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}` });
    owner = await setupWorkspace(t);
    mina = await addMember(t, owner, 'Mina Member');
  });
  after(async () => {
    await t.close();
    await relay.close();
    apple.close();
  });

  test('a phone registers; a direct message to someone away reaches it, and opens the message', async () => {
    assert.equal((await mina.call('client.push.registerDevice', { platform: 'blackberry', device_token: 'x'.repeat(64) })).error, 'invalid_arguments');
    const token = 'a1'.repeat(32);
    assert.deepEqual(await mina.ok('client.push.registerDevice', { platform: 'ios', device_token: token }), { ok: true, relay: true });
    const status = await mina.ok('client.push.status');
    assert.equal(status.native_relay, true);
    assert.equal(status.devices, 1);

    const dm = (await owner.ok('conversations.open', { users: mina.userId })).channel.id;
    const posted = await owner.ok('chat.postMessage', { channel: dm, text: 'Lunch at noon?' });
    await until(() => seen.some((entry) => entry.path === `/3/device/${token}`));
    const sent = seen.find((entry) => entry.path === `/3/device/${token}`)!;
    assert.equal(sent.body.aps.alert.title, 'Olive Owner');
    assert.equal(sent.body.aps.alert.body, 'Lunch at noon?');
    assert.equal(sent.body.url, `/c/${dm}?ts=${posted.ts}`);
    assert.equal(sent.body.server, t.app.ctx.config.publicUrl);
  });

  test('a phone Apple no longer knows is forgotten', async () => {
    const gone = `gone${'b'.repeat(60)}`;
    await mina.ok('client.push.registerDevice', { platform: 'ios', device_token: gone });
    const dm = (await owner.ok('conversations.open', { users: mina.userId })).channel.id;
    await owner.ok('chat.postMessage', { channel: dm, text: 'Still there?' });
    await until(async () => (await mina.ok('client.push.status')).devices === 1);
    await mina.ok('client.push.unregisterDevice', { device_token: 'a1'.repeat(32) });
    assert.equal((await mina.ok('client.push.status')).devices, 0);
  });

  test('without a relay the server says so', async () => {
    const plain = await startApp();
    const someone = await setupWorkspace(plain);
    assert.equal((await someone.ok('client.push.status')).native_relay, false);
    await plain.close();
  });
});
