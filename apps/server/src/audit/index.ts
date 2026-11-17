import type { IncomingMessage } from 'node:http';
import { sendJson } from '../api/http.ts';
import type { Args, Call } from '../api/registry.ts';
import type { Kernel } from '../app.ts';
import { authenticate, createToken } from '../core/auth.ts';
import { ApiError } from '../core/errors.ts';
import { nowSeconds } from '../core/ids.ts';
import { getUser, isAdmin, type UserRow } from '../core/users.ts';

/**
 * The audit log: every change to the workspace's people, roles, apps,
 * channels and settings, and every sign-in (and failed one), with who, when,
 * from where. Recorded by wrapping the API methods that make such changes,
 * so methods added later are covered by the same rules. Arguments are
 * reduced to identifiers; secrets and tokens never reach the log.
 *
 * Read it in Administration, with `client.admin.audit.list`, or with the
 * Slack Audit Logs API shape at GET /audit/v1/logs (a token from
 * `client.admin.auditToken`).
 */

const AUDITED = [
  /^client\.admin\./,
  /^client\.apps\./,
  /^client\.invites\./,
  /^client\.(account|security|sessions|sso|twofactor|password)\./,
  /^admin\./,
  /^apps\.manifest\./,
  /^client\.(signin|signout|signup|setup)$/,
  /^(conversations\.(create|archive|unarchive|rename|convertToPrivate)|client\.conversations\.convertGroupDm)$/,
  /^files\.(sharedPublicURL|revokePublicURL)$/,
  /^(oauth\.v2\.access|openid\.connect\.token|tooling\.tokens\.rotate|auth\.revoke)$/,
  /^client\.messages\.report$/,
];
/** Reading is not changing. */
const READ_ONLY = /\.(list|info|get|stats|limits|unknownMethods|retention|export|validate|home|homeOpened|preview|test)$/;
/** Argument names whose values identify what was acted on; everything else is dropped. */
const KEPT_ARGS = ['user', 'users', 'channel', 'app', 'app_id', 'file', 'report', 'role', 'active', 'name', 'kind', 'action', 'command', 'email', 'reason', 'is_private', 'hidden'];

const ACTIONS: Record<string, string | ((args: Args, ok: boolean) => string)> = {
  'client.signin': (_args, ok) => (ok ? 'user_login' : 'user_login_failed'),
  'client.signout': 'user_logout',
  'client.signup': 'user_created',
  'client.setup': 'workspace_created',
  'client.admin.setActive': (args) => (args.bool('active', true) ? 'user_reactivated' : 'user_deactivated'),
  'client.admin.setRole': (args) => `role_change_to_${args.str('role') ?? 'member'}`,
  'client.admin.updateTeam': 'workspace_settings_changed',
  'client.admin.setRetention': 'retention_policy_changed',
  'client.admin.scimToken': 'scim_token_created',
  'client.admin.auditToken': 'audit_token_created',
  'client.apps.create': 'app_installed',
  'apps.manifest.create': 'app_installed',
  'client.apps.delete': 'app_uninstalled',
  'apps.manifest.delete': 'app_uninstalled',
  'client.apps.update': 'app_settings_changed',
  'apps.manifest.update': 'app_settings_changed',
  'client.apps.rotateToken': 'app_token_rotated',
  'client.apps.configToken': 'app_configuration_token_created',
  'oauth.v2.access': 'app_token_issued',
  'openid.connect.token': 'user_signed_in_to_app',
  'client.invites.create': 'invite_created',
  'client.invites.revoke': 'invite_revoked',
  'conversations.create': 'channel_created',
  'conversations.archive': 'channel_archive',
  'conversations.unarchive': 'channel_unarchive',
  'conversations.rename': 'channel_rename',
  'client.conversations.convertGroupDm': 'group_dm_converted_to_channel',
  'files.sharedPublicURL': 'file_public_link_created',
  'files.revokePublicURL': 'file_public_link_revoked',
  'client.messages.report': 'message_reported',
  'client.admin.reports.resolve': (args) => (args.str('action') === 'remove' ? 'reported_message_removed' : 'report_dismissed'),
};

interface AuditRow {
  id: number;
  created: number;
  action: string;
  actor_type: string;
  actor_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  details: string;
  ip: string | null;
  ua: string | null;
}

function clientIp(req: IncomingMessage): string | null {
  return req.socket.remoteAddress ?? null;
}

/** What was acted on, from the arguments or (for creations) the result. */
function entityOf(args: Args, result: Record<string, unknown> | void): { type: string; id: string } | null {
  const pick = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
  const nested = (key: string): string | null => {
    const value = result?.[key];
    return value && typeof value === 'object' ? pick((value as Record<string, unknown>).id) : null;
  };
  const app = pick(args.str('app')) ?? pick(args.str('app_id')) ?? nested('app') ?? pick(result?.app_id);
  const user = pick(args.str('user')) ?? nested('user');
  const channel = pick(args.str('channel')) ?? nested('channel');
  const file = pick(args.str('file'));
  if (file) return { type: 'file', id: file };
  if (user) return { type: 'user', id: user };
  if (app) return { type: 'app', id: app };
  if (channel) return { type: 'channel', id: channel };
  if (args.str('report')) return { type: 'report', id: args.str('report')! };
  return null;
}

export function installAudit(kernel: Kernel): void {
  const { ctx } = kernel;

  const record = (name: string, call: Call | { actor: Call['actor'] | null; args: Args; req: IncomingMessage }, ok: boolean, result: Record<string, unknown> | void, error?: string): void => {
    const mapping = ACTIONS[name];
    const action = typeof mapping === 'function' ? mapping(call.args, ok) : (mapping ?? name);
    let actorType = 'user';
    let actorId: string | null = call.actor?.userId ?? null;
    if (call.actor?.appId && call.actor.kind !== 'session') actorType = 'app';
    if (!actorId && name === 'client.signin') {
      const email = call.args.str('email')?.trim().toLowerCase();
      actorId = email ? (ctx.db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', email)?.id ?? null) : null;
    }
    if (!actorId && (name === 'oauth.v2.access' || name === 'openid.connect.token')) {
      actorType = 'app';
      actorId = ctx.db.get<{ id: string }>('SELECT id FROM apps WHERE client_id = ?', call.args.str('client_id') ?? '')?.id ?? null;
    }
    const details: Record<string, unknown> = { method: name };
    for (const key of KEPT_ARGS) {
      if (call.args.has(key)) details[key] = call.args.raw[key];
    }
    if (error) details.error = error;
    const entity = entityOf(call.args, result);
    ctx.db.run(
      'INSERT INTO audit_log (created, action, actor_type, actor_id, entity_type, entity_id, details, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      nowSeconds(),
      action,
      actorType,
      actorId,
      entity?.type ?? null,
      entity?.id ?? null,
      JSON.stringify(details),
      clientIp(call.req),
      String(call.req.headers['user-agent'] ?? '').slice(0, 300) || null,
    );
  };

  /** Wrap every audited method that exists now. Installed last, so it sees them all. */
  const wrapAll = (): void => {
    for (const name of kernel.registry.names()) {
      if (!AUDITED.some((pattern) => pattern.test(name)) || READ_ONLY.test(name)) continue;
      const def = kernel.registry.get(name)!;
      const original = def.handler;
      def.handler = async (call) => {
        try {
          const result = await original(call);
          record(name, call, true, result ?? undefined);
          return result;
        } catch (error) {
          // Failed sign-ins matter; other refusals changed nothing.
          if (name === 'client.signin' && error instanceof ApiError) record(name, call, false, undefined, error.code);
          throw error;
        }
      };
    }
  };

  kernel.registry.add('client.admin.auditToken', { auth: 'admin' }, ({ actor }) => {
    ctx.db.run("DELETE FROM tokens WHERE user_id = ? AND kind = 'user' AND app_id IS NULL AND scopes = 'auditlogs:read'", actor.userId);
    return { token: createToken(ctx, { kind: 'user', userId: actor.userId, scopes: ['auditlogs:read'] }) };
  });

  const users = new Map<string, UserRow | undefined>();
  const userOf = (id: string): UserRow | undefined => {
    if (!users.has(id)) users.set(id, getUser(ctx, id));
    return users.get(id);
  };

  /** Slack's audit log entry shape. */
  const entryToApi = (row: AuditRow): Record<string, unknown> => {
    users.clear();
    const team = ctx.requireTeam();
    const actorUser = row.actor_type === 'user' && row.actor_id ? userOf(row.actor_id) : undefined;
    const app = row.actor_type === 'app' && row.actor_id ? ctx.db.get<{ id: string; name: string }>('SELECT id, name FROM apps WHERE id = ?', row.actor_id) : undefined;
    const entityName = (): string | null => {
      if (!row.entity_id) return null;
      if (row.entity_type === 'user') return userOf(row.entity_id)?.name ?? null;
      if (row.entity_type === 'channel') return ctx.db.get<{ name: string | null }>('SELECT name FROM conversations WHERE id = ?', row.entity_id)?.name ?? null;
      if (row.entity_type === 'app') return ctx.db.get<{ name: string }>('SELECT name FROM apps WHERE id = ?', row.entity_id)?.name ?? null;
      if (row.entity_type === 'file') return ctx.db.get<{ name: string }>('SELECT name FROM files WHERE id = ?', row.entity_id)?.name ?? null;
      return null;
    };
    return {
      id: String(row.id),
      date_create: row.created,
      action: row.action,
      actor:
        row.actor_type === 'app'
          ? { type: 'app', app: { id: row.actor_id, name: app?.name ?? null } }
          : { type: 'user', user: { id: row.actor_id, name: actorUser?.name ?? null, email: actorUser?.email ?? null } },
      entity: row.entity_type ? { type: row.entity_type, [row.entity_type]: { id: row.entity_id, name: entityName() } } : null,
      context: { location: { type: 'workspace', id: team.id, name: team.name, domain: team.domain }, ua: row.ua, ip_address: row.ip },
      details: JSON.parse(row.details) as Record<string, unknown>,
    };
  };

  const query = (filters: { limit: number; cursor?: string; oldest?: number; latest?: number; action?: string; actor?: string; entity?: string }): Record<string, unknown> => {
    const where: string[] = [];
    const values: (string | number)[] = [];
    if (filters.cursor) {
      where.push('id < ?');
      values.push(Number(filters.cursor));
    }
    if (filters.oldest) {
      where.push('created >= ?');
      values.push(filters.oldest);
    }
    if (filters.latest) {
      where.push('created <= ?');
      values.push(filters.latest);
    }
    if (filters.action) {
      const actions = filters.action.split(',').map((item) => item.trim()).filter(Boolean);
      where.push(`action IN (${actions.map(() => '?').join(', ')})`);
      values.push(...actions);
    }
    if (filters.actor) {
      where.push('actor_id = ?');
      values.push(filters.actor);
    }
    if (filters.entity) {
      where.push('entity_id = ?');
      values.push(filters.entity);
    }
    const rows = ctx.db.all<AuditRow>(
      `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
      ...values,
      filters.limit + 1,
    );
    const more = rows.length > filters.limit;
    const page = rows.slice(0, filters.limit);
    return { entries: page.map(entryToApi), response_metadata: { next_cursor: more ? String(page.at(-1)!.id) : '' } };
  };

  kernel.registry.add('client.admin.audit.list', { auth: 'admin' }, ({ args }) =>
    query({
      limit: Math.min(1000, Math.max(1, args.int('limit', 100))),
      cursor: args.str('cursor'),
      oldest: args.int('oldest', 0) || undefined,
      latest: args.int('latest', 0) || undefined,
      action: args.str('action'),
      actor: args.str('actor'),
      entity: args.str('entity'),
    }),
  );

  kernel.router.add('GET', /^\/audit\/v1\/(logs|schemas|actions)$/, ({ req, res, url, params }) => {
    const { actor } = authenticate(ctx, req, undefined);
    if (!actor || actor.kind !== 'user' || !actor.scopes?.has('auditlogs:read') || !isAdmin(actor)) {
      return sendJson(res, 401, { ok: false, error: 'invalid_authentication' });
    }
    if (params[0] === 'actions') {
      return sendJson(res, 200, { actions: { workspace_or_org: [...new Set(Object.keys(ACTIONS).map((name) => (typeof ACTIONS[name] === 'string' ? (ACTIONS[name] as string) : name)))] } });
    }
    if (params[0] === 'schemas') {
      return sendJson(res, 200, { schemas: [{ type: 'user' }, { type: 'channel' }, { type: 'app' }, { type: 'file' }, { type: 'report' }] });
    }
    const number = (key: string): number | undefined => {
      const value = Number(url.searchParams.get(key));
      return Number.isFinite(value) && value > 0 ? value : undefined;
    };
    sendJson(
      res,
      200,
      query({
        limit: Math.min(9999, number('limit') ?? 100),
        cursor: url.searchParams.get('cursor') ?? undefined,
        oldest: number('oldest'),
        latest: number('latest'),
        action: url.searchParams.get('action') ?? undefined,
        actor: url.searchParams.get('actor') ?? undefined,
        entity: url.searchParams.get('entity') ?? undefined,
      }),
    );
  });

  wrapAll();
}
