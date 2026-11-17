import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, Session, setupWorkspace, startApp, type TestApp } from './helpers.ts';
import { MailSink } from './mail-sink.ts';

describe('without mail', () => {
  let t: TestApp;
  let owner: Session;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
  });
  after(() => t.close());

  test('everything still works and the mail-only paths say so', async () => {
    const status = await new Session(t.base).ok('client.status');
    assert.equal(status.mail_enabled, false);
    assert.equal((await new Session(t.base).call('client.signin.sendCode', { email: 'owner@acme.test' })).error, 'mail_not_configured');
    assert.equal((await new Session(t.base).call('client.password.sendReset', { email: 'owner@acme.test' })).error, 'mail_not_configured');
    const { invite, email_sent } = await owner.ok('client.invites.create', { email: 'new@acme.test' });
    assert.equal(email_sent, false);
    assert.match(invite.url, /\/join\//);
  });
});

describe('with mail', () => {
  let t: TestApp;
  let sink: MailSink;
  let owner: Session;

  before(async () => {
    sink = new MailSink();
    const smtpUrl = await sink.start();
    t = await startApp({ smtpUrl, mailFrom: 'Acme <chat@acme.test>' });
    owner = await setupWorkspace(t);
  });
  after(async () => {
    await t.close();
    await sink.stop();
  });

  test('an invitation is mailed with a link that works', async () => {
    const { invite, email_sent } = await owner.ok('client.invites.create', { email: 'lee@acme.test' });
    assert.equal(email_sent, true);
    const mail = await sink.next((item) => item.to.includes('lee@acme.test'));
    assert.equal(mail.from, 'chat@acme.test');
    assert.match(mail.subject, /invited you to Acme/);
    assert.ok(mail.text.includes(`/join/${invite.code}`));
    const lee = new Session(t.base);
    await lee.ok('client.signup', { code: invite.code, email: 'lee@acme.test', password: 'a long enough password', real_name: 'Lee' });
    assert.equal((await lee.ok('auth.test')).user, 'lee');
  });

  test('sign in with a code sent by mail; wrong codes run out', async () => {
    const member = await addMember(t, owner, 'Mina Member');
    const browser = new Session(t.base);
    assert.equal((await browser.ok('client.status')).mail_enabled, true);

    await browser.ok('client.signin.sendCode', { email: 'mina.member@acme.test' });
    const mail = await sink.next((item) => item.to.includes('mina.member@acme.test') && /sign-in code/.test(item.subject));
    const code = /\b(\d{6})\b/.exec(mail.subject)![1]!;
    assert.ok(mail.text.includes(code));
    const wrong = code === '000000' ? '111111' : '000000';
    assert.equal((await browser.call('client.signin.withCode', { email: 'mina.member@acme.test', code: wrong })).error, 'invalid_code');
    const signedIn = await browser.ok('client.signin.withCode', { email: 'mina.member@acme.test', code });
    assert.equal(signedIn.user_id, member.userId);
    assert.equal((await browser.ok('auth.test')).user_id, member.userId);
    // A used code does not work twice.
    assert.equal((await new Session(t.base).call('client.signin.withCode', { email: 'mina.member@acme.test', code })).error, 'invalid_code');

    // Five wrong guesses use up a code, even the right one afterwards.
    await browser.ok('client.signin.sendCode', { email: 'mina.member@acme.test' });
    const second = await sink.next((item) => item.to.includes('mina.member@acme.test') && item !== mail && /sign-in code/.test(item.subject));
    const secondCode = /\b(\d{6})\b/.exec(second.subject)![1]!;
    const bad = secondCode === '999999' ? '888888' : '999999';
    for (let i = 0; i < 5; i += 1) await browser.call('client.signin.withCode', { email: 'mina.member@acme.test', code: bad });
    assert.equal((await browser.call('client.signin.withCode', { email: 'mina.member@acme.test', code: secondCode })).error, 'invalid_code');
  });

  test('asking for a code for an unknown address looks the same and sends nothing', async () => {
    const before = sink.mails.length;
    const result = await new Session(t.base).ok('client.signin.sendCode', { email: 'nobody@acme.test' });
    assert.deepEqual(Object.keys(result), ['ok']);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(sink.mails.length, before);
  });

  test('a password reset link sets a new password, signs out old sessions and works once', async () => {
    const member = await addMember(t, owner, 'Rey Reset');
    const browser = new Session(t.base);
    await browser.ok('client.password.sendReset', { email: 'rey.reset@acme.test' });
    const mail = await sink.next((item) => item.to.includes('rey.reset@acme.test') && /Reset/.test(item.subject));
    const token = /\/reset\/([A-Za-z0-9_.-]+)/.exec(mail.text)![1]!;
    assert.ok(token.startsWith(`${member.userId}-`));

    assert.equal((await browser.call('client.password.reset', { token, password: 'short' })).error, 'password_too_short');
    await browser.ok('client.password.reset', { token, password: 'a brand new password' });
    assert.equal((await browser.ok('auth.test')).user_id, member.userId);
    // The session from before the reset is gone.
    assert.equal((await member.call('auth.test')).error, 'invalid_auth');
    assert.equal((await new Session(t.base).call('client.password.reset', { token, password: 'another new password' })).error, 'invalid_token');
    const again = new Session(t.base);
    await again.ok('client.signin', { email: 'rey.reset@acme.test', password: 'a brand new password' });
  });
});
