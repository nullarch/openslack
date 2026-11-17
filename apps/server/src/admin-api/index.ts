import { channelNameError, normalizeChannelName } from '@app/shared';
import { Args, type Call } from '../api/registry.ts';
import type { Kernel } from '../app.ts';
import { getConv, type ConvRow } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { nowSeconds } from '../core/ids.ts';
import { postSystemMessage } from '../core/messages.ts';
import type { UserRow } from '../core/users.ts';
import type { Actor } from '../ctx.ts';
import { isHeld } from '../legal/index.ts';

/**
 * Slack's admin API (`admin.users.*`, `admin.conversations.*`,
 * `admin.teams.settings.*`, `admin.inviteRequests.*`) for automation that
 * manages a workspace: an admin's user token with the admin scopes, granted
 * through an OAuth install that only an admin can approve. Changes go through
 * the same code as the web client's administration, so its rules (only
 * owners touch owners, the primary owner stays) and the audit log apply.
 * Admin methods act on any channel, including private ones the admin is not in.
 */

const USERS_READ = ['admin.users:read'];
const USERS_WRITE = ['admin.users:write'];
const CONV_READ = ['admin.conversations:read'];
const CONV_WRITE = ['admin.conversations:write'];
const TEAMS_WRITE = ['admin.teams:write'];
const INVITES_READ = ['admin.invites:read'];
const INVITES_WRITE = ['admin.invites:write'];

export const ADMIN_USER_SCOPES = ['admin.users:read', 'admin.users:write', 'admin.conversations:read', 'admin.conversations:write', 'admin.teams:read', 'admin.teams:write', 'admin.invites:read', 'admin.invites:write', 'admin.barriers:read', 'admin.barriers:write', 'admin.usergroups:read', 'admin.usergroups:write', 'admin.workflows:read', 'admin.workflows:write', 'admin.analytics:read'];

export function installAdminApi(kernel: Kernel): void {
  const { ctx, registry } = kernel;

  const invoke = async (name: string, call: Call, raw: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const def = registry.get(name);
    if (!def) fail('unknown_method');
    // The token's user acts, with the full authority of their role (the admin scope was the gate).
    const actor: Actor = { ...call.actor, scopes: null };
    return ((await def.handler({ ...call, actor, args: new Args(raw) } as Call)) ?? {}) as Record<string, unknown>;
  };

  const channelArg = (args: Args): ConvRow => {
    const conv = getConv(ctx, args.req('channel_id', 'channel_not_found'));
    if (!conv || (conv.kind !== 'public' && conv.kind !== 'private')) fail('channel_not_found');
    return conv;
  };

  // ── admin.users.* ─────────────────────────────────────────────────────────

  const userToAdminApi = (row: UserRow): Record<string, unknown> => {
    const team = ctx.requireTeam();
    const last = ctx.db.get<{ day: string | null }>('SELECT max(day) AS day FROM activity_days WHERE user_id = ?', row.id)?.day;
    const prefs = (() => {
      try {
        return JSON.parse(row.prefs) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    return {
      id: row.id,
      email: row.email ?? undefined,
      is_admin: row.role !== 'member',
      is_owner: row.role === 'owner' || row.role === 'primary_owner',
      is_primary_owner: row.role === 'primary_owner',
      is_restricted: (row as UserRow & { guest?: string }).guest === 'multi',
      is_ultra_restricted: (row as UserRow & { guest?: string }).guest === 'single',
      is_bot: row.is_bot === 1,
      username: row.name,
      full_name: row.real_name,
      is_active: row.deleted === 0,
      date_created: row.created,
      ...(last ? { last_active_ts: Math.floor(Date.parse(`${last}T00:00:00Z`) / 1000) } : {}),
      has_2fa: Boolean(prefs.two_factor_enabled),
      workspaces: [team.id],
    };
  };

  registry.add('admin.users.list', { auth: 'admin', scopes: USERS_READ }, ({ args }) => {
    const limit = args.int('limit', 100, { min: 1, max: 1000 });
    const after = args.str('cursor') ? Buffer.from(args.str('cursor')!, 'base64').toString('utf8') : '';
    const rows = ctx.db.all<UserRow>("SELECT * FROM users WHERE is_bot = 0 AND home = '' AND id > ? ORDER BY id LIMIT ?", after, limit + 1);
    const page = rows.slice(0, limit);
    return { users: page.map(userToAdminApi), response_metadata: { next_cursor: rows.length > limit ? Buffer.from(page.at(-1)!.id).toString('base64') : '' } };
  });

  for (const [method, role] of [['admin.users.setAdmin', 'admin'], ['admin.users.setOwner', 'owner'], ['admin.users.setRegular', 'member']] as const) {
    registry.add(method, { auth: 'admin', scopes: USERS_WRITE }, async (call) => {
      await invoke('client.admin.setRole', call, { user: call.args.req('user_id', 'user_not_found'), role });
    });
  }

  registry.add('admin.users.remove', { auth: 'admin', scopes: USERS_WRITE }, async (call) => {
    await invoke('client.admin.setActive', call, { user: call.args.req('user_id', 'user_not_found'), active: false });
  });

  registry.add('admin.users.invite', { auth: 'admin', scopes: USERS_WRITE }, async (call) => {
    const { args } = call;
    const guest = args.bool('is_ultra_restricted') ? 'single' : args.bool('is_restricted') ? 'multi' : '';
    const expires = args.int('guest_expiration_ts', 0);
    const raw: Record<string, unknown> = { email: args.req('email', 'invalid_email') };
    if (guest) {
      raw.guest = guest;
      raw.channels = args.list('channel_ids');
      if (expires) raw.guest_expires_in_days = Math.max(1, Math.ceil((expires - nowSeconds()) / 86_400));
    }
    await invoke('client.invites.create', call, raw);
  });

  // ── admin.conversations.* ─────────────────────────────────────────────────

  const toAdminChannel = (conv: ConvRow): Record<string, unknown> => ({
    id: conv.id,
    name: conv.name,
    is_private: conv.kind === 'private',
    is_archived: conv.is_archived === 1,
    is_general: conv.is_general === 1,
    created: conv.created,
    creator_id: conv.creator,
    purpose: conv.purpose,
    member_count: ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM members WHERE conversation_id = ?', conv.id)!.n,
    last_activity_ts: Number(conv.last_ts?.split('.')[0] ?? 0) || conv.created,
    internal_team_ids: [ctx.requireTeam().id],
  });

  registry.add('admin.conversations.search', { auth: 'admin', scopes: CONV_READ }, ({ args }) => {
    const limit = args.int('limit', 10, { min: 1, max: 20 });
    const offset = Number(args.str('cursor') ?? 0) || 0;
    const types = args.list('search_channel_types');
    const where = ["kind IN ('public', 'private')"];
    const params: (string | number)[] = [];
    const query = args.str('query')?.trim().toLowerCase();
    if (query) {
      where.push('name LIKE ?');
      params.push(`%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
    }
    if (types.includes('private') && !types.includes('public')) where.push("kind = 'private'");
    if (types.includes('public') && !types.includes('private')) where.push("kind = 'public'");
    if (types.includes('archived')) where.push('is_archived = 1');
    if (types.includes('exclude_archived')) where.push('is_archived = 0');
    const rows = ctx.db.all<ConvRow>(`SELECT * FROM conversations WHERE ${where.join(' AND ')} ORDER BY ${args.str('sort') === 'name' ? 'name' : 'created DESC'} LIMIT ? OFFSET ?`, ...params, limit + 1, offset);
    const total = ctx.db.get<{ n: number }>(`SELECT count(*) AS n FROM conversations WHERE ${where.join(' AND ')}`, ...params)!.n;
    return { conversations: rows.slice(0, limit).map(toAdminChannel), total_count: total, next_cursor: rows.length > limit ? String(offset + limit) : '' };
  });

  registry.add('admin.conversations.getTeams', { auth: 'admin', scopes: CONV_READ }, ({ args }) => {
    channelArg(args);
    return { team_ids: [ctx.requireTeam().id], response_metadata: { next_cursor: '' } };
  });

  const audienceOf = (conv: ConvRow): { all: true } | { conversation: string } => (conv.kind === 'public' ? { all: true } : { conversation: conv.id });

  registry.add('admin.conversations.archive', { auth: 'admin', scopes: CONV_WRITE }, ({ actor, args }) => {
    const conv = channelArg(args);
    if (conv.is_general === 1) fail('cant_archive_general');
    if (conv.is_archived === 1) fail('already_archived');
    postSystemMessage(ctx, conv, actor.userId, 'channel_archive', `<@${actor.userId}> archived the channel`);
    ctx.db.run('UPDATE conversations SET is_archived = 1, updated = ? WHERE id = ?', nowSeconds(), conv.id);
    ctx.bus.emit({ event: { type: 'channel_archive', channel: conv.id, user: actor.userId, event_ts: ctx.clock.eventTs() }, audience: audienceOf(conv) });
  });

  registry.add('admin.conversations.unarchive', { auth: 'admin', scopes: CONV_WRITE }, ({ actor, args }) => {
    const conv = channelArg(args);
    if (conv.is_archived === 0) fail('not_archived');
    ctx.db.run('UPDATE conversations SET is_archived = 0, updated = ? WHERE id = ?', nowSeconds(), conv.id);
    ctx.bus.emit({ event: { type: 'channel_unarchive', channel: conv.id, user: actor.userId, event_ts: ctx.clock.eventTs() }, audience: audienceOf(conv) });
  });

  registry.add('admin.conversations.rename', { auth: 'admin', scopes: CONV_WRITE }, ({ actor, args }) => {
    const conv = channelArg(args);
    const name = normalizeChannelName(args.req('name', 'invalid_name_required'));
    const error = channelNameError(name);
    if (error) fail(error);
    if (name === conv.name) return;
    if (ctx.db.get("SELECT 1 FROM conversations WHERE name = ? AND kind IN ('public', 'private')", name)) fail('name_taken');
    ctx.db.run('UPDATE conversations SET name = ?, updated = ? WHERE id = ?', name, nowSeconds(), conv.id);
    ctx.bus.emit({
      event: { type: 'channel_rename', channel: { id: conv.id, name, name_normalized: name, created: conv.created, is_channel: true }, event_ts: ctx.clock.eventTs() },
      audience: audienceOf(conv),
    });
    postSystemMessage(ctx, conv, actor.userId, 'channel_name', `<@${actor.userId}> has renamed the channel from "${conv.name}" to "${name}"`, { old_name: conv.name, name });
  });

  /** Permanently delete a channel and everything in it. Refused for #general and for channels under legal hold. */
  registry.add('admin.conversations.delete', { auth: 'admin', scopes: CONV_WRITE }, ({ actor, args }) => {
    const conv = channelArg(args);
    if (conv.is_general === 1) fail('cant_delete_general');
    if (isHeld(ctx, conv.id, null)) fail('restricted_action', { detail: 'legal_hold' });
    const members = ctx.db.all<{ user_id: string }>('SELECT user_id FROM members WHERE conversation_id = ?', conv.id).map((row) => row.user_id);
    ctx.db.tx(() => {
      for (const table of ['reactions', 'pins', 'mentions', 'file_shares']) ctx.db.run(`DELETE FROM ${table} WHERE conversation_id = ?`, conv.id);
      ctx.db.run('DELETE FROM messages WHERE conversation_id = ?', conv.id);
      ctx.db.run('DELETE FROM conversations WHERE id = ?', conv.id);
    });
    ctx.bus.emit({ event: { type: 'channel_deleted', channel: conv.id, actor_id: actor.userId, event_ts: ctx.clock.eventTs() }, audience: conv.kind === 'public' ? { all: true } : { users: members } });
  });

  /** `prefs`: { who_can_post: 'type:admin' | 'type:user' } (Slack's form), mapped onto posting permissions. */
  registry.add('admin.conversations.setConversationPrefs', { auth: 'admin', scopes: CONV_WRITE }, ({ args }) => {
    const conv = channelArg(args);
    const prefs = args.json<Record<string, unknown>>('prefs') ?? fail('invalid_arguments', { arg: 'prefs' });
    const post = String(prefs.who_can_post ?? '');
    if (post) {
      const admins = post.split(',').includes('type:admin') && !post.split(',').includes('type:user');
      ctx.db.run('UPDATE conversations SET post_policy = ? WHERE id = ?', admins ? 'admins' : '', conv.id);
      ctx.bus.emit({ event: { type: 'channel_updated', channel: { id: conv.id } }, audience: audienceOf(conv), clientOnly: true });
    }
  });

  // ── admin.teams.settings.* and admin.inviteRequests.* ─────────────────────

  registry.add('admin.teams.settings.setName', { auth: 'admin', scopes: TEAMS_WRITE }, async (call) => {
    await invoke('client.admin.updateTeam', call, { name: call.args.req('name', 'invalid_name') });
  });

  registry.add('admin.teams.settings.setDefaultChannels', { auth: 'admin', scopes: TEAMS_WRITE }, ({ args }) => {
    const ids = args.list('channel_ids');
    for (const id of ids) {
      const conv = getConv(ctx, id);
      if (!conv || conv.kind !== 'public' || conv.is_archived === 1) fail('channel_not_found', { id });
    }
    ctx.db.run("UPDATE team SET prefs = json_set(prefs, '$.default_channels', json(?)) WHERE id = ?", JSON.stringify(ids), ctx.requireTeam().id);
    ctx.invalidateTeam();
  });

  registry.add('admin.inviteRequests.list', { auth: 'admin', scopes: INVITES_READ }, async (call) => {
    const result = await invoke('client.admin.inviteRequests.list', call, {});
    return { invite_requests: result.requests ?? result.invite_requests ?? [] };
  });
  registry.add('admin.inviteRequests.approve', { auth: 'admin', scopes: INVITES_WRITE }, async (call) => {
    await invoke('client.admin.inviteRequests.approve', call, { id: call.args.req('invite_request_id', 'invalid_invite_id') });
  });
  registry.add('admin.inviteRequests.deny', { auth: 'admin', scopes: INVITES_WRITE }, async (call) => {
    await invoke('client.admin.inviteRequests.deny', call, { id: call.args.req('invite_request_id', 'invalid_invite_id') });
  });
}

