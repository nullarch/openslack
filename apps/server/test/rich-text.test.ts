import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { sendEmailDigests } from '../src/attention/email.ts';
import { MailSink } from './mail-sink.ts';
import { addMember, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

const later = (minutes: number): number => Math.floor(Date.now() / 1000) + minutes * 60;

/** A message as the web composer sends it: mrkdwn `text` plus a `rich_text` block of the same document. */
function composed(userId: string): { text: string; blocks: string } {
  const blocks = [
    {
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [
            { type: 'user', user_id: userId },
            { type: 'text', text: ' the ' },
            { type: 'text', text: 'heron', style: { bold: true } },
            { type: 'text', text: ' plan:' },
          ],
        },
        {
          type: 'rich_text_list',
          style: 'ordered',
          indent: 0,
          border: 0,
          elements: [
            { type: 'rich_text_section', elements: [{ type: 'text', text: 'draft' }] },
            { type: 'rich_text_section', elements: [{ type: 'link', url: 'https://example.com/r?a=1&b=2', text: 'review' }] },
          ],
        },
      ],
    },
  ];
  return { text: `<@${userId}> the *heron* plan:\n1. draft\n2. <https://example.com/r?a=1&amp;b=2|review>`, blocks: JSON.stringify(blocks) };
}

describe('messages with rich_text blocks, as people send them', () => {
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

  test('the block is stored and delivered as sent, the mention counts and the words are found', async () => {
    const posted = await owner.ok('chat.postMessage', { channel: general, ...composed(mia.userId) });
    assert.equal(posted.message.blocks[0].type, 'rich_text');
    assert.equal(posted.message.blocks[0].elements[1].type, 'rich_text_list');
    const history = await mia.ok('conversations.history', { channel: general, limit: 1 });
    assert.deepEqual(history.messages[0].blocks, posted.message.blocks);
    assert.equal((await mia.ok('search.messages', { query: 'heron' })).messages.total, 1);
    const unread = (await mia.ok('client.boot')).channels.find((channel: Json) => channel.id === general);
    assert.equal(unread.mention_count, 1);
  });

  test('the words are kept once, not twice: the missed-message email quotes the text', async () => {
    const dm = (await owner.ok('conversations.open', { users: mia.userId })).channel.id;
    await owner.ok('chat.postMessage', { channel: dm, ...composed(mia.userId) });
    assert.equal(await sendEmailDigests(t.app.ctx, later(3)), 1);
    const mail = sink.mails.at(-1)!;
    // The quoted line ends where the text ends: the block's copy of the same words is not appended.
    const quoted = /in a direct message:\r?\n(.*?)\r?\n/.exec(mail.text)?.[1];
    assert.equal(quoted, `<@${mia.userId}> the *heron* plan: 1. draft 2. <https://example.com/r?a=1&amp;b=2|review>`);
  });

  test('a block that says more than its text is still searchable', async () => {
    const blocks = [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Quarterly flamingo census attached' }] }] }];
    await owner.ok('chat.postMessage', { channel: general, text: 'New report', blocks: JSON.stringify(blocks) });
    assert.equal((await mia.ok('search.messages', { query: 'flamingo' })).messages.total, 1);
    assert.equal((await mia.ok('search.messages', { query: 'report' })).messages.total, 1);
  });

  test('an edit replaces the block, and the new words are found', async () => {
    const posted = await owner.ok('chat.postMessage', { channel: general, ...composed(mia.userId) });
    const blocks = [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'the egret plan' }] }] }];
    const updated = await owner.ok('chat.update', { channel: general, ts: posted.ts, text: 'the egret plan', blocks: JSON.stringify(blocks) });
    assert.deepEqual(updated.message.blocks[0].elements[0].elements, [{ type: 'text', text: 'the egret plan' }]);
    assert.equal((await mia.ok('search.messages', { query: 'egret' })).messages.total, 1);
  });
});
