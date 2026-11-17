import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';
import busboy from 'busboy';
import type { Ctx } from '../../ctx.ts';
import { authenticate } from '../../core/auth.ts';
import { getConv, resolveConv } from '../../core/conversations.ts';
import { ApiError, fail } from '../../core/errors.ts';
import {
  canAccessFile,
  createPendingFile,
  deleteFile,
  fileToApi,
  getFile,
  isInlineSafe,
  receiveUpload,
  type FileRow,
} from '../../core/files.ts';
import { messageToApi, postMessage } from '../../core/messages.ts';
import { getUser, isAdmin } from '../../core/users.ts';
import { sendJson, type Router } from '../http.ts';
import { pageByOffset, type Registry } from '../registry.ts';
import { readContent, requirePostable } from './chat.ts';
import { getEmojiImage } from './emoji.ts';

export function registerFiles(registry: Registry): void {
  registry.add('files.getUploadURLExternal', { scopes: ['files:write'] }, ({ ctx, actor, args }) => {
    const filename = args.req('filename');
    const length = args.int('length', -1);
    if (length <= 0) fail('invalid_arguments', { needed: 'length' });
    const pending = createPendingFile(ctx, actor.userId, filename, length, args.str('alt_txt') ?? null);
    // A snippet is a text file shown inline with syntax highlighting; `snippet_type` names the language.
    const snippetType = args.str('snippet_type');
    if (snippetType) {
      if (!/^[a-z0-9_+#-]{1,30}$/i.test(snippetType)) fail('invalid_arguments', { needed: 'snippet_type' });
      ctx.db.run("UPDATE files SET mode = 'snippet', filetype = ?, mimetype = 'text/plain' WHERE id = ?", snippetType.toLowerCase(), pending.row.id);
    }
    return { upload_url: pending.uploadUrl, file_id: pending.row.id };
  });

  registry.add('files.completeUploadExternal', { scopes: ['files:write'] }, ({ ctx, actor, args }) => {
    const entries = args.json<{ id: string; title?: string }[]>('files');
    if (!Array.isArray(entries) || entries.length === 0) fail('invalid_arguments', { needed: 'files' });
    const rows: FileRow[] = [];
    for (const entry of entries) {
      const row = getFile(ctx, String(entry.id));
      if (!row || row.user_id !== actor.userId) fail('file_not_found');
      if (row.state === 'pending') fail('file_not_uploaded', { file: row.id });
      if (entry.title) ctx.db.run('UPDATE files SET title = ? WHERE id = ?', String(entry.title).slice(0, 255), row.id);
      rows.push(row);
    }
    const channelIds = args.has('channel_id') ? [args.req('channel_id')] : args.list('channels');
    const content = readContent(args);
    const comment = args.str('initial_comment') ?? content.text;
    for (const channelId of channelIds) {
      const conv = resolveConv(ctx, actor, channelId);
      requirePostable(ctx, conv, actor);
      postMessage(ctx, {
        conv,
        userId: actor.userId,
        botId: actor.botId,
        appId: actor.isBot ? actor.appId : null,
        text: comment ?? '',
        blocks: content.blocks,
        fileIds: rows.map((row) => row.id),
        threadTs: args.ts('thread_ts'),
        clientMsgId: args.str('client_msg_id') ?? null,
        eventExtra: { subtype: 'file_share' },
      });
    }
    return { files: rows.map((row) => fileToApi(ctx, getFile(ctx, row.id)!)) };
  });

  registry.add('files.info', { scopes: ['files:read'] }, ({ ctx, actor, args }) => {
    const row = getFile(ctx, args.req('file', 'file_not_found'));
    if (!row || !canAccessFile(ctx, row, actor.userId)) fail('file_not_found');
    return { file: fileToApi(ctx, row) };
  });

  registry.add('files.list', { scopes: ['files:read'] }, ({ ctx, actor, args }) => {
    const channel = args.has('channel') ? resolveConv(ctx, actor, args.req('channel')) : null;
    const user = args.str('user');
    const types = args.has('types') ? args.list('types') : ['all'];
    const rows = ctx.db
      .all<FileRow>("SELECT * FROM files WHERE state = 'shared' ORDER BY created DESC, id")
      .filter((row) => !user || row.user_id === user)
      .filter((row) => {
        if (types.includes('all')) return true;
        if (types.includes('images') && row.mimetype.startsWith('image/')) return true;
        if (types.includes('videos') && row.mimetype.startsWith('video/')) return true;
        if (types.includes('pdfs') && row.mimetype === 'application/pdf') return true;
        return false;
      })
      .filter((row) => {
        if (channel) {
          return ctx.db.get('SELECT 1 FROM file_shares WHERE file_id = ? AND conversation_id = ?', row.id, channel.id) !== undefined;
        }
        return canAccessFile(ctx, row, actor.userId);
      });
    const { page, response_metadata } = pageByOffset(rows, args.str('cursor'), args.int('count', 100, { min: 1, max: 1000 }));
    return {
      files: page.map((row) => fileToApi(ctx, row)),
      paging: { count: page.length, total: rows.length, page: 1, pages: 1 },
      response_metadata,
    };
  });

  registry.add('files.delete', { scopes: ['files:write'] }, async ({ ctx, actor, args }) => {
    const row = getFile(ctx, args.req('file', 'file_not_found'));
    if (!row || !canAccessFile(ctx, row, actor.userId)) fail('file_not_found');
    if (row.user_id !== actor.userId && !isAdmin(actor)) fail('cant_delete_file');
    // Messages that carried only this file disappear with it; others just lose the attachment.
    const shares = ctx.db.all<{ conversation_id: string; ts: string }>(
      'SELECT conversation_id, ts FROM file_shares WHERE file_id = ?',
      row.id,
    );
    await deleteFile(ctx, row);
    for (const share of shares) {
      const conv = getConv(ctx, share.conversation_id);
      const message = conv
        ? ctx.db.get<{ id: number; files: string | null }>(
            'SELECT id, files FROM messages WHERE conversation_id = ? AND ts = ?',
            share.conversation_id,
            share.ts,
          )
        : undefined;
      if (!conv || !message?.files) continue;
      const remaining = (JSON.parse(message.files) as string[]).filter((id) => id !== row.id);
      ctx.db.run('UPDATE messages SET files = ? WHERE id = ?', remaining.length ? JSON.stringify(remaining) : null, message.id);
      const fresh = ctx.db.get<Parameters<typeof messageToApi>[1]>('SELECT * FROM messages WHERE id = ?', message.id);
      if (!fresh) continue;
      ctx.bus.emit({
        event: {
          type: 'message',
          subtype: 'message_changed',
          hidden: true,
          channel: conv.id,
          ts: ctx.clock.eventTs(),
          event_ts: ctx.clock.eventTs(),
          message: messageToApi(ctx, fresh),
        },
        audience: { conversation: conv.id },
        clientOnly: true,
      });
    }
  });
}

// ── Byte routes ─────────────────────────────────────────────────────────────

/** The uploaded bytes: the raw request body, or the first file part of a multipart form. */
function uploadStream(req: IncomingMessage): Promise<Readable> {
  const contentType = String(req.headers['content-type'] ?? '');
  if (!contentType.startsWith('multipart/form-data')) return Promise.resolve(req);
  return new Promise((resolve, reject) => {
    const parser = busboy({ headers: req.headers, limits: { files: 1 } });
    let found = false;
    parser.on('file', (_name, stream) => {
      found = true;
      resolve(stream);
    });
    parser.on('error', reject);
    parser.on('close', () => {
      if (!found) reject(new ApiError('no_file_data'));
    });
    req.pipe(parser);
  });
}

const SVG_ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function initialsSvg(label: string, color: string, size: number): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? [...words[0]!][0]! + [...words.at(-1)!][0]! : [...(words[0] ?? '?')].slice(0, 2).join(''))
    .toUpperCase()
    .replace(/[&<>"]/g, (char) => SVG_ESCAPE[char]!);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><rect width="64" height="64" fill="#${color}"/><text x="32" y="33" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="26" font-weight="600" fill="#fff" text-anchor="middle" dominant-baseline="central">${initials}</text></svg>`;
}

function sniffImageType(head: Buffer): string {
  if (head.length >= 4 && head.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (head.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (head.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

async function sendStored(ctx: Ctx, res: ServerResponse, key: string, mimetype: string | null): Promise<boolean> {
  const size = await ctx.storage.size(key);
  if (size === null) return false;
  let type = mimetype;
  if (!type) {
    const chunks: Buffer[] = [];
    for await (const chunk of ctx.storage.read(key, { start: 0, end: 15 })) chunks.push(chunk as Buffer);
    type = sniffImageType(Buffer.concat(chunks));
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': size,
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });
  ctx.storage.read(key).pipe(res);
  return true;
}

function sendSvg(res: ServerResponse, svg: string): void {
  res.writeHead(200, {
    'content-type': 'image/svg+xml',
    'content-length': Buffer.byteLength(svg),
    'cache-control': 'public, max-age=86400',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(svg);
}

export function registerFileRoutes(ctx: Ctx, router: Router): void {
  router.add('POST', /^\/upload\/v1\/([A-Z0-9]+)$/, async ({ req, res, url, params }) => {
    const size = await receiveUpload(ctx, params[0]!, url.searchParams.get('secret') ?? '', await uploadStream(req));
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`OK - ${size}`);
  });

  router.add('GET', /^\/files-pri\/[A-Z0-9]+-([A-Z0-9]+)\/(download\/)?[^/]*$/, async ({ req, res, params }) => {
    // Credentials come from the Authorization header or the session cookie, never from the URL.
    const { actor } = authenticate(ctx, req, undefined);
    const row = getFile(ctx, params[0]!);
    // Unknown and forbidden look the same to the caller.
    if (!actor || !row || row.state === 'pending' || !canAccessFile(ctx, row, actor.userId)) {
      sendJson(res, 404, { ok: false, error: 'file_not_found' });
      return;
    }
    const size = await ctx.storage.size(row.storage_key);
    if (size === null) {
      sendJson(res, 404, { ok: false, error: 'file_not_found' });
      return;
    }
    const inline = !params[1] && isInlineSafe(row.mimetype);
    const headers: Record<string, string | number> = {
      'content-type': inline ? row.mimetype : 'application/octet-stream',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      'cache-control': 'private, max-age=86400',
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      // Uploaded content never runs script in this origin. PDFs are the exception to `sandbox`:
      // browsers refuse to open their viewer for a sandboxed document, and the viewer isolates the file itself.
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; media-src 'self'; img-src 'self'${
        row.mimetype === 'application/pdf' ? "; object-src 'self'" : '; sandbox'
      }`,
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      ctx.storage.read(row.storage_key, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': size });
    ctx.storage.read(row.storage_key).pipe(res);
  });

  router.add('GET', /^\/avatars\/([A-Z0-9]+)\/(\d+)$/, async ({ res, params }) => {
    const user = getUser(ctx, params[0]!);
    if (!user) {
      sendJson(res, 404, { ok: false, error: 'user_not_found' });
      return;
    }
    if (user.avatar_key && (await sendStored(ctx, res, user.avatar_key, null))) return;
    const size = Math.max(16, Math.min(512, Number(params[1])));
    sendSvg(res, initialsSvg(user.display_name || user.real_name || user.name, user.color || '5b6ee1', size));
  });

  router.add('GET', /^\/team-icon\/(\d+)$/, async ({ res, params }) => {
    const team = ctx.team();
    if (!team) {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    if (team.icon_key && (await sendStored(ctx, res, team.icon_key, null))) return;
    sendSvg(res, initialsSvg(team.name, '3b3f52', Math.max(16, Math.min(512, Number(params[0])))));
  });

  router.add('GET', /^\/emoji\/([^/]+)$/, async ({ res, params }) => {
    const image = getEmojiImage(ctx, decodeURIComponent(params[0]!));
    if (image && (await sendStored(ctx, res, image.key, image.mimetype))) return;
    sendJson(res, 404, { ok: false, error: 'emoji_not_found' });
  });
}
