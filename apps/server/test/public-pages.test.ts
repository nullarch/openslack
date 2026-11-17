import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function page(t: TestApp, path: string): Promise<{ status: number; html: string; headers: Headers }> {
  const response = await fetch(`${t.base}${path}`, { redirect: 'manual' });
  return { status: response.status, html: await response.text(), headers: response.headers };
}

describe('public channel pages', () => {
  let t: TestApp;
  let owner: Session;
  let mina: Session;
  let announce: Json;
  let parentTs: string;
  let fileUrlPath: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    mina = await addMember(t, owner, 'Mina Member');
    await mina.ok('users.profile.set', { profile: { display_name: 'mina' } });
    announce = (await owner.ok('conversations.create', { name: 'announcements' })).channel;
    await owner.ok('conversations.setPurpose', { channel: announce.id, purpose: 'News from the team' });
    await owner.ok('conversations.invite', { channel: announce.id, users: mina.userId });
    const parent = await owner.ok('chat.postMessage', { channel: announce.id, text: `*Release 2.4* is out, thanks <@${mina.userId}> :tada: <https://example.com/notes|notes>` });
    parentTs = parent.ts;
    await mina.ok('chat.postMessage', { channel: announce.id, text: 'Great work everyone', thread_ts: parent.ts });
    await mina.ok('chat.postMessage', { channel: announce.id, text: '<script>alert(1)</script> & "quotes"' });
    await owner.ok('chat.postMessage', { channel: announce.id, markdown_text: '## Notes\n\n- one\n- two\n\n[docs](javascript:alert(1)) and [site](https://example.com)' });
    await owner.ok('reactions.add', { channel: announce.id, timestamp: parent.ts, name: 'rocket' });
    const { upload_url, file_id } = await owner.ok('files.getUploadURLExternal', { filename: 'chart.png', length: PNG.length });
    await fetch(upload_url, { method: 'POST', body: PNG });
    await owner.ok('files.completeUploadExternal', { files: [{ id: file_id }], channel_id: announce.id, initial_comment: 'the chart' });
    fileUrlPath = `/public/${announce.id}/files/${file_id}/chart.png`;
    await owner.ok('chat.postMessage', { channel: '#general', text: 'internal only' });
  });
  after(() => t.close());

  test('nothing is public until an admin says so', async () => {
    assert.equal((await page(t, `/public/${announce.id}/announcements`)).status, 404);
    assert.equal((await page(t, '/public')).status, 404);
    const robots = await page(t, '/robots.txt');
    assert.equal(robots.html, 'User-agent: *\nDisallow: /\n');
    assert.equal((await mina.call('client.admin.setChannelWeb', { channel: announce.id, web_public: true })).error, 'not_allowed');
    const secret = (await owner.ok('conversations.create', { name: 'secret', is_private: true })).channel;
    assert.equal((await owner.call('client.admin.setChannelWeb', { channel: secret.id, web_public: true })).error, 'method_not_supported_for_channel_type');
  });

  test('a public page shows the conversation safely, without emails or files', async () => {
    const result = await owner.ok('client.admin.setChannelWeb', { channel: announce.id, web_public: true });
    assert.match(result.url, new RegExp(`/public/${announce.id}/announcements$`));
    const { status, html, headers } = await page(t, `/public/${announce.id}/announcements`);
    assert.equal(status, 200);
    assert.match(headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.match(html, /<title>#announcements — Acme<\/title>/);
    assert.match(html, /<meta name="description" content="News from the team">/);
    assert.match(html, /<link rel="canonical" href="http:\/\/localhost:\d+\/public\/C[A-Z0-9]+\/announcements">/);
    assert.match(html, /property="og:title"/);
    assert.match(html, /<strong>Release 2\.4<\/strong> is out, thanks <span class="mention">@mina<\/span>/);
    assert.match(html, /🎉/);
    assert.match(html, /<a href="https:\/\/example.com\/notes" rel="nofollow ugc noopener">notes<\/a>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quotes&quot;/);
    assert.ok(!html.includes('<script'));
    assert.ok(!html.includes('javascript:'));
    assert.match(html, /<h4>Notes<\/h4><ul><li>one<\/li><li>two<\/li><\/ul>/);
    assert.match(html, /1 reply/);
    assert.match(html, /🚀<\/span> 1/);
    assert.match(html, /A file was shared here\./);
    assert.ok(!html.includes(fileUrlPath));
    assert.ok(!html.includes('@acme.test'));
    assert.ok(!html.includes('internal only'));
    assert.equal((await page(t, fileUrlPath)).status, 404);
  });

  test('threads, slugs and the sign-in or join link', async () => {
    const thread = await page(t, `/public/${announce.id}/announcements/t/${parentTs}`);
    assert.equal(thread.status, 200);
    assert.match(thread.html, /Great work everyone/);
    assert.match(thread.html, /<meta property="og:type" content="article">/);
    const renamed = await page(t, `/public/${announce.id}/old-name`);
    assert.equal(renamed.status, 301);
    assert.equal(renamed.headers.get('location'), `/public/${announce.id}/announcements`);
    assert.match((await page(t, `/public/${announce.id}/announcements`)).html, /href="\/signin">Sign in</);

    const { invite } = await owner.ok('client.invites.create', {});
    await owner.ok('client.admin.updateSettings', { public_invite_code: invite.code });
    assert.match((await page(t, `/public/${announce.id}/announcements`)).html, new RegExp(`href="/join/${invite.code}">Join Acme<`));
    await owner.ok('client.invites.revoke', { code: invite.code });
    assert.match((await page(t, `/public/${announce.id}/announcements`)).html, /href="\/signin">Sign in</);
  });

  test('files appear only when the admin allows them', async () => {
    await owner.ok('client.admin.setChannelWeb', { channel: announce.id, web_public: true, web_files: true });
    const { html } = await page(t, `/public/${announce.id}/announcements`);
    assert.ok(html.includes(fileUrlPath));
    const file = await fetch(`${t.base}${fileUrlPath}`);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
  });

  test('pages of older messages, the index, the sitemap and robots.txt', async () => {
    for (let i = 0; i < 55; i += 1) await owner.ok('chat.postMessage', { channel: announce.id, text: `update ${i}` });
    const newest = await page(t, `/public/${announce.id}/announcements`);
    assert.match(newest.html, /update 54/);
    assert.ok(!newest.html.includes('Release 2.4'));
    const older = /href="([^"]+\?before=[0-9.]+)" rel="prev"/.exec(newest.html)![1]!;
    const second = await page(t, older);
    assert.match(second.html, /Release 2\.4/);
    assert.match(second.html, /rel="next"/);

    const index = await page(t, '/public');
    assert.match(index.html, /#announcements/);
    const robots = await page(t, '/robots.txt');
    assert.match(robots.html, /Allow: \/public\/\nDisallow: \/\nSitemap: http:\/\/localhost:\d+\/sitemap.xml/);
    const sitemap = await page(t, '/sitemap.xml');
    assert.match(sitemap.html, /<loc>http:\/\/localhost:\d+\/public\/C[A-Z0-9]+\/announcements<\/loc>/);
    assert.match(sitemap.html, new RegExp(`/t/${parentTs.replace('.', '\\.')}</loc>`));
  });

  test('making the channel private takes it off the web', async () => {
    await owner.ok('admin.conversations.convertToPrivate', { channel_id: announce.id });
    assert.equal((await page(t, `/public/${announce.id}/announcements`)).status, 404);
    assert.equal((await page(t, fileUrlPath)).status, 404);
    assert.ok(!(await page(t, '/sitemap.xml')).html.includes(announce.id));
  });
});
