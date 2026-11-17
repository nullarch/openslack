import { recordAuditEvent } from '../audit/index.ts';
import type { Writable } from 'node:stream';
import type { Kernel } from '../app.ts';
import { authenticate } from '../core/auth.ts';
import { convToApi, memberIds, type ConvRow } from '../core/conversations.ts';
import { getFile } from '../core/files.ts';
import { messageToApi, type MsgRow } from '../core/messages.ts';
import type { UserRow } from '../core/users.ts';
import type { Ctx } from '../ctx.ts';
import { sendJson } from '../api/http.ts';
import { ZipWriter } from './zip-writer.ts';

/**
 * Everything in the workspace as a Slack-format export archive: users.json,
 * channels.json, groups.json, dms.json, mpims.json and one folder per
 * conversation with a JSON file per day. Uploaded files go under
 * `__uploads/<file id>/<name>`, which this server's importer reads back.
 */

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2), 'utf8');
}

function userToExport(row: UserRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    real_name: row.real_name,
    deleted: row.deleted === 1,
    is_bot: row.is_bot === 1,
    is_admin: row.role !== 'member',
    is_owner: row.role === 'owner' || row.role === 'primary_owner',
    is_primary_owner: row.role === 'primary_owner',
    is_restricted: row.guest !== '',
    is_ultra_restricted: row.guest === 'single',
    tz: row.tz,
    updated: row.updated,
    profile: {
      email: row.email ?? undefined,
      real_name: row.real_name,
      display_name: row.display_name,
      title: row.title,
      phone: row.phone,
      bot_id: row.bot_id ?? undefined,
    },
  };
}

function topic(value: string, creator: string, set: number): Record<string, unknown> {
  return { value, creator, last_set: set };
}

function conversationToExport(ctx: Ctx, conv: ConvRow): Record<string, unknown> {
  const pins = ctx.db.all<{ ts: string; user_id: string; created: number }>(
    'SELECT ts, user_id, created FROM pins WHERE conversation_id = ? ORDER BY created',
    conv.id,
  );
  const base: Record<string, unknown> = { id: conv.id, created: conv.created, creator: conv.creator, members: memberIds(ctx, conv.id) };
  if (conv.kind === 'im') return base;
  if (conv.kind === 'mpim') return { ...base, name: convToApi(ctx, conv, null).name };
  return {
    ...base,
    name: conv.name,
    is_archived: conv.is_archived === 1,
    is_general: conv.is_general === 1,
    topic: topic(conv.topic, conv.topic_creator, conv.topic_set),
    purpose: topic(conv.purpose, conv.purpose_creator, conv.purpose_set),
    pins: pins.map((pin) => ({ id: pin.ts, type: 'C', user: pin.user_id, created: pin.created })),
  };
}

function folderOf(ctx: Ctx, conv: ConvRow): string {
  if (conv.kind === 'im') return conv.id;
  if (conv.kind === 'mpim') return String(convToApi(ctx, conv, null).name);
  return conv.name ?? conv.id;
}

function dayOf(ts: string): string {
  return new Date(Number(ts.split('.')[0]) * 1000).toISOString().slice(0, 10);
}

/** A stored message in the shape Slack exports use. */
function messageToExport(ctx: Ctx, row: MsgRow): Record<string, unknown> {
  const message = messageToApi(ctx, row) as unknown as Record<string, unknown>;
  delete message.streaming;
  delete message.team;
  return message;
}

export interface ExportOptions {
  /** Put the uploaded files in the archive too. */
  files: boolean;
}

export async function writeSlackExport(ctx: Ctx, out: Writable, options: ExportOptions): Promise<void> {
  const zip = new ZipWriter(out);
  const users = ctx.db.all<UserRow>('SELECT * FROM users ORDER BY created, id');
  await zip.add('users.json', json(users.map(userToExport)));

  const conversations = ctx.db.all<ConvRow>('SELECT * FROM conversations ORDER BY created, id');
  const byKind = (kind: ConvRow['kind']): Record<string, unknown>[] =>
    conversations.filter((conv) => conv.kind === kind).map((conv) => conversationToExport(ctx, conv));
  await zip.add('channels.json', json(byKind('public')));
  await zip.add('groups.json', json(byKind('private')));
  await zip.add('dms.json', json(byKind('im')));
  await zip.add('mpims.json', json(byKind('mpim')));

  const fileIds = new Set<string>();
  const statement = ctx.db.raw.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY ts');
  for (const conv of conversations) {
    const folder = folderOf(ctx, conv);
    let day = '';
    let batch: Record<string, unknown>[] = [];
    const flush = async (): Promise<void> => {
      if (batch.length) await zip.add(`${folder}/${day}.json`, json(batch));
      batch = [];
    };
    for (const raw of statement.iterate(conv.id)) {
      const row = raw as unknown as MsgRow;
      const rowDay = dayOf(row.ts);
      if (rowDay !== day) {
        await flush();
        day = rowDay;
      }
      if (row.files) for (const id of JSON.parse(row.files) as string[]) fileIds.add(id);
      batch.push(messageToExport(ctx, row));
    }
    await flush();
  }

  if (options.files) {
    for (const id of fileIds) {
      const file = getFile(ctx, id);
      if (!file || file.state === 'pending') continue;
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of ctx.storage.read(file.storage_key)) chunks.push(chunk as Buffer);
      } catch {
        continue;
      }
      await zip.add(`__uploads/${file.id}/${file.name.replace(/[\\/]/g, '_')}`, Buffer.concat(chunks), new Date(file.created * 1000));
    }
  }
  await zip.finish();
}

/** `GET /admin/export.zip`: the workspace's owners download everything. */
export function installExport(kernel: Kernel): void {
  const { ctx, router } = kernel;
  router.add('GET', /^\/admin\/export\.zip$/, async ({ req, res, url }) => {
    const { actor } = authenticate(ctx, req, undefined);
    const owner = actor && actor.kind === 'session' && (actor.role === 'owner' || actor.role === 'primary_owner');
    if (!owner) {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    const team = ctx.requireTeam();
    recordAuditEvent(ctx, { action: 'workspace_exported', actorId: actor.userId, req, details: { files: url.searchParams.get('files') !== '0' } });
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${team.domain || 'workspace'}-export-${stamp}.zip"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    try {
      await writeSlackExport(ctx, res, { files: url.searchParams.get('files') !== '0' });
    } catch (error) {
      if (!ctx.config.quiet) console.error('[export] failed', error);
      res.destroy();
      return;
    }
    res.end();
  });
}
