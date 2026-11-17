import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { clientIp, inRanges, parseCidr } from '../src/core/network.ts';
import { setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

describe('IP allowlist', () => {
  let t: TestApp;
  let owner: Session;
  let bot: string;

  before(async () => {
    t = await startApp({ trustProxy: 1 });
    owner = await setupWorkspace(t);
    bot = (await owner.ok('client.apps.create', { name: 'Ops Bot' })).bot_token;
  });
  after(() => t.close());

  const from = (address: string, method: string, args: Json = {}, auth: { cookie?: string; token?: string } = { cookie: owner.cookie }): Promise<Json> =>
    fetch(`${t.base}/api/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: t.base,
        'x-forwarded-for': address,
        ...(auth.cookie ? { cookie: auth.cookie } : {}),
        ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
      },
      body: JSON.stringify(args),
    }).then((response) => response.json() as Promise<Json>);

  test('ranges, IPv6 and proxies', () => {
    assert.ok(inRanges(['10.0.0.0/8'], '10.20.30.40'));
    assert.ok(inRanges(['10.0.0.0/8'], '::ffff:10.1.2.3'));
    assert.ok(!inRanges(['10.0.0.0/8'], '11.0.0.1'));
    assert.ok(inRanges(['2001:db8::/32'], '2001:db8:1::5'));
    assert.equal(parseCidr('10.0.0.0/33'), null);
    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.2' } } as never;
    assert.equal(clientIp(t.app.ctx, req), '10.0.0.2', 'one trusted proxy: the entry it added');
  });

  test('outside addresses lose the web client and sign-in; tokens only when asked; no locking yourself out', async () => {
    assert.equal((await owner.call('client.admin.setIpAllowlist', { cidrs: ['198.51.100.0/24'] })).error, 'would_lock_out');
    assert.equal((await owner.call('client.admin.setIpAllowlist', { cidrs: ['not-an-ip'] })).error, 'invalid_cidr');
    await owner.ok('client.admin.setIpAllowlist', { cidrs: ['127.0.0.1/32', '198.51.100.0/24'] });

    assert.equal((await from('198.51.100.7', 'auth.test')).ok, true, 'an allowed office address');
    const outside = await from('203.0.113.9', 'auth.test');
    assert.equal(outside.error, 'access_denied');
    assert.equal(outside.detail, 'ip_not_allowed');
    assert.equal((await from('203.0.113.9', 'client.signin', { email: 'owner@acme.test', password: 'correct horse battery' }, {})).error, 'access_denied');
    assert.equal((await from('203.0.113.9', 'auth.test', {}, { token: bot })).ok, true, 'tokens are not limited unless asked');

    await from('198.51.100.7', 'client.admin.setIpAllowlist', { cidrs: ['198.51.100.0/24'], applies_to_tokens: true });
    assert.equal((await from('203.0.113.9', 'auth.test', {}, { token: bot })).error, 'access_denied');
    assert.equal((await from('198.51.100.8', 'auth.test', {}, { token: bot })).ok, true);

    t.app.ctx.config.ipAllowlistDisabled = true;
    assert.equal((await from('203.0.113.9', 'auth.test')).ok, true, 'IP_ALLOWLIST_DISABLED lifts it');
    t.app.ctx.config.ipAllowlistDisabled = false;
    const status = await from('198.51.100.7', 'client.admin.ipAllowlist');
    assert.equal(status.your_address, '198.51.100.7');
    await from('198.51.100.7', 'client.admin.setIpAllowlist', { cidrs: [] });
    assert.equal((await from('203.0.113.9', 'auth.test')).ok, true, 'an empty list turns it off');
  });
});
