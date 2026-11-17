import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { discordToMrkdwn, importDiscord } from '../src/importer/discord.ts';
import { setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

const guild = { id: '900000000000000001', name: 'Makers', iconUrl: null };
const ana = { id: '100000000000000001', name: 'ana', discriminator: '0000', nickname: 'Ana', color: null, isBot: false, roles: [], avatarUrl: null };
const ben = { id: '100000000000000002', name: 'ben', discriminator: '0000', nickname: 'Ben', color: null, isBot: false, roles: [], avatarUrl: null };
const at = (minute: number): string => `2025-03-01T10:${String(minute).padStart(2, '0')}:00.000+00:00`;
const message = (id: string, minute: number, author: typeof ana, content: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  type: 'Default',
  timestamp: at(minute),
  timestampEdited: null,
  callEndedTimestamp: null,
  isPinned: false,
  content,
  author,
  attachments: [],
  embeds: [],
  stickers: [],
  reactions: [],
  mentions: [],
  inlineEmojis: [],
  ...extra,
});

function writeExport(dir: string): void {
  const general = {
    guild,
    channel: { id: '200000000000000001', type: 'GuildTextChat', categoryId: null, category: 'Text', name: 'general', topic: 'Say hi' },
    dateRange: { after: null, before: null },
    exportedAt: at(59),
    messages: [
      message('300000000000000001', 1, ana, 'Welcome **everyone** to <#200000000000000002>! cc <@100000000000000002>', {
        isPinned: true,
        reactions: [{ emoji: { id: '', name: '👍', code: 'thumbsup', isAnimated: false, imageUrl: '' }, count: 1, users: [ben] }],
        mentions: [ben],
      }),
      message('300000000000000002', 2, ben, 'thanks <:partyblob:555> ||spoiler||', { type: 'Reply', reference: { messageId: '300000000000000001', channelId: '200000000000000001', guildId: guild.id } }),
      message('300000000000000003', 3, ana, 'here is the plan', {
        attachments: [
          { id: '1', url: 'general.json_Files/plan-1A2B.txt', fileName: 'plan.txt', fileSizeBytes: 9 },
          { id: '2', url: 'https://cdn.discordapp.com/attachments/1/2/remote.png', fileName: 'remote.png', fileSizeBytes: 100 },
        ],
      }),
      { ...message('300000000000000004', 4, ana, ''), type: 'GuildMemberJoin' },
      message('300000000000000005', 5, ben, 'thread starter message'),
    ],
    messageCount: 5,
  };
  const projects = {
    guild,
    channel: { id: '200000000000000002', type: 'GuildTextChat', categoryId: null, category: 'Text', name: 'Projects 2025', topic: null },
    messages: [message('300000000000000010', 6, ben, 'projects channel')],
    messageCount: 1,
  };
  // A thread started from message …005 in #general (Discord gives the thread the starter's id).
  const thread = {
    guild,
    channel: { id: '300000000000000005', type: 'GuildPublicThread', categoryId: '200000000000000001', category: 'general', name: 'starter thread', topic: null },
    messages: [message('300000000000000020', 7, ana, 'first reply in thread'), message('300000000000000021', 8, ben, 'second reply')],
    messageCount: 2,
  };
  // A forum post: its parent (the forum) was not exported as a text channel.
  const forumPost = {
    guild,
    channel: { id: '400000000000000001', type: 'GuildPublicThread', categoryId: '210000000000000001', category: 'help-forum', name: 'How do I deploy?', topic: null },
    messages: [message('300000000000000030', 9, ben, 'I am stuck deploying'), message('300000000000000031', 10, ana, 'try the docker image')],
    messageCount: 2,
  };
  const direct = { guild, channel: { id: '500000000000000001', type: 'DirectTextChat', name: 'ben' }, messages: [message('300000000000000040', 11, ben, 'private')], messageCount: 1 };
  writeFileSync(join(dir, 'general.json'), JSON.stringify(general));
  mkdirSync(join(dir, 'general.json_Files'));
  writeFileSync(join(dir, 'general.json_Files', 'plan-1A2B.txt'), 'step 1, 2');
  writeFileSync(join(dir, 'projects.json'), JSON.stringify(projects));
  writeFileSync(join(dir, 'thread.json'), JSON.stringify(thread));
  writeFileSync(join(dir, 'forum-post.json'), JSON.stringify(forumPost));
  writeFileSync(join(dir, 'dm.json'), JSON.stringify(direct));
}

describe('Discord (DiscordChatExporter) import', () => {
  let t: TestApp;
  let owner: Session;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'discord-export-'));
    writeExport(dir);
    t = await startApp();
    owner = await setupWorkspace(t);
  });
  after(async () => {
    await t.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('markup and markdown become mrkdwn', () => {
    const lookup = { user: (id: string) => (id === '1' ? 'UONE' : null), channel: (id: string) => (id === '2' ? 'CTWO' : null) };
    assert.equal(discordToMrkdwn('**bold** *it* __under__ ~~gone~~ ||secret||', lookup), '*bold* _it_ under ~gone~ secret');
    assert.equal(discordToMrkdwn('<@1> <@!1> <@9> <#2> <#9> <@&5> <:blob:77> <a:spin:78>', lookup), '<@UONE> <@UONE> <@9> <#CTWO> #deleted-channel @role :blob: :spin:');
    assert.equal(discordToMrkdwn('@everyone see [docs](https://x.test) `**raw**`', lookup), '<!everyone> see <https://x.test|docs> `**raw**`');
  });

  test('imports channels, threads, forum posts, replies, reactions, pins and local attachments', async () => {
    const report = await importDiscord(t.app.ctx, dir);
    assert.equal(report.files, 5);
    assert.deepEqual(report.people, { created: 2, matched: report.people.matched });
    assert.deepEqual(report.channels, { created: 2, matched: 1 }); // #general joins the existing one; projects-2025 and help-forum are new
    assert.equal(report.threads, 2);
    assert.equal(report.messages.imported, 9);
    assert.equal(report.messages.skipped, 1); // the member-join notice
    assert.equal(report.reactions, 1);
    assert.equal(report.pins, 1);
    assert.deepEqual(report.attachments, { stored: 1, linked: 1, failed: 0 });
    assert.ok(report.problems.some((line) => line.includes('DirectTextChat')));

    const users = (await owner.ok('users.list')).members;
    const ben = users.find((user: Json) => user.real_name === 'Ben');
    assert.equal(ben.deleted, true, 'Discord authors are kept as former members');
    const boot = await owner.ok('client.boot');
    const byName = (name: string): Json => boot.channels.find((channel: Json) => channel.name === name);
    const general = byName('general');
    const projects = byName('projects-2025');
    assert.ok(projects, 'channel names are normalised');

    const history = (await owner.ok('conversations.history', { channel: general.id, limit: 20 })).messages;
    const welcome = history.find((m: Json) => m.text.startsWith('Welcome'));
    assert.equal(welcome.text, `Welcome *everyone* to <#${projects.id}>! cc <@${ben.id}>`);
    assert.deepEqual(welcome.reactions.map((r: Json) => [r.name, r.count]), [['thumbsup', 1]]);
    assert.deepEqual(welcome.pinned_to, [general.id]);
    const reply = history.find((m: Json) => m.text.includes('thanks'));
    assert.match(reply.text, new RegExp(`^<http://[^|]+/archives/${general.id}/p${welcome.ts.replace('.', '')}\\|↪ in reply> thanks :partyblob: spoiler$`));
    const plan = history.find((m: Json) => m.text === 'here is the plan');
    assert.equal(plan.files[0].name, 'plan.txt');
    assert.equal(plan.attachments[0].title, 'remote.png');
    const download = await fetch(`${t.base}${new URL(plan.files[0].url_private).pathname}`, { headers: { cookie: owner.cookie } });
    assert.equal(await download.text(), 'step 1, 2');

    const starter = history.find((m: Json) => m.text === 'thread starter message');
    assert.equal(starter.reply_count, 2);
    const forum = byName('help-forum');
    const post = (await owner.ok('conversations.history', { channel: forum.id })).messages[0];
    assert.equal(post.text, '*How do I deploy?*');
    const replies = (await owner.ok('conversations.replies', { channel: forum.id, ts: post.ts })).messages.map((m: Json) => m.text);
    assert.deepEqual(replies, ['*How do I deploy?*', 'I am stuck deploying', 'try the docker image']);
  });

  test('a second run adds nothing', async () => {
    const report = await importDiscord(t.app.ctx, dir);
    assert.equal(report.messages.imported, 0);
    assert.equal(report.messages.alreadyPresent, 9);
    assert.equal(report.people.created, 0);
    assert.equal(report.channels.created, 0);
    assert.equal(report.reactions, 0);
  });
});

describe('Discord import next to a private channel of the same name', () => {
  let t: TestApp;
  let owner: Session;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'discord-export-clash-'));
    writeExport(dir);
    t = await startApp();
    owner = await setupWorkspace(t);
    await owner.ok('conversations.create', { name: 'projects-2025', is_private: true });
  });
  after(async () => {
    await t.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a public Discord channel does not land in a private channel; a second run finds it again', async () => {
    const report = await importDiscord(t.app.ctx, dir);
    assert.ok(report.problems.some((line) => line.includes('projects-2025-imported')), report.problems.join('\n'));
    const kinds = () => t.app.ctx.db.all<{ name: string; kind: string }>("SELECT name, kind FROM conversations WHERE name LIKE 'projects-2025%' ORDER BY name").map((row) => ({ ...row }));
    assert.deepEqual(kinds(), [
      { name: 'projects-2025', kind: 'private' },
      { name: 'projects-2025-imported', kind: 'public' },
    ]);
    await importDiscord(t.app.ctx, dir);
    assert.equal(kinds().length, 2);
  });
});
