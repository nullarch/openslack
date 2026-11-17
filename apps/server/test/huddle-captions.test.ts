import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { LiveKitConfig } from '../src/huddles/livekit.ts';
import { fakeClaude, type FakeProvider } from './ai-fakes.ts';
import { addMember, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

const LIVEKIT: LiveKitConfig = {
  // Nothing listens here: room API calls fail, and the server must cope.
  url: 'ws://127.0.0.1:9',
  apiUrl: 'http://127.0.0.1:9',
  apiKey: 'APItestkey',
  apiSecret: 'a-test-secret-that-is-long-enough-for-hs256',
};

/** The Huddles bot's reply in a huddle's thread, once it arrives. */
async function threadReply(session: Session, channel: string, ts: string, timeoutMs = 5000): Promise<Json | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = await session.ok('conversations.replies', { channel, ts, limit: 50 });
    const found = (page.messages as Json[]).find((message) => message.ts !== ts && message.bot_id);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return null;
}

describe('huddle captions and notes', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let outsider: Session;
  let claude: FakeProvider;
  let channel: string;

  before(async () => {
    process.env.HUDDLE_RECONCILE_MS = '0';
    claude = await fakeClaude();
    t = await startApp({ livekit: LIVEKIT });
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    outsider = await addMember(t, owner, 'Otto Outsider');
    channel = (await owner.ok('conversations.create', { name: 'standup' })).channel.id;
    await member.ok('conversations.join', { channel });
    await outsider.ok('conversations.join', { channel });
  });
  after(async () => {
    await t.close();
    await claude.close();
  });

  test('captions reach everyone in the huddle; the transcript and notes land in its thread when it ends', async () => {
    await owner.ok('client.ai.settings.set', { provider: 'anthropic', base_url: claude.url, api_key: 'sk-ant-test-0000' });
    claude.reply = (system) => (system.includes('notes of a call') ? '**Summary**\nThe release moves to Friday.\n\n**Decisions**\n- Ship Friday\n\n**Action items**\n- Mina updates the changelog' : 'unused');
    assert.equal((await owner.ok('client.huddles.info')).transcripts, true);
    const started = await owner.ok('client.huddles.join', { channel });
    await member.ok('client.huddles.join', { channel });
    const watching = await member.connect();

    // Words in progress are shown but not kept.
    const interim = watching.next((event) => event.type === 'huddle_caption' && event.final === false);
    assert.equal((await owner.ok('client.huddles.caption', { channel, text: 'let us move the', final: false })).kept, false);
    assert.equal((await interim).text, 'let us move the');
    const final = watching.next((event) => event.type === 'huddle_caption' && event.final === true);
    assert.equal((await owner.ok('client.huddles.caption', { channel, text: '  Let us move the release   to Friday. ' })).kept, true);
    const shown = await final;
    assert.deepEqual([shown.user, shown.text], [owner.userId, 'Let us move the release to Friday.']);
    await member.ok('client.huddles.caption', { channel, text: 'I will update the changelog.' });
    watching.close();

    // Only people in the huddle caption it, and only while it runs.
    assert.equal((await outsider.call('client.huddles.caption', { channel, text: 'hello' })).error, 'not_in_huddle');
    const general = (await owner.ok('client.boot')).channels.find((conv: Json) => conv.is_general).id;
    assert.equal((await owner.call('client.huddles.caption', { channel: general, text: 'hello' })).error, 'no_active_huddle');

    await member.ok('client.huddles.leave', { channel });
    await owner.ok('client.huddles.leave', { channel });
    const notes = await threadReply(member, channel, started.huddle.ts);
    assert.ok(notes, 'notes posted in the huddle thread');
    assert.match(notes.text, /Huddle notes/);
    assert.match(JSON.stringify(notes.blocks), /Mina updates the changelog/);
    const prompt: string = claude.requests.at(-1)!.body.messages[0].content;
    assert.match(prompt, /\[00:0\d\] [^:]+: Let us move the release to Friday\.\n\[00:0\d\] Mina Member: I will update the changelog\./);
    assert.doesNotMatch(prompt, /let us move the$/m, 'words in progress are not in the transcript');

    // The transcript is an ordinary file in the thread, readable by the channel.
    assert.equal(notes.files.length, 1);
    assert.match(notes.files[0].name, /^Huddle transcript \d{4}-\d{2}-\d{2}\.txt$/);
    const download = await fetch(`${t.base}${new URL(notes.files[0].url_private).pathname}`, { headers: { cookie: outsider.cookie } });
    assert.match(await download.text(), /Mina Member: I will update the changelog\./);
  });

  test('without notes, the transcript alone; with transcripts off, captions stay live only', async () => {
    await owner.ok('client.ai.settings.set', { features: { huddle_notes: false } });
    const second = await owner.ok('client.huddles.join', { channel });
    await owner.ok('client.huddles.caption', { channel, text: 'Quick check on the build.' });
    const requests = claude.requests.length;
    await owner.ok('client.huddles.leave', { channel });
    const transcriptOnly = await threadReply(owner, channel, second.huddle.ts);
    assert.equal(transcriptOnly?.text, 'Transcript of the huddle');
    assert.equal(transcriptOnly?.files.length, 1);
    assert.equal(claude.requests.length, requests, 'no model request');

    assert.ok((await member.call('client.admin.setHuddleTranscripts', { enabled: false })).error, 'admins only');
    await owner.ok('client.admin.setHuddleTranscripts', { enabled: false });
    assert.equal((await member.ok('client.huddles.info')).transcripts, false);
    const third = await owner.ok('client.huddles.join', { channel });
    assert.equal((await owner.ok('client.huddles.caption', { channel, text: 'Not kept.' })).kept, false);
    await owner.ok('client.huddles.leave', { channel });
    assert.equal(await threadReply(owner, channel, third.huddle.ts, 600), null);
    await owner.ok('client.admin.setHuddleTranscripts', { enabled: true });
  });

  test('a direct-message huddle gets its transcript without anyone being added to the conversation', async () => {
    const dm = (await owner.ok('conversations.open', { users: member.userId })).channel.id;
    const call = await owner.ok('client.huddles.join', { channel: dm });
    await owner.ok('client.huddles.caption', { channel: dm, text: 'Just us two.' });
    await owner.ok('client.huddles.leave', { channel: dm });
    const reply = await threadReply(member, dm, call.huddle.ts);
    assert.ok(reply);
    assert.deepEqual((await member.ok('conversations.members', { channel: dm })).members.sort(), [owner.userId, member.userId].sort());
  });
});
