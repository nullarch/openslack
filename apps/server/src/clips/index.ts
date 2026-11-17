import { sendJson } from '../api/http.ts';
import { authenticate } from '../core/auth.ts';
import type { Kernel } from '../app.ts';
import { fail } from '../core/errors.ts';
import { canAccessFile, fileToApi, getFile } from '../core/files.ts';
import { contentChecks } from '../core/messages.ts';
import { vttText } from './vtt.ts';

/**
 * Clips (t079): audio, video and screen recordings made in the composer and
 * sent as files. What makes them more than files is the transcript: the
 * recording browser turns the speaker's words into WebVTT captions as they
 * record, attaches them with `client.files.setTranscript`, and everyone who
 * can open the file gets captions on the video, the text under the player,
 * and search over what was said.
 */

const MAX_VTT_BYTES = 256 * 1024;

const TIMING = /^(\d{2,}:)?\d{2}:\d{2}\.\d{3} --> (\d{2,}:)?\d{2}:\d{2}\.\d{3}/;

function validVtt(vtt: string): boolean {
  if (!/^﻿?WEBVTT(?:[ \t][^\n]*)?(?:\r?\n|$)/.test(vtt)) return false;
  return vtt
    .split(/\r?\n/)
    .filter((line) => line.includes('-->'))
    .every((line) => TIMING.test(line.trim()));
}

export function installClips(kernel: Kernel): void {
  const { ctx, registry, router } = kernel;

  registry.add('client.files.setTranscript', { auth: 'session' }, ({ actor, args }) => {
    const row = getFile(ctx, args.req('file', 'file_not_found'));
    // Only the person who uploaded the file; to anyone else it does not exist.
    if (!row || row.user_id !== actor.userId) fail('file_not_found');
    if (!/^(audio|video)\//.test(row.mimetype)) fail('not_a_recording');
    const vtt = args.req('vtt', 'invalid_transcript');
    if (Buffer.byteLength(vtt) > MAX_VTT_BYTES || !validVtt(vtt)) fail('invalid_transcript');
    const text = vttText(vtt);
    // Workspace policies (sensitive information) apply to what was said, as to what is written.
    for (const check of contentChecks) check(ctx, actor.userId, text, null);
    const locale = (args.str('locale') ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 35) || null;
    ctx.db.run('UPDATE files SET transcript = ?, transcript_locale = ? WHERE id = ?', vtt, locale, row.id);
    // Search over what was said.
    ctx.db.run('DELETE FROM file_text WHERE file_id = ?', row.id);
    ctx.db.run('INSERT INTO file_text (file_id, body) VALUES (?, ?)', row.id, text);
    return { file: fileToApi(ctx, getFile(ctx, row.id)!) };
  });

  router.add('GET', /^\/files-vtt\/[A-Z0-9]+-([A-Z0-9]+)$/, ({ req, res, params }) => {
    const { actor } = authenticate(ctx, req, undefined);
    const row = getFile(ctx, params[0]!);
    if (!actor || !row || row.state === 'pending' || !row.transcript || !canAccessFile(ctx, row, actor.userId)) {
      sendJson(res, 404, { ok: false, error: 'file_not_found' });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8', 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff' });
    res.end(row.transcript);
  });
}
