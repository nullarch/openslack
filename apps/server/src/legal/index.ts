import type { Kernel } from '../app.ts';
import { recordAuditEvent } from '../audit/index.ts';
import { authenticate } from '../core/auth.ts';
import { fail } from '../core/errors.ts';
import { keepFileBytes, type FileRow } from '../core/files.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import { beforeMessageChange } from '../core/messages.ts';
import { getUser } from '../core/users.ts';
import type { Actor, Ctx } from '../ctx.ts';
import { ZipWriter } from '../export/zip-writer.ts';
import { sendJson } from '../api/http.ts';

/**
 * Legal hold and eDiscovery, for workspace owners. A hold covers people
 * (everything they post anywhere) and conversations (everything in them).
 * While a hold is active, nothing it covers is lost: retention skips it, and
 * when a message is edited or deleted, or a file deleted, the earlier version
 * is kept out of sight. A discovery export collects messages (and the kept
 * versions and files) by people, conversations and dates into one zip. Every
 * step is in the audit log.
 */

interface HoldRow {
  id: string;
  name: string;
  created_by: string;
  created: number;
  released: number | null;
}

const ACTIVE_USER = `SELECT t.target_id FROM legal_hold_targets t JOIN legal_holds h ON h.id = t.hold_id WHERE h.released IS NULL AND t.kind = 'user'`;
const ACTIVE_CONV = `SELECT t.target_id FROM legal_hold_targets t JOIN legal_holds h ON h.id = t.hold_id WHERE h.released IS NULL AND t.kind = 'conversation'`;

/** SQL that is true for a message (alias `m`) an active hold covers. */
export const HELD_MESSAGE_SQL = `(m.user_id IN (${ACTIVE_USER}) OR m.conversation_id IN (${ACTIVE_CONV}))`;
/** SQL that is true for a file (alias `files`) an active hold covers. */
export const HELD_FILE_SQL = `(files.user_id IN (${ACTIVE_USER}) OR files.id IN (SELECT file_id FROM file_shares WHERE conversation_id IN (${ACTIVE_CONV})))`;

export function isHeld(ctx: Ctx, conversationId: string, userId: string | null): boolean {
  return Boolean(ctx.db.get(`SELECT 1 FROM legal_hold_targets t JOIN legal_holds h ON h.id = t.hold_id WHERE h.released IS NULL AND ((t.kind = 'conversation' AND t.target_id = ?) OR (t.kind = 'user' AND t.target_id = ?)) LIMIT 1`, conversationId, userId ?? ''));
}

function holdToApi(ctx: Ctx, row: HoldRow): Record<string, unknown> {
  const targets = ctx.db.all<{ kind: string; target_id: string }>('SELECT kind, target_id FROM legal_hold_targets WHERE hold_id = ? ORDER BY kind, target_id', row.id);
  return {
    id: row.id,
    name: row.name,
    created_by: row.created_by,
    created: row.created,
    released: row.released,
    is_active: row.released === null,
    users: targets.filter((target) => target.kind === 'user').map((target) => target.target_id),
    conversations: targets.filter((target) => target.kind === 'conversation').map((target) => target.target_id),
  };
}

const ownersOnly = (actor: Actor): void => {
  if (actor.role !== 'owner' && actor.role !== 'primary_owner') fail('not_allowed');
};

export function installLegal(kernel: Kernel): void {
  const { ctx } = kernel;

  beforeMessageChange.push((ctx2, conv, row, change) => {
    if (!isHeld(ctx2, conv.id, row.user_id)) return;
    ctx2.db.run(
      'INSERT INTO held_versions (conversation_id, ts, user_id, text, blocks, files, thread_ts, change, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      conv.id,
      row.ts,
      row.user_id,
      row.text,
      row.blocks,
      row.files,
      row.thread_ts,
      change,
      nowSeconds(),
    );
  });

  keepFileBytes.push((ctx2, row: FileRow) => {
    const held = ctx2.db.get(`SELECT 1 FROM files WHERE id = ? AND ${HELD_FILE_SQL}`, row.id);
    if (!held) return false;
    // Where it was shared goes with it: the shares themselves are removed with the file.
    const shares = ctx2.db.all<{ conversation_id: string }>('SELECT DISTINCT conversation_id FROM file_shares WHERE file_id = ?', row.id).map((share) => share.conversation_id);
    ctx2.db.run('INSERT OR REPLACE INTO held_files (file_id, row, deleted) VALUES (?, ?, ?)', row.id, JSON.stringify({ ...row, shares }), nowSeconds());
    return true;
  });

  const readTargets = (value: unknown, kind: 'user' | 'conversation'): string[] => {
    const list = Array.isArray(value) ? value : typeof value === 'string' && value ? value.split(',') : [];
    return [...new Set(list.map((entry) => String(entry).trim()).filter(Boolean))].map((id) => {
      const known = kind === 'user' ? getUser(ctx, id) : ctx.db.get('SELECT 1 FROM conversations WHERE id = ?', id);
      if (!known) fail(kind === 'user' ? 'user_not_found' : 'channel_not_found', { id });
      return id;
    });
  };

  kernel.registry.add('client.admin.holds.list', { auth: 'admin' }, ({ actor }) => {
    ownersOnly(actor);
    return { holds: ctx.db.all<HoldRow>('SELECT * FROM legal_holds ORDER BY released IS NOT NULL, created DESC').map((row) => holdToApi(ctx, row)) };
  });

  kernel.registry.add('client.admin.holds.create', { auth: 'admin' }, ({ actor, args }) => {
    ownersOnly(actor);
    const name = args.req('name', 'invalid_name').trim().slice(0, 120);
    const users = readTargets(args.raw.users, 'user');
    const conversations = readTargets(args.raw.channels, 'conversation');
    if (users.length === 0 && conversations.length === 0) fail('invalid_arguments', { detail: 'A hold needs people or conversations.' });
    const id = newId('LH');
    ctx.db.tx(() => {
      ctx.db.run('INSERT INTO legal_holds (id, name, created_by, created) VALUES (?, ?, ?, ?)', id, name, actor.userId, nowSeconds());
      for (const user of users) ctx.db.run("INSERT INTO legal_hold_targets (hold_id, kind, target_id) VALUES (?, 'user', ?)", id, user);
      for (const conv of conversations) ctx.db.run("INSERT INTO legal_hold_targets (hold_id, kind, target_id) VALUES (?, 'conversation', ?)", id, conv);
    });
    return { hold: holdToApi(ctx, ctx.db.get<HoldRow>('SELECT * FROM legal_holds WHERE id = ?', id)!) };
  });

  kernel.registry.add('client.admin.holds.release', { auth: 'admin' }, ({ actor, args }) => {
    ownersOnly(actor);
    const row = ctx.db.get<HoldRow>('SELECT * FROM legal_holds WHERE id = ?', args.req('hold', 'hold_not_found'));
    if (!row) fail('hold_not_found');
    if (row.released !== null) fail('already_released');
    ctx.db.run('UPDATE legal_holds SET released = ? WHERE id = ?', nowSeconds(), row.id);
    return { hold: holdToApi(ctx, ctx.db.get<HoldRow>('SELECT * FROM legal_holds WHERE id = ?', row.id)!) };
  });

  /**
   * `GET /admin/discovery.zip?users=U1,U2&channels=C1&oldest=…&latest=…&files=0`:
   * messages by those people or in those conversations (either list may be
   * empty, not both), kept versions included, as NDJSON, with the files.
   */
  kernel.router.add('GET', /^\/admin\/discovery\.zip$/, async ({ req, res, url }) => {
    const { actor } = authenticate(ctx, req, undefined);
    if (!actor || actor.kind !== 'session' || (actor.role !== 'owner' && actor.role !== 'primary_owner')) return sendJson(res, 404, { ok: false, error: 'not_found' });
    const list = (key: string): string[] => (url.searchParams.get(key) ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    const users = list('users');
    const channels = list('channels');
    if (users.length === 0 && channels.length === 0) return sendJson(res, 400, { ok: false, error: 'invalid_arguments' });
    const oldest = Number(url.searchParams.get('oldest') ?? 0) || 0;
    const latest = Number(url.searchParams.get('latest') ?? 0) || 9_999_999_999;
    const withFiles = url.searchParams.get('files') !== '0';
    const scope = `(${users.length ? `m.user_id IN (${users.map(() => '?').join(', ')})` : '0'} OR ${channels.length ? `m.conversation_id IN (${channels.map(() => '?').join(', ')})` : '0'})`;
    const range = [String(oldest).padStart(10, '0'), `${String(latest).padStart(10, '0')}.999999`];
    recordAuditEvent(ctx, { action: 'discovery_export', actorId: actor.userId, req, details: { users, channels, oldest, latest, files: withFiles } });

    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="discovery-${new Date().toISOString().slice(0, 10)}.zip"`,
      'cache-control': 'no-store',
    });
    const zip = new ZipWriter(res);
    const names = new Map<string, string>();
    const nameOf = (id: string | null): string | null => {
      if (!id) return null;
      if (!names.has(id)) names.set(id, getUser(ctx, id)?.name ?? id);
      return names.get(id)!;
    };
    const lines: string[] = [];
    const fileIds = new Set<string>();
    const rows = ctx.db.all<{ conversation_id: string; name: string | null; kind: string; ts: string; thread_ts: string | null; user_id: string | null; text: string; files: string | null; edited_ts: string | null; subtype: string | null }>(
      `SELECT m.conversation_id, c.name, c.kind, m.ts, m.thread_ts, m.user_id, m.text, m.files, m.edited_ts, m.subtype
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE ${scope} AND m.ts >= ? AND m.ts <= ? ORDER BY m.ts`,
      ...users,
      ...channels,
      ...range,
    );
    for (const row of rows) {
      const files = row.files ? (JSON.parse(row.files) as string[]) : [];
      files.forEach((id) => fileIds.add(id));
      lines.push(JSON.stringify({ type: 'message', channel: row.conversation_id, channel_name: row.name, channel_kind: row.kind, ts: row.ts, thread_ts: row.thread_ts, user: row.user_id, user_name: nameOf(row.user_id), subtype: row.subtype, text: row.text, files, edited_ts: row.edited_ts }));
    }
    const kept = ctx.db.all<{ conversation_id: string; ts: string; user_id: string | null; text: string; files: string | null; thread_ts: string | null; change: string; at: number }>(
      `SELECT * FROM held_versions m WHERE ${scope} AND m.ts >= ? AND m.ts <= ? ORDER BY m.ts, m.id`,
      ...users,
      ...channels,
      ...range,
    );
    for (const row of kept) {
      const files = row.files ? (JSON.parse(row.files) as string[]) : [];
      files.forEach((id) => fileIds.add(id));
      lines.push(JSON.stringify({ type: 'kept_version', change: row.change, changed_at: row.at, channel: row.conversation_id, ts: row.ts, thread_ts: row.thread_ts, user: row.user_id, user_name: nameOf(row.user_id), text: row.text, files }));
    }
    // Files deleted while held: by these people, or once shared in these conversations.
    for (const held of ctx.db.all<{ file_id: string; row: string; deleted: number }>('SELECT * FROM held_files ORDER BY deleted')) {
      const file = JSON.parse(held.row) as FileRow & { shares?: string[] };
      const inScope = users.includes(file.user_id) || (file.shares ?? []).some((conversation) => channels.includes(conversation));
      if (!inScope || file.created < oldest || file.created > latest) continue;
      fileIds.add(file.id);
      lines.push(JSON.stringify({ type: 'kept_file', change: 'deleted', changed_at: held.deleted, file: file.id, name: file.name, user: file.user_id, user_name: nameOf(file.user_id), created: file.created, shared_in: file.shares ?? [] }));
    }
    await zip.add('messages.ndjson', Buffer.from(lines.join('\n') + (lines.length ? '\n' : '')));
    let fileCount = 0;
    if (withFiles) {
      for (const id of fileIds) {
        const live = ctx.db.get<FileRow>('SELECT * FROM files WHERE id = ?', id);
        const held = live ? undefined : ctx.db.get<{ row: string }>('SELECT row FROM held_files WHERE file_id = ?', id);
        const file = live ?? (held ? (JSON.parse(held.row) as FileRow) : undefined);
        if (!file) continue;
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of ctx.storage.read(file.storage_key)) chunks.push(chunk as Buffer);
          await zip.add(`files/${file.id}/${file.name.replace(/[\\/]/g, '_')}`, Buffer.concat(chunks), new Date(file.created * 1000));
          fileCount += 1;
        } catch {
          // Bytes missing from storage: listed in messages, absent here.
        }
      }
    }
    await zip.add(
      'manifest.json',
      Buffer.from(JSON.stringify({ generated: new Date().toISOString(), by: actor.userId, criteria: { users, channels, oldest, latest, files: withFiles }, messages: rows.length, kept_versions: kept.length, files: fileCount }, null, 2)),
    );
    await zip.finish();
    res.end();
  });
}
