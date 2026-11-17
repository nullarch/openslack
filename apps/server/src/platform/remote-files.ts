import { readFile } from 'node:fs/promises';
import type { Kernel } from '../app.ts';
import { uploadNamed } from '../api/methods/legacy-files.ts';
import { requirePostable } from '../api/methods/chat.ts';
import type { Args } from '../api/registry.ts';
import { resolveConv } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { extractorFor } from '../core/file-text.ts';
import { canAccessFile, deleteFile, fileToApi, getFile, parseImageSize, type FileRow } from '../core/files.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import { postMessage } from '../core/messages.ts';
import type { Actor, Ctx } from '../ctx.ts';

/**
 * Remote files (`files.remote.*`): documents that live somewhere else (Google
 * Drive, Dropbox, an internal tool) registered by an app so they show in
 * channels with a title and a preview image and can be found in search. The
 * bytes stay at `external_url`; this server keeps the record, the optional
 * preview image (as the file's thumbnail) and the optional searchable text.
 *
 * Apps add, update and remove their own files with a bot token; anyone the
 * file is shared with can read it, and a user of the app can share it.
 */

const MAX_EXTERNAL_ID = 255;
const MAX_TITLE = 255;
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const MAX_PREVIEW_SIDE = 8000;
const MAX_INDEX_BYTES = 1024 * 1024;

function requireBot(actor: Actor): void {
  if (!actor.isBot || !actor.appId) fail('bot_user_required');
}

function externalUrl(value: string): string {
  try {
    const url = new URL(value);
    // Shown as a link: nothing but web addresses.
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
  } catch {
    // fall through
  }
  return fail('invalid_url');
}

function externalId(value: string): string {
  if (!value || value.length > MAX_EXTERNAL_ID || !/^[\x20-\x7e]+$/.test(value)) fail('invalid_external_id');
  return value;
}

/** Find the file named by `file` or `external_id` (the caller's app's own ids). */
function locate(ctx: Ctx, actor: Actor, args: Args, both: 'refuse' | 'allow'): FileRow {
  const id = args.str('file');
  const external = args.str('external_id');
  if (id && external && both === 'refuse') fail('too_many_ids');
  if (!id && !external) fail('invalid_args');
  const row = id
    ? getFile(ctx, id)
    : actor.appId
      ? ctx.db.get<FileRow>("SELECT * FROM files WHERE mode = 'external' AND app_id = ? AND external_id = ?", actor.appId, external!)
      : undefined;
  if (!row || row.mode !== 'external') fail('file_not_found');
  if (id && external && row.external_id !== external) fail('file_not_found');
  return row;
}

/** Readable: the app's own files, and any shared where the caller can see them. */
function readable(ctx: Ctx, actor: Actor, row: FileRow): boolean {
  return (actor.appId !== null && row.app_id === actor.appId) || canAccessFile(ctx, row, actor.userId);
}

function ownedBy(actor: Actor, row: FileRow): void {
  if (row.app_id !== actor.appId) fail('file_not_found');
}

/** Store `preview_image` as the file's thumbnail, after checking it is a picture of sensible size. */
async function storePreview(ctx: Ctx, row: FileRow, args: Args): Promise<void> {
  const upload = uploadNamed(args.raw, 'preview_image');
  if (!upload) return;
  if (upload.size > MAX_PREVIEW_BYTES) fail('too_large');
  const data = await readFile(upload.path);
  const size = parseImageSize(data.subarray(0, 256 * 1024));
  if (!size) fail('bad_image');
  if (size.width > MAX_PREVIEW_SIDE || size.height > MAX_PREVIEW_SIDE) fail('too_large');
  await ctx.storage.putBuffer(`${row.storage_key}_t`, data);
  ctx.db.run('UPDATE files SET width = ?, height = ?, thumb = ? WHERE id = ?', size.width, size.height, JSON.stringify({ w: size.width, h: size.height }), row.id);
}

/** Store `indexable_file_contents` (a text file of search terms) for search. */
async function storeIndex(ctx: Ctx, row: FileRow, args: Args): Promise<void> {
  const upload = uploadNamed(args.raw, 'indexable_file_contents');
  const inline = args.str('indexable_file_contents');
  let text: string | null = null;
  if (upload) text = (await readFile(upload.path)).subarray(0, MAX_INDEX_BYTES).toString('utf8');
  else if (inline !== undefined) text = inline.slice(0, MAX_INDEX_BYTES);
  if (text === null) return;
  ctx.db.run('DELETE FROM file_text WHERE file_id = ?', row.id);
  ctx.db.run('INSERT INTO file_text (file_id, body) VALUES (?, ?)', row.id, `${row.title}\n${text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')}`);
}

function changed(ctx: Ctx, row: FileRow): void {
  ctx.bus.emit({ event: { type: 'file_change', file_id: row.id, file: { id: row.id }, event_ts: ctx.clock.eventTs() }, audience: { all: true } });
}

const PREVIEW_CHARS = 20_000;
const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
const OFFICE = new Set(['docx', 'xlsx', 'pptx']);

export function installRemoteFiles(kernel: Kernel): void {
  const { ctx, registry } = kernel;
  // Office documents shown as their text, extracted on request (the most recent few kept).
  const previews = new Map<string, { text: string; truncated: boolean }>();

  registry.add('client.files.textPreview', { auth: 'session' }, async ({ actor, args }) => {
    const row = getFile(ctx, args.req('file', 'file_not_found'));
    if (!row || row.state === 'pending' || !canAccessFile(ctx, row, actor.userId)) fail('file_not_found');
    if (!OFFICE.has(row.filetype) || row.size > PREVIEW_MAX_BYTES) fail('no_preview');
    let preview = previews.get(row.id);
    if (!preview) {
      const extractor = extractorFor(row.name, row.mimetype);
      if (!extractor) fail('no_preview');
      const chunks: Buffer[] = [];
      for await (const chunk of ctx.storage.read(row.storage_key)) chunks.push(chunk as Buffer);
      let text = '';
      try {
        text = extractor(Buffer.concat(chunks)).normalize('NFKC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      } catch {
        fail('no_preview');
      }
      preview = { text: text.slice(0, PREVIEW_CHARS), truncated: text.length > PREVIEW_CHARS };
      previews.set(row.id, preview);
      if (previews.size > 50) previews.delete(previews.keys().next().value!);
    }
    return { file: row.id, ...preview };
  });

  registry.add('files.remote.add', { scopes: ['remote_files:write'] }, async ({ actor, args }) => {
    requireBot(actor);
    const external = externalId(args.req('external_id'));
    const url = externalUrl(args.req('external_url'));
    const title = args.req('title').trim();
    if (!title || title.length > MAX_TITLE) fail('bad_title');
    const filetype = (args.str('filetype') ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20);
    // Adding an id the app already used updates that file.
    let row = ctx.db.get<FileRow>("SELECT * FROM files WHERE mode = 'external' AND app_id = ? AND external_id = ?", actor.appId, external);
    if (row) {
      ctx.db.run('UPDATE files SET title = ?, name = ?, external_url = ?, remote_type = ? WHERE id = ?', title, title, url, filetype || row.remote_type || null, row.id);
    } else {
      const id = newId('F');
      ctx.db.run(
        `INSERT INTO files (id, user_id, name, title, mimetype, filetype, size, storage_key, state, mode, external_id, external_url, app_id, remote_type, created)
         VALUES (?, ?, ?, ?, 'application/vnd.slack-remote', 'remote', 0, ?, 'uploaded', 'external', ?, ?, ?, ?, ?)`,
        id,
        actor.userId,
        title,
        title,
        `remote${id}`,
        external,
        url,
        actor.appId,
        filetype || null,
        nowSeconds(),
      );
    }
    row = ctx.db.get<FileRow>("SELECT * FROM files WHERE mode = 'external' AND app_id = ? AND external_id = ?", actor.appId, external)!;
    await storePreview(ctx, row, args);
    await storeIndex(ctx, getFile(ctx, row.id)!, args);
    return { file: fileToApi(ctx, getFile(ctx, row.id)!) };
  });

  registry.add('files.remote.info', { scopes: ['remote_files:read'] }, ({ actor, args }) => {
    const row = locate(ctx, actor, args, 'refuse');
    if (!readable(ctx, actor, row)) fail('file_not_found');
    return { file: fileToApi(ctx, row) };
  });

  registry.add('files.remote.list', { scopes: ['remote_files:read'] }, ({ actor, args }) => {
    const limit = args.int('limit', 100, { min: 1, max: 1000 });
    const from = Number(args.str('ts_from') ?? 0) || 0;
    const to = args.str('ts_to') ? Number(args.str('ts_to')) : Number.MAX_SAFE_INTEGER;
    const channel = args.str('channel');
    const conv = channel ? resolveConv(ctx, actor, channel) : null;
    // The cursor is the position after the last file returned: "created:id", newest first.
    let after: [number, string] | null = null;
    const cursor = args.str('cursor');
    if (cursor) {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const match = /^(\d+):(F[A-Z0-9]+)$/.exec(decoded);
      if (!match) fail('invalid_cursor');
      after = [Number(match[1]), match[2]!];
    }
    const rows = ctx.db.all<FileRow>(
      `SELECT * FROM files f WHERE f.mode = 'external' AND f.created >= ? AND f.created <= ?
         ${conv ? 'AND EXISTS (SELECT 1 FROM file_shares s WHERE s.file_id = f.id AND s.conversation_id = ?)' : ''}
         ${after ? 'AND (f.created < ? OR (f.created = ? AND f.id < ?))' : ''}
       ORDER BY f.created DESC, f.id DESC`,
      from,
      to,
      ...(conv ? [conv.id] : []),
      ...(after ? [after[0], after[0], after[1]] : []),
    );
    const files: FileRow[] = [];
    let more = false;
    for (const row of rows) {
      if (!readable(ctx, actor, row)) continue;
      if (files.length === limit) {
        more = true;
        break;
      }
      files.push(row);
    }
    const last = files.at(-1);
    return {
      files: files.map((row) => fileToApi(ctx, row)),
      response_metadata: { next_cursor: more && last ? Buffer.from(`${last.created}:${last.id}`).toString('base64url') : '' },
    };
  });

  registry.add('files.remote.update', { scopes: ['remote_files:write'] }, async ({ actor, args }) => {
    requireBot(actor);
    const row = locate(ctx, actor, args, 'allow');
    ownedBy(actor, row);
    const title = args.str('title');
    if (title !== undefined && (!title.trim() || title.length > MAX_TITLE)) fail('invalid_title');
    const url = args.str('external_url');
    const filetype = args.str('filetype');
    ctx.db.run(
      'UPDATE files SET title = ?, name = ?, external_url = ?, remote_type = ? WHERE id = ?',
      title?.trim() ?? row.title,
      title?.trim() ?? row.name,
      url !== undefined ? externalUrl(url) : (row.external_url ?? null),
      filetype !== undefined ? filetype.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || null : (row.remote_type ?? null),
      row.id,
    );
    await storePreview(ctx, getFile(ctx, row.id)!, args);
    await storeIndex(ctx, getFile(ctx, row.id)!, args);
    const fresh = getFile(ctx, row.id)!;
    changed(ctx, fresh);
    return { file: fileToApi(ctx, fresh) };
  });

  registry.add('files.remote.remove', { scopes: ['remote_files:write'] }, async ({ actor, args }) => {
    requireBot(actor);
    const row = locate(ctx, actor, args, 'refuse');
    ownedBy(actor, row);
    await deleteFile(ctx, row);
  });

  registry.add('files.remote.share', { scopes: ['remote_files:share'] }, ({ actor, args }) => {
    const row = locate(ctx, actor, args, 'allow');
    if (!readable(ctx, actor, row)) fail('file_not_found');
    const channels = args.list('channels');
    if (channels.length === 0) fail('invalid_args');
    // Check every destination before posting to any.
    const targets = channels.map((channel) => {
      const conv = resolveConv(ctx, actor, channel);
      requirePostable(ctx, conv, actor);
      return conv;
    });
    for (const conv of targets) {
      postMessage(ctx, { conv, userId: actor.userId, botId: actor.botId, appId: actor.appId, text: '', fileIds: [row.id] });
    }
    return { file: fileToApi(ctx, getFile(ctx, row.id)!) };
  });
}
