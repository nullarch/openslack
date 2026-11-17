import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { fakeClaude, fakeOpenAi, type FakeProvider } from './ai-fakes.ts';
import { addMember, callWithToken, Session, setupWorkspace, startApp, type Json, type Stream, type TestApp } from './helpers.ts';
import { createPlatformApp } from './platform-helpers.ts';

// Recaps are checked often in tests, so a due one is sent within a second.
process.env.AI_RECAP_INTERVAL_MS = '150';

const AI_METHODS: [string, Json][] = [
  ['client.ai.summarize', { channel: '#general' }],
  ['client.ai.answer', { query: 'freeze' }],
  ['client.ai.translate', { channel: '#general', ts: '1.000000', language: 'fr' }],
  ['client.ai.write', { text: 'draft', mode: 'shorten' }],
  ['client.ai.recaps.set', { channels: '#general', time: '09:00' }],
];

/** Wait for the end of a streamed AI request on the requester's connection. */
async function finished(stream: Stream, requestId: string): Promise<Json> {
  return stream.next((event) => event.type === 'ai_done' && event.request_id === requestId, 5000);
}

describe('AI features', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let claude: FakeProvider;
  let openai: FakeProvider;
  let general: string;
  let threadTs: string;

  before(async () => {
    claude = await fakeClaude();
    openai = await fakeOpenAi();
    t = await startApp();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    const parent = await owner.ok('chat.postMessage', { channel: general, text: 'Release plan: code freeze on Thursday' });
    threadTs = parent.ts;
    await member.ok('chat.postMessage', { channel: general, thread_ts: threadTs, text: `Thursday works for me <@${owner.userId}>` });
    await owner.ok('chat.postMessage', { channel: general, thread_ts: threadTs, text: 'Decided: we ship Thursday.' });
  });
  after(async () => {
    await t.close();
    await claude.close();
    await openai.close();
  });

  test('off by default: every AI method refuses and nothing leaves the server', async () => {
    assert.deepEqual((await member.ok('client.ai.status')).configured, false);
    for (const [method, args] of AI_METHODS) {
      assert.equal((await member.call(method, args)).error, 'ai_not_configured', method);
    }
    assert.equal((await owner.call('client.ai.settings.test')).error, 'ai_not_configured');
    assert.equal(claude.requests.length + openai.requests.length, 0);
    // Only admins configure, and only from the web client.
    assert.equal((await member.call('client.ai.settings.set', { provider: 'anthropic', api_key: 'x' })).error, 'not_allowed');
  });

  test('an admin connects Claude; the key is never sent back', async () => {
    const stream = await member.connect();
    const saved = await owner.ok('client.ai.settings.set', { provider: 'anthropic', base_url: claude.url, api_key: 'sk-ant-test-secret-1234' });
    assert.equal(saved.settings.model, 'claude-opus-5-5');
    assert.equal(saved.settings.has_key, true);
    assert.equal(saved.settings.key_hint, 'sk-a…1234');
    assert.ok(!JSON.stringify(saved).includes('test-secret'));
    assert.ok(!JSON.stringify(await owner.ok('client.ai.settings.get')).includes('test-secret'));
    await stream.next((event) => event.type === 'ai_settings_changed');
    stream.close();

    const check = await owner.ok('client.ai.settings.test');
    assert.equal(check.reply, 'ready');
    const sent = claude.requests.at(-1)!;
    assert.match(sent.url, /^\/v1\/messages/);
    // An API key goes out in X-Api-Key only (SDK 1.x would otherwise send it as a bearer token).
    assert.equal(sent.headers['x-api-key'], 'sk-ant-test-secret-1234');
    assert.equal(sent.headers.authorization, undefined);
    assert.equal(sent.body.model, 'claude-opus-5-5');
    assert.equal(sent.body.stream, true);
    // Server-side fallback is requested on the Claude path.
    assert.equal(sent.body.fallbacks, 'default');
    assert.match(String(sent.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);

    const status = await member.ok('client.ai.status');
    assert.equal(status.configured, true);
    assert.equal(status.features.summaries, true);
    assert.equal(status.provider, undefined);
  });

  test('a thread summary streams to the person who asked, with citations', async () => {
    const memberStream = await member.connect();
    const ownerStream = await owner.connect();
    const { request_id } = await member.ok('client.ai.summarize', { channel: general, thread_ts: threadTs });
    const done = await finished(memberStream, request_id);
    assert.equal(done.kind, 'summary');
    assert.equal(done.error, undefined);
    assert.match(done.text, /Ship on Thursday \[1\]\[2\]/);
    assert.deepEqual(
      done.citations.map((citation: Json) => citation.n),
      [1, 2],
    );
    assert.equal(done.citations[0].ts, threadTs);
    assert.match(done.citations[0].link, new RegExp(`^/archives/${general}/p\\d{16}$`));
    assert.match(done.citations[1].link, /\?thread_ts=/);
    assert.ok(memberStream.events.some((event) => event.type === 'ai_stream' && event.request_id === request_id));
    // Nobody else receives it.
    await owner.ok('chat.postMessage', { channel: general, text: 'marker after summary' });
    await ownerStream.next((event) => event.text === 'marker after summary');
    assert.ok(!ownerStream.events.some((event) => event.request_id === request_id));
    const prompt = claude.requests.at(-1)!.body.messages[0].content as string;
    assert.match(prompt, /\[1\] Olive Owner, .* UTC \(2 replies in thread\): Release plan/);
    assert.match(prompt, /\[2\] Mina Member, .*: Thursday works for me @Olive Owner/);
    memberStream.close();
    ownerStream.close();
  });

  test('a channel summary covers a range, and an empty range says so', async () => {
    const stream = await member.connect();
    const today = await member.ok('client.ai.summarize', { channel: general, range: 'today' });
    const done = await finished(stream, today.request_id);
    assert.ok(done.messages >= 1);
    // Thread replies stay out of a channel summary.
    assert.ok(!(claude.requests.at(-1)!.body.messages[0].content as string).includes('Decided: we ship Thursday'));
    const read = await member.ok('client.counts');
    const latest = read.channels.find((entry: Json) => entry.id === general).latest_ts;
    await member.ok('conversations.mark', { channel: general, ts: latest });
    assert.equal((await member.call('client.ai.summarize', { channel: general, range: 'unread' })).error, 'nothing_to_summarize');
    stream.close();
  });

  test('private conversations never reach anyone else’s summary, answer, translation or recap', async () => {
    const { channel } = await owner.ok('conversations.create', { name: 'board', is_private: true });
    const secret = await owner.ok('chat.postMessage', { channel: channel.id, text: 'Acquisition codename nightingale, freeze everything' });
    const before = claude.requests.length;

    assert.equal((await member.call('client.ai.summarize', { channel: channel.id })).error, 'channel_not_found');
    assert.equal((await member.call('client.ai.translate', { channel: channel.id, ts: secret.ts, language: 'fr' })).error, 'channel_not_found');
    assert.equal((await member.call('client.ai.recaps.set', { channels: channel.id, time: '08:00' })).error, 'channel_not_found');
    assert.equal((await member.call('client.ai.answer', { query: 'nightingale' })).error, 'no_results');

    // A broad question: the member's search finds public messages only.
    const stream = await member.connect();
    const asked = await member.ok('client.ai.answer', { query: 'freeze' });
    await finished(stream, asked.request_id);
    const sentSince = claude.requests.slice(before);
    assert.equal(sentSince.length, 1);
    assert.ok(!JSON.stringify(sentSince[0]!.body).includes('nightingale'));

    // The owner can read it, so the owner's answer may use it.
    const ownerStream = await owner.connect();
    const ownerAsked = await owner.ok('client.ai.answer', { query: 'nightingale' });
    const ownerDone = await finished(ownerStream, ownerAsked.request_id);
    assert.equal(ownerDone.citations[0].channel, channel.id);
    stream.close();
    ownerStream.close();
  });

  test('a search answer cites the messages it used', async () => {
    const stream = await member.connect();
    const { request_id } = await member.ok('client.ai.answer', { query: 'freeze' });
    const done = await finished(stream, request_id);
    assert.equal(done.kind, 'answer');
    assert.equal(done.text, 'The freeze is on Thursday [1].');
    assert.equal(done.citations.length, 1);
    assert.match(done.citations[0].excerpt, /freeze/i);
    const prompt = claude.requests.at(-1)!.body.messages[0].content as string;
    assert.match(prompt, /^Question: freeze/);
    assert.match(prompt, /\[1\] \(#general\)/);
    stream.close();
  });

  test('translation and writing help answer directly and post nothing', async () => {
    const translated = await member.ok('client.ai.translate', { channel: general, ts: threadTs, language: 'fr-FR' });
    assert.equal(translated.text, 'Le gel du code est toujours prévu pour jeudi.');
    assert.match(claude.requests.at(-1)!.body.messages[0].content, /BCP 47 tag "fr-FR"/);

    const historyBefore = (await member.ok('conversations.history', { channel: general })).messages.length;
    const written = await member.ok('client.ai.write', { text: 'can u look at release notes by fri', mode: 'formal' });
    assert.equal(written.text, 'Could you review the release notes by Friday?');
    assert.equal((await member.ok('conversations.history', { channel: general })).messages.length, historyBefore);
    assert.equal((await member.call('client.ai.write', { text: 'x', mode: 'pirate' })).error, 'invalid_mode');
  });

  test('admins switch features off one by one; provider failures are reported, not thrown', async () => {
    await owner.ok('client.ai.settings.set', { features: { translate: false } });
    assert.equal((await member.call('client.ai.translate', { channel: general, ts: threadTs })).error, 'ai_feature_disabled');
    assert.equal((await member.ok('client.ai.status')).features.translate, false);
    await owner.ok('client.ai.settings.set', { features: { translate: true } });

    claude.failNextWith = 401;
    const failed = await member.call('client.ai.write', { text: 'hello', mode: 'fix' });
    assert.equal(failed.error, 'ai_provider_error');
    assert.equal(failed.detail, 'authentication_failed');

    // A failure during a streamed request ends it with the reason instead of text.
    claude.failNextWith = 404;
    const stream = await member.connect();
    const { request_id } = await member.ok('client.ai.summarize', { channel: general, thread_ts: threadTs });
    const done = await finished(stream, request_id);
    assert.equal(done.error, 'model_not_found');
    stream.close();
  });

  test('an OpenAI-compatible endpoint works the same way', async () => {
    await owner.ok('client.ai.settings.set', { provider: 'openai_compatible', base_url: `${openai.url}/v1`, model: 'local-model', api_key: 'local-key' });
    const settings = (await owner.ok('client.ai.settings.get')).settings;
    assert.equal(settings.provider, 'openai_compatible');
    assert.equal(settings.model, 'local-model');
    const stream = await member.connect();
    const { request_id } = await member.ok('client.ai.summarize', { channel: general, thread_ts: threadTs });
    const done = await finished(stream, request_id);
    assert.match(done.text, /Ship on Thursday/);
    const sent = openai.requests.at(-1)!;
    assert.equal(sent.url, '/v1/chat/completions');
    assert.equal(sent.headers.authorization, 'Bearer local-key');
    assert.equal(sent.body.model, 'local-model');
    assert.equal(sent.body.stream, true);
    assert.deepEqual(
      sent.body.messages.map((message: Json) => message.role),
      ['system', 'user'],
    );
    stream.close();
    // Back to Claude for the remaining tests.
    await owner.ok('client.ai.settings.set', { provider: 'anthropic', base_url: claude.url, api_key: 'sk-ant-test-secret-1234' });
  });

  test('a daily recap arrives as a direct message from a built-in bot, with links back', async () => {
    const set = await member.ok('client.ai.recaps.set', { channels: general, time: '07:30', tz: 'Asia/Seoul' });
    assert.deepEqual(set.recap.channels, [general]);
    assert.equal(set.recap.time, '07:30');
    assert.ok(set.recap.next_at > Date.now() / 1000);
    const stream = await member.connect();
    const sent = await member.ok('client.ai.recaps.sendNow');
    assert.equal(sent.sent, true);
    const dm = await stream.next((event) => event.type === 'message' && event.channel_type === 'im' && /daily recap/.test(event.text));
    assert.ok(dm.bot_id);
    const body = dm.blocks[0].text as string;
    assert.match(body, /The release ships Thursday \[\[1\]\]\(http:\/\/(localhost|127\.0\.0\.1):\d+\/archives\//);
    // Nothing new since: no second recap.
    assert.equal((await member.ok('client.ai.recaps.sendNow')).sent, false);
    stream.close();
  });

  test('agents: apps using assistant status and streaming show up with their threads, within what the viewer can see', async () => {
    const app = await createPlatformApp(owner, 'Helper Agent');
    await owner.ok('conversations.invite', { channel: general, users: app.botUserId });
    await callWithToken(t.base, app.botToken, 'assistant.threads.setStatus', { channel_id: general, thread_ts: threadTs, status: 'is reading the thread…' });
    const { channel: secret } = await owner.ok('conversations.create', { name: 'agents-private', is_private: true });
    await owner.ok('conversations.invite', { channel: secret.id, users: app.botUserId });
    const hidden = await owner.ok('chat.postMessage', { channel: secret.id, text: 'private task' });
    await callWithToken(t.base, app.botToken, 'assistant.threads.setStatus', { channel_id: secret.id, thread_ts: hidden.ts, status: 'working on the private task' });

    const memberView = (await member.ok('client.agents.list')).agents.find((agent: Json) => agent.app_id === app.id);
    assert.ok(memberView);
    assert.equal(memberView.threads.length, 1);
    assert.equal(memberView.threads[0].channel, general);
    assert.equal(memberView.threads[0].status, 'is reading the thread…');
    assert.equal(memberView.state, 'working');
    assert.match(memberView.threads[0].title, /Release plan/);

    const ownerView = (await owner.ok('client.agents.list')).agents.find((agent: Json) => agent.app_id === app.id);
    assert.equal(ownerView.threads.length, 2);

    // Streaming a reply marks the thread as replying; finishing clears it.
    const started = await callWithToken(t.base, app.botToken, 'chat.startStream', { channel: general, thread_ts: threadTs, markdown_text: 'Looking' });
    assert.equal(started.ok, true, JSON.stringify(started));
    let view = (await member.ok('client.agents.list')).agents.find((agent: Json) => agent.app_id === app.id);
    assert.equal(view.state, 'replying');
    await callWithToken(t.base, app.botToken, 'chat.stopStream', { channel: general, ts: started.ts });
    view = (await member.ok('client.agents.list')).agents.find((agent: Json) => agent.app_id === app.id);
    assert.equal(view.threads[0].streaming, false);
    assert.equal(view.threads[0].status, '');
  });

  test('disconnecting turns everything off again', async () => {
    await owner.ok('client.ai.settings.disconnect');
    const before = claude.requests.length;
    for (const [method, args] of AI_METHODS) {
      assert.equal((await member.call(method, args)).error, 'ai_not_configured', method);
    }
    assert.equal(claude.requests.length, before);
    assert.equal((await owner.ok('client.ai.settings.get')).settings.configured, false);
  });
});

describe('AI recaps survive a restart', () => {
  test('a recap due while the server was down is sent after it starts', async () => {
    const claude = await fakeClaude();
    const dataDir = mkdtempSync(join(tmpdir(), 'chat-ai-restart-'));
    const config = {
      port: 0,
      host: '127.0.0.1',
      dataDir,
      publicUrl: '',
      webDir: null,
      maxUploadBytes: 1024 * 1024,
      cookieSecure: false,
      version: 'test',
      quiet: true,
    };
    const start = async (): Promise<TestApp> => {
      const app = createApp({ ...config });
      const port = await app.listen();
      return { app, base: `http://127.0.0.1:${port}`, close: () => app.close() };
    };
    try {
      const first = await start();
      const owner = await setupWorkspace(first);
      await owner.ok('client.ai.settings.set', { provider: 'anthropic', base_url: claude.url, api_key: 'k' });
      await owner.ok('chat.postMessage', { channel: '#general', text: 'Overnight: the release ships Thursday' });
      await owner.ok('client.ai.recaps.set', { channels: '#general', time: '06:00' });
      await first.close();

      // While stopped, the recap became due.
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(join(dataDir, 'app.db'));
      db.prepare('UPDATE ai_recaps SET next_at = ?').run(Math.floor(Date.now() / 1000) - 60);
      db.close();

      const second = await start();
      const again = new Session(second.base);
      await again.ok('client.signin', { email: 'owner@acme.test', password: 'correct horse battery' });
      let dm: Json;
      for (let i = 0; i < 40 && !dm; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const boot = await again.ok('client.boot');
        const im = boot.channels.find((channel: Json) => channel.is_im);
        if (im) dm = (await again.ok('conversations.history', { channel: im.id })).messages[0];
      }
      assert.ok(dm, 'the recap arrived');
      assert.match(dm.text, /daily recap/);
      const recap = (await again.ok('client.ai.recaps.get')).recap;
      assert.ok(recap.next_at > Date.now() / 1000);
      assert.ok(recap.last_sent);
      await second.close();
    } finally {
      await claude.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
