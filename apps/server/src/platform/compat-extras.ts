import type { Kernel } from '../app.ts';
import { Args, type Call } from '../api/registry.ts';
import { canSee, getConv, resolveConv, type ConvRow } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { getMessage, messageToApi } from '../core/messages.ts';
import { getUser, isAdmin, userToApi } from '../core/users.ts';
import { teamPrefs } from '../accounts/prefs.ts';
import { getApp } from './apps.ts';
import { sameToken } from './oauth.ts';

/**
 * Smaller Web API methods existing apps still call: reactions.list,
 * stars.*, users.identity, auth.teams.list, apps.uninstall,
 * apps.event.authorizations.list, team.preferences.list,
 * team.billableInfo, team.accessLogs, team.integrationLogs and
 * migration.exchange. Each follows Slack's reference; where this server has
 * no such thing (stars are "Later" and starred conversations here, there is
 * no Enterprise organisation) the closest honest answer is given.
 */

/** Page with `count`/`page` (Slack's older paging) or `cursor`/`limit`. */
function paginate<T>(items: T[], args: Args): { page: T[]; paging?: Record<string, number>; response_metadata?: { next_cursor: string } } {
  if (args.has('cursor') || args.has('limit')) {
    const limit = args.int('limit', 100, { min: 1, max: 1000 });
    let offset = 0;
    const cursor = args.str('cursor');
    if (cursor) {
      const match = /^o:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (!match) fail('invalid_cursor');
      offset = Number(match[1]);
    }
    const page = items.slice(offset, offset + limit);
    const next = offset + limit < items.length ? Buffer.from(`o:${offset + limit}`).toString('base64url') : '';
    return { page, response_metadata: { next_cursor: next } };
  }
  const count = args.int('count', 100, { min: 1, max: 1000 });
  const pageNumber = args.int('page', 1, { min: 1, max: 100 });
  const pages = Math.max(1, Math.ceil(items.length / count));
  return { page: items.slice((pageNumber - 1) * count, pageNumber * count), paging: { count, total: items.length, page: pageNumber, pages } };
}

function requireAdmin(call: Call): void {
  if (!isAdmin(call.actor)) fail('no_permission');
}

/** Run another method's handler with these arguments, as the same caller. */
function delegate(kernel: Kernel, name: string, call: Call, raw: Record<string, unknown>): unknown {
  return kernel.registry.get(name)!.handler({ ...call, args: new Args(raw) });
}

export function installCompatExtras(kernel: Kernel): void {
  const { ctx, registry } = kernel;

  // ── reactions.list ────────────────────────────────────────────────────────

  registry.add('reactions.list', { scopes: ['reactions:read'] }, ({ actor, args }) => {
    const userId = args.str('user') ?? actor.userId;
    if (!getUser(ctx, userId)) fail('user_not_found');
    const rows = ctx.db.all<{ conversation_id: string; ts: string; at: number }>(
      'SELECT conversation_id, ts, MAX(created) AS at FROM reactions WHERE user_id = ? GROUP BY conversation_id, ts ORDER BY at DESC, ts DESC LIMIT 5000',
      userId,
    );
    const convs = new Map<string, ConvRow | undefined>();
    const items: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (!convs.has(row.conversation_id)) convs.set(row.conversation_id, getConv(ctx, row.conversation_id));
      const conv = convs.get(row.conversation_id);
      // Only what the caller may read, whoever's reactions are listed.
      if (!conv || !canSee(ctx, conv, actor.userId)) continue;
      const message = getMessage(ctx, conv.id, row.ts);
      if (message) items.push({ type: 'message', channel: conv.id, message: messageToApi(ctx, message) });
    }
    const { page, paging, response_metadata } = paginate(items, args);
    return { items: page, ...(paging ? { paging } : {}), response_metadata: response_metadata ?? { next_cursor: '' } };
  });

  // ── stars.* : "Later" for messages, the Starred section for conversations ──

  const starTarget = (call: Call): { conv: ConvRow; ts: string | undefined } => {
    const { args, actor } = call;
    if (args.has('file') || args.has('file_comment')) fail(args.has('file') ? 'file_not_found' : 'file_comment_not_found');
    const channel = args.str('channel');
    if (!channel) fail('no_item_specified');
    const conv = resolveConv(ctx, actor, channel);
    const ts = args.str('timestamp');
    if (ts !== undefined && !/^\d{10}\.\d{6}$/.test(ts)) fail('bad_timestamp');
    if (ts && !getMessage(ctx, conv.id, ts)) fail('message_not_found');
    return { conv, ts };
  };

  registry.add('stars.add', { scopes: ['stars:write'] }, (call) => {
    const { conv, ts } = starTarget(call);
    if (ts) {
      if (ctx.db.get('SELECT 1 FROM saved WHERE user_id = ? AND conversation_id = ? AND ts = ?', call.actor.userId, conv.id, ts)) fail('already_starred');
      delegate(kernel, 'client.saved.add', call, { channel: conv.id, ts });
      return {};
    }
    if (ctx.db.get('SELECT 1 FROM members WHERE conversation_id = ? AND user_id = ? AND is_starred = 1', conv.id, call.actor.userId)) fail('already_starred');
    delegate(kernel, 'client.conversations.setPrefs', call, { channel: conv.id, starred: 'true' });
    return {};
  });

  registry.add('stars.remove', { scopes: ['stars:write'] }, (call) => {
    const { conv, ts } = starTarget(call);
    if (ts) {
      if (!ctx.db.get('SELECT 1 FROM saved WHERE user_id = ? AND conversation_id = ? AND ts = ?', call.actor.userId, conv.id, ts)) fail('not_starred');
      delegate(kernel, 'client.saved.remove', call, { channel: conv.id, ts });
      return {};
    }
    if (!ctx.db.get('SELECT 1 FROM members WHERE conversation_id = ? AND user_id = ? AND is_starred = 1', conv.id, call.actor.userId)) fail('not_starred');
    delegate(kernel, 'client.conversations.setPrefs', call, { channel: conv.id, starred: 'false' });
    return {};
  });

  registry.add('stars.list', { scopes: ['stars:read'] }, ({ actor, args }) => {
    const items: Record<string, unknown>[] = [];
    for (const saved of ctx.db.all<{ conversation_id: string; ts: string; created: number }>(
      'SELECT conversation_id, ts, created FROM saved WHERE user_id = ? ORDER BY created DESC LIMIT 1000',
      actor.userId,
    )) {
      const conv = getConv(ctx, saved.conversation_id);
      const message = conv && canSee(ctx, conv, actor.userId) ? getMessage(ctx, conv.id, saved.ts) : undefined;
      if (message) items.push({ type: 'message', channel: conv!.id, message: messageToApi(ctx, message), date_create: saved.created });
    }
    for (const member of ctx.db.all<{ conversation_id: string; joined: number }>('SELECT conversation_id, joined FROM members WHERE user_id = ? AND is_starred = 1', actor.userId)) {
      const conv = getConv(ctx, member.conversation_id);
      if (!conv) continue;
      const type = conv.kind === 'public' ? 'channel' : conv.kind === 'im' ? 'im' : 'group';
      items.push({ type, channel: conv.id, date_create: member.joined });
    }
    const { page, paging, response_metadata } = paginate(items, args);
    const counted = paging ?? { count: page.length, total: items.length, page: 1, pages: 1 };
    return {
      items: page,
      paging: { per_page: counted.count, spill: 0, page: counted.page, total: counted.total, pages: counted.pages },
      ...(response_metadata ? { response_metadata } : {}),
    };
  });

  // ── users.identity (Sign in with Slack, identity.* scopes) ────────────────

  registry.add('users.identity', { scopes: ['identity.basic'] }, ({ actor }) => {
    const user = getUser(ctx, actor.userId);
    if (!user) fail('invalid_user_id');
    const team = ctx.requireTeam();
    const has = (scope: string): boolean => actor.scopes === null || actor.scopes.has(scope);
    const out: Record<string, unknown> = { name: user.real_name || user.name, id: user.id };
    if (has('identity.email')) {
      if (!user.email) fail('email_not_verified');
      out.email = user.email;
    }
    if (has('identity.avatar')) {
      const profile = userToApi(ctx, user).profile as unknown as Record<string, unknown>;
      for (const size of [24, 32, 48, 72, 192, 512]) if (profile[`image_${size}`]) out[`image_${size}`] = profile[`image_${size}`];
    }
    return { user: out, team: has('identity.team') ? { id: team.id, name: team.name, domain: team.domain } : { id: team.id } };
  });

  // ── auth.teams.list, migration.exchange: one workspace, no Enterprise organisation ──

  registry.add('auth.teams.list', {}, ({ args }) => {
    const team = ctx.requireTeam();
    const entry: Record<string, unknown> = { name: team.name, id: team.id };
    if (args.bool('include_icon')) entry.icon = { image_default: true };
    return { teams: [entry], response_metadata: { next_cursor: '' } };
  });

  registry.add('migration.exchange', { scopes: ['tokens.basic'] }, () => fail('not_enterprise_team'));

  // ── team.preferences.list ─────────────────────────────────────────────────

  registry.add('team.preferences.list', { scopes: ['team.preferences:read'] }, () => {
    const prefs = teamPrefs(ctx) as Record<string, unknown>;
    const window = Number(prefs.msg_edit_window_mins);
    const general = ctx.db.get<{ post_policy: string }>('SELECT post_policy FROM conversations WHERE is_general = 1');
    return {
      display_real_names: true,
      disable_file_uploads: 'allow_all',
      msg_edit_window_mins: Number.isInteger(window) && window >= -1 ? window : -1,
      who_can_post_general: general?.post_policy ? 'admin' : 'everyone',
    };
  });

  // ── team.billableInfo, team.accessLogs, team.integrationLogs (admins) ─────

  registry.add('team.billableInfo', { scopes: ['admin'] }, (call) => {
    requireAdmin(call);
    const only = call.args.str('user');
    if (only && !getUser(ctx, only)) fail('user_not_found');
    // Billable: active people; bots, apps and single-channel guests are not.
    const rows = ctx.db.all<{ id: string; deleted: number; is_bot: number; guest: string }>(
      `SELECT id, deleted, is_bot, guest FROM users WHERE id != 'USLACKBOT' ${only ? 'AND id = ?' : ''} ORDER BY id`,
      ...(only ? [only] : []),
    );
    const { page, response_metadata } = paginate(rows.filter((row) => row.is_bot === 0), new Args({ ...call.args.raw, limit: call.args.str('limit') ?? '1000' }));
    const billable: Record<string, { billing_active: boolean }> = {};
    for (const row of page) billable[row.id] = { billing_active: row.deleted === 0 && row.guest !== 'single' };
    return { billable_info: billable, response_metadata };
  });

  registry.add('team.accessLogs', { scopes: ['admin'] }, (call) => {
    requireAdmin(call);
    const before = call.args.str('before');
    const until = before && before !== 'now' ? Number(before) : Number.MAX_SAFE_INTEGER;
    const rows = ctx.db.all<{ user_id: string; ip: string | null; user_agent: string; first: number; last: number; n: number }>(
      `SELECT user_id, ip, user_agent, MIN(created) AS first, MAX(COALESCE(last_seen, created)) AS last, COUNT(*) AS n
       FROM sessions WHERE created <= ? GROUP BY user_id, ip, user_agent ORDER BY last DESC LIMIT 100000`,
      until,
    );
    const logins = rows.map((row) => ({
      user_id: row.user_id,
      username: getUser(ctx, row.user_id)?.name ?? '',
      date_first: row.first,
      date_last: row.last,
      count: row.n,
      ip: row.ip ?? '',
      user_agent: row.user_agent,
      isp: '',
      country: '',
      region: '',
    }));
    const { page, paging, response_metadata } = paginate(logins, call.args);
    return { logins: page, ...(paging ? { paging } : {}), ...(response_metadata ? { response_metadata } : {}) };
  });

  const CHANGE: Record<string, string> = {
    app_installed: 'added',
    app_uninstalled: 'removed',
    app_settings_changed: 'updated',
    app_token_issued: 'expanded',
  };
  registry.add('team.integrationLogs', { scopes: ['admin'] }, (call) => {
    requireAdmin(call);
    const { args } = call;
    const rows = ctx.db.all<{ created: number; action: string; actor_id: string | null; entity_id: string | null; details: string }>(
      `SELECT created, action, actor_id, entity_id, details FROM audit_log WHERE action IN (${Object.keys(CHANGE).map(() => '?').join(',')}) ORDER BY created DESC, id DESC LIMIT 10000`,
      ...Object.keys(CHANGE),
    );
    const logs = rows
      .map((row) => {
        const details = JSON.parse(row.details || '{}') as Record<string, unknown>;
        const appId = row.entity_id ?? (typeof details.app_id === 'string' ? details.app_id : '');
        const app = appId ? getApp(ctx, appId) : undefined;
        return {
          app_id: appId,
          app_type: app?.name ?? (typeof details.name === 'string' ? details.name : ''),
          user_id: row.actor_id ?? '',
          user_name: row.actor_id ? (getUser(ctx, row.actor_id)?.name ?? '') : '',
          date: String(row.created),
          change_type: CHANGE[row.action]!,
          scope: app ? app.bot_scopes : '',
        };
      })
      .filter((log) => (!args.str('app_id') || log.app_id === args.str('app_id')) && (!args.str('change_type') || log.change_type === args.str('change_type')) && (!args.str('user') || log.user_id === args.str('user')));
    const { page, paging } = paginate(logs, new Args({ count: args.str('count') ?? '100', page: args.str('page') ?? '1' }));
    return { logs: page, paging: paging! };
  });

  // ── apps.uninstall, apps.event.authorizations.list ────────────────────────

  registry.add('apps.uninstall', {}, ({ actor, args }) => {
    if (actor.kind === 'session' || !actor.appId) fail('not_allowed_token_type');
    const found = ctx.db.get<{ id: string }>('SELECT id FROM apps WHERE client_id = ?', args.req('client_id', 'invalid_client_id'));
    const row = found ? getApp(ctx, found.id) : undefined;
    if (!row) fail('invalid_client_id');
    if (!sameToken(args.req('client_secret', 'bad_client_secret'), row.client_secret)) fail('bad_client_secret');
    if (row.id !== actor.appId) fail('client_id_token_mismatch');
    // Every token of this installation: the bot's, the app-level ones and those its users granted.
    ctx.db.run('DELETE FROM tokens WHERE app_id = ?', row.id);
    ctx.bus.emit({ event: { type: 'app_uninstalled', app_id: row.id, event_ts: ctx.clock.eventTs() }, audience: { all: true }, clientOnly: true });
    return {};
  });

  registry.add('apps.event.authorizations.list', { scopes: ['authorizations:read'] }, ({ actor, args }) => {
    if (actor.kind !== 'app' || !actor.appId) fail('not_allowed_token_type');
    const context = args.req('event_context', 'invalid_event_context');
    let decoded: { tid?: string; aid?: string } = {};
    try {
      decoded = JSON.parse(Buffer.from(context.replace(/^4-/, ''), 'base64url').toString('utf8')) as typeof decoded;
    } catch {
      fail('invalid_event_context');
    }
    if (!decoded.aid || decoded.tid !== ctx.requireTeam().id) fail('invalid_event_context');
    if (decoded.aid !== actor.appId) fail('auth_mismatch');
    const app = getApp(ctx, decoded.aid)!;
    const authorizations: Record<string, unknown>[] = [{ enterprise_id: null, team_id: decoded.tid, user_id: app.bot_user_id, is_bot: true, is_enterprise_install: false }];
    for (const row of ctx.db.all<{ user_id: string }>("SELECT DISTINCT user_id FROM tokens WHERE app_id = ? AND kind = 'user'", app.id)) {
      authorizations.push({ enterprise_id: null, team_id: decoded.tid, user_id: row.user_id, is_bot: false, is_enterprise_install: false });
    }
    const { page, response_metadata } = paginate(authorizations, new Args({ ...args.raw, limit: args.str('limit') ?? '100' }));
    return { authorizations: page, response_metadata };
  });
}
