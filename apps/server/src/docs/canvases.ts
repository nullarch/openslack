import * as Y from 'yjs';
import type { Registry } from '../api/registry.ts';
import { getConv, getMember, resolveConv } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import { getUser } from '../core/users.ts';
import type { Actor, Ctx } from '../ctx.ts';
import {
  accessList,
  accessOf,
  canWrite,
  emitDocChanged,
  getDoc,
  grant,
  reindex,
  requireDoc,
  revoke,
  permalink,
  type DocRow,
  type Level,
} from './access.ts';
import type { CanvasHub } from './hub.ts';
import { FIELD, fragmentToHtml, fragmentToMarkdown, markdownToY, sections, type Labels } from './markdown.ts';

const READ = ['canvases:read', 'canvases:write'];
const WRITE = ['canvases:write'];
export const MAX_MARKDOWN = 400_000;

/**
 * Checks before someone who can open a canvas comments on it; a guard throws to
 * refuse (a code channel's read-only canvas view). Process-wide: a guard uses
 * the ctx it is called with.
 */
export const commentGuards: ((ctx: Ctx, doc: DocRow, level: Level, userId: string) => void)[] = [];

export function labelsFor(ctx: Ctx): Labels {
  return {
    user: (id) => {
      const user = getUser(ctx, id);
      return user ? user.display_name || user.real_name || user.name : id;
    },
    channel: (id) => getConv(ctx, id)?.name ?? id,
  };
}

interface DocumentContent {
  type?: string;
  markdown?: string;
}

function readContent(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const content = value as DocumentContent;
  if (typeof content !== 'object' || content.type !== 'markdown' || typeof content.markdown !== 'string') fail('invalid_arguments', { needed: 'document_content' });
  if (content.markdown.length > MAX_MARKDOWN) fail('canvas_too_large');
  return content.markdown;
}

export function canvasToApi(ctx: Ctx, doc: DocRow, level: Level | null): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: doc.id,
    title: doc.title,
    owner: doc.owner,
    created: doc.created,
    updated: doc.updated,
    updated_by: doc.updated_by,
    conversation_id: doc.conversation_id,
    permalink: permalink(ctx, doc),
    access_level: level,
    open_comments: ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM canvas_comments WHERE doc_id = ? AND root_id IS NULL AND resolved = 0', doc.id)?.n ?? 0,
  };
  if (canWrite(level)) out.access = accessList(ctx, doc.id);
  return out;
}

export interface NewCanvas {
  owner: string;
  title: string;
  markdown?: string | null;
  /** The conversation whose tab shows it; its members can edit. */
  conversation?: string | null;
}

export function createCanvas(ctx: Ctx, hub: CanvasHub, input: NewCanvas): DocRow {
  const id = newId('F');
  const now = nowSeconds();
  ctx.db.tx(() => {
    ctx.db.run(
      'INSERT INTO docs (id, kind, title, owner, conversation_id, created, updated, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      'canvas',
      input.title.trim().slice(0, 255) || 'Untitled',
      input.owner,
      input.conversation ?? null,
      now,
      now,
      input.owner,
    );
    if (input.conversation) grant(ctx, id, input.conversation, 'write');
  });
  if (input.markdown) {
    const blocks = markdownToY(input.markdown, labelsFor(ctx));
    hub.edit(id, input.owner, (fragment) => fragment.insert(0, blocks));
  } else {
    reindex(ctx, id);
  }
  const doc = getDoc(ctx, id, 'canvas')!;
  emitDocChanged(ctx, doc, 'created');
  return doc;
}

/** The conversation a canvas or list is created in must be one the caller belongs to (or, for bots, any public channel). */
export function hostConversation(ctx: Ctx, actor: Actor, channel: string | undefined): string | null {
  if (!channel) return null;
  const conv = resolveConv(ctx, actor, channel);
  if (!getMember(ctx, conv.id, actor.userId) && !(actor.isBot && conv.kind === 'public')) fail('not_in_channel');
  if (conv.is_archived === 1) fail('is_archived');
  return conv.id;
}

function setAccess(ctx: Ctx, doc: DocRow, actor: Actor, args: { channelIds: string[]; userIds: string[]; level: 'read' | 'write' | null }): Record<string, unknown> {
  if (args.channelIds.length && args.userIds.length) fail('invalid_arguments', { detail: 'channel_ids and user_ids cannot be combined' });
  if (!args.channelIds.length && !args.userIds.length) fail('invalid_arguments', { needed: 'channel_ids or user_ids' });
  const failedChannels: string[] = [];
  const failedUsers: string[] = [];
  for (const channel of args.channelIds) {
    const conv = getConv(ctx, channel);
    // Sharing into a conversation needs the caller to be able to post there.
    if (!conv || conv.kind === 'im' || (!getMember(ctx, conv.id, actor.userId) && !(actor.isBot && conv.kind === 'public'))) {
      failedChannels.push(channel);
      continue;
    }
    if (args.level) grant(ctx, doc.id, conv.id, args.level);
    else revoke(ctx, doc.id, conv.id);
  }
  for (const userId of args.userIds) {
    const user = getUser(ctx, userId);
    if (!user || user.deleted === 1 || userId === doc.owner) {
      failedUsers.push(userId);
      continue;
    }
    if (args.level) grant(ctx, doc.id, userId, args.level);
    else revoke(ctx, doc.id, userId);
  }
  const out: Record<string, unknown> = {};
  if (failedChannels.length) out.failed_to_update_channel_ids = failedChannels;
  if (failedUsers.length) out.failed_to_update_user_ids = failedUsers;
  return out;
}

interface Change {
  operation?: string;
  section_id?: string;
  document_content?: DocumentContent;
  title_content?: DocumentContent;
}

function applyChanges(ctx: Ctx, hub: CanvasHub, doc: DocRow, userId: string, changes: Change[]): void {
  const labels = labelsFor(ctx);
  // Check every change before applying any, so a bad one leaves the canvas untouched.
  const known = new Set(sections(hub.fragment(doc.id)).map((section) => section.id));
  for (const change of changes) {
    const operation = change.operation ?? '';
    if (!['insert_after', 'insert_before', 'insert_at_start', 'insert_at_end', 'replace', 'delete', 'rename'].includes(operation)) {
      fail('canvas_editing_failed', { detail: `unknown operation ${operation}` });
    }
    if (['insert_after', 'insert_before', 'delete'].includes(operation) && !change.section_id) fail('canvas_editing_failed', { detail: 'section_id is required' });
    if (change.section_id && !known.has(change.section_id)) fail('canvas_editing_failed', { detail: 'section_not_found' });
    if (operation === 'rename') readContent(change.title_content ?? null) ?? fail('canvas_editing_failed', { detail: 'title_content is required' });
    else if (operation !== 'delete') readContent(change.document_content ?? null) ?? fail('canvas_editing_failed', { detail: 'document_content is required' });
  }
  let title: string | null = null;
  hub.edit(doc.id, userId, (fragment) => {
    for (const change of changes) {
      const operation = change.operation!;
      if (operation === 'rename') {
        title = readContent(change.title_content)!.replace(/[#*_~`]/g, '').trim().slice(0, 255);
        continue;
      }
      const index = change.section_id ? sections(fragment).find((section) => section.id === change.section_id)?.index : undefined;
      if (change.section_id && index === undefined) fail('canvas_editing_failed', { detail: 'section_not_found' });
      const blocks = operation === 'delete' ? [] : markdownToY(readContent(change.document_content)!, labels);
      switch (operation) {
        case 'insert_at_start':
          fragment.insert(0, blocks);
          break;
        case 'insert_at_end':
          fragment.insert(fragment.length, blocks);
          break;
        case 'insert_before':
          fragment.insert(index!, blocks);
          break;
        case 'insert_after':
          fragment.insert(index! + 1, blocks);
          break;
        case 'replace':
          if (index === undefined) {
            fragment.delete(0, fragment.length);
            fragment.insert(0, blocks);
          } else {
            fragment.delete(index, 1);
            fragment.insert(index, blocks);
          }
          break;
        case 'delete':
          fragment.delete(index!, 1);
          break;
      }
    }
  });
  if (title !== null) {
    ctx.db.run('UPDATE docs SET title = ?, updated = ?, updated_by = ? WHERE id = ?', title || 'Untitled', nowSeconds(), userId, doc.id);
    reindex(ctx, doc.id);
    emitDocChanged(ctx, doc, 'renamed');
  }
}

function commentToApi(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    root_id: row.root_id ?? null,
    user: row.user_id,
    text: row.text,
    quote: row.quote,
    anchor: row.anchor ? JSON.parse(String(row.anchor)) : null,
    created: row.created,
    resolved: row.resolved === 1,
    resolved_by: row.resolved_by ?? null,
  };
}

export function registerCanvases(registry: Registry, hub: CanvasHub): void {
  // ── Slack's methods ───────────────────────────────────────────────────────

  registry.add('canvases.create', { scopes: WRITE }, ({ ctx, actor, args }) => {
    const conversation = hostConversation(ctx, actor, args.str('channel_id'));
    const doc = createCanvas(ctx, hub, {
      owner: actor.userId,
      title: args.str('title') ?? 'Untitled',
      markdown: readContent(args.json('document_content')),
      conversation,
    });
    return { canvas_id: doc.id };
  });

  registry.add('conversations.canvases.create', { scopes: WRITE }, ({ ctx, actor, args }) => {
    const conversation = hostConversation(ctx, actor, args.req('channel_id', 'channel_not_found'))!;
    const existing = ctx.db.get<{ id: string }>("SELECT id FROM docs WHERE kind = 'canvas' AND conversation_id = ? AND deleted = 0 AND extra LIKE '%\"channel_canvas\":true%'", conversation);
    if (existing) fail('channel_canvas_already_exists');
    const conv = getConv(ctx, conversation)!;
    const doc = createCanvas(ctx, hub, {
      owner: actor.userId,
      title: args.str('title') ?? (conv.name ? `#${conv.name}` : 'Canvas'),
      markdown: readContent(args.json('document_content')),
      conversation,
    });
    ctx.db.run('UPDATE docs SET extra = ? WHERE id = ?', JSON.stringify({ channel_canvas: true }), doc.id);
    return { canvas_id: doc.id };
  });

  registry.add('canvases.edit', { scopes: WRITE }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('canvas_id', 'canvas_not_found'), 'canvas', actor.userId, 'write');
    const changes = args.json<Change[]>('changes');
    if (!Array.isArray(changes) || changes.length === 0) fail('invalid_arguments', { needed: 'changes' });
    applyChanges(ctx, hub, doc, actor.userId, changes);
  });

  registry.add('canvases.delete', { scopes: WRITE }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('canvas_id', 'canvas_not_found'), 'canvas', actor.userId, 'owner');
    ctx.db.run('UPDATE docs SET deleted = 1, updated = ? WHERE id = ?', nowSeconds(), doc.id);
    reindex(ctx, doc.id);
    emitDocChanged(ctx, doc, 'deleted');
    hub.drop(doc.id);
  });

  registry.add('canvases.access.set', { scopes: WRITE }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('canvas_id', 'canvas_not_found'), 'canvas', actor.userId, 'owner');
    const level = args.req('access_level');
    if (level !== 'read' && level !== 'write') fail('invalid_arguments', { needed: 'access_level' });
    const result = setAccess(ctx, doc, actor, { channelIds: args.list('channel_ids'), userIds: args.list('user_ids'), level });
    emitDocChanged(ctx, doc, 'access');
    return result;
  });

  registry.add('canvases.access.delete', { scopes: WRITE }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('canvas_id', 'canvas_not_found'), 'canvas', actor.userId, 'owner');
    const before = accessList(ctx, doc.id);
    const result = setAccess(ctx, doc, actor, { channelIds: args.list('channel_ids'), userIds: args.list('user_ids'), level: null });
    // People who lost access hear about it, and their open copies close.
    ctx.bus.emit({
      event: { type: 'doc_changed', kind: 'canvas', id: doc.id, change: 'access' },
      audience: { users: before.filter((row) => /^[UW]/.test(row.principal)).map((row) => row.principal) },
      clientOnly: true,
    });
    emitDocChanged(ctx, doc, 'access');
    hub.recheck(doc.id);
    return result;
  });

  registry.add('canvases.sections.lookup', { scopes: READ }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('canvas_id', 'canvas_not_found'), 'canvas', actor.userId);
    const criteria = args.json<{ section_types?: string[]; contains_text?: string }>('criteria');
    if (!criteria || (!criteria.section_types?.length && !criteria.contains_text)) fail('invalid_arguments', { needed: 'criteria' });
    const types = new Set(criteria.section_types ?? []);
    const text = criteria.contains_text?.toLowerCase();
    const matches = sections(hub.fragment(doc.id)).filter((section) => {
      if (types.size) {
        const header = section.kind !== 'other';
        if (!(types.has(section.kind) || (types.has('any_header') && header))) return false;
      }
      return !text || section.text.toLowerCase().includes(text);
    });
    return { sections: matches.map((section) => ({ id: section.id })) };
  });

  registry.add('canvases.getContent', { scopes: READ }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('canvas_id', 'canvas_not_found'), 'canvas', actor.userId);
    const type = args.str('content_type') ?? 'markdown';
    if (type !== 'markdown' && type !== 'html') fail('invalid_arguments', { detail: 'content_type is markdown or html' });
    const fragment = hub.fragment(doc.id);
    return { content: type === 'html' ? fragmentToHtml(fragment) : fragmentToMarkdown(fragment) };
  });

  // ── First-party additions ─────────────────────────────────────────────────

  registry.add('client.canvases.info', { auth: 'session' }, ({ ctx, actor, args }) => {
    const { doc, level } = requireDoc(ctx, args.req('canvas_id', 'canvas_not_found'), 'canvas', actor.userId);
    return { canvas: canvasToApi(ctx, doc, level), viewers: hub.viewers(doc.id) };
  });

  registry.add('client.canvases.rename', { auth: 'session' }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('canvas_id', 'canvas_not_found'), 'canvas', actor.userId, 'write');
    const title = args.req('title').trim().slice(0, 255) || 'Untitled';
    ctx.db.run('UPDATE docs SET title = ?, updated = ?, updated_by = ? WHERE id = ?', title, nowSeconds(), actor.userId, doc.id);
    reindex(ctx, doc.id);
    emitDocChanged(ctx, doc, 'renamed');
  });

  registry.add('client.canvases.versions.list', { auth: 'session' }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('canvas_id', 'canvas_not_found'), 'canvas', actor.userId);
    const rows = ctx.db.all<{ id: string; title: string; created: number; created_by: string; label: string }>(
      'SELECT id, title, created, created_by, label FROM canvas_versions WHERE doc_id = ? ORDER BY created DESC, rowid DESC LIMIT 100',
      doc.id,
    );
    return { versions: rows };
  });

  registry.add('client.canvases.versions.save', { auth: 'session' }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('canvas_id', 'canvas_not_found'), 'canvas', actor.userId, 'write');
    return { version_id: hub.saveVersion(doc.id, actor.userId, args.str('label') ?? '') };
  });

  registry.add('client.canvases.versions.get', { auth: 'session' }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('canvas_id', 'canvas_not_found'), 'canvas', actor.userId);
    const row = ctx.db.get<{ state: Uint8Array; title: string; created: number; created_by: string }>(
      'SELECT state, title, created, created_by FROM canvas_versions WHERE id = ? AND doc_id = ?',
      args.req('version_id'),
      doc.id,
    );
    if (!row) fail('version_not_found');
    const snapshot = new Y.Doc();
    Y.applyUpdate(snapshot, row.state);
    const markdown = fragmentToMarkdown(snapshot.getXmlFragment(FIELD));
    snapshot.destroy();
    // `state` is the Yjs update itself, so the client can show the version exactly as it was.
    return { version: { title: row.title, created: row.created, created_by: row.created_by, markdown, state: Buffer.from(row.state).toString('base64') } };
  });

  registry.add('client.canvases.versions.restore', { auth: 'session' }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('canvas_id', 'canvas_not_found'), 'canvas', actor.userId, 'write');
    const row = ctx.db.get<{ state: Uint8Array; title: string }>('SELECT state, title FROM canvas_versions WHERE id = ? AND doc_id = ?', args.req('version_id'), doc.id);
    if (!row) fail('version_not_found');
    // Keep what is there now, so a restore can itself be undone.
    hub.saveVersion(doc.id, actor.userId, 'Before restore');
    const snapshot = new Y.Doc();
    Y.applyUpdate(snapshot, row.state);
    const copies = snapshot
      .getXmlFragment(FIELD)
      .toArray()
      .map((node) => node.clone() as Y.XmlElement | Y.XmlText);
    hub.edit(doc.id, actor.userId, (fragment) => {
      fragment.delete(0, fragment.length);
      fragment.insert(0, copies);
    });
    snapshot.destroy();
    if (row.title && row.title !== doc.title) {
      ctx.db.run('UPDATE docs SET title = ? WHERE id = ?', row.title, doc.id);
      reindex(ctx, doc.id);
      emitDocChanged(ctx, doc, 'renamed');
    }
  });

  registry.add('client.canvases.comments.list', { auth: 'session' }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('canvas_id', 'canvas_not_found'), 'canvas', actor.userId);
    const rows = ctx.db.all<Record<string, unknown>>('SELECT * FROM canvas_comments WHERE doc_id = ? ORDER BY created, rowid', doc.id);
    return { comments: rows.map(commentToApi) };
  });

  registry.add('client.canvases.comments.add', { auth: 'session' }, ({ ctx, actor, args }) => {
    // Anyone who can read the canvas can comment on it, unless a module says otherwise.
    const { doc, level } = requireDoc(ctx, args.req('canvas_id', 'canvas_not_found'), 'canvas', actor.userId);
    for (const guard of commentGuards) guard(ctx, doc, level, actor.userId);
    const text = args.req('text').trim().slice(0, 4000);
    if (!text) fail('no_text');
    let rootId: string | null = null;
    if (args.has('root_id')) {
      const root = ctx.db.get<{ id: string; root_id: string | null }>('SELECT id, root_id FROM canvas_comments WHERE id = ? AND doc_id = ?', args.req('root_id'), doc.id);
      if (!root) fail('comment_not_found');
      rootId = root.root_id ?? root.id;
    }
    const anchor = args.json<unknown>('anchor');
    const id = newId('Cm');
    ctx.db.run(
      'INSERT INTO canvas_comments (id, doc_id, root_id, user_id, text, quote, anchor, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      doc.id,
      rootId,
      actor.userId,
      text,
      (args.str('quote') ?? '').slice(0, 500),
      anchor === undefined ? null : JSON.stringify(anchor).slice(0, 4000),
      nowSeconds(),
    );
    emitDocChanged(ctx, doc, 'comments');
    return { comment: commentToApi(ctx.db.get<Record<string, unknown>>('SELECT * FROM canvas_comments WHERE id = ?', id)!) };
  });

  registry.add('client.canvases.comments.resolve', { auth: 'session' }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('canvas_id', 'canvas_not_found'), 'canvas', actor.userId);
    const comment = ctx.db.get<{ id: string; root_id: string | null; user_id: string }>('SELECT id, root_id, user_id FROM canvas_comments WHERE id = ? AND doc_id = ?', args.req('comment_id'), doc.id);
    if (!comment || comment.root_id) fail('comment_not_found');
    // The person who started the thread, or anyone who can edit, may resolve it.
    if (comment.user_id !== actor.userId && !canWrite(accessOf(ctx, doc, actor.userId))) fail('access_denied');
    const resolved = args.bool('resolved', true);
    ctx.db.run('UPDATE canvas_comments SET resolved = ?, resolved_by = ? WHERE id = ?', resolved ? 1 : 0, resolved ? actor.userId : null, comment.id);
    emitDocChanged(ctx, doc, 'comments');
  });

  registry.add('client.canvases.comments.delete', { auth: 'session' }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('canvas_id', 'canvas_not_found'), 'canvas', actor.userId);
    const comment = ctx.db.get<{ id: string; user_id: string }>('SELECT id, user_id FROM canvas_comments WHERE id = ? AND doc_id = ?', args.req('comment_id'), doc.id);
    if (!comment) fail('comment_not_found');
    if (comment.user_id !== actor.userId && accessOf(ctx, doc, actor.userId) !== 'owner') fail('access_denied');
    ctx.db.run('DELETE FROM canvas_comments WHERE id = ? OR root_id = ?', comment.id, comment.id);
    emitDocChanged(ctx, doc, 'comments');
  });
}
