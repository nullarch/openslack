import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { needsDatabase, searchRequest, toDocument } from '../src/search/meilisearch.ts';
import type { MsgRow } from '../src/core/messages.ts';
import { addMember, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

// A running Meilisearch for the end-to-end part, e.g.
//   meilisearch --http-addr 127.0.0.1:7701 --master-key <key>
//   MEILISEARCH_TEST_URL=http://127.0.0.1:7701 MEILISEARCH_TEST_KEY=<key> node --test test/meilisearch.test.ts
const MEILI_URL = process.env.MEILISEARCH_TEST_URL;
const MEILI_KEY = process.env.MEILISEARCH_TEST_KEY ?? null;

async function until<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('Meilisearch requests', () => {
  test('restricted to readable conversations, with the modifiers as filters', () => {
    const request = searchRequest(
      { terms: ['deploy', 'friday'], fromUser: 'U1', inConversation: 'C2', after: 100, before: 200, hasLink: true, hasFile: true, inThread: true },
      ['C1', 'C2'],
      { limit: 20, offset: 40 },
    );
    assert.deepEqual(request, {
      q: 'deploy friday',
      filter: ['conversation_id IN ["C1", "C2"]', 'conversation_id = "C2"', 'user_id = "U1"', 'ts < 200', 'ts >= 100', 'has_link = true', 'has_file = true', 'thread = true'],
      matchingStrategy: 'all',
      limit: 20,
      offset: 40,
      attributesToRetrieve: ['id'],
      sort: ['ts:desc'],
    });
    assert.equal(searchRequest({ terms: ['x'] }, ['C1'], { limit: 1, offset: 0, relevance: true }).sort, undefined, 'relevance: no sort');
    assert.equal(needsDatabase({ terms: [], hasPin: true }), true);
    assert.equal(toDocument({ id: 1, subtype: 'channel_join', plain: '' } as MsgRow), null);
  });
});

describe('search keeps working when Meilisearch cannot be reached', () => {
  let t: TestApp;
  let owner: Session;

  before(async () => {
    t = await startApp({ meilisearch: { url: 'http://127.0.0.1:9', key: null, index: 'unreachable' } });
    owner = await setupWorkspace(t);
  });
  after(() => t.close());

  test('the built-in index answers, and changes wait in the queue', async () => {
    const general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    await owner.ok('chat.postMessage', { channel: general, text: 'quarterly roadmap review' });
    assert.equal((await owner.ok('search.messages', { query: 'roadmap' })).messages.total, 1);
    assert.ok((t.app.ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM search_outbox')?.n ?? 0) > 0);
  });
});

describe('search through a real Meilisearch', { skip: MEILI_URL ? false : 'set MEILISEARCH_TEST_URL to run' }, () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let general: string;
  let secret: string;
  const index = `test-${randomBytes(4).toString('hex')}`;

  before(async () => {
    t = await startApp({ meilisearch: { url: MEILI_URL!, key: MEILI_KEY, index } });
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    secret = (await owner.ok('conversations.create', { name: 'board', is_private: true })).channel.id;
    await owner.ok('chat.postMessage', { channel: general, text: 'The deployment checklist is in the wiki' });
    await owner.ok('chat.postMessage', { channel: secret, text: 'Deployment of the reorg plan stays here' });
    await owner.ok('chat.postMessage', { channel: general, text: '배포 일정은 금요일입니다' });
  });
  after(async () => {
    await t.close();
    await fetch(`${MEILI_URL}/indexes/${index}`, { method: 'DELETE', headers: MEILI_KEY ? { authorization: `Bearer ${MEILI_KEY}` } : {} });
  });

  const search = (session: Session, query: string) => session.ok('search.messages', { query, sort: 'score' });

  test('finds with a typo (the built-in index would not), only where the person may read', async () => {
    // "deploymnet": a typo only Meilisearch's ranking tolerates.
    const found = await until(async () => {
      const result = await search(owner, 'deploymnet');
      return result.messages.total >= 2 ? result : null;
    });
    assert.equal(found.messages.total, 2);
    const forMember = await search(member, 'deploymnet');
    assert.deepEqual(forMember.messages.matches.map((match: Json) => match.text), ['The deployment checklist is in the wiki']);
    assert.equal((await search(member, '배포 일정')).messages.total, 1);
  });

  test('edits and deletions reach the index; joining a channel opens its history', async () => {
    const posted = await owner.ok('chat.postMessage', { channel: general, text: 'lunch at the pizzeria' });
    await until(async () => (await search(owner, 'pizzeria')).messages.total === 1);
    await owner.ok('chat.update', { channel: general, ts: posted.ts, text: 'lunch at the noodle bar' });
    await until(async () => (await search(owner, 'pizzeria')).messages.total === 0 && (await search(owner, 'noodle')).messages.total === 1);
    await owner.ok('chat.delete', { channel: general, ts: posted.ts });
    await until(async () => (await search(owner, 'noodle')).messages.total === 0);
    await owner.ok('conversations.invite', { channel: secret, users: member.userId });
    assert.equal((await search(member, 'reorg plan')).messages.total, 1);
  });
});
