import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { parseMail } from '../src/inbound/mime.ts';
import { addMember, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

const KEY = 'inbound-secret-for-tests';

function mime(to: string, extra = ''): string {
  return [
    'From: =?UTF-8?B?7ZmN6ri464+Z?= <hong@partner.test>',
    `To: ${to}`,
    'Subject: =?UTF-8?Q?Quarterly_report_=E2=80=94_Q3?=',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="outer"',
    '',
    '--outer',
    'Content-Type: multipart/alternative; boundary="inner"',
    '',
    '--inner',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Hello team,=0A=0ANumbers are attached. =EB=A7=A4=EC=B6=9C=EC=9D=B4 =EB=8A=98=EC=97=88=EC=8A=B5=EB=8B=88=EB=8B=A4.',
    '--inner',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Hello team</p>',
    '--inner--',
    '--outer',
    'Content-Type: text/csv; name="q3.csv"',
    'Content-Disposition: attachment; filename*=UTF-8\'\'%EB%A7%A4%EC%B6%9C.csv',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('quarter,revenue\nQ3,120\n').toString('base64'),
    '--outer--',
    extra,
  ].join('\r\n');
}

describe('email to a channel', () => {
  let t: TestApp;
  let owner: Session;
  let general: string;
  let address: string;

  before(async () => {
    t = await startApp({ inboundEmailDomain: 'in.acme.test', inboundEmailSecret: KEY });
    owner = await setupWorkspace(t);
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
  });
  after(() => t.close());

  const deliver = (body: string | FormData, key = KEY, headers: Record<string, string> = { 'content-type': 'message/rfc822' }): Promise<Response> =>
    fetch(`${t.base}/inbound/email`, { method: 'POST', headers: { 'x-inbound-key': key, ...(body instanceof FormData ? {} : headers) }, body });

  test('the MIME reader handles encoded words, quoted-printable, charsets and RFC 2231 file names', () => {
    const mail = parseMail(Buffer.from(mime('general.abc@in.acme.test')));
    assert.deepEqual(mail.from, { name: '홍길동', address: 'hong@partner.test' });
    assert.equal(mail.subject, 'Quarterly report — Q3');
    assert.match(mail.text, /Numbers are attached\. 매출이 늘었습니다\./);
    assert.equal(mail.attachments[0]!.filename, '매출.csv');
    assert.equal(mail.attachments[0]!.content.toString(), 'quarter,revenue\nQ3,120\n');
  });

  test('a member makes the address; mail sent there appears in the channel with its attachment', async () => {
    assert.deepEqual((await owner.ok('client.conversations.email.get', { channel: general })), { ok: true, enabled: true, address: null });
    address = (await owner.ok('client.conversations.email.create', { channel: general })).address;
    assert.match(address, /^general\.[a-z0-9]+@in\.acme\.test$/);
    const outsider = await addMember(t, owner, 'Out Sider');
    const ops = (await owner.ok('conversations.create', { name: 'ops' })).channel.id;
    assert.equal((await outsider.call('client.conversations.email.create', { channel: ops })).error, 'not_in_channel');

    assert.equal((await deliver(mime(address), 'wrong')).status, 401);
    const response = await deliver(mime(`Team <${address}>`));
    const result = (await response.json()) as Json;
    assert.equal(result.delivered, true, JSON.stringify(result));
    const message = (await owner.ok('conversations.history', { channel: general, limit: 1 })).messages[0];
    assert.match(message.text, /^\*Quarterly report — Q3\*\nFrom 홍길동 &lt;hong@partner\.test&gt;/);
    assert.match(message.text, /매출이 늘었습니다/);
    assert.equal(message.files[0].name, '매출.csv');
    const author = (await owner.ok('users.info', { user: message.user })).user;
    assert.equal(author.real_name, 'Email');
  });

  test('a SendGrid-style form works; unknown or replaced addresses are dropped quietly', async () => {
    const form = new FormData();
    form.set('email', mime(address).replace('Quarterly report', 'Form report'));
    form.set('to', address);
    assert.equal(((await (await deliver(form)).json()) as Json).delivered, true);
    assert.equal(((await (await deliver(mime('general.nope@in.acme.test'))).json()) as Json).delivered, false);
    const replaced = (await owner.ok('client.conversations.email.create', { channel: general })).address;
    assert.notEqual(replaced, address);
    assert.equal(((await (await deliver(mime(address))).json()) as Json).delivered, false, 'the old address stopped working');
    await owner.ok('client.conversations.email.delete', { channel: general });
    assert.equal(((await (await deliver(mime(replaced))).json()) as Json).delivered, false);
  });
});

describe('email to a channel, not configured', () => {
  test('the endpoint does not exist and addresses cannot be made', async () => {
    const t = await startApp();
    try {
      const owner = await setupWorkspace(t);
      assert.equal((await fetch(`${t.base}/inbound/email`, { method: 'POST', body: 'x' })).status, 404);
      const general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
      assert.equal((await owner.call('client.conversations.email.create', { channel: general })).error, 'not_configured');
    } finally {
      await t.close();
    }
  });
});
