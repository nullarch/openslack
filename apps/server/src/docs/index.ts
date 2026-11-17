import type { Kernel } from '../app.ts';
import { activityResolvers } from '../attention/activity.ts';
import { fail } from '../core/errors.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import { isAdmin } from '../core/users.ts';
import type { Ctx } from '../ctx.ts';
import { accessOf, emitDocChanged, getDoc, permalink, requireDoc, visibleDocs, type DocKind, type DocRow } from './access.ts';
import { canvasToApi, createCanvas, hostConversation, registerCanvases } from './canvases.ts';
import { CanvasHub } from './hub.ts';
import { createList, itemTitle, listExtra, listToApi, registerLists } from './lists.ts';
import { fragmentToMarkdown } from './markdown.ts';
import { getTemplate, listTemplates, type CanvasBody, type ListBody } from './templates.ts';

export { createListItem } from './lists.ts';

/**
 * Canvases (collaborative documents) and lists (structured trackers). Both are
 * "docs": one table, one access model, one search index. See `access.ts` for
 * who may open what, `hub.ts` for live editing, and the Slack-shaped methods
 * in `canvases.ts` and `lists.ts`.
 */
export function installDocs(kernel: Kernel): CanvasHub {
  const { ctx, registry } = kernel;
  const hub = new CanvasHub(ctx);
  hub.install(kernel);
  registerCanvases(registry, hub);
  registerLists(kernel);

  const kindArg = (value: string | undefined): DocKind | undefined => {
    if (value === undefined || value === '') return undefined;
    if (value !== 'canvas' && value !== 'list') fail('invalid_arguments', { needed: 'kind' });
    return value;
  };

  const summary = (doc: DocRow & { level?: string }, userId: string): Record<string, unknown> => ({
    id: doc.id,
    kind: doc.kind,
    title: doc.title,
    owner: doc.owner,
    conversation_id: doc.conversation_id,
    updated: doc.updated,
    updated_by: doc.updated_by,
    access_level: doc.level ?? accessOf(ctx, doc, userId),
    snippet: doc.plain.slice(0, 160),
    permalink: permalink(ctx, doc),
  });

  /** Canvases and lists the caller can open: all of them, or those that are tabs of one conversation. */
  registry.add('client.docs.list', { auth: 'session' }, ({ ctx: c, actor, args }) => {
    const kind = kindArg(args.str('kind'));
    const channel = args.str('channel');
    let docs = visibleDocs(c, actor.userId, kind);
    if (channel) docs = docs.filter((doc) => doc.conversation_id === channel);
    return { docs: docs.map((doc) => summary(doc, actor.userId)) };
  });

  /** A new canvas or list, empty or from a template, optionally as a tab of a conversation. */
  registry.add('client.docs.create', { auth: 'session' }, ({ ctx: c, actor, args }) => {
    const kind = kindArg(args.req('kind')) as DocKind;
    const template = args.str('template_id') ? (getTemplate(c, args.req('template_id')) ?? fail('template_not_found')) : undefined;
    if (template && template.kind !== kind) fail('template_not_found');
    const conversation = hostConversation(c, actor, args.str('channel'));
    const title = args.str('title')?.trim() || template?.title || (kind === 'canvas' ? 'Untitled' : 'Untitled list');
    if (kind === 'canvas') {
      const doc = createCanvas(c, hub, { owner: actor.userId, title, markdown: (template?.body as CanvasBody | undefined)?.markdown ?? null, conversation });
      return { doc: summary(doc, actor.userId) };
    }
    const body = template?.body as ListBody | undefined;
    const doc = createList(c, {
      owner: actor.userId,
      title,
      description: body?.description,
      schema: body?.schema ?? [
        { key: 'name', name: 'Name', type: 'text' },
        { key: 'status', name: 'Status', type: 'select', options: { choices: [{ label: 'Not started' }, { label: 'In progress' }, { label: 'Done' }] } },
        { key: 'assignee', name: 'Assignee', type: 'user' },
        { key: 'due', name: 'Due', type: 'date' },
      ],
      todo: body?.todo,
      conversation,
      items: body?.items,
    });
    return { doc: summary(doc, actor.userId) };
  });

  registry.add('client.lists.delete', { auth: 'session' }, ({ ctx: c, actor, args }) => {
    const { doc } = requireDoc(c, args.req('list_id', 'list_not_found'), 'list', actor.userId, 'owner');
    c.db.run('UPDATE docs SET deleted = 1, updated = ? WHERE id = ?', nowSeconds(), doc.id);
    c.db.run('DELETE FROM docs_fts WHERE rowid = (SELECT rowid FROM docs WHERE id = ?)', doc.id);
    emitDocChanged(c, doc, 'deleted');
  });

  /**
   * Search canvas and list text. Only documents the caller can open are
   * returned; terms under three characters (short Korean words, for one) use a
   * substring scan, as message search does.
   */
  registry.add('client.docs.search', { auth: 'session' }, ({ ctx: c, actor, args }) => {
    const text = args.req('query', 'no_query').trim();
    const kind = kindArg(args.str('kind'));
    const count = args.int('count', 20, { min: 1, max: 100 });
    const terms = text.split(/\s+/).filter(Boolean).slice(0, 10);
    if (!terms.length) return { docs: [], total: 0 };
    const where = ['d.deleted = 0'];
    const params: (string | number)[] = [];
    const indexed = terms.filter((term) => [...term].length >= 3);
    const short = terms.filter((term) => [...term].length < 3);
    if (indexed.length) {
      where.push('d.rowid IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH ?)');
      params.push(indexed.map((term) => `"${term.replace(/"/g, '""')}"`).join(' AND '));
    }
    for (const term of short) {
      where.push("(d.title || ' ' || d.plain) LIKE ? ESCAPE '\\'");
      params.push(`%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
    }
    if (kind) {
      where.push('d.kind = ?');
      params.push(kind);
    }
    const rows = c.db.all<DocRow>(`SELECT d.* FROM docs d WHERE ${where.join(' AND ')} ORDER BY d.updated DESC LIMIT 1000`, ...params);
    const visible = rows.filter((row) => accessOf(c, row, actor.userId));
    const lower = terms[0]!.toLowerCase();
    return {
      total: visible.length,
      docs: visible.slice(0, count).map((doc) => {
        const at = doc.plain.toLowerCase().indexOf(lower);
        const start = Math.max(0, at - 60);
        return { ...summary(doc, actor.userId), snippet: at >= 0 ? `${start > 0 ? '…' : ''}${doc.plain.slice(start, start + 180)}` : doc.plain.slice(0, 160) };
      }),
    };
  });

  /** What a link to a canvas or list shows in a message, for someone who can open it. */
  registry.add('client.docs.card', { auth: 'session' }, ({ ctx: c, actor, args }) => {
    const doc = getDoc(c, args.req('id', 'not_found'));
    const level = doc ? accessOf(c, doc, actor.userId) : null;
    if (!doc || !level) fail('not_found');
    const card = summary(doc, actor.userId);
    if (doc.kind === 'list') {
      card.item_count = c.db.get<{ n: number }>('SELECT count(*) AS n FROM list_items WHERE doc_id = ? AND archived = 0', doc.id)?.n ?? 0;
      card.columns = listExtra(doc).schema.slice(0, 4).map((column) => column.name);
    }
    return { card };
  });

  // ── Templates ─────────────────────────────────────────────────────────────

  registry.add('client.docs.templates.list', { auth: 'session' }, ({ ctx: c, args }) => {
    const kind = kindArg(args.str('kind'));
    return {
      templates: listTemplates(c, kind).map(({ body, ...template }) => ({
        ...template,
        preview: 'markdown' in body ? body.markdown.slice(0, 400) : (body.schema as { name?: string }[]).map((column) => column.name).join(' · '),
      })),
    };
  });

  /** Save a canvas's content, or a list's columns (and optionally its items), as a template for everyone. */
  registry.add('client.docs.templates.save', { auth: 'session' }, ({ ctx: c, actor, args }) => {
    const source = getDoc(c, args.req('doc_id', 'not_found'));
    if (!source || !accessOf(c, source, actor.userId)) fail('not_found');
    const title = (args.str('title') ?? source.title).trim().slice(0, 120) || source.title;
    let body: CanvasBody | ListBody;
    if (source.kind === 'canvas') body = { markdown: fragmentToMarkdown(hub.fragment(source.id)) };
    else {
      const extra = listExtra(source);
      const schema = extra.schema.map(({ id: _id, is_primary_column: _primary, ...column }) => column);
      const items = args.bool('include_items')
        ? c.db
            .all<{ fields: string }>('SELECT fields FROM list_items WHERE doc_id = ? AND archived = 0 ORDER BY position LIMIT 500', source.id)
            .map((row) => {
              const values = JSON.parse(row.fields) as Record<string, unknown>;
              return Object.fromEntries(extra.schema.filter((column) => values[column.id] !== undefined && column.type !== 'user').map((column) => [column.key, values[column.id]]));
            })
        : undefined;
      body = { schema, items, description: extra.description, todo: extra.todo_mode };
    }
    const id = newId('TPL');
    c.db.run(
      'INSERT INTO doc_templates (id, kind, title, description, body, created_by, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      source.kind,
      title,
      (args.str('description') ?? '').slice(0, 300),
      JSON.stringify(body),
      actor.userId,
      nowSeconds(),
    );
    return { template_id: id };
  });

  registry.add('client.docs.templates.delete', { auth: 'session' }, ({ ctx: c, actor, args }) => {
    const row = c.db.get<{ created_by: string }>('SELECT created_by FROM doc_templates WHERE id = ?', args.req('template_id'));
    if (!row) fail('template_not_found');
    if (row.created_by !== actor.userId && !isAdmin(actor)) fail('access_denied');
    c.db.run('DELETE FROM doc_templates WHERE id = ?', args.req('template_id'));
  });

  // ── Activity ──────────────────────────────────────────────────────────────

  const docFor = (c: Ctx, row: { conversation_id: string }, userId: string): DocRow | null => {
    const doc = getDoc(c, row.conversation_id);
    return doc && accessOf(c, doc, userId) ? doc : null;
  };
  const docRef = (c: Ctx, row: { conversation_id: string }): Record<string, unknown> => {
    const doc = getDoc(c, row.conversation_id);
    return doc ? { doc: { id: doc.id, kind: doc.kind, title: doc.title, permalink: permalink(c, doc) } } : {};
  };
  activityResolvers.set('canvas_mention', {
    canSee: (c, row, userId) => docFor(c, row, userId) !== null,
    toApi: (c, row) => docRef(c, row),
  });
  for (const kind of ['list_assigned', 'list_due']) {
    activityResolvers.set(kind, {
      canSee: (c, row, userId) => {
        const doc = docFor(c, row, userId);
        return doc !== null && c.db.get('SELECT 1 FROM list_items WHERE id = ? AND doc_id = ?', row.ts, doc.id) !== undefined;
      },
      toApi: (c, row) => {
        const doc = getDoc(c, row.conversation_id, 'list');
        const out = docRef(c, row);
        if (doc) out.item = { id: row.ts, title: itemTitle(c, doc, row.ts) };
        if (kind === 'list_due') out.due = row.detail;
        return out;
      },
    });
  }

  return hub;
}

export { canvasToApi, listToApi };
