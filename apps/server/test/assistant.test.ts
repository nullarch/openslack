import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { keywords } from '../src/ai/assistant.ts';
import { fakeClaude, type FakeProvider } from './ai-fakes.ts';
import { addMember, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

/** The assistant's finished reply after `after` (a ts), in the DM or one of its threads. */
async function reply(session: Session, channel: string, after: string, threadTs?: string): Promise<Json> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const page = threadTs
      ? await session.ok('conversations.replies', { channel, ts: threadTs, limit: 100 })
      : await session.ok('conversations.history', { channel, limit: 20 });
    const found = (page.messages as Json[]).find((message) => message.bot_id && message.ts > after && !message.streaming && message.text);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('the assistant did not reply');
}

describe('the built-in assistant', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let claude: FakeProvider;
  let dm: string;
  let botId: string;

  before(async () => {
    claude = await fakeClaude();
    t = await startApp();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    const general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    await owner.ok('chat.postMessage', { channel: general, text: 'The code freeze starts on Thursday.' });
    const secret = await owner.ok('conversations.create', { name: 'payroll', is_private: true });
    await owner.ok('chat.postMessage', { channel: secret.channel.id, text: 'Payroll freeze until March, keep it quiet.' });
  });
  after(async () => {
    await t.close();
    await claude.close();
  });

  test('picks search terms from a question in English or Korean', () => {
    assert.deepEqual(keywords('When does the code freeze start?'), ['freeze', 'start', 'code']);
    assert.deepEqual(keywords('코드 동결은 언제 시작해?'), ['시작해', '코드', '동결', '언제']);
  });

  test('is off until a model is connected', async () => {
    assert.equal((await member.call('client.assistant.open')).error, 'ai_not_configured');
    await owner.ok('client.ai.settings.set', { provider: 'anthropic', base_url: claude.url, api_key: 'sk-ant-test-0000' });
  });

  test('answers from what the person can read, with links, and proposes a memory without keeping it', async () => {
    const opened = await member.ok('client.assistant.open');
    dm = opened.channel;
    botId = opened.bot_id;
    assert.equal((await member.ok('conversations.info', { channel: dm })).channel.is_im, true);
    claude.reply = (system, prompt) =>
      system.includes('built-in assistant') ? `The freeze starts on Thursday [1].\n<remember>Mina leads the release.</remember>` : 'unused';
    const asked = await member.ok('chat.postMessage', { channel: dm, text: 'When does the freeze start? I lead the release, by the way.' });
    const answer = await reply(member, dm, asked.ts);
    assert.equal(answer.user, botId);
    const request = claude.requests.at(-1)!.body;
    const prompt: string = request.messages[0].content;
    assert.match(prompt, /The code freeze starts on Thursday/);
    assert.doesNotMatch(prompt, /Payroll/, 'a private channel the person is not in never reaches the model');
    assert.match(prompt, /Latest message from Mina Member:\nWhen does the freeze start\?/);
    assert.doesNotMatch(answer.text, /remember/i);
    assert.match(answer.text, /\[\[1\]\]\(http[^)]+\/archives\/C[A-Z0-9]+\/p\d+\)/);
    const proposal = (answer.blocks as Json[]).find((block) => block.type === 'actions');
    assert.ok(proposal, 'a Remember button under the reply');
    assert.match(JSON.stringify(answer.blocks), /Remember this\? _Mina leads the release\._/);
    assert.deepEqual((await member.ok('client.assistant.memories.list')).memories, [], 'a proposal is not a memory');

    // Only the person in the conversation can answer it; then it is kept.
    const press = (who: Session, actionId: string) =>
      who.call('client.interactions.blockAction', {
        channel: dm,
        message_ts: answer.ts,
        action: JSON.stringify({ action_id: actionId, block_id: proposal.block_id, value: proposal.elements[0].value }),
      });
    assert.equal((await press(owner, 'assistant_remember')).error, 'channel_not_found');
    assert.equal((await press(member, 'assistant_remember')).ok, true);
    assert.deepEqual((await member.ok('client.assistant.memories.list')).memories.map((memory: Json) => memory.text), ['Mina leads the release.']);
    const updated = (await member.ok('conversations.history', { channel: dm, limit: 5 })).messages.find((message: Json) => message.ts === answer.ts);
    assert.equal(updated.blocks.some((block: Json) => block.type === 'actions'), false);
    assert.match(JSON.stringify(updated.blocks), /Remembered: _Mina leads the release\._/);
    assert.equal((await press(member, 'assistant_remember')).error, 'action_not_found', 'answered once');
  });

  test('remembers in later conversations and follows the conversation so far', async () => {
    claude.reply = () => 'You lead the release. <remember>Mina leads the release.</remember>';
    const asked = await member.ok('chat.postMessage', { channel: dm, text: 'What do you know about me?' });
    const answer = await reply(member, dm, asked.ts);
    const request = claude.requests.at(-1)!.body;
    assert.match(request.system, /What Mina Member asked you to remember:\n- Mina leads the release\./);
    assert.match(request.messages[0].content, /Conversation so far, oldest first:\nMina Member: When does the freeze start\?[^\n]*\nYou: The freeze starts on Thursday/);
    assert.equal((answer.blocks as Json[]).some((block) => block.type === 'actions'), false, 'nothing already remembered is proposed again');
  });

  test('"Not now" drops a proposal; replies in a thread stay in it', async () => {
    claude.reply = () => 'Noted. <remember>Mina prefers short answers.</remember>';
    const parent = await member.ok('chat.postMessage', { channel: dm, text: 'Keep answers short please' });
    const first = await reply(member, dm, parent.ts);
    const proposal = (first.blocks as Json[]).find((block) => block.type === 'actions');
    const dismissed = await member.call('client.interactions.blockAction', {
      channel: dm,
      message_ts: first.ts,
      action: JSON.stringify({ action_id: 'assistant_dismiss', block_id: proposal.block_id, value: proposal.elements[1].value }),
    });
    assert.equal(dismissed.ok, true);
    assert.equal((await member.ok('client.assistant.memories.list')).memories.length, 1);

    claude.reply = () => 'In the thread.';
    const inThread = await member.ok('chat.postMessage', { channel: dm, thread_ts: parent.ts, text: 'And the freeze again?' });
    const threaded = await reply(member, dm, inThread.ts, parent.ts);
    assert.equal(threaded.thread_ts, parent.ts);
  });

  test('people manage their own memories; nobody else can', async () => {
    const added = await member.ok('client.assistant.memories.add', { text: '  My manager is   Daniel.  ' });
    assert.equal(added.memory.text, 'My manager is Daniel.');
    assert.equal((await owner.ok('client.assistant.memories.list')).memories.length, 0);
    assert.equal((await owner.call('client.assistant.memories.delete', { id: added.memory.id })).error, 'not_found');
    await member.ok('client.assistant.memories.delete', { id: added.memory.id });
    assert.equal((await member.ok('client.assistant.memories.list')).memories.length, 1);
    assert.equal((await member.ok('client.assistant.memories.clear')).removed, 1);
    assert.equal((await member.call('client.assistant.memories.add', { text: '   ' })).error, 'no_text');
  });

  test('says so when an admin turns it off, and when the model fails', async () => {
    await owner.ok('client.ai.settings.set', { features: { assistant: false } });
    assert.equal((await member.call('client.assistant.open')).error, 'ai_feature_disabled');
    const off = await member.ok('chat.postMessage', { channel: dm, text: 'Are you there?' });
    assert.match((await reply(member, dm, off.ts)).text, /turned off/);
    await owner.ok('client.ai.settings.set', { features: { assistant: true } });
    // A refused key is not retried by the SDK (a 429 would be, and succeed).
    claude.failNextWith = 401;
    const refused = await member.ok('chat.postMessage', { channel: dm, text: 'Now?' });
    assert.match((await reply(member, dm, refused.ts)).text, /AI connection was refused/);
  });
});
