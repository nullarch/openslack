import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { sendEmailDigests } from '../src/attention/email.ts';
import { getConv } from '../src/core/conversations.ts';
import { postMessage } from '../src/core/messages.ts';
import { MailSink } from './mail-sink.ts';
import { addMember, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

const later = (minutes: number): number => Math.floor(Date.now() / 1000) + minutes * 60;

describe('email notifications for missed mentions and direct messages', () => {
  let t: TestApp;
  let sink: MailSink;
  let owner: Session;
  let mia: Session;
  let general: string;

  before(async () => {
    sink = new MailSink();
    t = await startApp({ smtpUrl: await sink.start(), mailFrom: 'Acme <chat@acme.test>' });
    owner = await setupWorkspace(t);
    mia = await addMember(t, owner, 'Mia Member');
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
  });
  after(async () => {
    await t.close();
    await sink.stop();
  });

  test('one email lists unread mentions and DMs; read or seen messages are not mailed again', async () => {
    await owner.ok('chat.postMessage', { channel: general, text: `<@${mia.userId}> can you review the launch notes?` });
    await owner.ok('chat.postMessage', { channel: general, text: 'not about Mia at all' });
    const dm = (await owner.ok('conversations.open', { users: mia.userId })).channel.id;
    await owner.ok('chat.postMessage', { channel: dm, text: 'are you around later?' });

    // Too fresh: two minutes to read it elsewhere first.
    assert.equal(await sendEmailDigests(t.app.ctx), 0);
    assert.equal(await sendEmailDigests(t.app.ctx, later(3)), 1);
    const mail = await sink.next((item) => item.to.includes('mia.member@acme.test') || item.text.includes('launch notes'));
    assert.match(mail.subject, /1 mention and 1 direct message in /);
    assert.match(mail.text, /can you review the launch notes/);
    assert.match(mail.text, /are you around later/);
    assert.doesNotMatch(mail.text, /not about Mia/);

    // Nothing new: no second email, even after the interval.
    assert.equal(await sendEmailDigests(t.app.ctx, later(30)), 0);
    // Something new, but within 15 minutes of the last email: wait.
    await owner.ok('chat.postMessage', { channel: dm, text: 'ping again' });
    assert.equal(await sendEmailDigests(t.app.ctx, later(10)), 0);
    assert.equal(await sendEmailDigests(t.app.ctx, later(20)), 1);
    assert.doesNotMatch(sink.mails.at(-1)!.text, /launch notes/, 'what was mailed before is not repeated');
  });

  test('reading, muting, being online or turning it off means no email', async () => {
    const dm = (await owner.ok('conversations.open', { users: mia.userId })).channel.id;
    const posted = await owner.ok('chat.postMessage', { channel: dm, text: 'read this one' });
    await mia.ok('conversations.mark', { channel: dm, ts: posted.ts });
    assert.equal(await sendEmailDigests(t.app.ctx, later(60)), 0);

    await mia.ok('client.prefs.set', { prefs: { email_notifications: 'off' } });
    await owner.ok('chat.postMessage', { channel: dm, text: 'while emails are off' });
    assert.equal(await sendEmailDigests(t.app.ctx, later(90)), 0);
    await mia.ok('client.prefs.set', { prefs: { email_notifications: '1h' } });
  });

  test('thread replies count once the thread is unread; a bot is never mailed', async () => {
    const parent = await mia.ok('chat.postMessage', { channel: general, text: 'thread start' });
    postMessage(t.app.ctx, { conv: getConv(t.app.ctx, general)!, userId: owner.userId, text: `<@${mia.userId}> replied in your thread`, threadTs: parent.ts });
    const before = sink.mails.length;
    assert.equal(await sendEmailDigests(t.app.ctx, later(300)), 1);
    assert.match(sink.mails.at(-1)!.text, /replied in your thread/);
    assert.match(sink.mails.at(-1)!.text, /\(in a thread\)/);
    assert.equal(sink.mails.length, before + 1);
  });

  test('someone online right now is not mailed', async () => {
    const dm = (await owner.ok('conversations.open', { users: mia.userId })).channel.id;
    await owner.ok('chat.postMessage', { channel: dm, text: 'while Mia is here' });
    const stream = await mia.connect();
    assert.equal(await sendEmailDigests(t.app.ctx, later(600)), 0);
    stream.close();
  });
});
