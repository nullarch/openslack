import type { Block } from '@app/shared';
import type { Ctx } from '../ctx.ts';
import { hashPassword } from '../core/auth.ts';
import { addMember, createChannel, getConv, openDirect, type ConvRow } from '../core/conversations.ts';
import { newHex, newId, newSecret, nowSeconds } from '../core/ids.ts';
import { addReaction, postMessage, requireMessage } from '../core/messages.ts';
import { createUser, type UserRow } from '../core/users.ts';

export const DEMO_EMAIL = 'maya@example.com';
export const DEMO_PASSWORD = 'demo-password';

interface Line {
  /** Minutes before now. */
  ago: number;
  who: string;
  text?: string;
  blocks?: Block[];
  /** Key of the message this replies to. */
  reply?: string;
  /** Key so later lines can reply to or react to this one. */
  key?: string;
  reactions?: Record<string, string[]>;
}

function tsAgo(minutes: number, jitter: number): string {
  const micros = BigInt(Date.now() - minutes * 60_000) * 1000n + BigInt(jitter);
  return `${(micros / 1_000_000n).toString().padStart(10, '0')}.${(micros % 1_000_000n).toString().padStart(6, '0')}`;
}

function createBotApp(ctx: Ctx, owner: UserRow, name: string, handle: string, description: string): UserRow {
  const appId = newId('A');
  const botId = newId('B');
  const bot = createUser(ctx, { realName: name, isBot: true, botId, appId, handle });
  ctx.db.run(
    `INSERT INTO apps (id, name, description, created_by, bot_user_id, bot_id, signing_secret, client_id, client_secret,
       verification_token, socket_mode, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    appId,
    name,
    description,
    owner.id,
    bot.id,
    botId,
    newHex(16),
    `${newId('', 12)}.${newId('', 12)}`,
    newHex(16),
    newSecret(18),
    nowSeconds(),
  );
  return bot;
}

/**
 * Fill an empty database with a believable small team: people, channels,
 * threads, reactions, a deploy bot and an AI agent. Used for the public demo,
 * screenshots and local development. Returns false when a workspace already exists.
 */
export async function seedDemo(ctx: Ctx): Promise<boolean> {
  if (ctx.team()) return false;
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  ctx.db.run('INSERT INTO team (id, name, domain, created) VALUES (?, ?, ?, ?)', newId('T'), 'Northwind', 'northwind', nowSeconds());
  ctx.invalidateTeam();

  const people: Record<string, UserRow> = {};
  const person = (key: string, name: string, title: string, tz: string, role: UserRow['role'] = 'member'): void => {
    const row = createUser(ctx, {
      email: key === 'maya' ? DEMO_EMAIL : `${key}@example.com`,
      realName: name,
      displayName: name.split(' ')[0],
      passwordHash,
      role,
      tz,
    });
    ctx.db.run('UPDATE users SET title = ? WHERE id = ?', title, row.id);
    people[key] = row;
  };
  person('maya', 'Maya Chen', 'Engineering Lead', 'America/Los_Angeles', 'primary_owner');
  person('daniel', 'Daniel Okafor', 'Backend Engineer', 'Europe/London');
  person('sofia', 'Sofia Rossi', 'Product Designer', 'Europe/Rome');
  person('jun', 'Jun Park', 'Frontend Engineer', 'Asia/Seoul');
  person('priya', 'Priya Nair', 'Product Manager', 'Asia/Kolkata', 'admin');
  person('tom', 'Tom Becker', 'Site Reliability', 'Europe/Berlin');
  person('aiko', 'Aiko Tanaka', 'Customer Success', 'Asia/Tokyo');
  const maya = people.maya!;
  people.deploy = createBotApp(ctx, maya, 'Deploy Bot', 'deploybot', 'Announces builds and deploys.');
  people.atlas = createBotApp(ctx, maya, 'Atlas', 'atlas', 'An AI agent that investigates failures and opens pull requests.');
  ctx.db.run("UPDATE users SET status_emoji = ':palm_tree:', status_text = 'Out until Monday' WHERE id = ?", people.aiko!.id);
  ctx.db.run("UPDATE users SET status_emoji = ':headphones:', status_text = 'Focus time' WHERE id = ?", people.jun!.id);

  const humans = ['maya', 'daniel', 'sofia', 'jun', 'priya', 'tom', 'aiko'];
  const channel = (name: string, purpose: string, members: string[], options: { isPrivate?: boolean; isGeneral?: boolean } = {}): ConvRow => {
    const conv = createChannel(ctx, { name, purpose, creator: maya.id, isPrivate: options.isPrivate ?? false, isGeneral: options.isGeneral });
    for (const key of members) {
      if (key !== 'maya') addMember(ctx, conv, people[key]!.id, { silent: true });
    }
    // The creation message is noise in a seeded history.
    ctx.db.run("DELETE FROM messages WHERE conversation_id = ? AND subtype = 'channel_join'", conv.id);
    return getConv(ctx, conv.id)!;
  };
  const general = channel('general', 'Announcements and conversation for the whole team.', humans, { isGeneral: true });
  const engineering = channel('engineering', 'Build, ship, and argue about tabs.', ['maya', 'daniel', 'jun', 'tom', 'priya', 'atlas', 'deploy']);
  const deploys = channel('deploys', 'Every build and deploy, as it happens.', ['maya', 'daniel', 'jun', 'tom', 'deploy']);
  const design = channel('design', 'Critiques, explorations and pixel debates.', ['maya', 'sofia', 'jun', 'priya']);
  const support = channel('support', 'What customers are telling us.', ['maya', 'aiko', 'priya', 'daniel']);
  const random = channel('random', 'Everything that does not fit anywhere else.', humans);
  const leadership = channel('leadership', 'Planning and hiring.', ['maya', 'priya'], { isPrivate: true });
  ctx.db.run('UPDATE team SET prefs = ?', JSON.stringify({ default_channels: [general.id, random.id] }));
  ctx.invalidateTeam();

  let counter = 0;
  const keys = new Map<string, { conv: ConvRow; ts: string }>();
  const say = (conv: ConvRow, lines: Line[]): void => {
    for (const line of lines) {
      counter += 1;
      const author = people[line.who]!;
      const row = postMessage(ctx, {
        conv: getConv(ctx, conv.id)!,
        userId: author.id,
        botId: author.bot_id,
        appId: author.app_id,
        text: line.text ?? '',
        blocks: line.blocks ?? null,
        threadTs: line.reply ? keys.get(line.reply)!.ts : null,
        ts: tsAgo(line.ago, counter),
        silent: true,
      });
      if (line.key) keys.set(line.key, { conv, ts: row.ts });
      for (const [name, users] of Object.entries(line.reactions ?? {})) {
        for (const user of users) addReaction(ctx, conv, requireMessage(ctx, conv.id, row.ts), name, people[user]!.id);
      }
    }
  };
  const at = (key: string): string => `<@${people[key]!.id}>`;

  say(general, [
    { ago: 2890, who: 'priya', text: `Welcome ${at('aiko')} to the team! :wave: Aiko joins us from Tokyo to lead customer success.`, reactions: { wave: ['maya', 'sofia', 'jun', 'tom'], tada: ['daniel', 'maya'] } },
    { ago: 2880, who: 'aiko', text: 'Thank you all! Excited to be here. I will be doing listening tours this week — expect a calendar invite.' },
    { ago: 1500, who: 'maya', text: '*2.4 ships Thursday.* Code freeze is Wednesday 18:00 UTC. If something is at risk, say so in <#' + engineering.id + '> today rather than tomorrow.', key: 'freeze', reactions: { white_check_mark: ['daniel', 'jun', 'tom', 'priya'] } },
    { ago: 1490, who: 'tom', text: 'On-call for release week is me, then Daniel. Runbook is pinned in the incidents doc.', reply: 'freeze' },
    { ago: 1485, who: 'sofia', text: 'Release notes draft is ready for review. Screenshots land tonight.', reply: 'freeze' },
    { ago: 320, who: 'priya', text: 'Reminder: all-hands moved to 16:00 UTC so Tokyo and Seoul can make it without a midnight alarm. :pray:', reactions: { pray: ['aiko', 'jun'], heart: ['aiko'] } },
    { ago: 42, who: 'aiko', text: 'Three customers asked about self-hosting in the last two days. Sharing notes in <#' + support.id + '>.' },
  ]);

  say(engineering, [
    { ago: 1320, who: 'daniel', text: 'Heads up: the session store migration is behind a flag. Flip `sessions_v2` in staging if you want to try it.' },
    { ago: 1300, who: 'jun', text: 'Tried it — sign-in is noticeably faster. One thing: the "remember me" checkbox no longer does anything.', reactions: { eyes: ['daniel'] } },
    { ago: 1290, who: 'daniel', text: 'Good catch. That path still reads the old cookie. Fix incoming.' },
    { ago: 410, who: 'tom', text: 'p95 on `/api/search` dropped from 480ms to 95ms after the index change. Graph in the thread.', key: 'p95', reactions: { rocket: ['maya', 'daniel', 'jun'], fire: ['priya'] } },
    { ago: 405, who: 'maya', text: 'That is a bigger win than the whole last quarter of tuning. What changed?', reply: 'p95' },
    { ago: 400, who: 'tom', text: 'Trigram index instead of scanning. Also stopped counting total hits on every keystroke.', reply: 'p95' },
    { ago: 96, who: 'maya', text: `${at('atlas')} the checkout test started failing on main about an hour ago. Can you find out why?`, key: 'atlas' },
    {
      ago: 94,
      who: 'atlas',
      reply: 'atlas',
      text: 'Found it: a rounding change in the tax helper.',
      blocks: [
        {
          type: 'markdown',
          text:
            '**Cause.** `checkout.total` fails because `roundTax()` switched from banker\'s rounding to half-up in `a41c9e7`. One fixture lands exactly on a half cent.\n\n' +
            '```diff\n- return Math.round(amount * 100) / 100;\n+ return roundHalfEven(amount, 2);\n```\n\n' +
            '**What I did**\n\n1. Reproduced locally with the failing fixture (`cart-eu-07`).\n2. Restored half-even rounding and added a test for the half-cent case.\n3. Ran the checkout suite: 214 passed, 0 failed.',
        },
        {
          type: 'actions',
          block_id: 'atlas_pr',
          elements: [
            { type: 'button', action_id: 'open_pr', style: 'primary', text: { type: 'plain_text', text: 'Open pull request' }, value: 'fix-tax-rounding' },
            { type: 'button', action_id: 'show_diff', text: { type: 'plain_text', text: 'Show full diff' }, value: 'fix-tax-rounding' },
            { type: 'button', action_id: 'dismiss', text: { type: 'plain_text', text: 'Dismiss' }, value: 'dismiss' },
          ],
        },
      ],
    },
    { ago: 90, who: 'daniel', text: 'That was my commit. Half-even is right for tax — thanks for catching it before the freeze.', reply: 'atlas', reactions: { pray: ['maya'] } },
    { ago: 88, who: 'maya', text: 'Open the PR, I will review it now.', reply: 'atlas' },
    { ago: 30, who: 'jun', text: 'New composer is behind `?composer=next` on staging. Mentions, emoji and slash commands all autocomplete now.', reactions: { tada: ['sofia', 'maya'] } },
    { ago: 12, who: 'priya', text: 'Are we still good for the freeze tomorrow? Anything I should warn customers about?' },
    { ago: 9, who: 'maya', text: 'On track. The only open item is the tax fix above, and that is in review.' },
  ]);

  const deployBlocks = (title: string, detail: string, fields: [string, string][], buttons: boolean): Block[] => {
    const blocks: Block[] = [
      { type: 'section', text: { type: 'mrkdwn', text: `*${title}*\n${detail}` } },
      { type: 'section', fields: fields.map(([label, value]) => ({ type: 'mrkdwn', text: `*${label}*\n${value}` })) },
    ];
    if (buttons) {
      blocks.push({
        type: 'actions',
        block_id: 'deploy_actions',
        elements: [
          { type: 'button', action_id: 'promote', style: 'primary', text: { type: 'plain_text', text: 'Promote to production' }, value: 'build-1482' },
          { type: 'button', action_id: 'rollback', style: 'danger', text: { type: 'plain_text', text: 'Roll back' }, value: 'build-1481' },
          { type: 'button', action_id: 'logs', text: { type: 'plain_text', text: 'View logs' }, value: 'build-1482' },
        ],
      });
    }
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Triggered by a push to `main` · pipeline #1482' }] });
    return blocks;
  };
  say(deploys, [
    { ago: 600, who: 'deploy', text: 'Build 1480 passed', blocks: deployBlocks(':white_check_mark: Build 1480 passed', 'api · `7f3e21b` Speed up search with a trigram index', [['Duration', '3m 12s'], ['Tests', '1,204 passed']], false) },
    { ago: 598, who: 'deploy', text: 'Deployed 1480 to production', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: ':rocket: *Deployed build 1480 to production* — 12 pods healthy, error rate 0.02%' } }], reactions: { rocket: ['tom'] } },
    { ago: 110, who: 'deploy', text: 'Build 1481 failed', blocks: deployBlocks(':x: Build 1481 failed', 'api · `a41c9e7` Simplify tax rounding', [['Duration', '2m 47s'], ['Tests', '1,203 passed, *1 failed*']], false), key: 'failed' },
    { ago: 108, who: 'tom', text: 'Looks like checkout totals. Not infrastructure.', reply: 'failed' },
    { ago: 21, who: 'deploy', text: 'Build 1482 passed and is on staging', blocks: deployBlocks(':white_check_mark: Build 1482 passed · deployed to staging', 'api · `c09d5aa` Restore half-even tax rounding', [['Duration', '3m 05s'], ['Tests', '1,205 passed']], true) },
  ]);

  say(design, [
    { ago: 980, who: 'sofia', text: 'Three directions for the empty states. I lean toward B: one line, one action, no illustration.', key: 'empty', reactions: { two: ['jun', 'priya'], heart: ['maya'] } },
    { ago: 975, who: 'jun', text: 'B. It is also the only one that works at 320px without wrapping.', reply: 'empty' },
    { ago: 970, who: 'priya', text: 'B from me too. Can the action be the thing most people do first, not "learn more"?', reply: 'empty' },
    { ago: 250, who: 'sofia', text: 'Dark theme contrast pass is done. Secondary text went from 3.9:1 to 5.2:1 — small change, much easier to read.' },
    { ago: 60, who: 'jun', text: 'Shipping the new sidebar spacing to staging in an hour. Yell if the unread badges look off.' },
  ]);

  say(support, [
    { ago: 700, who: 'aiko', text: 'A logistics customer wants to keep ten years of history for audits. Today they export every 90 days by hand.' },
    { ago: 44, who: 'aiko', text: 'Notes from this week:\n• 3 of 7 calls asked for self-hosting\n• 2 asked whether their existing bots would keep working\n• nobody asked for more emoji', reactions: { joy: ['maya', 'daniel'] } },
    { ago: 40, who: 'priya', text: 'The bot question keeps coming up. Worth a short doc we can link to.' },
  ]);

  say(random, [
    { ago: 2000, who: 'tom', text: 'Whoever left the oat milk out: it has become sentient and is asking about equity.', reactions: { joy: ['maya', 'sofia', 'jun', 'priya', 'daniel'] } },
    { ago: 500, who: 'jun', text: 'Seoul office tip: the kimchi jjigae place downstairs now does lunch sets. 김치찌개 추천합니다 :ramen:' },
    { ago: 70, who: 'daniel', text: 'Friday demo slot is open if anyone wants to show something.' },
  ]);

  say(leadership, [
    { ago: 1400, who: 'priya', text: 'Two strong candidates for the infrastructure role. Debrief Thursday after the release?' },
    { ago: 1390, who: 'maya', text: 'Thursday works. I would like Tom in the room for the second one.' },
  ]);

  const dm = (other: string, lines: Line[]): ConvRow => {
    const conv = openDirect(ctx, maya.id, [people[other]!.id]).conv;
    say(conv, lines);
    ctx.db.run('UPDATE members SET is_open = 1 WHERE conversation_id = ?', conv.id);
    return conv;
  };
  const withDaniel = dm('daniel', [
    { ago: 87, who: 'daniel', text: 'Sorry about the rounding thing. I should have run the full checkout suite.' },
    { ago: 85, who: 'maya', text: 'No harm done — it was caught in an hour. Review the PR with me?' },
    { ago: 6, who: 'daniel', text: 'Approved. One comment on the test name, not blocking.' },
  ]);
  dm('sofia', [
    { ago: 300, who: 'sofia', text: 'Do you have ten minutes tomorrow to look at the onboarding flow?' },
    { ago: 295, who: 'maya', text: 'Yes — after standup.' },
  ]);
  dm('atlas', [
    { ago: 200, who: 'maya', text: 'Summarise what changed in the API since last Thursday.' },
    {
      ago: 199,
      who: 'atlas',
      text: 'Eleven merged pull requests since Thursday.',
      blocks: [
        {
          type: 'markdown',
          text: '**Eleven merged pull requests since Thursday**\n\n- **Search**: trigram index, p95 480ms → 95ms\n- **Sessions**: new store behind `sessions_v2`\n- **Tax**: rounding change, reverted today\n- **Docs**: migration guide for bot tokens',
        },
      ],
    },
  ]);

  // Everyone has read everything, except a few things left unread for Maya.
  ctx.db.run(
    'UPDATE members SET last_read = (SELECT last_ts FROM conversations WHERE conversations.id = members.conversation_id)',
  );
  const unreadSince = (conv: ConvRow, minutes: number): void => {
    ctx.db.run('UPDATE members SET last_read = ? WHERE conversation_id = ? AND user_id = ?', tsAgo(minutes, 0), conv.id, maya.id);
  };
  unreadSince(general, 100);
  unreadSince(deploys, 50);
  unreadSince(design, 100);
  unreadSince(withDaniel, 10);
  ctx.db.run('UPDATE members SET is_starred = 1 WHERE conversation_id = ? AND user_id = ?', engineering.id, maya.id);
  return true;
}
