import type { Ctx } from '../ctx.ts';
import { canSee, getConv, getMember, memberIds } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { nowSeconds } from '../core/ids.ts';
import { getUser } from '../core/users.ts';

/**
 * Canvases and lists share one access model. The owner can do everything.
 * Others get `read` or `write` either directly or through a conversation:
 * members of that conversation get the level granted; for a public channel,
 * people who can see the channel but have not joined it can read.
 * Anything a person may not open does not exist for them ("not found").
 */

export type DocKind = 'canvas' | 'list';
export type Level = 'read' | 'write' | 'owner';

export interface DocRow {
  id: string;
  kind: DocKind;
  title: string;
  owner: string;
  conversation_id: string | null;
  created: number;
  updated: number;
  updated_by: string;
  deleted: number;
  plain: string;
  extra: string;
}

const RANK: Record<Level, number> = { read: 1, write: 2, owner: 3 };

export function getDoc(ctx: Ctx, id: string | undefined, kind?: DocKind): DocRow | undefined {
  if (!id) return undefined;
  const row = ctx.db.get<DocRow>('SELECT * FROM docs WHERE id = ? AND deleted = 0', id);
  if (!row || (kind && row.kind !== kind)) return undefined;
  return row;
}

/** The highest level `userId` has on `doc`, or null when they may not open it. */
export function accessOf(ctx: Ctx, doc: DocRow, userId: string): Level | null {
  if (doc.owner === userId) return 'owner';
  const user = getUser(ctx, userId);
  if (!user || user.deleted === 1) return null;
  let best: Level | null = null;
  const raise = (level: Level): void => {
    if (!best || RANK[level] > RANK[best]) best = level;
  };
  for (const row of ctx.db.all<{ principal: string; level: 'read' | 'write' }>('SELECT principal, level FROM doc_access WHERE doc_id = ?', doc.id)) {
    if (row.principal === userId) raise(row.level);
    else if (/^[CDG]/.test(row.principal)) {
      const conv = getConv(ctx, row.principal);
      if (!conv) continue;
      if (getMember(ctx, conv.id, userId)) raise(row.level);
      else if (conv.kind === 'public' && canSee(ctx, conv, userId)) raise('read');
    }
  }
  return best;
}

/** Load a document the caller may open at `needed` or above; otherwise it does not exist (or is read-only). */
export function requireDoc(ctx: Ctx, id: string | undefined, kind: DocKind, userId: string, needed: Level = 'read'): { doc: DocRow; level: Level } {
  const notFound = kind === 'canvas' ? 'canvas_not_found' : 'list_not_found';
  const doc = getDoc(ctx, id, kind) ?? fail(notFound);
  const level = accessOf(ctx, doc, userId);
  if (!level) fail(notFound);
  if (RANK[level] < RANK[needed]) fail(needed === 'owner' ? 'restricted_action' : 'access_denied');
  return { doc, level };
}

export function canWrite(level: Level | null): boolean {
  return level === 'write' || level === 'owner';
}

/** Everyone who should hear about changes: the owner, people granted access, members of granted conversations. */
export function audienceOf(ctx: Ctx, doc: DocRow): string[] {
  const people = new Set<string>([doc.owner]);
  for (const row of ctx.db.all<{ principal: string }>('SELECT principal FROM doc_access WHERE doc_id = ?', doc.id)) {
    if (/^[UW]/.test(row.principal)) people.add(row.principal);
    else for (const id of memberIds(ctx, row.principal)) people.add(id);
  }
  return [...people];
}

export function grant(ctx: Ctx, docId: string, principal: string, level: 'read' | 'write'): void {
  ctx.db.run(
    'INSERT INTO doc_access (doc_id, principal, level) VALUES (?, ?, ?) ON CONFLICT (doc_id, principal) DO UPDATE SET level = excluded.level',
    docId,
    principal,
    level,
  );
}

export function revoke(ctx: Ctx, docId: string, principal: string): void {
  ctx.db.run('DELETE FROM doc_access WHERE doc_id = ? AND principal = ?', docId, principal);
}

export function accessList(ctx: Ctx, docId: string): { principal: string; level: 'read' | 'write' }[] {
  return ctx.db.all('SELECT principal, level FROM doc_access WHERE doc_id = ? ORDER BY principal', docId);
}

/** Tell everyone who can open the document that something changed; clients refetch through the API. */
export function emitDocChanged(ctx: Ctx, doc: DocRow, change: string, extra: Record<string, unknown> = {}): void {
  ctx.bus.emit({
    event: { type: 'doc_changed', kind: doc.kind, id: doc.id, conversation_id: doc.conversation_id, change, ...extra },
    audience: { users: audienceOf(ctx, doc) },
    clientOnly: true,
  });
}

/** Keep the search index in step with a document's title and text. */
export function reindex(ctx: Ctx, docId: string): void {
  const row = ctx.db.get<{ rowid: number; title: string; plain: string; deleted: number }>('SELECT rowid, title, plain, deleted FROM docs WHERE id = ?', docId);
  if (!row) return;
  ctx.db.run('DELETE FROM docs_fts WHERE rowid = ?', row.rowid);
  if (row.deleted === 0) ctx.db.run('INSERT INTO docs_fts (rowid, search) VALUES (?, ?)', row.rowid, `${row.title}\n${row.plain}`);
}

export function touch(ctx: Ctx, docId: string, userId: string): void {
  ctx.db.run('UPDATE docs SET updated = ?, updated_by = ? WHERE id = ?', nowSeconds(), userId, docId);
}

export function permalink(ctx: Ctx, doc: Pick<DocRow, 'id' | 'kind'>): string {
  return `${ctx.config.publicUrl}/${doc.kind === 'canvas' ? 'docs' : 'lists'}/${ctx.requireTeam().id}/${doc.id}`;
}

/** Documents `userId` may open, newest first, optionally only one kind. */
export function visibleDocs(ctx: Ctx, userId: string, kind?: DocKind, limit = 200): (DocRow & { level: Level })[] {
  const rows = ctx.db.all<DocRow>(
    `SELECT * FROM docs WHERE deleted = 0 ${kind ? 'AND kind = ?' : ''} ORDER BY updated DESC LIMIT 2000`,
    ...(kind ? [kind] : []),
  );
  const out: (DocRow & { level: Level })[] = [];
  for (const row of rows) {
    const level = accessOf(ctx, row, userId);
    if (level) out.push({ ...row, level });
    if (out.length >= limit) break;
  }
  return out;
}
