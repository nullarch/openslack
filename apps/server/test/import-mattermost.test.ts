import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { importMattermost, markdownToMrkdwn } from '../src/importer/mattermost.ts';
import { Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';

const AT = 1_731_000_000_000; // ms

/** A bulk export as documented: one JSON object per line, in the documented order. */
function exportLines(): string {
  const lines: unknown[] = [
    { type: 'version', version: 1, info: { generator: 'mmctl', version: '10.0.0' } },
    { type: 'team', team: { name: 'eng', display_name: 'Engineering', type: 'O' } },
    { type: 'team', team: { name: 'ops', display_name: 'Ops', type: 'O' } },
    { type: 'channel', channel: { team: 'eng', name: 'town-square', display_name: 'Town Square', type: 'O', header: 'Welcome', purpose: 'Everyone' } },
    { type: 'channel', channel: { team: 'eng', name: 'backend', display_name: 'Backend', type: 'P', purpose: 'APIs' } },
    { type: 'channel', channel: { team: 'ops', name: 'town-square', display_name: 'Town Square', type: 'O' } },
    {
      type: 'user',
      user: {
        username: 'olive',
        email: 'owner@acme.test',
        roles: 'system_admin system_user',
        teams: [{ name: 'eng', roles: 'team_user', channels: [{ name: 'town-square', roles: 'channel_user' }, { name: 'backend', roles: 'channel_user' }] }],
      },
    },
    {
      type: 'user',
      user: {
        username: 'bob.builder',
        email: 'bob@acme.test',
        first_name: 'Bob',
        last_name: 'Builder',
        position: 'SRE',
        roles: 'system_user',
        teams: [
          { name: 'eng', roles: 'team_user', channels: [{ name: 'town-square', roles: 'channel_user' }] },
          { name: 'ops', roles: 'team_user', channels: [{ name: 'town-square', roles: 'channel_user' }] },
        ],
      },
    },
    { type: 'user', user: { username: 'gone', email: 'gone@acme.test', roles: 'system_user', delete_at: AT, teams: [] } },
    {
      type: 'post',
      post: {
        team: 'eng',
        channel: 'town-square',
        user: 'olive',
        message: 'Deploy is **done**, see [the log](https://ci.example.com/1) and ping @bob.builder',
        props: {},
        create_at: AT,
        reactions: [{ user: 'bob.builder', emoji_name: '+1', create_at: AT + 5 }],
        replies: [
          { user: 'bob.builder', message: 'thanks, *nice*', create_at: AT + 1000 },
          { user: 'olive', message: 'with a file', create_at: AT + 2000, attachments: [{ path: 'attachments/notes.txt' }] },
        ],
      },
    },
    // Same millisecond, same channel: both must survive.
    { type: 'post', post: { team: 'eng', channel: 'town-square', user: 'bob.builder', message: 'same moment 1', props: {}, create_at: AT + 3000 } },
    { type: 'post', post: { team: 'eng', channel: 'town-square', user: 'olive', message: 'same moment 2', props: {}, create_at: AT + 3000 } },
    { type: 'post', post: { team: 'eng', channel: 'backend', user: 'olive', message: 'private plans `**not bold**`', props: {}, create_at: AT + 4000 } },
    { type: 'post', post: { team: 'ops', channel: 'town-square', user: 'bob.builder', message: 'ops square', props: {}, create_at: AT + 5000 } },
    { type: 'post', post: { team: 'eng', channel: 'no-such-channel', user: 'olive', message: 'lost', props: {}, create_at: AT + 6000 } },
    { type: 'direct_channel', direct_channel: { members: ['olive', 'bob.builder'] } },
    { type: 'direct_post', direct_post: { channel_members: ['olive', 'bob.builder'], user: 'bob.builder', message: '한글 메시지도 됩니다', create_at: AT + 7000 } },
  ];
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}

describe('Mattermost bulk export import', () => {
  let t: TestApp;
  let owner: Session;
  let dir: string;
  let zipPath: string | null = null;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mm-export-'));
    writeFileSync(join(dir, 'export.jsonl'), exportLines());
    mkdirSync(join(dir, 'data', 'attachments'), { recursive: true });
    writeFileSync(join(dir, 'data', 'attachments', 'notes.txt'), 'notes from mattermost');
    try {
      execFileSync('zip', ['-q', '-r', join(dir, 'export.zip'), 'export.jsonl', 'data'], { cwd: dir });
      zipPath = join(dir, 'export.zip');
    } catch {
      zipPath = null;
    }
    t = await startApp();
    owner = await setupWorkspace(t);
  });
  after(async () => {
    await t.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('Markdown becomes mrkdwn, outside code', () => {
    const ids: Record<string, string> = { bob: 'UBOB' };
    const convert = (text: string): string => markdownToMrkdwn(text, (name) => ids[name] ?? null);
    assert.equal(convert('**bold** and *italic* and ~~gone~~'), '*bold* and _italic_ and ~gone~');
    assert.equal(convert('see [docs](https://x.test/a)'), 'see <https://x.test/a|docs>');
    assert.equal(convert('hi @bob, and @nobody'), 'hi <@UBOB>, and @nobody');
    assert.equal(convert('@channel heads up'), '<!channel> heads up');
    assert.equal(convert('`**stay**` and ```\n**stay**\n```'), '`**stay**` and ```\n**stay**\n```');
  });

  test('imports people, channels across teams, threads, reactions, files and direct messages', async () => {
    const source = zipPath ?? join(dir, 'export.jsonl');
    const report = await importMattermost(t.app.ctx, source);
    assert.deepEqual(report.users, { created: 2, matched: 1 });
    assert.deepEqual(report.channels, { created: 3, matched: 0 });
    assert.equal(report.directs, 1);
    assert.equal(report.messages.imported, 8); // 5 posts in channels, 2 replies, 1 direct message
    assert.equal(report.messages.failed, 1);
    assert.equal(report.replies, 2);
    assert.equal(report.reactions, 1);
    if (zipPath) assert.deepEqual(report.files, { stored: 1, missing: 0 });
    assert.ok(report.problems.some((line) => line.includes('no-such-channel')));

    const boot = await owner.ok('client.boot');
    const names = boot.channels.filter((channel: Json) => !channel.is_im).map((channel: Json) => channel.name).sort();
    // The two "town-square" channels collided, so each got its team's name.
    assert.ok(names.includes('eng-town-square'));
    assert.ok(names.includes('backend'));
    const users = (await owner.ok('users.list')).members;
    const bob = users.find((user: Json) => user.name === 'bob.builder');
    assert.equal(bob.real_name, 'Bob Builder');
    assert.equal(bob.profile.title, 'SRE');
    assert.equal(users.find((user: Json) => user.name === 'gone').deleted, true);

    const square = boot.channels.find((channel: Json) => channel.name === 'eng-town-square');
    assert.equal(square.topic.value, 'Welcome');
    const history = await owner.ok('conversations.history', { channel: square.id, limit: 10 });
    const texts = history.messages.map((message: Json) => message.text);
    assert.ok(texts.includes('same moment 1') && texts.includes('same moment 2'));
    const deploy = history.messages.find((message: Json) => message.text.startsWith('Deploy'));
    assert.equal(deploy.text, `Deploy is *done*, see <https://ci.example.com/1|the log> and ping <@${bob.id}>`);
    assert.equal(deploy.reply_count, 2);
    assert.deepEqual(deploy.reactions, [{ name: '+1', users: [bob.id], count: 1 }]);
    const thread = await owner.ok('conversations.replies', { channel: square.id, ts: deploy.ts });
    assert.equal(thread.messages[1].text, 'thanks, _nice_');
    if (zipPath) {
      const file = thread.messages[2].files[0];
      const body = await fetch(`${t.base}${new URL(file.url_private).pathname}`, { headers: { cookie: owner.cookie } });
      assert.equal(await body.text(), 'notes from mattermost');
    }
    const backend = boot.channels.find((channel: Json) => channel.name === 'backend');
    assert.equal(backend.is_private, true);
    const dm = boot.channels.find((channel: Json) => channel.is_im && channel.user === bob.id);
    assert.equal((await owner.ok('conversations.history', { channel: dm.id })).messages[0].text, '한글 메시지도 됩니다');
    assert.equal((await owner.ok('search.messages', { query: '한글 메시지' })).messages.total, 1);
  });

  test('running it again adds nothing', async () => {
    const report = await importMattermost(t.app.ctx, zipPath ?? join(dir, 'export.jsonl'));
    assert.equal(report.messages.imported, 0);
    assert.equal(report.messages.alreadyPresent, 8);
    assert.equal(report.reactions, 0);
  });

  test('people from the export claim their account through an invite', async () => {
    const { invite } = await owner.ok('client.invites.create', {});
    const bob = new Session(t.base);
    const signup = await bob.ok('client.signup', { code: invite.code, email: 'bob@acme.test', password: 'a long enough password', real_name: 'Bob Builder' });
    const boot = await bob.ok('client.boot');
    assert.equal(boot.self.id, signup.user_id);
    assert.ok(boot.channels.some((channel: Json) => channel.name === 'ops-town-square'));
  });
});
