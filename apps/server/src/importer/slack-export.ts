import { freeChannelName } from './names.ts';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { channelNameError, normalizeChannelName, type Attachment, type Block } from '@app/shared';
import type { Ctx } from '../ctx.ts';
import { canonicalTs } from '../core/clock.ts';
import { getConv, type ConvRow } from '../core/conversations.ts';
import { getFile, typeForName } from '../core/files.ts';
import { nowSeconds } from '../core/ids.ts';
import { getMessage, postMessage } from '../core/messages.ts';
import { createUser, getUser, uniqueHandle, type UserRow } from '../core/users.ts';
import { openArchive, type Archive } from './archive.ts';

/**
 * Import a Slack workspace export (the zip Slack produces, or the same files
 * unpacked). Original user, channel and message identifiers are kept, so
 * mentions, channel links and thread structure survive unchanged. Running the
 * import again is safe: anything already present is skipped.
 */

export interface ImportOptions {
  /** Download each file from the URL recorded in the export and store it here. */
  downloadFiles?: boolean;
  /** Bearer token for file downloads, when the export's URLs need one. */
  token?: string;
  log?: (line: string) => void;
}

export interface ImportReport {
  users: { created: number; matched: number };
  channels: { created: number; merged: number };
  directs: { created: number; matched: number };
  messages: { imported: number; alreadyPresent: number; failed: number };
  reactions: number;
  pins: number;
  files: { stored: number; linked: number; failed: number };
  /** Items that could not be carried over exactly, one line each (first 500). */
  problems: string[];
  problemCount: number;
}

interface ExportUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_admin?: boolean;
  is_owner?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  tz?: string;
  profile?: { email?: string; display_name?: string; real_name?: string; title?: string; bot_id?: string };
}

interface ExportChannel {
  id: string;
  name?: string;
  created?: number;
  creator?: string;
  is_archived?: boolean;
  is_general?: boolean;
  members?: string[];
  topic?: { value?: string; creator?: string; last_set?: number };
  purpose?: { value?: string; creator?: string; last_set?: number };
  pins?: { id: string; user?: string; created?: number }[];
}

interface ExportFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  mode?: string;
  url_private?: string;
  url_private_download?: string;
  permalink?: string;
  original_w?: number;
  original_h?: number;
}

interface ExportMessage {
  type?: string;
  subtype?: string;
  ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  icons?: { emoji?: string; image_64?: string; image_48?: string };
  text?: string;
  blocks?: Block[];
  attachments?: Attachment[];
  files?: ExportFile[];
  thread_ts?: string;
  client_msg_id?: string;
  edited?: { user?: string; ts?: string };
  reactions?: { name: string; users?: string[] }[];
}

interface Target {
  /** Folder name inside the export. */
  folder: string;
  conv: ConvRow;
}

const MAX_PROBLEMS = 500;

export async function importSlackExport(ctx: Ctx, path: string, options: ImportOptions = {}): Promise<ImportReport> {
  const team = ctx.team();
  if (!team) throw new Error('Create the workspace first (open the web address and finish setup), then import.');
  const owner = ctx.db.get<UserRow>("SELECT * FROM users WHERE role = 'primary_owner' LIMIT 1");
  if (!owner) throw new Error('The workspace has no owner.');

  const log = options.log ?? (() => {});
  const report: ImportReport = {
    users: { created: 0, matched: 0 },
    channels: { created: 0, merged: 0 },
    directs: { created: 0, matched: 0 },
    messages: { imported: 0, alreadyPresent: 0, failed: 0 },
    reactions: 0,
    pins: 0,
    files: { stored: 0, linked: 0, failed: 0 },
    problems: [],
    problemCount: 0,
  };
  const problem = (line: string): void => {
    report.problemCount += 1;
    if (report.problems.length < MAX_PROBLEMS) report.problems.push(line);
  };

  const archive = openArchive(path);
  try {
    const names = new Set(archive.names());
    const readJson = <T>(name: string): T | null => {
      if (!names.has(name)) return null;
      try {
        return JSON.parse(archive.read(name).toString('utf8')) as T;
      } catch {
        problem(`${name}: not valid JSON`);
        return null;
      }
    };
    const users = readJson<ExportUser[]>('users.json');
    if (!users) throw new Error('users.json not found: this does not look like a Slack export.');

    // ── People ──────────────────────────────────────────────────────────────
    /** Export user id → local user id, when they differ. */
    const userMap = new Map<string, string>();
    const mapUser = (id: string): string => {
      const mapped = userMap.get(id);
      if (mapped) return mapped;
      if (!getUser(ctx, id)) {
        // Authors missing from users.json (removed apps, the built-in bot) still need a row.
        createUser(ctx, { id, realName: id === 'USLACKBOT' ? 'Slackbot' : `Former member ${id}`, isBot: id === 'USLACKBOT', deleted: id !== 'USLACKBOT', handle: uniqueHandle(ctx, id.toLowerCase()) });
        report.users.created += 1;
        problem(`user ${id}: not in users.json, created as a placeholder`);
      }
      userMap.set(id, id);
      return id;
    };
    ctx.db.tx(() => {
      for (const user of users) {
        if (!user.id) continue;
        const email = user.profile?.email?.trim().toLowerCase() || null;
        const existing =
          getUser(ctx, user.id) ?? (email ? ctx.db.get<UserRow>('SELECT * FROM users WHERE email = ?', email) : undefined);
        if (existing) {
          userMap.set(user.id, existing.id);
          report.users.matched += 1;
          continue;
        }
        const realName = user.real_name || user.profile?.real_name || user.name || user.id;
        createUser(ctx, {
          id: user.id,
          email,
          realName,
          displayName: user.profile?.display_name ?? '',
          handle: uniqueHandle(ctx, user.name || realName),
          role: user.is_owner ? 'owner' : user.is_admin ? 'admin' : 'member',
          tz: validTz(user.tz),
          isBot: user.is_bot === true,
          botId: user.profile?.bot_id ?? null,
          title: user.profile?.title ?? '',
          deleted: user.deleted === true,
          guest: user.is_ultra_restricted ? 'single' : user.is_restricted ? 'multi' : '',
        });
        userMap.set(user.id, user.id);
        report.users.created += 1;
      }
    });
    log(`people: ${report.users.created} created, ${report.users.matched} matched to existing accounts`);

    // ── Conversations ───────────────────────────────────────────────────────
    const channelMap = new Map<string, string>();
    const targets: Target[] = [];
    const pinSources: { conv: ConvRow; pins: NonNullable<ExportChannel['pins']> }[] = [];

    const addMembers = (conv: ConvRow, members: string[] | undefined): void => {
      for (const member of members ?? []) {
        ctx.db.run(
          'INSERT OR IGNORE INTO members (conversation_id, user_id, joined) VALUES (?, ?, ?)',
          conv.id,
          mapUser(member),
          conv.created,
        );
      }
    };

    const importChannels = (list: ExportChannel[] | null, isPrivate: boolean): void => {
      for (const channel of list ?? []) {
        if (!channel.id || !channel.name) continue;
        let name = normalizeChannelName(channel.name);
        if (channelNameError(name)) {
          name = name.replace(/[^\p{Ll}\p{Lo}\p{N}_-]+/gu, '-').slice(0, 80) || channel.id.toLowerCase();
          problem(`channel ${channel.name}: renamed to ${name}`);
        }
        // Matched by id on a second run. By name only public to public: merging a private channel into
        // another of the same name would show its history to that channel's members, and into a public
        // one to everyone.
        let conv = getConv(ctx, channel.id);
        if (!conv) {
          const sameName = ctx.db.get<ConvRow>("SELECT * FROM conversations WHERE name = ? AND kind IN ('public', 'private')", name);
          if (sameName && !isPrivate && sameName.kind === 'public') conv = sameName;
          else if (sameName) {
            const renamed = freeChannelName(ctx, name);
            problem(`${isPrivate ? 'private' : 'public'} channel ${channel.name}: a ${sameName.kind} channel with that name already exists here; imported separately as ${renamed}`);
            name = renamed;
          }
        }
        if (conv) {
          if (conv.id !== channel.id) report.channels.merged += 1;
        } else {
          const now = nowSeconds();
          ctx.db.run(
            `INSERT INTO conversations (id, kind, name, topic, topic_creator, topic_set, purpose, purpose_creator, purpose_set,
               creator, is_archived, created, updated)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            channel.id,
            isPrivate ? 'private' : 'public',
            name,
            channel.topic?.value ?? '',
            channel.topic?.creator ? mapUser(channel.topic.creator) : '',
            channel.topic?.last_set ?? 0,
            channel.purpose?.value ?? '',
            channel.purpose?.creator ? mapUser(channel.purpose.creator) : '',
            channel.purpose?.last_set ?? 0,
            channel.creator ? mapUser(channel.creator) : owner.id,
            channel.is_archived ? 1 : 0,
            channel.created ?? now,
            now,
          );
          conv = getConv(ctx, channel.id)!;
          report.channels.created += 1;
        }
        channelMap.set(channel.id, conv.id);
        addMembers(conv, channel.members);
        targets.push({ folder: channel.name, conv });
        if (channel.pins?.length) pinSources.push({ conv, pins: channel.pins });
      }
    };

    const importDirects = (list: ExportChannel[] | null, group: boolean): void => {
      for (const direct of list ?? []) {
        if (!direct.id || !direct.members?.length) continue;
        const members = [...new Set(direct.members.map(mapUser))].sort();
        const key = members.join(',');
        let conv = getConv(ctx, direct.id) ?? ctx.db.get<ConvRow>('SELECT * FROM conversations WHERE im_key = ?', key);
        if (conv) {
          report.directs.matched += 1;
        } else {
          const now = nowSeconds();
          ctx.db.run(
            'INSERT INTO conversations (id, kind, creator, im_key, created, updated) VALUES (?, ?, ?, ?, ?, ?)',
            direct.id,
            members.length > 2 ? 'mpim' : 'im',
            members[0]!,
            key,
            direct.created ?? now,
            now,
          );
          conv = getConv(ctx, direct.id)!;
          report.directs.created += 1;
        }
        channelMap.set(direct.id, conv.id);
        addMembers(conv, direct.members);
        targets.push({ folder: group && direct.name ? direct.name : direct.id, conv });
      }
    };

    ctx.db.tx(() => {
      importChannels(readJson<ExportChannel[]>('channels.json'), false);
      importChannels(readJson<ExportChannel[]>('groups.json'), true);
      importDirects(readJson<ExportChannel[]>('dms.json'), false);
      importDirects(readJson<ExportChannel[]>('mpims.json'), true);
    });
    log(`conversations: ${report.channels.created} channels created, ${report.channels.merged} merged, ${report.directs.created} direct`);

    // Mentions and channel links only need rewriting where an id changed.
    const renamed = new Map<string, string>();
    for (const [from, to] of [...userMap, ...channelMap]) {
      if (from !== to) renamed.set(from, to);
    }
    const renamePattern = renamed.size
      ? new RegExp(`(<[@#]|"(?:user_id|channel_id)":")(${[...renamed.keys()].join('|')})\\b`, 'g')
      : null;
    const rewrite = (text: string): string =>
      renamePattern ? text.replace(renamePattern, (_all, lead: string, id: string) => lead + renamed.get(id)!) : text;
    const rewriteJson = <T>(value: T | undefined): T | undefined =>
      value === undefined || !renamePattern ? value : (JSON.parse(rewrite(JSON.stringify(value))) as T);

    // ── Messages ────────────────────────────────────────────────────────────
    const byFolder = new Map<string, string[]>();
    for (const name of names) {
      const match = /^(.+)\/(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
      if (!match) continue;
      const list = byFolder.get(match[1]!);
      if (list) list.push(name);
      else byFolder.set(match[1]!, [name]);
    }

    for (const target of targets) {
      const files = (byFolder.get(target.folder) ?? []).sort();
      for (const name of files) {
        const day = readJson<ExportMessage[]>(name);
        if (!Array.isArray(day)) continue;
        day.sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));

        // Downloads are asynchronous, so they happen before the insert transaction.
        const prepared = new Map<ExportMessage, { fileIds: string[]; attachments: Attachment[] }>();
        for (const message of day) {
          if (!message.files?.length) continue;
          prepared.set(message, await importFiles(ctx, archive, message, mapUser, options, report, problem));
        }

        ctx.db.tx(() => {
          for (const message of day) {
            if ((message.type && message.type !== 'message') || !message.ts) continue;
            const ts = canonicalTs(message.ts);
            if (!ts) {
              report.messages.failed += 1;
              problem(`${name}: message with malformed ts ${message.ts}`);
              continue;
            }
            if (getMessage(ctx, target.conv.id, ts)) {
              report.messages.alreadyPresent += 1;
              continue;
            }
            let threadTs: string | null = null;
            if (message.thread_ts && message.thread_ts !== message.ts) {
              threadTs = canonicalTs(message.thread_ts);
              if (!threadTs || !getMessage(ctx, target.conv.id, threadTs)) {
                problem(`${name}: reply ${ts} lost its thread (parent ${message.thread_ts} is not in the export)`);
                threadTs = null;
              }
            }
            const extra = prepared.get(message);
            const attachments = [...(rewriteJson(message.attachments) ?? []), ...(extra?.attachments ?? [])];
            try {
              postMessage(ctx, {
                conv: getConv(ctx, target.conv.id)!,
                userId: message.user ? mapUser(message.user) : null,
                botId: message.bot_id ?? null,
                text: rewrite(message.text ?? ''),
                blocks: rewriteJson(message.blocks) ?? null,
                attachments: attachments.length ? attachments : null,
                fileIds: extra?.fileIds,
                threadTs,
                broadcast: message.subtype === 'thread_broadcast',
                subtype: message.subtype && message.subtype !== 'thread_broadcast' ? message.subtype : null,
                username: message.username ?? null,
                iconEmoji: message.icons?.emoji ?? null,
                iconUrl: message.icons?.image_64 ?? message.icons?.image_48 ?? null,
                clientMsgId: message.client_msg_id ?? null,
                ts,
                silent: true,
                allowEmpty: true,
              });
            } catch (error) {
              report.messages.failed += 1;
              problem(`${name}: message ${ts} not imported (${error instanceof Error ? error.message : String(error)})`);
              continue;
            }
            report.messages.imported += 1;
            const editedTs = message.edited?.ts ? canonicalTs(message.edited.ts) : null;
            if (editedTs && message.edited?.user) {
              ctx.db.run(
                'UPDATE messages SET edited_ts = ?, edited_user = ? WHERE conversation_id = ? AND ts = ?',
                editedTs,
                mapUser(message.edited.user),
                target.conv.id,
                ts,
              );
            }
            let order = 0;
            for (const reaction of message.reactions ?? []) {
              for (const user of reaction.users ?? []) {
                order += 1;
                const added = ctx.db.run(
                  'INSERT OR IGNORE INTO reactions (conversation_id, ts, name, user_id, created) VALUES (?, ?, ?, ?, ?)',
                  target.conv.id,
                  ts,
                  reaction.name,
                  mapUser(user),
                  Math.floor(Number(ts) * 1000) + order,
                );
                report.reactions += added.changes;
              }
            }
          }
        });
      }
      if (files.length) log(`#${target.folder}: ${files.length} day files`);
    }

    // ── Pins and read state ─────────────────────────────────────────────────
    ctx.db.tx(() => {
      for (const { conv, pins } of pinSources) {
        for (const pin of pins) {
          const ts = canonicalTs(pin.id);
          if (!ts || !getMessage(ctx, conv.id, ts)) {
            problem(`#${conv.name}: pinned item ${pin.id} is not a message in the export`);
            continue;
          }
          const added = ctx.db.run(
            'INSERT OR IGNORE INTO pins (conversation_id, ts, user_id, created) VALUES (?, ?, ?, ?)',
            conv.id,
            ts,
            pin.user ? mapUser(pin.user) : owner.id,
            pin.created ?? nowSeconds(),
          );
          report.pins += added.changes;
        }
      }
      // Imported history starts out read for everyone.
      for (const target of targets) {
        ctx.db.run(
          `UPDATE conversations SET last_ts = coalesce((
             SELECT max(ts) FROM messages
             WHERE conversation_id = conversations.id AND (thread_ts IS NULL OR thread_ts = ts OR is_broadcast = 1)
           ), last_ts) WHERE id = ?`,
          target.conv.id,
        );
        ctx.db.run(
          `UPDATE members SET last_read = max(last_read, (SELECT last_ts FROM conversations WHERE id = ?))
           WHERE conversation_id = ?`,
          target.conv.id,
          target.conv.id,
        );
      }
    });
  } finally {
    archive.close();
  }
  return report;
}

function validTz(value: string | undefined): string {
  if (!value) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return 'UTC';
  }
}

/**
 * Carry a message's files over. A file whose bytes are in the archive (under
 * `__uploads/<file id>/`, as this server's own export writes them) is stored
 * from there. With `downloadFiles`, others are fetched from the URL in the
 * export. Otherwise (or when a download fails) the message keeps a link to
 * where the file lived.
 */
async function importFiles(
  ctx: Ctx,
  archive: Archive,
  message: ExportMessage,
  mapUser: (id: string) => string,
  options: ImportOptions,
  report: ImportReport,
  problem: (line: string) => void,
): Promise<{ fileIds: string[]; attachments: Attachment[] }> {
  const fileIds: string[] = [];
  const attachments: Attachment[] = [];
  for (const file of message.files ?? []) {
    const name = file.name ?? file.title ?? 'file';
    if (!file.id || file.mode === 'tombstone' || file.mode === 'hidden_by_limit') continue;
    if (getFile(ctx, file.id)) {
      fileIds.push(file.id);
      continue;
    }
    const url = file.url_private_download ?? file.url_private;
    let stored = false;
    const packed = uploadsIn(archive).get(file.id);
    if (packed) {
      try {
        const data = archive.read(packed);
        await ctx.storage.putBuffer(file.id, data);
        const info = typeForName(name);
        ctx.db.run(
          `INSERT INTO files (id, user_id, name, title, mimetype, filetype, size, storage_key, state, width, height, created)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'shared', ?, ?, ?)`,
          file.id,
          message.user ? mapUser(message.user) : '',
          name,
          file.title ?? name,
          file.mimetype ?? info.mimetype,
          file.filetype ?? info.filetype,
          data.length,
          file.id,
          file.original_w ?? null,
          file.original_h ?? null,
          Math.floor(Number(message.ts ?? 0)),
        );
        fileIds.push(file.id);
        report.files.stored += 1;
        continue;
      } catch (error) {
        problem(`file ${file.id} (${name}): could not be read from the archive (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    if (options.downloadFiles && url) {
      try {
        const response = await fetch(url, {
          headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
          redirect: 'follow',
        });
        const type = response.headers.get('content-type') ?? '';
        // A sign-in page instead of the file means the URL's access has expired.
        if (!response.ok || !response.body || (type.startsWith('text/html') && !name.endsWith('.html'))) {
          throw new Error(`HTTP ${response.status}${type.startsWith('text/html') ? ' (sign-in page)' : ''}`);
        }
        const size = await ctx.storage.put(file.id, Readable.fromWeb(response.body as WebReadableStream), ctx.config.maxUploadBytes);
        const info = typeForName(name);
        ctx.db.run(
          `INSERT INTO files (id, user_id, name, title, mimetype, filetype, size, storage_key, state, width, height, created)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'shared', ?, ?, ?)`,
          file.id,
          message.user ? mapUser(message.user) : '',
          name,
          file.title ?? name,
          file.mimetype ?? info.mimetype,
          file.filetype ?? info.filetype,
          size,
          file.id,
          file.original_w ?? null,
          file.original_h ?? null,
          Math.floor(Number(message.ts ?? 0)),
        );
        fileIds.push(file.id);
        report.files.stored += 1;
        stored = true;
      } catch (error) {
        report.files.failed += 1;
        problem(`file ${file.id} (${name}): download failed (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    if (!stored) {
      attachments.push({
        fallback: name,
        title: file.title ?? name,
        title_link: file.permalink ?? file.url_private ?? '',
        text: 'This file stayed in the original workspace.',
      });
      report.files.linked += 1;
    }
  }
  return { fileIds, attachments };
}

const uploadIndexes = new WeakMap<Archive, Map<string, string>>();

/** File id → archive entry, for files packed under `__uploads/<file id>/`. */
function uploadsIn(archive: Archive): Map<string, string> {
  let index = uploadIndexes.get(archive);
  if (!index) {
    index = new Map();
    for (const name of archive.names()) {
      const match = /^__uploads\/([A-Z0-9]+)\/[^/]+$/.exec(name);
      if (match) index.set(match[1]!, name);
    }
    uploadIndexes.set(archive, index);
  }
  return index;
}
