import { isIP } from 'node:net';
import type { Block } from '@app/shared';
import * as Y from 'yjs';
import type { Kernel } from '../app.ts';
import { getMember, type ConvRow } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import type { Actor, Ctx } from '../ctx.ts';
import { accessOf, canWrite, emitDocChanged, getDoc, grant, type DocRow, type Level } from '../docs/access.ts';
import { commentGuards, labelsFor, MAX_MARKDOWN } from '../docs/canvases.ts';
import type { CanvasHub } from '../docs/hub.ts';
import { blockToMarkdown, FIELD, fragmentToMarkdown, markdownToY } from '../docs/markdown.ts';
import { announceChannel, callingAgent, codeChannel, isChannelAgent, parseJson, viewToProperty, viewsOf, type ViewRow } from './agent-state.ts';
import { getApp, type AppRow } from './apps.ts';
import { assignIds, locate, sanitizeState, type Json } from './elements.ts';
import { buildAction, deliverInteractive, payloadChannelName, payloadUser } from './interactivity.ts';
import { platformServices } from './local-apps.ts';
import { isPrivateAddress } from './net.ts';
import { readOptions } from './views.ts';

/**
 * View tabs of a code channel (`agents.conversations.setView`, `listViews`,
 * `removeView`) and the canvases an agent keeps there (`getCanvas`,
 * `setCanvasContent`). A view is HTML (shown in a sandboxed frame), a unified
 * diff (one per channel), Block Kit (interactions go to the agent), a canvas
 * (with the access level the agent chose) or a pull request link. At most five
 * per channel; each agent owns its own.
 */

const TYPES = ['html', 'diff', 'block_kit', 'canvas', 'pull_request'] as const;
type ViewType = (typeof TYPES)[number];
const MAX_VIEWS = 5;
const MAX_CONTENT_BYTES = 1_000_000;
const MAX_VIEW_BLOCKS = 100;
const MAX_SECTIONS = 1000;
const MAX_CSP_DOMAINS = 20;
const ACCESS_LEVELS = ['read', 'write', 'comment'] as const;
/** Host names that never point at the public internet. */
const INTERNAL_HOST = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa|test|invalid)$/;

interface ViewOptions {
  csp?: { resource_domains: string[]; connect_domains: string[] };
  base_branch?: string;
  head_branch?: string;
  access_level?: (typeof ACCESS_LEVELS)[number];
  agent_content_hash?: string;
}

/** One `csp` origin: https only, a public host (optionally `*.` for its subdomains). */
function cspOrigin(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 255) fail('invalid_csp_domain');
  const input = value.trim();
  let url: URL;
  try {
    url = new URL(input.includes('://') ? input : `https://${input}`);
  } catch {
    fail('invalid_csp_domain', { detail: input });
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('invalid_csp_domain', { detail: input });
  const host = url.hostname.toLowerCase();
  const bare = host.startsWith('*.') ? host.slice(2) : host;
  const literal = bare.replace(/^\[|\]$/g, '');
  if (isIP(literal)) {
    if (host !== bare || isPrivateAddress(literal)) fail('invalid_csp_domain', { detail: input });
  } else if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(bare) || INTERNAL_HOST.test(bare)) {
    fail('invalid_csp_domain', { detail: input });
  }
  return `https://${host}${url.port ? `:${url.port}` : ''}`;
}

function readCsp(value: unknown): ViewOptions['csp'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_csp_domain');
  const csp = value as Json;
  const list = (key: string): string[] => {
    const entries = csp[key];
    if (entries === undefined) return [];
    if (!Array.isArray(entries) || entries.length > MAX_CSP_DOMAINS) fail('invalid_csp_domain', { detail: key });
    return [...new Set(entries.map(cspOrigin))];
  };
  return { resource_domains: list('resource_domains'), connect_domains: list('connect_domains') };
}

/** The tab label when the agent gives none: the last part of `view_key`, without `.html`. */
function defaultName(viewKey: string): string {
  const last = viewKey.split('/').filter(Boolean).pop() ?? viewKey;
  return last.replace(/\.html?$/i, '') || viewKey;
}

/** Positions in `a` and `b` of a longest common subsequence of equal strings. */
function matches(a: string[], b: string[]): [number, number][] {
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i += 1;
    else j += 1;
  }
  return pairs;
}

function topLevel(fragment: Y.XmlFragment): Y.XmlElement[] {
  return fragment.toArray().filter((node): node is Y.XmlElement => node instanceof Y.XmlElement);
}

/** A Slack-shaped `ts` for a comment, from its time and row. */
function commentTs(created: number, rowid: number): string {
  return `${created}.${String(rowid % 1_000_000).padStart(6, '0')}`;
}

/** Comments on a canvas that only lets channel members read are refused (`access_level: read`). */
function readOnlyCanvasViews(ctx: Ctx, doc: DocRow, level: Level, userId: string): void {
  if (canWrite(level)) return;
  const views = ctx.db.all<{ conversation_id: string; options: string }>("SELECT conversation_id, options FROM agent_views WHERE canvas_id = ? AND type = 'canvas'", doc.id);
  if (!views.length) return;
  const reachable = views.filter((view) => getMember(ctx, view.conversation_id, userId));
  const levels = (reachable.length ? reachable : views).map((view) => parseJson<ViewOptions>(view.options, {}).access_level ?? 'write');
  if (levels.every((value) => value === 'read')) fail('access_denied');
}

/** A view as the web client draws it: what `listViews` says plus its content. */
function viewDetail(ctx: Ctx, row: ViewRow): Json {
  const options = parseJson<ViewOptions>(row.options, {});
  const app = getApp(ctx, row.app_id);
  const out: Json = { ...viewToProperty(row), app_id: row.app_id, bot_user_id: app?.bot_user_id ?? null };
  if (row.type === 'html' || row.type === 'diff') out.content = row.body;
  if (row.type === 'block_kit') out.blocks = parseJson<Block[]>(row.body, []);
  if (row.type === 'pull_request') out.pr_url = row.body;
  if (row.type === 'canvas') out.access_level = options.access_level ?? 'write';
  if (row.type === 'diff') {
    if (options.base_branch) out.base_branch = options.base_branch;
    if (options.head_branch) out.head_branch = options.head_branch;
  }
  if (row.type === 'html') out.csp = { resource_domains: options.csp?.resource_domains ?? [] };
  return out;
}

export function installCodeViews(kernel: Kernel, hub: CanvasHub): void {
  const { ctx, registry } = kernel;
  if (!commentGuards.includes(readOnlyCanvasViews)) commentGuards.push(readOnlyCanvasViews);

  /** The caller as an agent of the channel, or (`members: true`) any bot in it. */
  const agentIn = (actor: Actor, channel: string | undefined, members = false): { app: AppRow; conv: ConvRow } => {
    const app = callingAgent(ctx, actor);
    const { conv } = codeChannel(ctx, actor, channel);
    if (!isChannelAgent(ctx, conv.id, app.id) && !(members && getMember(ctx, conv.id, actor.userId))) fail('not_authorized');
    return { app, conv };
  };

  /** A canvas the calling agent can open; anything else does not exist for it. */
  const canvasFor = (actor: Actor, canvasId: string | undefined): { doc: DocRow; level: Level } => {
    const doc = getDoc(ctx, canvasId, 'canvas');
    const level = doc ? accessOf(ctx, doc, actor.userId) : null;
    if (!doc || !level) fail('canvas_not_found');
    return { doc, level };
  };

  const findView = (conv: ConvRow, viewId: string): ViewRow =>
    ctx.db.get<ViewRow>('SELECT * FROM agent_views WHERE id = ? AND conversation_id = ?', viewId, conv.id) ?? fail('view_not_found');

  // ── Views ─────────────────────────────────────────────────────────────────

  registry.add('agents.conversations.listViews', { scopes: ['code_channels:manage'] }, ({ actor, args }) => {
    const { conv } = agentIn(actor, args.req('channel_id', 'channel_not_found'), true);
    return {
      views: viewsOf(ctx, conv.id).map((row) => {
        const view: Json = { view_id: row.id, type: row.type, file_id: row.file_id, label: row.name, content_version: row.content_version, date_added: row.created };
        if (row.type !== 'diff') view.view_key = row.view_key;
        if (row.canvas_id) view.canvas_id = row.canvas_id;
        return view;
      }),
    };
  });

  registry.add('agents.conversations.setView', { scopes: ['code_channels:manage'] }, ({ actor, args }) => {
    const { app, conv } = agentIn(actor, args.req('channel_id', 'channel_not_found'), true);
    if (conv.is_archived === 1) fail('is_archived');
    const type = (args.str('type') || 'html') as ViewType;
    if (!TYPES.includes(type)) fail('invalid_view_type');
    // A diff is the channel's one diff; every other view is keyed by the agent.
    const viewKey = type === 'diff' ? '' : (args.str('view_key')?.trim().slice(0, 1000) ?? '');
    if (type !== 'diff' && !viewKey) fail('missing_required_arg', { needed: 'view_key' });

    const options: ViewOptions = {};
    let body = '';
    let canvas: DocRow | null = null;
    if (type === 'html' || type === 'diff') {
      const content = args.str('content') ?? '';
      if (!content) fail('missing_required_arg', { needed: 'content' });
      if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) fail('content_too_large');
      body = content;
    }
    if (type === 'html') {
      const csp = readCsp(args.json<unknown>('csp'));
      if (csp) options.csp = csp;
    }
    if (type === 'diff') {
      const base = args.str('base_branch')?.trim().slice(0, 255);
      const head = args.str('head_branch')?.trim().slice(0, 255);
      if (base) options.base_branch = base;
      if (head) options.head_branch = head;
    }
    if (type === 'block_kit') {
      const blocks = args.json<unknown>('blocks');
      if (blocks === undefined) fail('missing_required_arg', { needed: 'blocks' });
      if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > MAX_VIEW_BLOCKS) fail('invalid_blocks');
      if (blocks.some((block) => !block || typeof block !== 'object' || typeof (block as Json).type !== 'string')) fail('invalid_blocks');
      body = JSON.stringify(assignIds(blocks as Block[]));
      if (Buffer.byteLength(body, 'utf8') > MAX_CONTENT_BYTES) fail('content_too_large');
    }
    if (type === 'canvas') {
      if (!args.has('canvas_id')) fail('missing_required_arg', { needed: 'canvas_id' });
      canvas = canvasFor(actor, args.req('canvas_id')).doc;
      const level = args.str('access_level') || 'write';
      if (!(ACCESS_LEVELS as readonly string[]).includes(level)) fail('invalid_arguments', { needed: 'access_level' });
      options.access_level = level as ViewOptions['access_level'];
      const hash = args.str('agent_content_hash');
      if (hash) options.agent_content_hash = hash.slice(0, 255);
    }
    if (type === 'pull_request') {
      const url = args.str('pr_url')?.trim() ?? '';
      if (!url) fail('missing_required_arg', { needed: 'pr_url' });
      if (!/^https?:\/\/\S+$/i.test(url) || url.length > 2048) fail('invalid_arguments', { needed: 'pr_url' });
      body = url;
    }
    const name = (type === 'diff' ? 'Diff' : (args.str('name') || args.str('label') || defaultName(viewKey))).trim().slice(0, 80) || defaultName(viewKey);

    const existing = ctx.db.get<ViewRow>('SELECT * FROM agent_views WHERE conversation_id = ? AND view_key = ?', conv.id, viewKey);
    if (existing && existing.app_id !== app.id) fail('not_view_owner');
    if (!existing && viewsOf(ctx, conv.id).length >= MAX_VIEWS) fail('too_many_views');
    const now = nowSeconds();
    let id: string;
    if (existing) {
      id = existing.id;
      ctx.db.run(
        'UPDATE agent_views SET type = ?, name = ?, file_id = ?, canvas_id = ?, body = ?, options = ?, content_version = content_version + 1, updated = ? WHERE id = ?',
        type,
        name,
        canvas ? canvas.id : existing.canvas_id && existing.file_id === existing.canvas_id ? newId('F') : existing.file_id,
        canvas?.id ?? null,
        body,
        JSON.stringify(options),
        now,
        id,
      );
    } else {
      id = newId('Ct');
      ctx.db.run(
        'INSERT INTO agent_views (id, conversation_id, app_id, type, view_key, name, file_id, canvas_id, body, options, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        conv.id,
        app.id,
        type,
        viewKey,
        name,
        canvas ? canvas.id : newId('F'),
        canvas?.id ?? null,
        body,
        JSON.stringify(options),
        now,
        now,
      );
    }
    // The channel's members open the canvas at the level the agent chose: reading or commenting leaves the agent the only author.
    if (canvas && accessOf(ctx, canvas, actor.userId) === 'owner') {
      grant(ctx, canvas.id, conv.id, options.access_level === 'write' ? 'write' : 'read');
      emitDocChanged(ctx, canvas, 'access');
      hub.recheck(canvas.id);
    }
    announceChannel(ctx, conv.id);
    const row = findView(conv, id);
    return { channel_id: conv.id, view_id: row.id, file_id: row.file_id, ...(row.canvas_id ? { canvas_id: row.canvas_id } : {}), content_version: row.content_version, type: row.type };
  });

  registry.add('agents.conversations.removeView', { scopes: ['code_channels:manage'] }, ({ actor, args }) => {
    const { app, conv } = agentIn(actor, args.req('channel_id', 'channel_not_found'), true);
    const byKey = args.str('view_key');
    const byId = args.str('view_id');
    if (Boolean(byKey) === Boolean(byId)) fail('invalid_arguments', { detail: 'exactly one of view_key or view_id' });
    const row = byId
      ? ctx.db.get<ViewRow>('SELECT * FROM agent_views WHERE id = ? AND conversation_id = ?', byId, conv.id)
      : ctx.db.get<ViewRow>("SELECT * FROM agent_views WHERE conversation_id = ? AND view_key = ? AND type != 'diff'", conv.id, byKey!);
    if (!row) fail('view_not_found');
    if (row.app_id !== app.id) fail('not_view_owner');
    ctx.db.run('DELETE FROM agent_views WHERE id = ?', row.id);
    announceChannel(ctx, conv.id);
    return { channel_id: conv.id, view_id: row.id };
  });

  // ── Canvases ──────────────────────────────────────────────────────────────

  registry.add('agents.conversations.getCanvas', { scopes: ['code_channels:manage'] }, ({ actor, args }) => {
    agentIn(actor, args.req('channel', 'channel_not_found'));
    const { doc } = canvasFor(actor, args.req('canvas_id', 'canvas_not_found'));
    const format = args.str('content_format') || 'markdown';
    if (format !== 'markdown') fail('invalid_arguments', { needed: 'content_format' });
    const resolved = args.bool('include_resolved');
    type CommentRow = { rowid: number; id: string; user_id: string; text: string; quote: string; created: number; resolved: number };
    const roots = ctx.db.all<CommentRow>(
      `SELECT rowid, * FROM canvas_comments WHERE doc_id = ? AND root_id IS NULL ${resolved ? '' : 'AND resolved = 0'} ORDER BY created DESC, rowid DESC LIMIT 101`,
      doc.id,
    );
    const threads = roots.slice(0, 100).reverse();
    return {
      canvas_id: doc.id,
      title: doc.title,
      content: fragmentToMarkdown(hub.fragment(doc.id)),
      comments: threads.map((root) => {
        const replies = ctx.db.all<CommentRow>('SELECT rowid, * FROM canvas_comments WHERE root_id = ? ORDER BY created DESC, rowid DESC LIMIT 101', root.id);
        return {
          id: root.id,
          ts: commentTs(root.created, root.rowid),
          user_id: root.user_id,
          text: root.text,
          quoted_text: root.quote,
          is_resolved: root.resolved === 1,
          replies: replies
            .slice(0, 100)
            .reverse()
            .map((reply) => ({ ts: commentTs(reply.created, reply.rowid), user_id: reply.user_id, text: reply.text })),
          has_more_replies: replies.length > 100,
        };
      }),
      has_more_comments: roots.length > 100,
    };
  });

  /**
   * Replace a canvas with Markdown, touching only the sections that differ:
   * unchanged blocks stay the same objects, so what people wrote beside them
   * (comments, cursors) stays where it was. The same content is no change at all.
   */
  registry.add('agents.conversations.setCanvasContent', { scopes: ['code_channels:manage'] }, ({ actor, args }) => {
    agentIn(actor, args.req('channel', 'channel_not_found'));
    const { doc, level } = canvasFor(actor, args.req('canvas_id', 'canvas_not_found'));
    if (!canWrite(level)) fail('not_authorized');
    const content = args.str('content');
    if (content === undefined) fail('invalid_arguments', { needed: 'content' });
    if (content.length > MAX_MARKDOWN) fail('content_too_large');

    const scratch = new Y.Doc();
    const incoming = scratch.getXmlFragment(FIELD);
    incoming.insert(0, markdownToY(content, labelsFor(ctx)));
    const wanted = topLevel(incoming);
    const current = topLevel(hub.fragment(doc.id));
    if (wanted.length > MAX_SECTIONS || current.length > MAX_SECTIONS) {
      scratch.destroy();
      fail('too_many_sections');
    }
    const before = current.map(blockToMarkdown);
    const after = wanted.map(blockToMarkdown);
    const kept = matches(before, after);
    // Runs between kept blocks, last first so earlier positions stay valid.
    const bounds: [number, number][] = [[-1, -1], ...kept, [before.length, after.length]];
    const edits: { at: number; remove: number; insert: Y.XmlElement[] }[] = [];
    for (let k = bounds.length - 1; k > 0; k -= 1) {
      const [oldEnd, newEnd] = bounds[k]!;
      const [oldStart, newStart] = bounds[k - 1]!;
      const remove = oldEnd - oldStart - 1;
      const insert = wanted.slice(newStart + 1, newEnd).map((block) => block.clone() as Y.XmlElement);
      if (remove || insert.length) edits.push({ at: oldStart + 1, remove, insert });
    }
    scratch.destroy();
    const changed = edits.reduce((sum, edit) => sum + Math.max(edit.remove, edit.insert.length), 0);
    if (changed > 0) {
      hub.edit(doc.id, actor.userId, (fragment) => {
        // Positions count top-level elements; the fragment holds only those.
        for (const edit of edits) {
          if (edit.remove) fragment.delete(edit.at, edit.remove);
          if (edit.insert.length) fragment.insert(edit.at, edit.insert);
        }
      });
    }
    return { canvas_id: doc.id, sections_changed_count: changed };
  });

  // ── What people see and do ────────────────────────────────────────────────

  /** One view with its content, for someone who can see the channel. */
  registry.add('client.codeChannels.view', { auth: 'session' }, ({ actor, args }) => {
    const { conv } = codeChannel(ctx, actor, args.req('channel', 'channel_not_found'));
    return { view: viewDetail(ctx, findView(conv, args.req('view_id', 'view_not_found'))) };
  });

  /** A person used an element of a Block Kit view: `block_actions` to the agent that owns the view. */
  registry.add('client.codeChannels.blockAction', { auth: 'session' }, async ({ actor, args }) => {
    const { conv } = codeChannel(ctx, actor, args.req('channel', 'channel_not_found'));
    if (!getMember(ctx, conv.id, actor.userId)) fail('not_in_channel');
    const row = findView(conv, args.req('view_id', 'view_not_found'));
    if (row.type !== 'block_kit') fail('view_not_found');
    const app = getApp(ctx, row.app_id) ?? fail('app_not_found');
    const blocks = parseJson<Block[]>(row.body, []);
    const input = args.json<Json>('action');
    if (!input || typeof input !== 'object' || typeof input.action_id !== 'string') fail('invalid_arguments', { needed: 'action' });
    const located = locate(blocks, input.action_id, typeof input.block_id === 'string' ? input.block_id : undefined) ?? fail('action_not_found');
    const sent = args.json<Json>('state');
    const { interactivity } = platformServices(ctx);
    const team = ctx.requireTeam();
    const payload: Json = {
      type: 'block_actions',
      user: payloadUser(ctx, actor.userId),
      api_app_id: app.id,
      token: app.verification_token,
      container: { type: 'view', view_id: row.id, channel_id: conv.id },
      trigger_id: interactivity.triggers.issue(app.id, actor.userId, conv.id),
      team: { id: team.id, domain: team.domain },
      enterprise: null,
      is_enterprise_install: false,
      channel: { id: conv.id, name: payloadChannelName(conv) },
      state: { values: sanitizeState(blocks, sent && typeof sent === 'object' ? sent.values : undefined) },
      response_url: interactivity.hooks.create({ app, kind: 'actions', conversationId: conv.id, userId: actor.userId }),
      actions: [buildAction(located, input, ctx.clock.eventTs())],
    };
    await deliverInteractive(interactivity, app, 'interactive', payload, app.interactivity_url);
    return {};
  });

  /** Options for an `external_select` in a Block Kit view: `block_suggestion` to its agent. */
  registry.add('client.codeChannels.suggest', { auth: 'session' }, async ({ actor, args }) => {
    const { conv } = codeChannel(ctx, actor, args.req('channel', 'channel_not_found'));
    const row = findView(conv, args.req('view_id', 'view_not_found'));
    if (row.type !== 'block_kit') fail('view_not_found');
    const app = getApp(ctx, row.app_id) ?? fail('app_not_found');
    const located = locate(parseJson<Block[]>(row.body, []), args.req('action_id'), args.str('block_id'));
    if (!located || !String(located.element.type).includes('external_select')) fail('action_not_found');
    const { interactivity } = platformServices(ctx);
    const team = ctx.requireTeam();
    const payload: Json = {
      type: 'block_suggestion',
      user: payloadUser(ctx, actor.userId),
      container: { type: 'view', view_id: row.id, channel_id: conv.id },
      api_app_id: app.id,
      token: app.verification_token,
      action_id: located.element.action_id,
      block_id: located.blockId,
      value: (args.str('value') ?? '').slice(0, 1000),
      team: { id: team.id, domain: team.domain },
      channel: { id: conv.id, name: payloadChannelName(conv) },
      enterprise: null,
      is_enterprise_install: false,
    };
    return readOptions(await deliverInteractive(interactivity, app, 'interactive', payload, app.interactivity_url));
  });
}
