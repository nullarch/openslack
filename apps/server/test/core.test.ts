import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, callWithToken, createBot, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';

describe('workspace', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let general: string;

  before(async () => {
    t = await startApp();
    const status = await new Session(t.base).call('client.status');
    assert.equal(status.setup_required, true);
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    const boot = await owner.ok('client.boot');
    general = boot.channels.find((channel: Json) => channel.is_general).id;
  });
  after(() => t.close());

  test('setup creates the owner, default channels and a session', async () => {
    const boot = await owner.ok('client.boot');
    assert.equal(boot.self.is_primary_owner, true);
    assert.equal(boot.self.tz, 'Asia/Seoul');
    assert.equal(boot.team.name, 'Acme');
    assert.deepEqual(boot.channels.map((channel: Json) => channel.name).sort(), ['general', 'random']);
    assert.equal((await new Session(t.base).call('client.setup', {})).error, 'already_set_up');
  });

  test('a second member joins the default channels through an invite', async () => {
    const boot = await member.ok('client.boot');
    assert.equal(boot.self.is_admin, false);
    assert.equal(boot.channels.length, 2);
    assert.equal(boot.users.length, 2);
  });

  test('calls without valid credentials are rejected the way Slack rejects them', async () => {
    const anonymous = new Session(t.base);
    assert.equal((await anonymous.call('conversations.list')).error, 'not_authed');
    assert.equal((await callWithToken(t.base, 'xoxb-nope', 'auth.test')).error, 'invalid_auth');
    assert.equal((await owner.call('no.such.method')).error, 'unknown_method');
    assert.equal((await anonymous.call('client.signin', { email: 'owner@acme.test', password: 'wrong' })).error, 'invalid_credentials');
  });

  test('messages get strictly increasing timestamps and come back newest first', async () => {
    const sent: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const result = await owner.ok('chat.postMessage', { channel: general, text: `message ${i}` });
      sent.push(result.ts);
    }
    assert.deepEqual([...sent].sort(), sent);
    assert.equal(new Set(sent).size, 5);
    const history = await owner.ok('conversations.history', { channel: general, limit: 3 });
    assert.deepEqual(history.messages.map((message: Json) => message.text), ['message 4', 'message 3', 'message 2']);
    assert.equal(history.has_more, true);
    const older = await owner.ok('conversations.history', { channel: general, limit: 3, cursor: history.response_metadata.next_cursor });
    assert.equal(older.messages[0].text, 'message 1');
  });

  test('editing and deleting a message', async () => {
    const { ts } = await owner.ok('chat.postMessage', { channel: general, text: 'tpyo' });
    assert.equal((await member.call('chat.update', { channel: general, ts, text: 'hijack' })).error, 'cant_update_message');
    const updated = await owner.ok('chat.update', { channel: general, ts, text: 'typo' });
    assert.equal(updated.message.text, 'typo');
    assert.equal(updated.message.edited.user, owner.userId);
    assert.equal((await member.call('chat.delete', { channel: general, ts })).error, 'cant_delete_message');
    await owner.ok('chat.delete', { channel: general, ts });
    assert.equal((await owner.call('chat.update', { channel: general, ts, text: 'x' })).error, 'message_not_found');
  });

  test('threads keep replies out of the channel and summarise them on the parent', async () => {
    const parent = await owner.ok('chat.postMessage', { channel: general, text: 'thread parent' });
    await member.ok('chat.postMessage', { channel: general, text: 'reply one', thread_ts: parent.ts });
    const second = await owner.ok('chat.postMessage', { channel: general, text: 'reply two', thread_ts: parent.ts });
    // Replying to a reply stays in the same thread.
    const nested = await member.ok('chat.postMessage', { channel: general, text: 'reply three', thread_ts: second.ts });
    assert.equal(nested.message.thread_ts, parent.ts);
    await member.ok('chat.postMessage', { channel: general, text: 'also in channel', thread_ts: parent.ts, reply_broadcast: true });

    const history = await owner.ok('conversations.history', { channel: general, limit: 5 });
    const texts = history.messages.map((message: Json) => message.text);
    assert.ok(texts.includes('also in channel'));
    assert.ok(!texts.includes('reply one'));
    const head = history.messages.find((message: Json) => message.ts === parent.ts);
    assert.equal(head.reply_count, 4);
    assert.equal(head.reply_users_count, 2);
    assert.equal(head.thread_ts, parent.ts);

    const thread = await owner.ok('conversations.replies', { channel: general, ts: parent.ts });
    assert.deepEqual(
      thread.messages.map((message: Json) => message.text),
      ['thread parent', 'reply one', 'reply two', 'reply three', 'also in channel'],
    );
    assert.equal(thread.messages[1].parent_user_id, owner.userId);

    // Deleting a parent that has replies leaves a placeholder.
    await owner.ok('chat.delete', { channel: general, ts: parent.ts });
    const after = await owner.ok('conversations.replies', { channel: general, ts: parent.ts });
    assert.equal(after.messages[0].subtype, 'tombstone');
    assert.equal(after.messages.length, 5);
  });

  test('reactions and pins', async () => {
    const { ts } = await owner.ok('chat.postMessage', { channel: general, text: 'react to me' });
    await owner.ok('reactions.add', { channel: general, timestamp: ts, name: 'tada' });
    await member.ok('reactions.add', { channel: general, timestamp: ts, name: ':tada:' });
    assert.equal((await member.call('reactions.add', { channel: general, timestamp: ts, name: 'tada' })).error, 'already_reacted');
    const got = await owner.ok('reactions.get', { channel: general, timestamp: ts });
    assert.deepEqual(got.message.reactions, [{ name: 'tada', users: [owner.userId, member.userId], count: 2 }]);
    await member.ok('reactions.remove', { channel: general, timestamp: ts, name: 'tada' });
    assert.equal((await member.call('reactions.remove', { channel: general, timestamp: ts, name: 'tada' })).error, 'no_reaction');

    await owner.ok('pins.add', { channel: general, timestamp: ts });
    assert.equal((await owner.call('pins.add', { channel: general, timestamp: ts })).error, 'already_pinned');
    const pins = await member.ok('pins.list', { channel: general });
    assert.equal(pins.items[0].message.text, 'react to me');
    assert.deepEqual(pins.items[0].message.pinned_to, [general]);
  });

  test('people are listed on a reaction in the order they reacted, however close together', async () => {
    // Two reactions often land in the same millisecond; alternate who goes first so no id order can hide a tie.
    for (let round = 0; round < 40; round += 1) {
      const { ts } = await owner.ok('chat.postMessage', { channel: general, text: `quick reactions ${round}` });
      const [first, second] = round % 2 === 0 ? [owner, member] : [member, owner];
      await first.ok('reactions.add', { channel: general, timestamp: ts, name: 'zap' });
      await second.ok('reactions.add', { channel: general, timestamp: ts, name: 'zap' });
      const got = await owner.ok('reactions.get', { channel: general, timestamp: ts });
      assert.deepEqual(got.message.reactions[0].users, [first.userId, second.userId], `round ${round}`);
    }
  });

  test('unread and mention counts follow each member’s read position', async () => {
    const { channel } = await owner.ok('conversations.create', { name: 'unread-test' });
    await owner.ok('conversations.invite', { channel: channel.id, users: member.userId });
    await owner.ok('chat.postMessage', { channel: channel.id, text: 'one' });
    await owner.ok('chat.postMessage', { channel: channel.id, text: `two <@${member.userId}>` });
    const last = await owner.ok('chat.postMessage', { channel: channel.id, text: 'three <!channel>' });

    const counts = async (session: Session): Promise<Json> =>
      (await session.ok('client.counts')).channels.find((entry: Json) => entry.id === channel.id);
    assert.deepEqual([(await counts(member)).unread_count, (await counts(member)).mention_count], [3, 2]);
    // The author has nothing unread and is not mentioned by their own @channel.
    assert.deepEqual([(await counts(owner)).unread_count, (await counts(owner)).mention_count], [0, 0]);

    await member.ok('conversations.mark', { channel: channel.id, ts: last.ts });
    assert.deepEqual([(await counts(member)).unread_count, (await counts(member)).mention_count], [0, 0]);

    // A mention inside a thread badges the channel, and catching up with the channel clears it.
    await owner.ok('chat.postMessage', { channel: channel.id, text: `in a thread <@${member.userId}>`, thread_ts: last.ts });
    assert.deepEqual([(await counts(member)).unread_count, (await counts(member)).mention_count], [0, 1]);
    await member.ok('conversations.mark', { channel: channel.id, ts: last.ts });
    assert.deepEqual([(await counts(member)).unread_count, (await counts(member)).mention_count], [0, 0]);
    // Marking as unread moves the position back.
    await member.ok('conversations.mark', { channel: channel.id, ts: '0000000001.000000' });
    assert.equal((await counts(member)).unread_count, 3);
  });

  test('a message posted right after someone joins is unread for them', async () => {
    // Joining stamps the read position and posting stamps the message; the second must never sort before the first.
    for (let round = 0; round < 60; round += 1) {
      const { channel } = await owner.ok('conversations.create', { name: `join-then-post-${round}` });
      await owner.ok('conversations.invite', { channel: channel.id, users: member.userId });
      await owner.ok('chat.postMessage', { channel: channel.id, text: 'posted straight after the invitation' });
      const counts = (await member.ok('client.counts')).channels.find((entry: Json) => entry.id === channel.id);
      assert.equal(counts.unread_count, 1, `round ${round}`);
    }
  });

  test('private channels are invisible to non-members everywhere', async () => {
    const { channel } = await owner.ok('conversations.create', { name: 'secret-plans', is_private: true });
    await owner.ok('chat.postMessage', { channel: channel.id, text: 'the launch codeword is nectarine' });

    assert.equal((await member.call('conversations.info', { channel: channel.id })).error, 'channel_not_found');
    assert.equal((await member.call('conversations.history', { channel: channel.id })).error, 'channel_not_found');
    assert.equal((await member.call('chat.postMessage', { channel: channel.id, text: 'hi' })).error, 'channel_not_found');
    assert.equal((await member.call('conversations.join', { channel: channel.id })).error, 'channel_not_found');
    const list = await member.ok('conversations.list', { types: 'public_channel,private_channel' });
    assert.ok(!list.channels.some((entry: Json) => entry.id === channel.id));
    const search = await member.ok('search.messages', { query: 'nectarine' });
    assert.equal(search.messages.total, 0);
    assert.equal((await owner.ok('search.messages', { query: 'nectarine' })).messages.total, 1);
  });

  test('direct messages open once and reach the other person as unread', async () => {
    const opened = await owner.ok('conversations.open', { users: member.userId });
    const again = await owner.ok('conversations.open', { users: member.userId });
    assert.equal(again.channel.id, opened.channel.id);
    assert.equal(again.already_open, true);
    assert.equal(opened.channel.is_im, true);
    await owner.ok('chat.postMessage', { channel: opened.channel.id, text: 'psst' });
    const boot = await member.ok('client.boot');
    const dm = boot.channels.find((entry: Json) => entry.id === opened.channel.id);
    assert.equal(dm.user, owner.userId);
    assert.deepEqual([dm.unread_count, dm.mention_count], [1, 1]);
    // Posting to a user id lands in the same conversation.
    const viaUser = await member.ok('chat.postMessage', { channel: owner.userId, text: 'reply' });
    assert.equal(viaUser.channel, opened.channel.id);
  });

  test('search handles Korean, short terms and modifiers', async () => {
    const { channel } = await owner.ok('conversations.create', { name: '검색-테스트' });
    await owner.ok('conversations.invite', { channel: channel.id, users: member.userId });
    await owner.ok('chat.postMessage', { channel: channel.id, text: '오늘 배포 일정 공유드립니다' });
    await member.ok('chat.postMessage', { channel: channel.id, text: '배포는 내일로 미뤄졌어요 https://example.com/release' });
    await member.ok('chat.postMessage', { channel: general, text: 'unrelated deploy note' });

    const total = async (query: string): Promise<number> => (await owner.ok('search.messages', { query })).messages.total;
    assert.equal(await total('배포'), 2); // two characters: substring scan
    assert.equal(await total('배포 일정'), 1); // both terms must match
    assert.equal(await total('공유드립니다'), 1); // trigram index
    assert.equal(await total('배포 from:@mina.member'), 1);
    assert.equal(await total('배포 from:me'), 1);
    assert.equal(await total('deploy in:#general'), 1);
    assert.equal(await total('deploy in:#검색-테스트'), 0);
    assert.equal(await total('배포 has:link'), 1);
    assert.equal(await total('배포 in:#no-such-channel'), 0);
    const hit = (await owner.ok('search.messages', { query: '공유드립니다' })).messages.matches[0];
    assert.equal(hit.channel.name, '검색-테스트');
    assert.match(hit.permalink, /\/archives\/C[A-Z0-9]+\/p\d{16}$/);
  });

  test('bot tokens: form-encoded calls, scopes, and posting without joining', async () => {
    const bot = createBot(t, ['chat:write', 'channels:read', 'channels:history']);
    const auth = await callWithToken(t.base, bot.token, 'auth.test');
    assert.equal(auth.user_id, bot.userId);
    assert.equal(auth.bot_id, bot.botId);

    const posted = await callWithToken(t.base, bot.token, 'chat.postMessage', {
      channel: '#general',
      text: 'fallback',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Build passed* for `main`' } }],
    });
    assert.equal(posted.ok, true);
    assert.equal(posted.message.bot_id, bot.botId);
    assert.equal(posted.message.blocks[0].type, 'section');
    assert.equal(posted.message.bot_profile.name, 'Test Bot');

    const denied = await callWithToken(t.base, bot.token, 'reactions.add', { channel: general, timestamp: posted.ts, name: 'eyes' });
    assert.equal(denied.error, 'missing_scope');
    assert.equal(denied.needed, 'reactions:write');

    // Standard Markdown input is kept as a markdown block.
    const markdown = await callWithToken(t.base, bot.token, 'chat.postMessage', { channel: general, markdown_text: '# Report\n\n- done' });
    assert.deepEqual(markdown.message.blocks, [{ type: 'markdown', text: '# Report\n\n- done' }]);

    // Block text is searchable.
    assert.equal((await owner.ok('search.messages', { query: 'Build passed' })).messages.total, 1);
  });

  test('administration: roles and deactivation', async () => {
    const third = await addMember(t, owner, 'Theo Third');
    assert.equal((await member.call('client.admin.setRole', { user: third.userId, role: 'admin' })).error, 'not_allowed');
    await owner.ok('client.admin.setRole', { user: third.userId, role: 'admin' });
    assert.equal((await third.ok('users.info', { user: third.userId })).user.is_admin, true);
    assert.equal((await third.call('client.admin.setActive', { user: owner.userId, active: false })).error, 'cannot_change_primary_owner');
    await owner.ok('client.admin.setActive', { user: third.userId, active: false });
    assert.equal((await third.call('client.boot')).error, 'invalid_auth');
    assert.equal((await new Session(t.base).call('client.signin', { email: 'theo.third@acme.test', password: 'another long password' })).error, 'account_inactive');
  });
});

describe('group DMs', () => {
  test('a group DM becomes a private channel with the same people and its history', async () => {
    const t = await startApp();
    try {
      const owner = await setupWorkspace(t);
      const a = await addMember(t, owner, 'Ana A');
      const b = await addMember(t, owner, 'Ben B');
      const outsider = await addMember(t, owner, 'Out Sider');
      const opened = await owner.ok('conversations.open', { users: `${a.userId},${b.userId}` });
      await owner.ok('chat.postMessage', { channel: opened.channel.id, text: 'planning the offsite' });
      assert.equal((await outsider.call('client.conversations.convertGroupDm', { channel: opened.channel.id, name: 'offsite' })).error, 'channel_not_found');
      const stream = await a.connect();
      const converted = await owner.ok('client.conversations.convertGroupDm', { channel: opened.channel.id, name: 'Offsite 2026' });
      assert.equal(converted.channel.id, opened.channel.id);
      assert.equal(converted.channel.name, 'offsite-2026');
      assert.equal(converted.channel.is_private, true);
      assert.equal(converted.channel.is_mpim, false);
      const joined = await stream.next((event) => event.type === 'channel_joined' && event.channel.id === opened.channel.id);
      assert.equal(joined.channel.name, 'offsite-2026');
      stream.close();
      const history = await b.ok('conversations.history', { channel: opened.channel.id });
      assert.ok(history.messages.some((message: Json) => message.text === 'planning the offsite'));
      assert.equal((await outsider.call('conversations.history', { channel: opened.channel.id })).error, 'channel_not_found');
      // It behaves as a channel now: invites work, and the old group DM is not reopened by the same three people.
      await owner.ok('conversations.invite', { channel: opened.channel.id, users: outsider.userId });
      const fresh = await owner.ok('conversations.open', { users: `${a.userId},${b.userId}` });
      assert.notEqual(fresh.channel.id, opened.channel.id);
      assert.equal((await owner.call('client.conversations.convertGroupDm', { channel: opened.channel.id, name: 'again' })).error, 'method_not_supported_for_channel_type');
    } finally {
      await t.close();
    }
  });
});
