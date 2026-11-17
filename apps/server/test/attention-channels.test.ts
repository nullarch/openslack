import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { previewLinks, readPage } from '../src/attention/previews.ts';
import { addMember, callWithToken, createBot, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';
import { createPlatformApp } from './platform-helpers.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A 2×2 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQoYGBgAGwQBAfMqSXQAAAAASUVORK5CYII=', 'base64');

describe('channels: posting permissions, bookmarks, forwarding', () => {
  let t: TestApp;
  let owner: Session;
  let mina: Session;
  let theo: Session;
  let channel: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    mina = await addMember(t, owner, 'Mina Member');
    theo = await addMember(t, owner, 'Theo Third');
    channel = (await owner.ok('conversations.create', { name: 'announcements' })).channel.id;
    await owner.ok('conversations.invite', { channel, users: `${mina.userId},${theo.userId}` });
  });
  after(() => t.close());

  test('an announcement channel: only admins and managers start messages; replies and @channel are separate switches', async () => {
    assert.equal((await mina.call('client.conversations.setPostingPolicy', { channel, post: 'admins' })).error, 'restricted_action');
    const set = await owner.ok('client.conversations.setPostingPolicy', { channel, post: 'admins' });
    assert.deepEqual(set.channel.properties.posting_restrictions, { type: ['admin', 'channel_manager'] });

    assert.equal((await mina.call('chat.postMessage', { channel, text: 'hello?' })).error, 'restricted_action_read_only_channel');
    const announcement = await owner.ok('chat.postMessage', { channel, text: 'Office closed on Friday.' });
    // Replies in threads stay open unless that is switched off too; broadcasting a reply is posting.
    await mina.ok('chat.postMessage', { channel, text: 'thanks!', thread_ts: announcement.ts });
    assert.equal((await mina.call('chat.postMessage', { channel, text: 'to all', thread_ts: announcement.ts, reply_broadcast: true })).error, 'restricted_action_read_only_channel');
    await owner.ok('client.conversations.setPostingPolicy', { channel, threads: 'admins' });
    assert.equal((await mina.call('chat.postMessage', { channel, text: 'again', thread_ts: announcement.ts })).error, 'restricted_action_non_threadable_channel');

    // A channel manager may post, and may change the rules.
    await owner.ok('client.conversations.setManagers', { channel, add: [theo.userId] });
    await theo.ok('chat.postMessage', { channel, text: 'manager here' });
    await theo.ok('client.conversations.setPostingPolicy', { channel, post: 'everyone', threads: 'everyone', mentions: 'admins' });
    const info = await mina.ok('conversations.info', { channel });
    assert.deepEqual(info.channel.managers, [theo.userId]);
    assert.equal(info.channel.properties.at_channel_restricted, true);
    await mina.ok('chat.postMessage', { channel, text: 'now I can post' });
    assert.equal((await mina.call('chat.postMessage', { channel, text: 'hey <!channel>' })).error, 'restricted_action_at_channel');
    assert.equal((await mina.call('chat.scheduleMessage', { channel, text: 'later <!here>', post_at: Math.floor(Date.now() / 1000) + 600 })).error, 'restricted_action_at_channel');
    // Files go through the same check, and apps are not restricted.
    await owner.ok('client.conversations.setPostingPolicy', { channel, post: 'admins' });
    const bot = createBot(t, ['chat:write']);
    await owner.ok('conversations.invite', { channel, users: bot.userId });
    assert.equal((await callWithToken(t.base, bot.token, 'chat.postMessage', { channel, text: 'deploy done' })).ok, true);
    // A manager can rename the channel (channel managers have the creator's powers).
    await theo.ok('conversations.rename', { channel, name: 'announce' });
    await owner.ok('client.conversations.setManagers', { channel, remove: [theo.userId] });
    assert.equal((await theo.call('chat.postMessage', { channel, text: 'still?' })).error, 'restricted_action_read_only_channel');
    await owner.ok('client.conversations.setPostingPolicy', { channel, post: 'everyone', mentions: 'everyone' });
  });

  test('bookmarks: add, list, edit, remove, with events, members only', async () => {
    const stream = await mina.connect();
    assert.equal((await owner.call('bookmarks.add', { channel_id: channel, title: 'x', type: 'link', link: 'javascript:alert(1)' })).error, 'invalid_link');
    const added = await owner.ok('bookmarks.add', { channel_id: channel, title: 'Runbook', type: 'link', link: 'https://example.com/runbook', emoji: ':book:' });
    assert.match(added.bookmark.id, /^Bk/);
    assert.equal(added.bookmark.channel_id, channel);
    assert.equal(added.bookmark.type, 'link');
    const event = await stream.next((item) => item.type === 'bookmark_added');
    assert.equal(event.bookmark.title, 'Runbook');
    await mina.ok('bookmarks.add', { channel_id: channel, title: 'Dashboard', type: 'link', link: 'https://example.com/dash' });
    const listed = await theo.ok('bookmarks.list', { channel_id: channel });
    assert.deepEqual(listed.bookmarks.map((item: Json) => item.title), ['Runbook', 'Dashboard']);
    const edited = await mina.ok('bookmarks.edit', { channel_id: channel, bookmark_id: added.bookmark.id, title: 'Runbook (new)' });
    assert.equal(edited.bookmark.title, 'Runbook (new)');
    assert.equal(edited.bookmark.last_updated_by_user_id, mina.userId);
    await mina.ok('bookmarks.remove', { channel_id: channel, bookmark_id: added.bookmark.id });
    await stream.next((item) => item.type === 'bookmark_removed');
    stream.close();
    assert.equal((await mina.call('bookmarks.remove', { channel_id: channel, bookmark_id: added.bookmark.id })).error, 'not_found');
    const outsider = await addMember(t, owner, 'Olga Outside');
    assert.equal((await outsider.call('bookmarks.add', { channel_id: channel, title: 'x', type: 'link', link: 'https://example.com' })).error, 'not_in_channel');
  });

  test('forwarding a message carries a quoted copy; you cannot forward what you cannot see', async () => {
    const original = await mina.ok('chat.postMessage', { channel, text: 'Quarterly numbers are *up*' });
    const target = (await owner.ok('conversations.create', { name: 'leadership', is_private: true })).channel.id;
    const shared = await owner.ok('client.messages.share', { channel, ts: original.ts, to: [target], text: 'worth a read' });
    const posted = (await owner.ok('conversations.history', { channel: target, limit: 1 })).messages[0];
    assert.equal(posted.ts, shared.shared[0].ts);
    assert.equal(posted.text, 'worth a read');
    const quote = posted.attachments[0];
    assert.equal(quote.is_share, true);
    assert.equal(quote.is_msg_unfurl, true);
    assert.equal(quote.text, 'Quarterly numbers are *up*');
    assert.equal(quote.author_id, mina.userId);
    assert.equal(quote.channel_id, channel);
    assert.match(quote.from_url, /\/archives\/C[A-Z0-9]+\/p\d{16}$/);
    assert.match(quote.footer, /^Posted in #/);

    // Mina cannot see the private channel, so cannot forward from it, nor into it.
    assert.equal((await mina.call('client.messages.share', { channel: target, ts: posted.ts, to: [channel] })).error, 'channel_not_found');
    assert.equal((await mina.call('client.messages.share', { channel, ts: original.ts, to: [target] })).error, 'channel_not_found');
  });

  test('a file shared into another conversation becomes readable there', async () => {
    const reserved = await mina.ok('files.getUploadURLExternal', { filename: 'notes.txt', length: 5 });
    await fetch(reserved.upload_url, { method: 'POST', body: 'hello' });
    const dm = (await mina.ok('conversations.open', { users: theo.userId })).channel.id;
    await mina.ok('files.completeUploadExternal', { files: [{ id: reserved.file_id }], channel_id: dm });
    assert.equal((await owner.call('files.info', { file: reserved.file_id })).error, 'file_not_found');
    assert.equal((await owner.call('client.files.share', { file: reserved.file_id, to: [channel] })).error, 'file_not_found');
    await mina.ok('client.files.share', { file: reserved.file_id, to: [channel], text: 'sharing my notes' });
    const file = (await owner.ok('files.info', { file: reserved.file_id })).file;
    assert.ok(file.channels.includes(channel));
  });

  test('snippets are text files with a language', async () => {
    const reserved = await mina.ok('files.getUploadURLExternal', { filename: 'query.sql', length: 18, snippet_type: 'sql' });
    await fetch(reserved.upload_url, { method: 'POST', body: 'SELECT 1 FROM dual' });
    const done = await mina.ok('files.completeUploadExternal', { files: [{ id: reserved.file_id, title: 'Query' }], channel_id: channel });
    assert.equal(done.files[0].mode, 'snippet');
    assert.equal(done.files[0].filetype, 'sql');
    assert.equal((await mina.call('files.getUploadURLExternal', { filename: 'x', length: 1, snippet_type: '<script>' })).error, 'invalid_arguments');
  });
});

describe('drafts, sent messages and the edit/delete policy', () => {
  let t: TestApp;
  let owner: Session;
  let mina: Session;
  let general: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    mina = await addMember(t, owner, 'Mina Member');
    general = (await owner.ok('client.boot')).channels.find((item: Json) => item.is_general).id;
  });
  after(() => t.close());

  test('drafts follow the person to another device and disappear when emptied', async () => {
    const otherDevice = new Session(t.base);
    await otherDevice.ok('client.signin', { email: 'mina.member@acme.test', password: 'another long password' });
    const stream = await otherDevice.connect();
    await mina.ok('client.drafts.set', { channel: general, text: 'half a thought', client_id: 'tab-1' });
    const event = await stream.next((item) => item.type === 'draft_changed');
    assert.equal(event.text, 'half a thought');
    assert.equal(event.client_id, 'tab-1');
    const { ts } = await owner.ok('chat.postMessage', { channel: general, text: 'thread root' });
    await mina.ok('client.drafts.set', { channel: general, thread_ts: ts, text: 'reply draft' });
    const drafts = (await otherDevice.ok('client.drafts.list')).drafts as Json[];
    assert.deepEqual(drafts.map((item) => item.text).sort(), ['half a thought', 'reply draft']);
    assert.equal(drafts.find((item) => item.text === 'reply draft').thread_ts, ts);
    await mina.ok('client.drafts.set', { channel: general, text: '' });
    assert.deepEqual((await mina.ok('client.drafts.list')).drafts.map((item: Json) => item.text), ['reply draft']);
    stream.close();
  });

  test('sent: your own messages, newest first, across conversations', async () => {
    await mina.ok('chat.postMessage', { channel: general, text: 'first of mine' });
    const dm = (await mina.ok('conversations.open', { users: owner.userId })).channel.id;
    await mina.ok('chat.postMessage', { channel: dm, text: 'second of mine' });
    const sent = await mina.ok('client.messages.sent', { limit: 2 });
    assert.deepEqual(sent.messages.map((item: Json) => item.message.text), ['second of mine', 'first of mine']);
    assert.equal(sent.messages[0].channel, dm);
  });

  test('admins set how long people may edit and who may delete', async () => {
    assert.equal((await mina.call('client.admin.setMessagePolicy', { msg_edit_window_mins: 0 })).error, 'not_allowed');
    const { ts } = await mina.ok('chat.postMessage', { channel: general, text: 'tpyo' });
    await sleep(1100);
    const policy = await owner.ok('client.admin.setMessagePolicy', { msg_edit_window_mins: 0, allow_message_deletion: 'admins' });
    assert.deepEqual(policy.policy, { msg_edit_window_mins: 0, allow_message_deletion: 'admins' });
    assert.equal((await mina.call('chat.update', { channel: general, ts, text: 'typo' })).error, 'edit_window_closed');
    assert.equal((await mina.call('chat.delete', { channel: general, ts })).error, 'cant_delete_message');
    await owner.ok('chat.delete', { channel: general, ts });
    const boot = await mina.ok('client.attention.boot');
    assert.deepEqual(boot.message_policy, { msg_edit_window_mins: 0, allow_message_deletion: 'admins' });
    await owner.ok('client.admin.setMessagePolicy', { msg_edit_window_mins: 5, allow_message_deletion: 'everyone' });
    const fresh = await mina.ok('chat.postMessage', { channel: general, text: 'tpyo again' });
    await mina.ok('chat.update', { channel: general, ts: fresh.ts, text: 'typo again' });
    await mina.ok('chat.delete', { channel: general, ts: fresh.ts });
  });
});

describe('link previews', () => {
  let t: TestApp;
  let site: Server;
  let siteUrl: string;
  let owner: Session;
  let general: string;
  /** `host path` of every request the site received. */
  const requests: string[] = [];

  before(async () => {
    site = createServer((req, res) => {
      requests.push(`${req.headers.host} ${req.url}`);
      if (req.url === '/article') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Fallback title</title>
          <meta property="og:title" content="Release notes &amp; more">
          <meta property="og:description" content="What changed in 2.4">
          <meta property="og:site_name" content="Example Blog">
          <meta property="og:image" content="/cover.png"></head><body>hi</body></html>`);
      } else if (req.url === '/cover.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG);
      } else if (req.url === '/moved') {
        res.writeHead(302, { location: '/article' });
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    t = await startApp({ linkPreviews: true });
    owner = await setupWorkspace(t);
    general = (await owner.ok('client.boot')).channels.find((item: Json) => item.is_general).id;
  });
  after(async () => {
    await t.close();
    site.close();
  });

  test('reading a page: Open Graph first, then the title; links found in message text', () => {
    assert.deepEqual(readPage('<title> A &lt;b&gt; </title><meta name="description" content="d">'), { title: 'A <b>', description: 'd', site: undefined, image: undefined });
    assert.deepEqual(previewLinks('see <https://a.example/x|this> and https://b.example/y. and <https://a.example/x>'), ['https://a.example/x', 'https://b.example/y']);
    assert.deepEqual(previewLinks('a https://a.example/1 b https://a.example/2 c https://a.example/3 d https://a.example/4'), ['https://a.example/1', 'https://a.example/2', 'https://a.example/3']);
  });

  test('a link gets a preview with the image served from this server; the author can remove it', async () => {
    const stream = await owner.connect();
    const { ts } = await owner.ok('chat.postMessage', { channel: general, text: `notes: <${siteUrl}/moved>` });
    const changed = await stream.next((event) => event.subtype === 'message_changed' && event.message.ts === ts, 5000);
    stream.close();
    const preview = changed.message.attachments[0];
    assert.equal(preview.title, 'Release notes & more');
    assert.equal(preview.text, 'What changed in 2.4');
    assert.equal(preview.service_name, 'Example Blog');
    assert.equal(preview.original_url, `${siteUrl}/moved`);
    assert.equal(changed.message.edited, undefined, 'a preview is not an edit');
    assert.deepEqual([preview.image_width, preview.image_height], [2, 2]);
    const imagePath = new URL(preview.image_url).pathname;
    assert.match(imagePath, /^\/previews\/lp[0-9a-f]{40}$/);
    const image = await fetch(`${t.base}${imagePath}`, { headers: { cookie: owner.cookie } });
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
    assert.equal((await fetch(`${t.base}${imagePath}`)).status, 404, 'signed-in only');

    const mina = await addMember(t, owner, 'Mina Member');
    assert.equal((await mina.call('client.messages.removePreview', { channel: general, ts, url: `${siteUrl}/moved` })).error, 'cant_update_message');
    await owner.ok('client.messages.removePreview', { channel: general, ts, url: `${siteUrl}/moved` });
    const after = (await owner.ok('conversations.history', { channel: general, limit: 1 })).messages[0];
    assert.equal(after.attachments, undefined);
  });

  test('private addresses are refused when the server is not local, and bots get no previews', async () => {
    process.env.ALLOW_PRIVATE_APP_URLS = '0';
    try {
      const { ts } = await owner.ok('chat.postMessage', { channel: general, text: `${siteUrl}/article?again=1` });
      await sleep(400);
      const message = (await owner.ok('conversations.history', { channel: general, limit: 5 })).messages.find((item: Json) => item.ts === ts);
      assert.equal(message.attachments, undefined);
    } finally {
      delete process.env.ALLOW_PRIVATE_APP_URLS;
    }
    const bot = createBot(t, ['chat:write']);
    const posted = await callWithToken(t.base, bot.token, 'chat.postMessage', { channel: general, text: `${siteUrl}/article?bot=1` });
    await sleep(400);
    const message = (await owner.ok('conversations.history', { channel: general, limit: 5 })).messages.find((item: Json) => item.ts === posted.ts);
    assert.equal(message.attachments, undefined);
  });

  test('a link under a domain an app registered is left to that app', async () => {
    // `news.localhost` reaches the test site; first show that it is previewed like any other link.
    const news = `http://news.localhost:${new URL(siteUrl).port}`;
    const stream = await owner.connect();
    const first = await owner.ok('chat.postMessage', { channel: general, text: `${news}/article` });
    const previewed = await stream.next((event) => event.subtype === 'message_changed' && event.message.ts === first.ts, 5000);
    assert.equal(previewed.message.attachments[0].original_url, `${news}/article`);

    const app = await createPlatformApp(owner, 'Newsroom');
    await owner.ok('client.apps.update', { app: app.id, unfurl_domains: 'news.localhost' });
    requests.length = 0;
    const second = await owner.ok('chat.postMessage', { channel: general, text: `${news}/moved and ${siteUrl}/article` });
    const changed = await stream.next((event) => event.subtype === 'message_changed' && event.message.ts === second.ts, 5000);
    stream.close();
    assert.deepEqual(
      changed.message.attachments.map((item: Json) => item.original_url),
      [`${siteUrl}/article`],
      'only the link no app registered gets a generic preview',
    );
    assert.equal(requests.filter((entry) => entry.startsWith('news.localhost')).length, 0, 'the registered link is not fetched');
  });
});
