import { readFileSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { channelNameError, normalizeChannelName } from '@app/shared';
import type { Ctx } from '../ctx.ts';
import { getConv, type ConvRow } from '../core/conversations.ts';
import { createPendingFile, receiveUpload } from '../core/files.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import { getMessage, postMessage } from '../core/messages.ts';
import { createUser, uniqueHandle, type UserRow } from '../core/users.ts';
import { openArchive, type Archive } from './archive.ts';

/**
 * Import a Mattermost bulk export: the JSONL file `mmctl export create`
 * produces, on its own or inside the export zip. Teams fold into this one
 * workspace (channel names that collide across teams get the team's name as a
 * prefix). Running it again is safe: what is already present is skipped.
 *
 * Format: https://docs.mattermost.com/administration-guide/onboard/bulk-loading-data.html
 */

export interface MattermostReport {
  users: { created: number; matched: number };
  channels: { created: number; matched: number };
  directs: number;
  messages: { imported: number; alreadyPresent: number; failed: number };
  replies: number;
  reactions: number;
  files: { stored: number; missing: number };
  problems: string[];
  problemCount: number;
}

type Loose = Record<string, unknown>;

interface MmReaction {
  user?: string;
  emoji_name?: string;
}
interface MmAttachment {
  path?: string;
}
interface MmReply {
  user?: string;
  message?: string;
  create_at?: number;
  reactions?: MmReaction[];
  attachments?: MmAttachment[];
}
interface MmPost extends MmReply {
  team?: string;
  channel?: string;
  channel_members?: string[];
  replies?: MmReply[];
}

const MAX_PROBLEMS = 500;

/** Mattermost Markdown → Slack mrkdwn, outside code. */
export function markdownToMrkdwn(text: string, mention: (username: string) => string | null): string {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part; // code stays as it is
      return part
        .replace(/!?\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
        .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1_$2_') // *italic* → _italic_
        .replace(/\*\*(?!\s)([^*\n]+?)\*\*/g, '*$1*') // **bold** → *bold*
        .replace(/~~(?!\s)([^~\n]+?)~~/g, '~$1~')
        .replace(/(^|[\s(])@([a-z0-9._-]+)/gi, (all, lead: string, name: string) => {
          if (name === 'channel' || name === 'here' || name === 'all') return `${lead}<!${name === 'all' ? 'everyone' : name}>`;
          const id = mention(name.replace(/[._-]+$/, ''));
          return id ? `${lead}<@${id}>${name.slice(name.replace(/[._-]+$/, '').length)}` : all;
        });
    })
    .join('');
}

function readLines(path: string): { lines: string[]; archive: Archive | null; base: string } {
  if (statSync(path).isFile() && /\.jsonl?$/i.test(path)) {
    return { lines: readFileSync(path, 'utf8').split('\n'), archive: null, base: '' };
  }
  const archive = openArchive(path);
  const name = archive.names().find((entry) => /\.jsonl$/i.test(entry));
  if (!name) {
    archive.close();
    throw new Error('No .jsonl file found: this does not look like a Mattermost export.');
  }
  const base = name.includes('/') ? name.slice(0, name.lastIndexOf('/') + 1) : '';
  return { lines: archive.read(name).toString('utf8').split('\n'), archive, base };
}

export async function importMattermost(ctx: Ctx, path: string, log: (line: string) => void = () => {}): Promise<MattermostReport> {
  if (!ctx.team()) throw new Error('Create the workspace first (open the web address and finish setup), then import.');
  const owner = ctx.db.get<UserRow>("SELECT * FROM users WHERE role = 'primary_owner' LIMIT 1")!;
  const report: MattermostReport = {
    users: { created: 0, matched: 0 },
    channels: { created: 0, matched: 0 },
    directs: 0,
    messages: { imported: 0, alreadyPresent: 0, failed: 0 },
    replies: 0,
    reactions: 0,
    files: { stored: 0, missing: 0 },
    problems: [],
    problemCount: 0,
  };
  const problem = (line: string): void => {
    report.problemCount += 1;
    if (report.problems.length < MAX_PROBLEMS) report.problems.push(line);
  };

  const { lines, archive, base } = readLines(path);
  try {
    const records: { type: string; body: Loose }[] = [];
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line) as Loose;
        const type = String(parsed.type ?? '');
        records.push({ type, body: (parsed[type] as Loose) ?? parsed });
      } catch {
        problem(`line ${index + 1}: not valid JSON`);
      }
    });
    const of = (type: string): Loose[] => records.filter((record) => record.type === type).map((record) => record.body);

    // ── People ──────────────────────────────────────────────────────────────
    const userIds = new Map<string, string>();
    const mention = (username: string): string | null => userIds.get(username.toLowerCase()) ?? null;
    ctx.db.tx(() => {
      for (const user of of('user')) {
        const username = String(user.username ?? '').toLowerCase();
        if (!username) continue;
        const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : null;
        const existing =
          (email ? ctx.db.get<UserRow>('SELECT * FROM users WHERE email = ?', email) : undefined) ??
          ctx.db.get<UserRow>('SELECT * FROM users WHERE name = ?', username);
        if (existing) {
          userIds.set(username, existing.id);
          report.users.matched += 1;
          continue;
        }
        const realName = [user.first_name, user.last_name].filter((part) => typeof part === 'string' && part).join(' ') || username;
        const roles = String(user.roles ?? '');
        const created = createUser(ctx, {
          email,
          realName,
          displayName: typeof user.nickname === 'string' ? user.nickname : '',
          handle: uniqueHandle(ctx, username),
          role: roles.includes('system_admin') ? 'admin' : 'member',
          title: typeof user.position === 'string' ? user.position : '',
          deleted: Number(user.delete_at ?? 0) > 0,
        });
        userIds.set(username, created.id);
        report.users.created += 1;
      }
    });
    const userFor = (username: unknown, where: string): string | null => {
      const id = typeof username === 'string' ? mention(username) : null;
      if (!id) problem(`${where}: unknown user ${String(username)}`);
      return id;
    };

    // ── Channels ────────────────────────────────────────────────────────────
    const channelDefs = of('channel');
    const nameCounts = new Map<string, number>();
    for (const channel of channelDefs) {
      const name = normalizeChannelName(String(channel.name ?? ''));
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    const channelIds = new Map<string, string>(); // "team/name" → conversation id
    ctx.db.tx(() => {
      for (const channel of channelDefs) {
        const team = String(channel.team ?? '');
        const original = normalizeChannelName(String(channel.name ?? ''));
        if (!original) continue;
        let name = (nameCounts.get(original) ?? 0) > 1 ? normalizeChannelName(`${team}-${original}`) : original;
        if (channelNameError(name)) name = name.replace(/[^\p{Ll}\p{Lo}\p{N}_-]+/gu, '-').slice(0, 80);
        let conv = ctx.db.get<ConvRow>("SELECT * FROM conversations WHERE name = ? AND kind IN ('public', 'private')", name);
        if (conv) {
          report.channels.matched += 1;
        } else {
          const now = nowSeconds();
          const id = newId('C');
          ctx.db.run(
            `INSERT INTO conversations (id, kind, name, topic, topic_creator, topic_set, purpose, purpose_creator, purpose_set, creator, created, updated)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            channel.type === 'P' ? 'private' : 'public',
            name,
            String(channel.header ?? '').slice(0, 250),
            channel.header ? owner.id : '',
            channel.header ? now : 0,
            String(channel.purpose ?? '').slice(0, 250),
            channel.purpose ? owner.id : '',
            channel.purpose ? now : 0,
            owner.id,
            now,
            now,
          );
          conv = getConv(ctx, id)!;
          report.channels.created += 1;
        }
        channelIds.set(`${team}/${original}`, conv.id);
      }

      // Memberships come from each user's team → channel list.
      for (const user of of('user')) {
        const userId = mention(String(user.username ?? ''));
        if (!userId) continue;
        for (const team of (user.teams as Loose[] | undefined) ?? []) {
          for (const channel of (team.channels as Loose[] | undefined) ?? []) {
            const conversation = channelIds.get(`${String(team.name)}/${normalizeChannelName(String(channel.name ?? ''))}`);
            if (conversation) {
              ctx.db.run('INSERT OR IGNORE INTO members (conversation_id, user_id, joined) VALUES (?, ?, ?)', conversation, userId, nowSeconds());
            }
          }
        }
      }
    });
    log(`people: ${report.users.created} created, ${report.users.matched} matched; channels: ${report.channels.created} created`);

    // ── Direct conversations ────────────────────────────────────────────────
    const directFor = (members: unknown, where: string): ConvRow | null => {
      if (!Array.isArray(members)) return null;
      const ids = [...new Set(members.map((member) => userFor(member, where)).filter((id): id is string => id !== null))].sort();
      if (ids.length < 1) return null;
      const key = ids.join(',');
      let conv = ctx.db.get<ConvRow>('SELECT * FROM conversations WHERE im_key = ?', key);
      if (!conv) {
        const now = nowSeconds();
        const id = newId('D');
        ctx.db.run(
          'INSERT INTO conversations (id, kind, creator, im_key, created, updated) VALUES (?, ?, ?, ?, ?, ?)',
          id,
          ids.length > 2 ? 'mpim' : 'im',
          ids[0]!,
          key,
          now,
          now,
        );
        for (const userId of ids) {
          ctx.db.run('INSERT OR IGNORE INTO members (conversation_id, user_id, joined) VALUES (?, ?, ?)', id, userId, now);
        }
        conv = getConv(ctx, id)!;
        report.directs += 1;
      }
      return conv;
    };
    ctx.db.tx(() => {
      for (const direct of of('direct_channel')) directFor(direct.members, 'direct channel');
    });

    // ── Messages ────────────────────────────────────────────────────────────
    // A Mattermost post is identified by its time in milliseconds; posts sharing a millisecond
    // in one conversation get consecutive microseconds, in file order, so re-runs map the same way.
    const used = new Map<string, Set<string>>();
    const tsFor = (convId: string, createAt: number): string => {
      let micros = BigInt(Math.max(0, Math.floor(createAt))) * 1000n;
      let set = used.get(convId);
      if (!set) used.set(convId, (set = new Set()));
      const format = (value: bigint): string =>
        `${(value / 1_000_000n).toString().padStart(10, '0')}.${(value % 1_000_000n).toString().padStart(6, '0')}`;
      while (set.has(format(micros))) micros += 1n;
      const ts = format(micros);
      set.add(ts);
      return ts;
    };

    const attach = async (attachments: MmAttachment[] | undefined, userId: string, where: string): Promise<string[]> => {
      const ids: string[] = [];
      for (const attachment of attachments ?? []) {
        const wanted = String(attachment.path ?? '').replace(/^\/+/, '');
        const candidates = [wanted, `${base}${wanted}`, `data/${wanted}`, `${base}data/${wanted}`];
        const found = archive ? candidates.find((candidate) => archive.names().includes(candidate)) : undefined;
        if (!archive || !found) {
          report.files.missing += 1;
          problem(`${where}: attachment ${wanted} is not in the export`);
          continue;
        }
        const bytes = archive.read(found);
        const filename = found.split('/').pop() ?? 'file';
        try {
          const pending = createPendingFile(ctx, userId, filename, bytes.length, null);
          const secret = new URL(pending.uploadUrl).searchParams.get('secret')!;
          await receiveUpload(ctx, pending.row.id, secret, Readable.from([bytes]));
          ids.push(pending.row.id);
          report.files.stored += 1;
        } catch (error) {
          report.files.missing += 1;
          problem(`${where}: attachment ${filename} not stored (${error instanceof Error ? error.message : String(error)})`);
        }
      }
      return ids;
    };

    const insert = async (conv: ConvRow, item: MmReply, threadTs: string | null, where: string): Promise<string | null> => {
      const userId = userFor(item.user, where);
      if (!userId || typeof item.create_at !== 'number') {
        report.messages.failed += 1;
        return null;
      }
      const ts = tsFor(conv.id, item.create_at);
      if (getMessage(ctx, conv.id, ts)) {
        report.messages.alreadyPresent += 1;
        return ts;
      }
      const fileIds = await attach(item.attachments, userId, where);
      try {
        postMessage(ctx, {
          conv: getConv(ctx, conv.id)!,
          userId,
          text: markdownToMrkdwn(String(item.message ?? ''), mention),
          fileIds,
          threadTs,
          ts,
          silent: true,
          allowEmpty: true,
        });
      } catch (error) {
        report.messages.failed += 1;
        problem(`${where}: message at ${item.create_at} not imported (${error instanceof Error ? error.message : String(error)})`);
        return null;
      }
      report.messages.imported += 1;
      if (threadTs) report.replies += 1;
      let order = 0;
      for (const reaction of item.reactions ?? []) {
        const reactor = userFor(reaction.user, `${where} reaction`);
        const name = String(reaction.emoji_name ?? '').replace(/^\+1$/, '+1');
        if (!reactor || !name) continue;
        order += 1;
        report.reactions += ctx.db.run(
          'INSERT OR IGNORE INTO reactions (conversation_id, ts, name, user_id, created) VALUES (?, ?, ?, ?, ?)',
          conv.id,
          ts,
          name,
          reactor,
          item.create_at + order,
        ).changes;
      }
      return ts;
    };

    const posts: { conv: ConvRow; post: MmPost; where: string }[] = [];
    for (const post of of('post') as MmPost[]) {
      const id = channelIds.get(`${String(post.team)}/${normalizeChannelName(String(post.channel ?? ''))}`);
      if (!id) {
        problem(`post in ${post.team}/${post.channel}: channel not in the export`);
        report.messages.failed += 1;
        continue;
      }
      posts.push({ conv: getConv(ctx, id)!, post, where: `#${post.channel}` });
    }
    for (const post of of('direct_post') as MmPost[]) {
      const conv = directFor(post.channel_members, 'direct message');
      if (conv) posts.push({ conv, post, where: 'direct message' });
    }
    posts.sort((a, b) => Number(a.post.create_at ?? 0) - Number(b.post.create_at ?? 0));

    for (const { conv, post, where } of posts) {
      const parentTs = await insert(conv, post, null, where);
      if (!parentTs) continue;
      for (const reply of [...(post.replies ?? [])].sort((a, b) => Number(a.create_at ?? 0) - Number(b.create_at ?? 0))) {
        await insert(conv, reply, parentTs, `${where} reply`);
      }
    }

    // Imported history starts out read; last_ts follows the newest top-level message.
    ctx.db.tx(() => {
      for (const id of new Set(posts.map((entry) => entry.conv.id))) {
        ctx.db.run(
          `UPDATE conversations SET last_ts = coalesce((
             SELECT max(ts) FROM messages WHERE conversation_id = conversations.id AND (thread_ts IS NULL OR thread_ts = ts OR is_broadcast = 1)
           ), last_ts) WHERE id = ?`,
          id,
        );
        ctx.db.run('UPDATE members SET last_read = max(last_read, (SELECT last_ts FROM conversations WHERE id = ?)) WHERE conversation_id = ?', id, id);
      }
    });
  } finally {
    archive?.close();
  }
  return report;
}
