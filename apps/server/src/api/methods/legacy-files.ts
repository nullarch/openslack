import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import type { Ctx } from '../../ctx.ts';
import { resolveConv } from '../../core/conversations.ts';
import { ApiError, fail } from '../../core/errors.ts';
import { createPendingFile, fileToApi, getFile, receiveUpload } from '../../core/files.ts';
import { newHex } from '../../core/ids.ts';
import { postMessage } from '../../core/messages.ts';
import type { Registry } from '../registry.ts';
import { requirePostable } from './chat.ts';

/**
 * `files.upload`, the one-request upload Slack retired in favour of
 * `files.getUploadURLExternal` + `files.completeUploadExternal`. Countless CI
 * scripts still call it with `curl -F file=@report.pdf`, so it is kept.
 */

export interface MultipartUpload {
  path: string;
  filename: string;
  size: number;
}

/** Key under which a multipart request's file reaches the method's arguments. */
export const UPLOAD_ARG = '__upload';
/** Every file of a multipart request, by form field name (`files.remote.add` sends two). */
export const UPLOADS_ARG = '__uploads';

/** The file sent in the form field `field`, if any. */
export function uploadNamed(raw: Record<string, unknown>, field: string): MultipartUpload | undefined {
  return (raw[UPLOADS_ARG] as Record<string, MultipartUpload> | undefined)?.[field];
}

/**
 * Read a multipart/form-data request: fields become arguments; the first file
 * is spooled to a temporary file (deleted after the call by the caller).
 */
export async function readMultipart(ctx: Ctx, req: IncomingMessage): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const dir = join(ctx.config.dataDir, 'tmp');
  await mkdir(dir, { recursive: true });
  return new Promise((resolve, reject) => {
    let parser: busboy.Busboy;
    try {
      parser = busboy({ headers: req.headers, limits: { files: 3, fields: 50, fieldSize: 1024 * 1024, fileSize: ctx.config.maxUploadBytes } });
    } catch {
      reject(new ApiError('invalid_form_data'));
      return;
    }
    const writing: Promise<void>[] = [];
    const byField: Record<string, MultipartUpload> = {};
    out[UPLOADS_ARG] = byField;
    let tooLarge = false;
    parser.on('field', (name, value) => {
      out[name] = value;
    });
    parser.on('file', (field, stream, info) => {
      const path = join(dir, `upload-${newHex(8)}`);
      const first = writing.length === 0;
      stream.on('limit', () => {
        tooLarge = true;
      });
      writing.push(
        pipeline(stream, createWriteStream(path)).then(async () => {
          const upload = { path, filename: info.filename || 'file', size: (await stat(path)).size } satisfies MultipartUpload;
          byField[field] ??= upload;
          // The first file is the one methods with a single upload read.
          if (first) out[UPLOAD_ARG] = upload;
        }),
      );
    });
    parser.on('error', () => reject(new ApiError('invalid_form_data')));
    parser.on('close', () => {
      void (async () => {
        try {
          await Promise.all(writing);
          if (tooLarge) {
            await discardMultipart(out);
            reject(new ApiError('file_too_large', { max_bytes: ctx.config.maxUploadBytes }));
            return;
          }
          resolve(out);
        } catch (error) {
          reject(error);
        }
      })();
    });
    req.pipe(parser);
  });
}

export async function discardMultipart(raw: Record<string, unknown>): Promise<void> {
  const paths = new Set<string>();
  const upload = raw[UPLOAD_ARG] as MultipartUpload | undefined;
  if (upload) paths.add(upload.path);
  for (const item of Object.values((raw[UPLOADS_ARG] as Record<string, MultipartUpload> | undefined) ?? {})) paths.add(item.path);
  for (const path of paths) await rm(path, { force: true });
}

export function registerLegacyFiles(registry: Registry): void {
  registry.add('files.upload', { scopes: ['files:write'] }, async ({ ctx, actor, args }) => {
    const upload = args.raw[UPLOAD_ARG] as MultipartUpload | undefined;
    const content = args.str('content');
    if (!upload && content === undefined) fail('no_file_data');

    const filename = args.str('filename') || upload?.filename || 'file.txt';
    const size = upload ? upload.size : Buffer.byteLength(content!);
    // Resolve the destinations first, so a bad channel fails before anything is stored.
    const channels = args.list('channels').map((channel) => {
      const conv = resolveConv(ctx, actor, channel);
      requirePostable(ctx, conv, actor);
      return conv;
    });

    const pending = createPendingFile(ctx, actor.userId, filename, size, null);
    const secret = new URL(pending.uploadUrl).searchParams.get('secret')!;
    await receiveUpload(ctx, pending.row.id, secret, upload ? createReadStream(upload.path) : Readable.from([Buffer.from(content!)]));
    const title = args.str('title');
    if (title) ctx.db.run('UPDATE files SET title = ? WHERE id = ?', title.slice(0, 255), pending.row.id);

    for (const conv of channels) {
      postMessage(ctx, {
        conv,
        userId: actor.userId,
        botId: actor.botId,
        appId: actor.isBot ? actor.appId : null,
        text: args.str('initial_comment') ?? '',
        fileIds: [pending.row.id],
        threadTs: args.ts('thread_ts'),
        eventExtra: { subtype: 'file_share' },
      });
    }
    return { file: fileToApi(ctx, getFile(ctx, pending.row.id)!) };
  });
}
