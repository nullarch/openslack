import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { channelNameError, normalizeChannelName, type Attachment } from '@app/shared';
import type { Ctx } from '../ctx.ts';
import { getConv, type ConvRow } from '../core/conversations.ts';
import { createPendingFile, receiveUpload } from '../core/files.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import { getMessage, postMessage } from '../core/messages.ts';
import { createUser, uniqueHandle, type UserRow } from '../core/users.ts';
import { openArchive } from './archive.ts';

/**
 * Import channels exported with DiscordChatExporter (JSON format): one file per
 * channel or thread, optionally with downloaded media next to it. Discord has
 * no server-wide export of its own, and exports carry no email addresses, so
 * authors become deactivated "former member" accounts that keep their names on
 * the history; people join with new accounts. Threads and forum posts become
 * threads; Discord replies become messages that link to what they answer.
 *
 * Format: DiscordChatExporter.Core/Exporting/JsonMessageWriter.cs
 */

export interface DiscordOptions {
  /** Fetch attachments whose `url` is still a Discord CDN address. */
  downloadFiles?: boolean;
  log?: (line: string) => void;
}

export interface DiscordReport {
  files: number;
  people: { created: number; matched: number };
  channels: { created: number; matched: number };
  messages: { imported: number; alreadyPresent: number; skipped: number; failed: number };
  threads: number;
  reactions: number;
  pins: number;
  attachments: { stored: number; linked: number; failed: number };
  problems: string[];
  problemCount: number;
}

interface DUser {
  id: string;
  name?: string;
  nickname?: string;
  isBot?: boolean;
}
interface DAttachment {
  id?: string;
  url?: string;
  fileName?: string;
  fileSizeBytes?: number;
}
interface DReaction {
  emoji?: { id?: string | null; name?: string; code?: string };
  count?: number;
  users?: DUser[];
}
interface DMessage {
  id: string;
  type?: string;
  timestamp?: string;
  timestampEdited?: string | null;
  isPinned?: boolean;
  content?: string;
  author?: DUser;
  attachments?: DAttachment[];
  reactions?: DReaction[];
  mentions?: DUser[];
  reference?: { messageId?: string | null; channelId?: string | null };
}
interface DExport {
  guild?: { id?: string; name?: string };
  channel?: { id?: string; type?: string; categoryId?: string | null; category?: string | null; name?: string; topic?: string | null };
  messages?: DMessage[];
}

interface Source {
  name: string;
  data: DExport;
  /** Read a file that sits next to the export (downloaded media), or null. */
  readLocal: (path: string) => Buffer | null;
}

const THREAD_KINDS = new Set(['GuildPublicThread', 'GuildPrivateThread', 'GuildNewsThread']);
const TEXT_KINDS = new Set(['GuildTextChat', 'GuildNews']);
const IMPORTED_TYPES = new Set(['Default', 'Reply', 'ThreadStarterMessage']);
const MAX_PROBLEMS = 500;

function loadSources(path: string): Source[] {
  const info = statSync(path);
  const fromDirectory = (root: string): Source[] => {
    const out: Source[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.endsWith('_Files')) walk(full);
        } else if (entry.name.toLowerCase().endsWith('.json')) {
          const base = dirname(full);
          out.push({
            name: entry.name,
            data: JSON.parse(readFileSync(full, 'utf8')) as DExport,
            readLocal: (relative) => {
              const target = resolve(base, normalize(relative));
              if (!target.startsWith(resolve(root) + sep)) return null; // never read outside the export
              try {
                return readFileSync(target);
              } catch {
                return null;
              }
            },
          });
        }
      }
    };
    walk(root);
    return out;
  };
  if (info.isDirectory()) return fromDirectory(path);
  if (path.toLowerCase().endsWith('.json')) {
    const root = dirname(path);
    return fromDirectory(root).filter((source) => source.name === basename(path));
  }
  const archive = openArchive(path);
  const names = archive.names();
  const sources = names
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .map((name) => {
      const base = name.includes('/') ? name.slice(0, name.lastIndexOf('/') + 1) : '';
      return {
        name,
        data: JSON.parse(archive.read(name).toString('utf8')) as DExport,
        readLocal: (relative: string) => {
          const wanted = `${base}${relative.split(/[\\/]+/).filter((part) => part && part !== '.' && part !== '..').join('/')}`;
          return names.includes(wanted) ? archive.read(wanted) : null;
        },
      };
    });
  archive.close();
  return sources;
}

/** Discord markdown and markup → Slack mrkdwn, leaving code alone. */
export function discordToMrkdwn(
  text: string,
  lookup: { user: (id: string) => string | null; channel: (id: string) => string | null },
): string {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part
        .replace(/<@!?(\d+)>/g, (all, id: string) => {
          const local = lookup.user(id);
          return local ? `<@${local}>` : all;
        })
        .replace(/<#(\d+)>/g, (all, id: string) => {
          const local = lookup.channel(id);
          return local ? `<#${local}>` : '#deleted-channel';
        })
        .replace(/<@&\d+>/g, '@role')
        .replace(/<a?:([\w~-]+):\d+>/g, ':$1:')
        .replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (_all, seconds: string) => `<!date^${seconds}^{date_short_pretty} {time}|${new Date(Number(seconds) * 1000).toISOString()}>`)
        .replace(/(^|\s)@everyone\b/g, '$1<!everyone>')
        .replace(/(^|\s)@here\b/g, '$1<!here>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
        .replace(/\*\*(?!\s)([^*\n]+?)\*\*/g, '\u0000$1\u0000') // bold, protected from the italic rule
        .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1_$2_')
        .replace(/__(?!\s)([^_\n]+?)__/g, '$1') // underline has no mrkdwn form
        .replace(/~~(?!\s)([^~\n]+?)~~/g, '~$1~')
        .replace(/\|\|([^|\n]+?)\|\|/g, '$1') // spoilers are shown plainly
        .replace(/\u0000/g, '*');
    })
    .join('');
}

function snowflakeMillis(id: string): number {
  // Discord ids encode milliseconds since 2015-01-01 in their upper bits.
  try {
    return Number((BigInt(id) >> 22n) + 1_420_070_400_000n);
  } catch {
    return 0;
  }
}

export async function importDiscord(ctx: Ctx, path: string, options: DiscordOptions = {}): Promise<DiscordReport> {
  if (!ctx.team()) throw new Error('Create the workspace first (open the web address and finish setup), then import.');
  const owner = ctx.db.get<UserRow>("SELECT * FROM users WHERE role = 'primary_owner' LIMIT 1")!;
  const log = options.log ?? (() => {});
  const report: DiscordReport = {
    files: 0,
    people: { created: 0, matched: 0 },
    channels: { created: 0, matched: 0 },
    messages: { imported: 0, alreadyPresent: 0, skipped: 0, failed: 0 },
    threads: 0,
    reactions: 0,
    pins: 0,
    attachments: { stored: 0, linked: 0, failed: 0 },
    problems: [],
    problemCount: 0,
  };
  const problem = (line: string): void => {
    report.problemCount += 1;
    if (report.problems.length < MAX_PROBLEMS) report.problems.push(line);
  };

  const sources = loadSources(path).filter((source) => {
    const ok = source.data?.channel?.id && Array.isArray(source.data.messages);
    if (!ok) problem(`${source.name}: not a DiscordChatExporter JSON export`);
    return ok;
  });
  report.files = sources.length;
  if (sources.length === 0) throw new Error('No DiscordChatExporter JSON files found.');

  // ── People: a deactivated account per Discord author, remembered by Discord id ──
  const userIds = new Map<string, string>();
  const personFor = (user: DUser | undefined): string | null => {
    if (!user?.id) return null;
    const known = userIds.get(user.id) ?? ctx.db.get<{ user_id: string }>('SELECT user_id FROM import_discord_users WHERE discord_id = ?', user.id)?.user_id;
    if (known) {
      if (!userIds.has(user.id)) report.people.matched += 1;
      userIds.set(user.id, known);
      return known;
    }
    const display = user.nickname || user.name || `discord-${user.id}`;
    const created = createUser(ctx, {
      realName: display,
      displayName: user.nickname ?? '',
      handle: uniqueHandle(ctx, user.name || display),
      isBot: user.isBot === true,
      deleted: true,
    });
    ctx.db.run('INSERT INTO import_discord_users (discord_id, user_id) VALUES (?, ?)', user.id, created.id);
    userIds.set(user.id, created.id);
    report.people.created += 1;
    return created.id;
  };

  // ── Channels: text channels as they are; forums become a channel holding their posts ──
  const channelIds = new Map<string, string>();
  const channelFor = (discordId: string, name: string, topic: string | null | undefined): ConvRow => {
    const known = channelIds.get(discordId) ?? ctx.db.get<{ conversation_id: string }>('SELECT conversation_id FROM import_discord_channels WHERE discord_id = ?', discordId)?.conversation_id;
    if (known) {
      channelIds.set(discordId, known);
      return getConv(ctx, known)!;
    }
    let local = normalizeChannelName(name);
    if (channelNameError(local)) local = local.replace(/[^\p{Ll}\p{Lo}\p{N}_-]+/gu, '-').slice(0, 80) || `discord-${discordId}`;
    let conv = ctx.db.get<ConvRow>("SELECT * FROM conversations WHERE name = ? AND kind IN ('public', 'private')", local);
    if (conv) {
      report.channels.matched += 1;
    } else {
      const now = nowSeconds();
      const id = newId('C');
      ctx.db.run(
        `INSERT INTO conversations (id, kind, name, topic, topic_creator, topic_set, creator, created, updated) VALUES (?, 'public', ?, ?, ?, ?, ?, ?, ?)`,
        id,
        local,
        (topic ?? '').slice(0, 250),
        topic ? owner.id : '',
        topic ? now : 0,
        owner.id,
        now,
        now,
      );
      ctx.db.run('INSERT OR IGNORE INTO members (conversation_id, user_id, joined) VALUES (?, ?, ?)', id, owner.id, now);
      conv = getConv(ctx, id)!;
      report.channels.created += 1;
    }
    ctx.db.run('INSERT OR IGNORE INTO import_discord_channels (discord_id, conversation_id) VALUES (?, ?)', discordId, conv.id);
    channelIds.set(discordId, conv.id);
    return conv;
  };

  const top = sources.filter((source) => TEXT_KINDS.has(source.data.channel!.type ?? 'GuildTextChat'));
  const threads = sources.filter((source) => THREAD_KINDS.has(source.data.channel!.type ?? ''));
  for (const source of sources) {
    const kind = source.data.channel!.type ?? '';
    if (!TEXT_KINDS.has(kind) && !THREAD_KINDS.has(kind)) problem(`${source.name}: ${kind || 'unknown'} channels are not imported (direct messages have no one to show them to)`);
  }
  for (const source of top) channelFor(source.data.channel!.id!, source.data.channel!.name ?? 'discord', source.data.channel!.topic);

  // ── Messages ────────────────────────────────────────────────────────────
  const used = new Map<string, Set<string>>();
  const tsFor = (convId: string, millis: number): string => {
    let micros = BigInt(Math.max(0, Math.floor(millis))) * 1000n;
    let set = used.get(convId);
    if (!set) used.set(convId, (set = new Set()));
    const format = (value: bigint): string => `${(value / 1_000_000n).toString().padStart(10, '0')}.${(value % 1_000_000n).toString().padStart(6, '0')}`;
    while (set.has(format(micros)) || (getMessage(ctx, convId, format(micros)) && !ctx.db.get('SELECT 1 FROM import_discord_messages WHERE conversation_id = ? AND ts = ?', convId, format(micros)))) micros += 1n;
    const ts = format(micros);
    set.add(ts);
    return ts;
  };
  const placed = (discordId: string): { conversation_id: string; ts: string } | undefined =>
    ctx.db.get<{ conversation_id: string; ts: string }>('SELECT conversation_id, ts FROM import_discord_messages WHERE discord_id = ?', discordId);

  const lookup = {
    user: (id: string): string | null => userIds.get(id) ?? ctx.db.get<{ user_id: string }>('SELECT user_id FROM import_discord_users WHERE discord_id = ?', id)?.user_id ?? null,
    channel: (id: string): string | null => channelIds.get(id) ?? null,
  };

  const attach = async (source: Source, message: DMessage, userId: string): Promise<{ fileIds: string[]; links: Attachment[] }> => {
    const fileIds: string[] = [];
    const links: Attachment[] = [];
    for (const item of message.attachments ?? []) {
      const url = item.url ?? '';
      const name = item.fileName || basename(url.split('?')[0] ?? '') || 'file';
      let bytes: Buffer | null = null;
      if (url && !/^https?:\/\//i.test(url)) bytes = source.readLocal(url);
      else if (url && options.downloadFiles) {
        try {
          const response = await fetch(url);
          if (response.ok && response.body) {
            const chunks: Buffer[] = [];
            for await (const chunk of Readable.fromWeb(response.body as WebReadableStream)) chunks.push(chunk as Buffer);
            bytes = Buffer.concat(chunks);
          }
        } catch {
          bytes = null;
        }
      }
      if (bytes) {
        try {
          const pending = createPendingFile(ctx, userId, name, bytes.length || 1, null);
          await receiveUpload(ctx, pending.row.id, new URL(pending.uploadUrl).searchParams.get('secret')!, Readable.from([bytes]));
          fileIds.push(pending.row.id);
          report.attachments.stored += 1;
          continue;
        } catch (error) {
          report.attachments.failed += 1;
          problem(`${source.name}: attachment ${name} not stored (${error instanceof Error ? error.message : String(error)})`);
        }
      } else if (url && !/^https?:\/\//i.test(url)) {
        report.attachments.failed += 1;
        problem(`${source.name}: attachment ${url} is not in the export`);
      }
      if (/^https?:\/\//i.test(url)) {
        links.push({ fallback: name, title: name, title_link: url, text: 'This file stayed on Discord.' });
        report.attachments.linked += 1;
      }
    }
    return { fileIds, links };
  };

  const importInto = async (source: Source, conv: ConvRow, threadTs: string | null, skipId: string | null): Promise<void> => {
    const messages = [...(source.data.messages ?? [])].sort((a, b) => (Date.parse(a.timestamp ?? '') || snowflakeMillis(a.id)) - (Date.parse(b.timestamp ?? '') || snowflakeMillis(b.id)));
    for (const message of messages) {
      if (!message.id || message.id === skipId) continue;
      if (message.type && !IMPORTED_TYPES.has(message.type)) {
        report.messages.skipped += 1;
        continue;
      }
      if (placed(message.id)) {
        report.messages.alreadyPresent += 1;
        continue;
      }
      const userId = personFor(message.author);
      for (const mention of message.mentions ?? []) personFor(mention);
      if (!userId) {
        report.messages.failed += 1;
        continue;
      }
      const millis = Date.parse(message.timestamp ?? '') || snowflakeMillis(message.id);
      const ts = tsFor(conv.id, millis);
      let text = discordToMrkdwn(message.content ?? '', lookup);
      const answered = message.type === 'Reply' && message.reference?.messageId ? placed(message.reference.messageId) : undefined;
      if (answered) {
        const link = `${ctx.config.publicUrl}/archives/${answered.conversation_id}/p${answered.ts.replace('.', '')}`;
        text = `<${link}|↪ in reply> ${text}`;
      }
      const { fileIds, links } = await attach(source, message, userId);
      try {
        postMessage(ctx, {
          conv: getConv(ctx, conv.id)!,
          userId,
          text,
          attachments: links.length ? links : null,
          fileIds,
          threadTs,
          ts,
          silent: true,
          allowEmpty: true,
        });
      } catch (error) {
        report.messages.failed += 1;
        problem(`${source.name}: message ${message.id} not imported (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      ctx.db.run('INSERT INTO import_discord_messages (discord_id, conversation_id, ts) VALUES (?, ?, ?)', message.id, conv.id, ts);
      report.messages.imported += 1;
      if (message.timestampEdited) {
        const edited = Date.parse(message.timestampEdited);
        if (edited) {
          const editedTs = `${String(Math.floor(edited / 1000)).padStart(10, '0')}.${String((edited % 1000) * 1000).padStart(6, '0')}`;
          ctx.db.run('UPDATE messages SET edited_ts = ?, edited_user = ? WHERE conversation_id = ? AND ts = ?', editedTs, userId, conv.id, ts);
        }
      }
      if (message.isPinned) {
        report.pins += ctx.db.run('INSERT OR IGNORE INTO pins (conversation_id, ts, user_id, created) VALUES (?, ?, ?, ?)', conv.id, ts, userId, Math.floor(millis / 1000)).changes;
      }
      let order = 0;
      for (const reaction of message.reactions ?? []) {
        const emoji = reaction.emoji;
        const name = ((emoji?.id ? emoji.name : emoji?.code || emoji?.name) ?? '').replace(/^:|:$/g, '').replace(/[^\p{L}\p{N}_+'-]/gu, '_');
        if (!name) continue;
        for (const user of reaction.users ?? []) {
          const reactor = personFor(user);
          if (!reactor) continue;
          order += 1;
          report.reactions += ctx.db.run(
            'INSERT OR IGNORE INTO reactions (conversation_id, ts, name, user_id, created) VALUES (?, ?, ?, ?, ?)',
            conv.id,
            ts,
            name,
            reactor,
            millis + order,
          ).changes;
        }
      }
    }
  };

  for (const source of top) {
    await importInto(source, getConv(ctx, channelIds.get(source.data.channel!.id!)!)!, null, null);
    log(`#${source.data.channel!.name}: ${source.data.messages?.length ?? 0} messages`);
  }

  // Threads: under the message they started from (thread id = starter id), or under a new message
  // naming the thread in its parent channel (forum posts, threads whose starter is gone).
  for (const source of threads) {
    const channel = source.data.channel!;
    const parentId = channel.categoryId ?? '';
    const parentConv = channelIds.has(parentId) ? getConv(ctx, channelIds.get(parentId)!)! : channelFor(parentId || `thread-${channel.id}`, channel.category ?? 'discord-threads', null);
    const starter = placed(channel.id!);
    let threadTs: string;
    let skip: string | null = null;
    if (starter && starter.conversation_id === parentConv.id) {
      threadTs = starter.ts;
    } else {
      const first = source.data.messages?.find((message) => message.type === 'Default' || message.type === 'ThreadStarterMessage' || !message.type);
      const author = personFor(first?.author) ?? owner.id;
      const millis = Date.parse(first?.timestamp ?? '') || snowflakeMillis(channel.id!);
      const existing = placed(`thread:${channel.id}`);
      if (existing) {
        threadTs = existing.ts;
      } else {
        threadTs = tsFor(parentConv.id, millis - 1);
        postMessage(ctx, {
          conv: getConv(ctx, parentConv.id)!,
          userId: author,
          text: `*${channel.name ?? 'Thread'}*`,
          ts: threadTs,
          silent: true,
        });
        ctx.db.run('INSERT INTO import_discord_messages (discord_id, conversation_id, ts) VALUES (?, ?, ?)', `thread:${channel.id}`, parentConv.id, threadTs);
      }
      skip = null;
    }
    await importInto(source, parentConv, threadTs, skip);
    report.threads += 1;
  }

  // Imported history starts out read.
  for (const id of new Set(channelIds.values())) {
    ctx.db.run(
      `UPDATE conversations SET last_ts = coalesce((SELECT max(ts) FROM messages WHERE conversation_id = conversations.id AND (thread_ts IS NULL OR thread_ts = ts OR is_broadcast = 1)), last_ts) WHERE id = ?`,
      id,
    );
    ctx.db.run('UPDATE members SET last_read = max(last_read, (SELECT last_ts FROM conversations WHERE id = ?)) WHERE conversation_id = ?', id, id);
  }
  return report;
}
