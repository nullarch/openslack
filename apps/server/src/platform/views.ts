import type { Block } from '@app/shared';
import type { Kernel } from '../app.ts';
import type { Actor, Ctx } from '../ctx.ts';
import { openDirect } from '../core/conversations.ts';
import { ApiError, fail } from '../core/errors.ts';
import { newHex, newId, nowSeconds } from '../core/ids.ts';
import { getUser } from '../core/users.ts';
import { getApp, requireApp, type AppRow } from './apps.ts';
import { sendToApp, type Delivery } from './dispatch.ts';
import { assignIds, locate, sanitizeState, type Json, type StateValues } from './elements.ts';
import { buildAction, deliverInteractive, payloadUser, type Interactivity } from './interactivity.ts';

/**
 * Views: modals and App Home tabs (`views.open`, `views.push`, `views.update`,
 * `views.publish`), and what happens when a person uses them: submissions,
 * closing, actions inside a view, and options for external menus.
 *
 * A person has at most one modal open, a stack of up to three views. Views are
 * stored, so a modal survives a reload and a Home tab survives a restart.
 */

interface ViewRow {
  id: string;
  app_id: string;
  user_id: string;
  type: 'modal' | 'home';
  root_view_id: string | null;
  previous_view_id: string | null;
  depth: number;
  external_id: string | null;
  hash: string;
  body: string;
  state: string;
  created: number;
  updated: number;
}

const MAX_STACK = 3;
const MAX_VIEW_BYTES = 250 * 1024;
const MAX_BLOCKS = 100;
const RESPONSE_ACTIONS = new Set(['errors', 'update', 'push', 'clear']);

function newHash(): string {
  return `${nowSeconds()}.${newHex(4)}`;
}

function parse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Check a view definition from an app and keep only what a view has. */
function readView(raw: unknown, allowed: ReadonlyArray<'modal' | 'home'>): Json {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid_arguments', { response_metadata: { messages: ['[ERROR] missing required field: view'] } });
  const view = raw as Json;
  if (JSON.stringify(view).length > MAX_VIEW_BYTES) fail('view_too_large');
  const type = view.type;
  if (type !== 'modal' && type !== 'home') fail('invalid_arguments', { response_metadata: { messages: ['[ERROR] must be a known view type [json-pointer:/view/type]'] } });
  if (!allowed.includes(type)) fail('invalid_arguments', { response_metadata: { messages: [`[ERROR] view type ${type} is not allowed here [json-pointer:/view/type]`] } });
  const blocks = view.blocks;
  if (!Array.isArray(blocks) || blocks.length > MAX_BLOCKS || blocks.some((block) => !block || typeof block !== 'object' || typeof (block as Json).type !== 'string')) {
    fail('invalid_arguments', { response_metadata: { messages: ['[ERROR] must provide an array of up to 100 blocks [json-pointer:/view/blocks]'] } });
  }
  const textObject = (value: unknown, max: number): Json | null => {
    if (value === undefined || value === null) return null;
    const text = typeof value === 'object' ? String((value as Json).text ?? '') : String(value);
    return { type: 'plain_text', text: text.slice(0, max), emoji: true };
  };
  if (type === 'modal' && !textObject(view.title, 24)?.text) {
    fail('invalid_arguments', { response_metadata: { messages: ['[ERROR] missing required field: title [json-pointer:/view/title]'] } });
  }
  const hasInputs = (blocks as Json[]).some((block) => block.type === 'input');
  if (type === 'modal' && hasInputs && !view.submit) {
    fail('invalid_arguments', { response_metadata: { messages: ['[ERROR] submit is required when an input block is present [json-pointer:/view/submit]'] } });
  }
  const externalId = typeof view.external_id === 'string' && view.external_id ? view.external_id.slice(0, 255) : null;
  return {
    type,
    title: textObject(view.title, 24),
    submit: type === 'modal' ? textObject(view.submit, 24) : null,
    close: type === 'modal' ? textObject(view.close, 24) : null,
    blocks: assignIds(blocks as Block[]),
    private_metadata: typeof view.private_metadata === 'string' ? view.private_metadata.slice(0, 3000) : '',
    callback_id: typeof view.callback_id === 'string' ? view.callback_id.slice(0, 255) : '',
    clear_on_close: view.clear_on_close === true,
    notify_on_close: view.notify_on_close === true,
    submit_disabled: view.submit_disabled === true,
    external_id: externalId,
  };
}

export class Views {
  private readonly ctx: Ctx;
  private readonly deps: Interactivity;
  private readonly delivery: Delivery;

  constructor(deps: Interactivity, delivery: Delivery) {
    this.ctx = deps.ctx;
    this.deps = deps;
    this.delivery = delivery;
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  private get(id: string): ViewRow | undefined {
    return this.ctx.db.get<ViewRow>('SELECT * FROM app_views WHERE id = ?', id);
  }

  private stack(userId: string): ViewRow[] {
    return this.ctx.db.all<ViewRow>("SELECT * FROM app_views WHERE user_id = ? AND type = 'modal' ORDER BY depth", userId);
  }

  private home(appId: string, userId: string): ViewRow | undefined {
    return this.ctx.db.get<ViewRow>("SELECT * FROM app_views WHERE app_id = ? AND user_id = ? AND type = 'home'", appId, userId);
  }

  private checkExternalId(app: AppRow, externalId: unknown, except: string | null): void {
    if (typeof externalId !== 'string' || !externalId) return;
    const taken = this.ctx.db.get<{ id: string }>('SELECT id FROM app_views WHERE app_id = ? AND external_id = ?', app.id, externalId);
    if (taken && taken.id !== except) fail('duplicate_external_id');
  }

  private insert(app: AppRow, userId: string, body: Json, place: { root: string | null; previous: string | null; depth: number }): ViewRow {
    this.checkExternalId(app, body.external_id, null);
    const id = newId('V');
    const now = nowSeconds();
    this.ctx.db.run(
      `INSERT INTO app_views (id, app_id, user_id, type, root_view_id, previous_view_id, depth, external_id, hash, body, created, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      app.id,
      userId,
      String(body.type),
      place.root ?? id,
      place.previous,
      place.depth,
      (body.external_id as string | null) ?? null,
      newHash(),
      JSON.stringify(body),
      now,
      now,
    );
    return this.get(id)!;
  }

  /** Replace a view's definition in place. Input already typed survives where block and action ids match. */
  private replace(row: ViewRow, body: Json): ViewRow {
    const app = getApp(this.ctx, row.app_id)!;
    this.checkExternalId(app, body.external_id, row.id);
    const blocks = body.blocks as Block[];
    const kept = sanitizeState(blocks, parse<StateValues>(row.state, {}));
    this.ctx.db.run(
      'UPDATE app_views SET body = ?, external_id = ?, hash = ?, state = ?, updated = ? WHERE id = ?',
      JSON.stringify(body),
      (body.external_id as string | null) ?? null,
      newHash(),
      JSON.stringify(kept),
      nowSeconds(),
      row.id,
    );
    return this.get(row.id)!;
  }

  /** The view object as Slack returns and sends it. */
  toApi(row: ViewRow): Json {
    const body = parse<Json>(row.body, {});
    const team = this.ctx.requireTeam();
    const app = getApp(this.ctx, row.app_id);
    const view: Json = {
      id: row.id,
      team_id: team.id,
      type: row.type,
      blocks: body.blocks ?? [],
      private_metadata: body.private_metadata ?? '',
      callback_id: body.callback_id ?? '',
      state: { values: parse<StateValues>(row.state, {}) },
      hash: row.hash,
      title: body.title ?? null,
      clear_on_close: body.clear_on_close === true,
      notify_on_close: body.notify_on_close === true,
      close: body.close ?? null,
      submit: body.submit ?? null,
      previous_view_id: row.previous_view_id,
      root_view_id: row.root_view_id,
      app_id: row.app_id,
      external_id: row.external_id ?? '',
      app_installed_team_id: team.id,
      bot_id: app?.bot_id ?? '',
    };
    if (body.submit_disabled === true) view.submit_disabled = true;
    return view;
  }

  /** What the person's browser gets: no `private_metadata`, which is for the app alone. */
  private toClient(row: ViewRow): Json {
    const { private_metadata: _hidden, ...view } = this.toApi(row);
    return view;
  }

  /** Tell the person's open tabs what their modal looks like now (an empty stack closes it). */
  private emitStack(userId: string): Json[] {
    const stack = this.stack(userId).map((row) => this.toClient(row));
    this.ctx.bus.emit({ event: { type: 'view_stack', stack }, audience: { users: [userId] }, clientOnly: true });
    return stack;
  }

  private emitHome(row: ViewRow): void {
    this.ctx.bus.emit({
      event: { type: 'app_home', app_id: row.app_id, view: this.toClient(row) },
      audience: { users: [row.user_id] },
      clientOnly: true,
    });
  }

  private emitChanged(row: ViewRow): void {
    if (row.type === 'home') this.emitHome(row);
    else this.emitStack(row.user_id);
  }

  // ── What apps call ────────────────────────────────────────────────────────

  private callerApp(actor: Actor): AppRow {
    if (!actor.isBot || !actor.appId) fail('not_allowed_token_type');
    return getApp(this.ctx, actor.appId) ?? fail('invalid_auth');
  }

  private findForApp(app: AppRow, viewId: string | undefined, externalId: string | undefined): ViewRow {
    let row: ViewRow | undefined;
    if (viewId) row = this.get(viewId);
    else if (externalId) row = this.ctx.db.get<ViewRow>('SELECT * FROM app_views WHERE app_id = ? AND external_id = ?', app.id, externalId);
    else fail('invalid_arguments', { response_metadata: { messages: ['[ERROR] either view_id or external_id is required'] } });
    if (!row || row.app_id !== app.id) fail('not_found');
    return row;
  }

  install(kernel: Kernel): void {
    const { registry } = kernel;
    const ctx = this.ctx;

    registry.add('views.open', {}, ({ actor, args }) => {
      const app = this.callerApp(actor);
      const view = readView(args.json('view'), ['modal']);
      const userId = this.deps.triggers.consume(args.str('trigger_id') ?? args.str('interactivity_pointer'), app.id);
      // One modal per person: opening a new one replaces whatever was open.
      const row = ctx.db.tx(() => {
        ctx.db.run("DELETE FROM app_views WHERE user_id = ? AND type = 'modal'", userId);
        return this.insert(app, userId, view, { root: null, previous: null, depth: 0 });
      });
      this.emitStack(userId);
      return { view: this.toApi(row) };
    });

    registry.add('views.push', {}, ({ actor, args }) => {
      const app = this.callerApp(actor);
      const view = readView(args.json('view'), ['modal']);
      const userId = this.deps.triggers.consume(args.str('trigger_id') ?? args.str('interactivity_pointer'), app.id);
      const stack = this.stack(userId);
      const top = stack.at(-1);
      if (!top || top.app_id !== app.id) fail('not_found');
      if (stack.length >= MAX_STACK) fail('push_limit_reached');
      const row = this.insert(app, userId, view, { root: top.root_view_id, previous: top.id, depth: top.depth + 1 });
      this.emitStack(userId);
      return { view: this.toApi(row) };
    });

    registry.add('views.update', {}, ({ actor, args }) => {
      const app = this.callerApp(actor);
      const current = this.findForApp(app, args.str('view_id'), args.str('external_id'));
      const view = readView(args.json('view'), [current.type]);
      const hash = args.str('hash');
      if (hash && hash !== current.hash) fail('hash_conflict');
      const row = this.replace(current, view);
      this.emitChanged(row);
      return { view: this.toApi(row) };
    });

    registry.add('views.publish', {}, ({ actor, args }) => {
      const app = this.callerApp(actor);
      const userId = args.req('user_id', 'user_not_found');
      const user = getUser(ctx, userId);
      if (!user || user.is_bot === 1) fail('user_not_found');
      const view = readView(args.json('view'), ['home']);
      const current = this.home(app.id, userId);
      const hash = args.str('hash');
      if (hash && current && hash !== current.hash) fail('hash_conflict');
      const row = current ? this.replace(current, view) : this.insert(app, userId, view, { root: null, previous: null, depth: 0 });
      this.emitHome(row);
      return { view: this.toApi(row) };
    });

    // ── What the web client calls ───────────────────────────────────────────

    /** The open modal, after a reload. */
    registry.add('client.views.stack', { auth: 'session' }, ({ actor }) => ({
      stack: this.stack(actor.userId).map((row) => this.toClient(row)),
    }));

    /**
     * Submit the top view of the modal. The app answers within three seconds:
     * nothing (close this view), or a `response_action` of `errors`, `update`,
     * `push` or `clear`.
     */
    registry.add('client.views.submit', { auth: 'session' }, async ({ actor, args }) => {
      const row = this.topView(actor.userId, args.req('view_id', 'not_found'));
      const app = requireApp(ctx, row.app_id);
      const body = parse<Json>(row.body, {});
      const sent = args.json<Json>('state');
      const state = sanitizeState((body.blocks ?? []) as Block[], sent && typeof sent === 'object' ? sent.values : undefined);
      ctx.db.run('UPDATE app_views SET state = ? WHERE id = ?', JSON.stringify(state), row.id);
      const fresh = this.get(row.id)!;
      const payload: Json = {
        type: 'view_submission',
        team: { id: ctx.requireTeam().id, domain: ctx.requireTeam().domain },
        user: payloadUser(ctx, actor.userId),
        api_app_id: app.id,
        token: app.verification_token,
        trigger_id: this.deps.triggers.issue(app.id, actor.userId),
        view: this.toApi(fresh),
        response_urls: [],
        is_enterprise_install: false,
        enterprise: null,
      };
      const answer = await deliverInteractive(this.deps, app, 'interactive', payload, app.interactivity_url);
      return this.applyResponse(actor.userId, app, fresh, answer);
    });

    /**
     * Close the modal. `clear` means the person closed the whole modal (the ×);
     * otherwise only the top view goes (Cancel), unless it asked to clear on close.
     */
    registry.add('client.views.close', { auth: 'session' }, ({ actor, args }) => {
      const row = this.topView(actor.userId, args.req('view_id', 'not_found'));
      const body = parse<Json>(row.body, {});
      const clear = args.bool('clear') || body.clear_on_close === true;
      const stack = this.stack(actor.userId);
      const notified = clear ? stack[0]! : row;
      ctx.db.run(clear ? "DELETE FROM app_views WHERE user_id = ? AND type = 'modal'" : 'DELETE FROM app_views WHERE id = ?', clear ? actor.userId : row.id);
      const notifyBody = parse<Json>(notified.body, {});
      if (notifyBody.notify_on_close === true) {
        const app = getApp(ctx, notified.app_id);
        if (app) {
          const view = this.toApi(notified);
          // The closed view's inputs are not reported.
          view.state = { values: {} };
          const payload: Json = {
            type: 'view_closed',
            team: { id: ctx.requireTeam().id, domain: ctx.requireTeam().domain },
            user: payloadUser(ctx, actor.userId),
            api_app_id: app.id,
            token: app.verification_token,
            view,
            is_cleared: clear,
            is_enterprise_install: false,
            enterprise: null,
          };
          deliverInteractive(this.deps, app, 'interactive', payload, app.interactivity_url).catch(() => undefined);
        }
      }
      return { stack: this.emitStack(actor.userId) };
    });

    /** An interactive element inside a modal or a Home tab was used. */
    registry.add('client.views.blockAction', { auth: 'session' }, async ({ actor, args }) => {
      const row = this.ownView(actor.userId, args.req('view_id', 'not_found'));
      const app = requireApp(ctx, row.app_id);
      const body = parse<Json>(row.body, {});
      const blocks = (body.blocks ?? []) as Block[];
      const input = args.json<Json>('action');
      if (!input || typeof input !== 'object' || typeof input.action_id !== 'string') fail('invalid_arguments', { needed: 'action' });
      const located = locate(blocks, input.action_id, typeof input.block_id === 'string' ? input.block_id : undefined);
      if (!located) fail('action_not_found');
      const sent = args.json<Json>('state');
      if (sent && typeof sent === 'object') {
        ctx.db.run('UPDATE app_views SET state = ? WHERE id = ?', JSON.stringify(sanitizeState(blocks, sent.values)), row.id);
      }
      const view = this.toApi(this.get(row.id)!);
      const team = ctx.requireTeam();
      const payload: Json = {
        type: 'block_actions',
        user: payloadUser(ctx, actor.userId),
        api_app_id: app.id,
        token: app.verification_token,
        container: { type: 'view', view_id: row.id },
        trigger_id: this.deps.triggers.issue(app.id, actor.userId),
        team: { id: team.id, domain: team.domain },
        enterprise: null,
        is_enterprise_install: false,
        view,
        actions: [buildAction(located, input, ctx.clock.eventTs())],
      };
      await deliverInteractive(this.deps, app, 'interactive', payload, app.interactivity_url);
      return {};
    });

    /** Options for an `external_select` in a view: the app answers with `options` or `option_groups`. */
    registry.add('client.views.suggest', { auth: 'session' }, async ({ actor, args }) => {
      const row = this.ownView(actor.userId, args.req('view_id', 'not_found'));
      const app = requireApp(ctx, row.app_id);
      const blocks = (parse<Json>(row.body, {}).blocks ?? []) as Block[];
      const located = locate(blocks, args.req('action_id'), args.str('block_id'));
      if (!located || !String(located.element.type).includes('external_select')) fail('action_not_found');
      const team = ctx.requireTeam();
      const payload: Json = {
        type: 'block_suggestion',
        user: payloadUser(ctx, actor.userId),
        container: { type: 'view', view_id: row.id },
        api_app_id: app.id,
        token: app.verification_token,
        action_id: located.element.action_id,
        block_id: located.blockId,
        value: (args.str('value') ?? '').slice(0, 1000),
        team: { id: team.id, domain: team.domain },
        enterprise: null,
        is_enterprise_install: false,
        view: this.toApi(row),
      };
      return readOptions(await deliverInteractive(this.deps, app, 'interactive', payload, app.interactivity_url));
    });

    /** The Home tab the app published for the caller, if any. */
    registry.add('client.apps.home', { auth: 'session' }, ({ actor, args }) => {
      const app = requireApp(ctx, args.str('app'));
      const row = this.home(app.id, actor.userId);
      return { view: row ? this.toClient(row) : null };
    });

    /**
     * The caller looked at the app's Home or Messages tab: the app hears
     * `app_home_opened`, and usually publishes a Home view in answer.
     */
    registry.add('client.apps.homeOpened', { auth: 'session' }, ({ actor, args }) => {
      const app = requireApp(ctx, args.str('app'));
      const tab = args.str('tab') === 'messages' ? 'messages' : 'home';
      const direct = openDirect(ctx, actor.userId, [app.bot_user_id]).conv;
      const row = this.home(app.id, actor.userId);
      const event: Json = { type: 'app_home_opened', user: actor.userId, channel: direct.id, tab, event_ts: ctx.clock.eventTs() };
      if (row) event.view = this.toApi(row);
      sendToApp(this.delivery, app, 'app_home_opened', event as { type: string });
      return { channel: direct.id, view: row ? this.toClient(row) : null };
    });
  }

  /** A view the caller owns (any modal view in their stack, or one of their Home tabs). */
  private ownView(userId: string, viewId: string): ViewRow {
    const row = this.get(viewId);
    if (!row || row.user_id !== userId) fail('not_found');
    return row;
  }

  /** The visible view of the caller's modal; only it can be submitted or closed. */
  private topView(userId: string, viewId: string): ViewRow {
    const top = this.stack(userId).at(-1);
    if (!top || top.id !== viewId) fail('not_found');
    return top;
  }

  /** Carry out an app's answer to a submission and return the new stack (and any errors). */
  private applyResponse(userId: string, app: AppRow, row: ViewRow, answer: unknown): Json {
    const response = answer && typeof answer === 'object' ? (answer as Json) : {};
    const action = typeof response.response_action === 'string' && RESPONSE_ACTIONS.has(response.response_action) ? response.response_action : null;
    const ctx = this.ctx;
    if (action === 'errors') {
      const errors: Record<string, string> = {};
      if (response.errors && typeof response.errors === 'object') {
        for (const [blockId, message] of Object.entries(response.errors as Json)) {
          if (typeof message === 'string') errors[blockId] = message.slice(0, 500);
        }
      }
      return { stack: this.stack(userId).map((entry) => this.toClient(entry)), errors };
    }
    try {
      if (action === 'update') {
        this.replace(row, readView(response.view, ['modal']));
      } else if (action === 'push') {
        if (this.stack(userId).length >= MAX_STACK) throw new ApiError('push_limit_reached');
        this.insert(app, userId, readView(response.view, ['modal']), { root: row.root_view_id, previous: row.id, depth: row.depth + 1 });
      } else if (action === 'clear') {
        ctx.db.run("DELETE FROM app_views WHERE user_id = ? AND type = 'modal'", userId);
      } else {
        ctx.db.run('DELETE FROM app_views WHERE id = ?', row.id);
      }
    } catch (error) {
      // An answer the server cannot use leaves the modal as it was, and says why.
      if (error instanceof ApiError) return { stack: this.emitStack(userId), errors: {}, app_error: error.code };
      throw error;
    }
    return { stack: this.emitStack(userId) };
  }
}

/** `options` or `option_groups` from an app's answer to `block_suggestion`, trimmed to what a menu shows. */
export function readOptions(answer: unknown): Json {
  const response = answer && typeof answer === 'object' ? (answer as Json) : {};
  const option = (value: unknown): Json | null => {
    if (!value || typeof value !== 'object') return null;
    const entry = value as Json;
    if (typeof entry.value !== 'string' || !entry.text) return null;
    return { text: entry.text, value: entry.value, ...(entry.description ? { description: entry.description } : {}) };
  };
  if (Array.isArray(response.option_groups)) {
    return {
      option_groups: (response.option_groups as Json[]).slice(0, 100).map((group) => ({
        label: group.label,
        options: (Array.isArray(group.options) ? group.options : []).map(option).filter(Boolean).slice(0, 100),
      })),
    };
  }
  return { options: (Array.isArray(response.options) ? response.options : []).map(option).filter(Boolean).slice(0, 100) };
}
