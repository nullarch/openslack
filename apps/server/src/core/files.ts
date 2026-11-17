import { vttText } from '../clips/vtt.ts';
import type { Readable } from 'node:stream';
import { scanStream } from './scanner.ts';
import { indexFileText } from './file-text.ts';
import type { FileObject } from '@app/shared';
import type { Ctx } from '../ctx.ts';
import { canSee, getConv } from './conversations.ts';
import { fail } from './errors.ts';
import { newId, newSecret, nowSeconds } from './ids.ts';

export interface FileRow {
  id: string;
  user_id: string;
  name: string;
  title: string;
  mimetype: string;
  filetype: string;
  size: number;
  storage_key: string;
  state: 'pending' | 'uploaded' | 'shared';
  width: number | null;
  height: number | null;
  alt_txt: string | null;
  upload_secret: string | null;
  created: number;
  mode?: string;
  /** JSON { w, h } of a thumbnail the uploading client made, stored under `<storage_key>_t`. */
  thumb?: string | null;
  /** Set while the file has a public link: the secret part of that link. */
  public_secret?: string | null;
  /** WebVTT captions of a recording, attached by the browser that made it. */
  transcript?: string | null;
  transcript_locale?: string | null;
  /** Remote files: the app that added it, its id for it, where it lives, and the kind it said it is. */
  external_id?: string | null;
  external_url?: string | null;
  app_id?: string | null;
  remote_type?: string | null;
}

interface TypeInfo {
  mimetype: string;
  filetype: string;
  pretty: string;
}

const TYPES: Record<string, TypeInfo> = {
  png: { mimetype: 'image/png', filetype: 'png', pretty: 'PNG' },
  jpg: { mimetype: 'image/jpeg', filetype: 'jpg', pretty: 'JPEG' },
  jpeg: { mimetype: 'image/jpeg', filetype: 'jpg', pretty: 'JPEG' },
  gif: { mimetype: 'image/gif', filetype: 'gif', pretty: 'GIF' },
  webp: { mimetype: 'image/webp', filetype: 'webp', pretty: 'WebP' },
  svg: { mimetype: 'image/svg+xml', filetype: 'svg', pretty: 'SVG' },
  heic: { mimetype: 'image/heic', filetype: 'heic', pretty: 'HEIC' },
  pdf: { mimetype: 'application/pdf', filetype: 'pdf', pretty: 'PDF' },
  mp4: { mimetype: 'video/mp4', filetype: 'mp4', pretty: 'MPEG 4 Video' },
  mov: { mimetype: 'video/quicktime', filetype: 'mov', pretty: 'QuickTime Movie' },
  webm: { mimetype: 'video/webm', filetype: 'webm', pretty: 'WebM' },
  mp3: { mimetype: 'audio/mpeg', filetype: 'mp3', pretty: 'MP3' },
  wav: { mimetype: 'audio/wav', filetype: 'wav', pretty: 'WAV' },
  ogg: { mimetype: 'audio/ogg', filetype: 'ogg', pretty: 'Ogg' },
  m4a: { mimetype: 'audio/mp4', filetype: 'm4a', pretty: 'MPEG 4 Audio' },
  weba: { mimetype: 'audio/webm', filetype: 'weba', pretty: 'WebM Audio' },
  txt: { mimetype: 'text/plain', filetype: 'text', pretty: 'Plain Text' },
  log: { mimetype: 'text/plain', filetype: 'text', pretty: 'Plain Text' },
  md: { mimetype: 'text/markdown', filetype: 'markdown', pretty: 'Markdown' },
  csv: { mimetype: 'text/csv', filetype: 'csv', pretty: 'CSV' },
  json: { mimetype: 'application/json', filetype: 'json', pretty: 'JSON' },
  yaml: { mimetype: 'text/yaml', filetype: 'yaml', pretty: 'YAML' },
  yml: { mimetype: 'text/yaml', filetype: 'yaml', pretty: 'YAML' },
  xml: { mimetype: 'text/xml', filetype: 'xml', pretty: 'XML' },
  html: { mimetype: 'text/html', filetype: 'html', pretty: 'HTML' },
  css: { mimetype: 'text/css', filetype: 'css', pretty: 'CSS' },
  js: { mimetype: 'text/javascript', filetype: 'javascript', pretty: 'JavaScript' },
  ts: { mimetype: 'text/plain', filetype: 'typescript', pretty: 'TypeScript' },
  py: { mimetype: 'text/plain', filetype: 'python', pretty: 'Python' },
  go: { mimetype: 'text/plain', filetype: 'go', pretty: 'Go' },
  rs: { mimetype: 'text/plain', filetype: 'rust', pretty: 'Rust' },
  sh: { mimetype: 'text/plain', filetype: 'shell', pretty: 'Shell' },
  sql: { mimetype: 'text/plain', filetype: 'sql', pretty: 'SQL' },
  diff: { mimetype: 'text/plain', filetype: 'diff', pretty: 'Diff' },
  zip: { mimetype: 'application/zip', filetype: 'zip', pretty: 'Zip' },
  gz: { mimetype: 'application/gzip', filetype: 'gzip', pretty: 'Gzip' },
  doc: { mimetype: 'application/msword', filetype: 'doc', pretty: 'Word Document' },
  docx: {
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    filetype: 'docx',
    pretty: 'Word Document',
  },
  xls: { mimetype: 'application/vnd.ms-excel', filetype: 'xls', pretty: 'Excel Spreadsheet' },
  xlsx: {
    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filetype: 'xlsx',
    pretty: 'Excel Spreadsheet',
  },
  ppt: { mimetype: 'application/vnd.ms-powerpoint', filetype: 'ppt', pretty: 'PowerPoint Presentation' },
  pptx: {
    mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    filetype: 'pptx',
    pretty: 'PowerPoint Presentation',
  },
};

export function typeForName(name: string): TypeInfo {
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return TYPES[extension] ?? { mimetype: 'application/octet-stream', filetype: extension || 'binary', pretty: 'File' };
}

/** Types a browser may display in place; everything else is sent as a download. */
export function isInlineSafe(mimetype: string): boolean {
  return (
    /^image\/(png|jpeg|gif|webp)$/.test(mimetype) ||
    /^(video|audio)\//.test(mimetype) ||
    mimetype === 'application/pdf' ||
    mimetype === 'text/plain'
  );
}

export function getFile(ctx: Ctx, id: string): FileRow | undefined {
  return ctx.db.get<FileRow>('SELECT * FROM files WHERE id = ?', id);
}

function fileUrl(ctx: Ctx, row: FileRow, download: boolean): string {
  const team = ctx.requireTeam().id;
  const name = encodeURIComponent(row.name);
  return `${ctx.config.publicUrl}/files-pri/${team}-${row.id}/${download ? 'download/' : ''}${name}`;
}

export function fileToApi(ctx: Ctx, row: FileRow): FileObject {
  const shares = ctx.db.all<{ conversation_id: string }>(
    'SELECT DISTINCT conversation_id FROM file_shares WHERE file_id = ?',
    row.id,
  );
  const channels: string[] = [];
  const groups: string[] = [];
  const ims: string[] = [];
  for (const share of shares) {
    const conv = getConv(ctx, share.conversation_id);
    if (!conv) continue;
    if (conv.kind === 'public') channels.push(conv.id);
    else if (conv.kind === 'im') ims.push(conv.id);
    else groups.push(conv.id);
  }
  const file: FileObject = {
    id: row.id,
    created: row.created,
    timestamp: row.created,
    name: row.name,
    title: row.title,
    mimetype: row.mimetype,
    filetype: row.filetype,
    pretty_type: typeForName(row.name).pretty,
    user: row.user_id,
    user_team: ctx.requireTeam().id,
    editable: false,
    size: row.size,
    mode: row.mode === 'snippet' ? 'snippet' : 'hosted',
    is_external: false,
    external_type: '',
    is_public: channels.length > 0,
    public_url_shared: Boolean(row.public_secret),
    display_as_bot: false,
    username: '',
    url_private: fileUrl(ctx, row, false),
    url_private_download: fileUrl(ctx, row, true),
    permalink: fileUrl(ctx, row, false),
    channels,
    groups,
    ims,
    has_rich_preview: false,
    file_access: 'visible',
  };
  if (row.alt_txt) file.alt_txt = row.alt_txt;
  if (row.mode === 'external') {
    // Remote files (files.remote.*): the bytes live at the app's address.
    file.mode = 'external';
    file.is_external = true;
    file.external_type = 'app';
    file.external_id = row.external_id ?? '';
    file.external_url = row.external_url ?? '';
    file.url_private = row.external_url ?? '';
    file.permalink = row.external_url ?? '';
    file.pretty_type = 'Remote';
    delete file.url_private_download;
    if (row.remote_type) file.filetype = row.remote_type;
  }
  if (row.transcript) {
    const words = vttText(row.transcript);
    file.transcription = {
      status: 'complete',
      locale: row.transcript_locale ?? '',
      preview: { content: words.slice(0, 500), has_more: words.length > 500 },
      vtt_url: `${ctx.config.publicUrl}/files-vtt/${ctx.requireTeam().id}-${row.id}`,
    };
  }
  if (row.public_secret) file.permalink_public = `${ctx.config.publicUrl}/files-pub/${ctx.requireTeam().id}-${row.id}-${row.public_secret}`;
  if (row.width && row.height) {
    file.original_w = row.width;
    file.original_h = row.height;
    const thumb = parseThumb(row.thumb);
    if (thumb) {
      // The client-made thumbnail (up to 720 px) serves every thumbnail size we report.
      const url = `${ctx.config.publicUrl}/files-tmb/${ctx.requireTeam().id}-${row.id}/720`;
      const scale = Math.min(1, 360 / Math.max(thumb.w, thumb.h));
      file.thumb_360 = url;
      file.thumb_360_w = Math.round(thumb.w * scale);
      file.thumb_360_h = Math.round(thumb.h * scale);
      file.thumb_720 = url;
      file.thumb_720_w = thumb.w;
      file.thumb_720_h = thumb.h;
    } else {
      // No thumbnail: the original, with the size it should be drawn at.
      const scale = Math.min(1, 360 / Math.max(row.width, row.height));
      file.thumb_360 = file.url_private;
      file.thumb_360_w = Math.round(row.width * scale);
      file.thumb_360_h = Math.round(row.height * scale);
    }
  }
  return file;
}

export function parseThumb(value: string | null | undefined): { w: number; h: number } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { w?: unknown; h?: unknown };
    return typeof parsed.w === 'number' && typeof parsed.h === 'number' ? { w: parsed.w, h: parsed.h } : null;
  } catch {
    return null;
  }
}

export const MAX_THUMB_BYTES = 1024 * 1024;
export const MAX_THUMB_SIDE = 1440;

/**
 * Store a thumbnail the uploading client made for an image it is about to
 * upload (browsers decode every format they display, so the server needs no
 * image library). Accepted only while the upload is pending and only as PNG,
 * JPEG or WebP no larger than MAX_THUMB_SIDE on either side.
 */
export async function receiveThumbnail(ctx: Ctx, id: string, secret: string, body: Readable): Promise<{ w: number; h: number }> {
  const row = getFile(ctx, id);
  if (!row || row.state !== 'pending' || !row.upload_secret || row.upload_secret !== secret) fail('invalid_upload');
  if (!row.mimetype.startsWith('image/')) fail('not_an_image');
  const key = `${row.storage_key}_t`;
  try {
    await ctx.storage.put(key, body, MAX_THUMB_BYTES);
  } catch (error) {
    if (error instanceof Error && error.message === 'too_large') fail('thumbnail_too_large');
    throw error;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of ctx.storage.read(key, { start: 0, end: 64 * 1024 - 1 })) chunks.push(chunk as Buffer);
  const head = Buffer.concat(chunks);
  const known =
    (head.length > 4 && head.readUInt32BE(0) === 0x89504e47) ||
    (head[0] === 0xff && head[1] === 0xd8) ||
    head.toString('ascii', 8, 12) === 'WEBP';
  const size = known ? parseImageSize(head) : null;
  if (!size || size.width < 1 || size.height < 1 || size.width > MAX_THUMB_SIDE || size.height > MAX_THUMB_SIDE) {
    await ctx.storage.remove(key);
    fail('invalid_thumbnail');
  }
  const thumb = { w: size.width, h: size.height };
  ctx.db.run('UPDATE files SET thumb = ? WHERE id = ?', JSON.stringify(thumb), id);
  return thumb;
}

export function filesToApi(ctx: Ctx, ids: string[]): FileObject[] {
  const files: FileObject[] = [];
  for (const id of ids) {
    const row = getFile(ctx, id);
    if (row) files.push(fileToApi(ctx, row));
  }
  return files;
}

export function shareFiles(ctx: Ctx, ids: string[], conversationId: string, ts: string): void {
  for (const id of ids) {
    ctx.db.run(
      'INSERT OR IGNORE INTO file_shares (file_id, conversation_id, ts) VALUES (?, ?, ?)',
      id,
      conversationId,
      ts,
    );
    ctx.db.run("UPDATE files SET state = 'shared' WHERE id = ?", id);
  }
}

/**
 * Other places a file can be shown (an image in a canvas) register a check
 * here: it returns true when `userId` may read the file through that place.
 */
export const fileAccessHooks: ((ctx: Ctx, fileId: string, userId: string) => boolean)[] = [];

/** A file is readable by its uploader, by anyone who can see a conversation it was shared in, and through `fileAccessHooks`. */
export function canAccessFile(ctx: Ctx, row: FileRow, userId: string): boolean {
  if (row.user_id === userId) return true;
  const shares = ctx.db.all<{ conversation_id: string }>(
    'SELECT DISTINCT conversation_id FROM file_shares WHERE file_id = ?',
    row.id,
  );
  for (const share of shares) {
    const conv = getConv(ctx, share.conversation_id);
    if (conv && canSee(ctx, conv, userId)) return true;
  }
  return fileAccessHooks.some((hook) => hook(ctx, row.id, userId));
}

export interface PendingUpload {
  row: FileRow;
  uploadUrl: string;
}

/** Step one of an upload: reserve a file id and hand back a one-time URL to send the bytes to. */
export function createPendingFile(
  ctx: Ctx,
  userId: string,
  filename: string,
  length: number,
  altTxt: string | null,
): PendingUpload {
  if (length > ctx.config.maxUploadBytes) fail('file_too_large', { max_bytes: ctx.config.maxUploadBytes });
  const name = filename.replace(/[\\/\0]/g, '_').slice(0, 255) || 'file';
  const id = newId('F');
  const secret = newSecret(18);
  const type = typeForName(name);
  ctx.db.run(
    `INSERT INTO files (id, user_id, name, title, mimetype, filetype, size, storage_key, alt_txt, upload_secret, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    name,
    name,
    type.mimetype,
    type.filetype,
    length,
    id,
    altTxt,
    secret,
    nowSeconds(),
  );
  return { row: getFile(ctx, id)!, uploadUrl: `${ctx.config.publicUrl}/upload/v1/${id}?secret=${secret}` };
}

/** Step two: store the bytes. The secret from the upload URL is the only credential. */
export async function receiveUpload(ctx: Ctx, id: string, secret: string, body: Readable): Promise<number> {
  const row = getFile(ctx, id);
  if (!row || row.state !== 'pending' || !row.upload_secret || row.upload_secret !== secret) fail('invalid_upload');
  let size: number;
  try {
    size = await ctx.storage.put(row.storage_key, body, ctx.config.maxUploadBytes);
  } catch (error) {
    if (error instanceof Error && error.message === 'too_large') fail('file_too_large');
    throw error;
  }
  await scanUpload(ctx, row, size);
  for (const check of uploadChecks) {
    try {
      await check(ctx, row, size);
    } catch (error) {
      // A refused upload leaves nothing behind.
      await ctx.storage.remove(row.storage_key);
      ctx.db.run('DELETE FROM files WHERE id = ?', row.id);
      throw error;
    }
  }
  const dimensions = row.mimetype.startsWith('image/') ? await sniffImageSize(ctx, row.storage_key) : null;
  ctx.db.run(
    "UPDATE files SET state = 'uploaded', size = ?, width = ?, height = ?, upload_secret = NULL WHERE id = ?",
    size,
    dimensions?.width ?? null,
    dimensions?.height ?? null,
    id,
  );
  // Reading the text is slower than storing the bytes; it happens after the upload has answered.
  const stored = getFile(ctx, id);
  if (stored) setImmediate(() => void indexFileText(ctx, stored).catch(() => undefined));
  return size;
}

/** Checks run on an upload's stored bytes before it is marked uploaded; one that throws refuses it. */
export const uploadChecks: ((ctx: Ctx, row: FileRow, size: number) => Promise<void>)[] = [];

/**
 * With a scanner configured, an upload is checked before it can be shared. An
 * infected file is removed and refused; when the scanner cannot answer, the
 * upload is refused too unless CLAMAV_FAIL_OPEN=1.
 */
async function scanUpload(ctx: Ctx, row: FileRow, size: number): Promise<void> {
  const scanner = ctx.config.scanner;
  if (!scanner) return;
  if (size > scanner.maxBytes) {
    console.warn(`[scan] ${row.id} (${size} bytes) is larger than CLAMAV_MAX_MB and was not scanned`);
    return;
  }
  const result = await scanStream(scanner, ctx.storage.read(row.storage_key));
  if ('clean' in result && result.clean) return;
  if ('signature' in result) {
    await ctx.storage.remove(row.storage_key);
    ctx.db.run('DELETE FROM files WHERE id = ?', row.id);
    console.warn(`[scan] ${row.id} refused: ${result.signature}`);
    fail('file_infected', { signature: result.signature });
  }
  console.error(`[scan] ${row.id} could not be scanned: ${result.error}`);
  if (!scanner.failOpen) {
    await ctx.storage.remove(row.storage_key);
    ctx.db.run('DELETE FROM files WHERE id = ?', row.id);
    fail('scan_unavailable');
  }
}

/**
 * Asked before a file is deleted; a hook that returns true takes the stored
 * bytes over (legal hold keeps them), so they are not removed.
 */
export const keepFileBytes: ((ctx: Ctx, row: FileRow) => boolean)[] = [];

export async function deleteFile(ctx: Ctx, row: FileRow): Promise<void> {
  const kept = keepFileBytes.some((hook) => hook(ctx, row));
  ctx.db.run('DELETE FROM files WHERE id = ?', row.id);
  if (!kept) {
    await ctx.storage.remove(row.storage_key);
    if (row.thumb) await ctx.storage.remove(`${row.storage_key}_t`);
  }
  ctx.bus.emit({
    event: { type: 'file_deleted', file_id: row.id, event_ts: ctx.clock.eventTs() },
    audience: { all: true },
  });
}

// ── Image dimensions ────────────────────────────────────────────────────────

async function readHead(ctx: Ctx, key: string, bytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of ctx.storage.read(key, { start: 0, end: bytes - 1 })) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Read width and height from the image header (PNG, GIF, JPEG, WebP) without decoding it. */
export async function sniffImageSize(ctx: Ctx, key: string): Promise<{ width: number; height: number } | null> {
  try {
    return parseImageSize(await readHead(ctx, key, 256 * 1024));
  } catch {
    return null;
  }
}

export function parseImageSize(head: Buffer): { width: number; height: number } | null {
  if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47) {
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  }
  if (head.length >= 10 && head.toString('ascii', 0, 3) === 'GIF') {
    return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
  }
  if (head.length >= 30 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') {
    const kind = head.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { width: 1 + head.readUIntLE(24, 3), height: 1 + head.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const bits = head.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < head.length) {
      if (head[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = head[offset + 1]!;
      // Start-of-frame markers carry the dimensions; C4, C8 and CC are other segment types.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: head.readUInt16BE(offset + 7), height: head.readUInt16BE(offset + 5) };
      }
      offset += 2 + head.readUInt16BE(offset + 2);
    }
  }
  return null;
}
