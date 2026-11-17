import { channelNameError, normalizeChannelName } from '@app/shared';
import { Args, type Call } from '../api/registry.ts';
import type { Kernel } from '../app.ts';
import { customEmoji } from '../api/methods/emoji.ts';
import { addMember, getConv, memberIds, type ConvRow } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { nowSeconds } from '../core/ids.ts';
import { emitUserChange, getUser, type UserRow } from '../core/users.ts';
import type { Actor } from '../ctx.ts';
import { revokeSessions } from '../sessions/index.ts';

/**
 * More of Slack's admin API, over features this server already has:
 * sessions (`admin.users.session.*`), guest expiry, custom emoji, the
 * workspace's admins, owners and settings, user groups' default channels,
 * channel lookup and prefs, admin channel creation, invites and conversion,
 * and decided invite requests. One workspace: `team_id` arguments must name
 * it, and org-wide options act on it.
 */

const USERS_READ = ['admin.users:read'];
const USERS_WRITE = ['admin.users:write'];
const TEAMS_READ = ['admin.teams:read'];
const TEAMS_WRITE = ['admin.teams:write'];
const CONV_READ = ['admin.conversations:read'];
const CONV_WRITE = ['admin.conversations:write'];
const GROUPS_READ = ['admin.usergroups:read'];
const GROUPS_WRITE = ['admin.usergroups:write'];
const INVITES_READ = ['admin.invites:read'];

export const MORE_ADMIN_SCOPES = ['admin.usergroups:read', 'admin.usergroups:write'];

const MIN_SESSION = 28_800;
const MAX_SESSION = 315_569_520;

interface SessionRow {
  token_hash: string;
  user_id: string;
  user_agent: string;
  created: number;
  expires: number;
  last_seen: number | null;
  ip: string | null;
}

/** Slack numbers sessions; here a session is its token hash, shown as a stable integer. */
const sessionNumber = (hash: string): number => Number.parseInt(hash.slice(0, 12), 16);

function list(args: Args, name: string): string[] {
  const raw = args.raw[name];
  return Array.isArray(raw) ? raw.map(String) : args.list(name);
}

/** `cursor`/`limit` paging over an in-memory list. */
function page<T>(items: T[], args: Args, defaultLimit: number): { items: T[]; next: string } {
  const limit = args.int('limit', defaultLimit, { min: 1, max: 1000 });
  let offset = 0;
  const cursor = args.str('cursor');
  if (cursor && cursor !== '*') {
    const match = /^o:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!match) fail('invalid_cursor');
    offset = Number(match[1]);
  }
  const slice = items.slice(offset, offset + limit);
  return { items: slice, next: offset + limit < items.length ? Buffer.from(`o:${offset + limit}`).toString('base64url') : '' };
}

function osOf(agent: string): string {
  return /iPhone|iPad/.test(agent) ? 'iOS' : /Android/.test(agent) ? 'Android' : /Mac OS X/.test(agent) ? 'OS X' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : '';
}

export function installMoreAdminApi(kernel: Kernel): void {
  const { ctx, registry } = kernel;
  const team = () => ctx.requireTeam();

  const checkTeam = (args: Args, required: boolean): void => {
    const teamId = args.str('team_id');
    if (!teamId) {
      if (required) fail('team_not_found');
      return;
    }
    if (teamId !== team().id) fail('team_not_found');
  };
  const requireUserArg = (id: string | undefined): UserRow => {
    const user = id ? getUser(ctx, id) : undefined;
    if (!user) fail('user_not_found');
    return user;
  };
  const invoke = async (name: string, call: Call, raw: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const def = registry.get(name) ?? fail('unknown_method');
    const actor: Actor = { ...call.actor, scopes: null };
    return ((await def.handler({ ...call, actor, args: new Args(raw) } as Call)) ?? {}) as Record<string, unknown>;
  };
  const prefsOf = (user: UserRow): Record<string, unknown> => {
    try {
      return JSON.parse(user.prefs) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const teamPrefs = (): Record<string, unknown> => JSON.parse(team().prefs) as Record<string, unknown>;
  const setTeamPref = (key: string, value: unknown): void => {
    ctx.db.run(`UPDATE team SET prefs = json_set(prefs, '$.${key}', json(?)) WHERE id = ?`, JSON.stringify(value), team().id);
    ctx.invalidateTeam();
  };

  // ── admin.users.session.* ─────────────────────────────────────────────────

  registry.add('admin.users.session.list', { auth: 'admin', scopes: USERS_READ }, ({ args }) => {
    const userId = args.str('user_id');
    const teamId = args.str('team_id');
    if (userId && !teamId) fail('missing_team');
    if (teamId && !userId) fail('missing_user');
    if (teamId) checkTeam(args, true);
    if (userId) requireUserArg(userId);
    const rows = ctx.db.all<SessionRow>(
      `SELECT * FROM sessions WHERE expires > ? ${userId ? 'AND user_id = ?' : ''} ORDER BY created DESC`,
      Math.floor(Date.now() / 1000),
      ...(userId ? [userId] : []),
    );
    if (userId && rows.length === 0) fail('no_active_sessions');
    const { items, next } = page(rows, args, 1000);
    const device = (row: SessionRow): Record<string, unknown> => ({ device_hardware: '', os: osOf(row.user_agent), os_version: '', slack_client_version: '', ip: row.ip ?? '' });
    return {
      active_sessions: items.map((row) => ({ user_id: row.user_id, team_id: team().id, session_id: sessionNumber(row.token_hash), created: device(row) })),
      response_metadata: { next_cursor: next },
    };
  });

  registry.add('admin.users.session.invalidate', { auth: 'admin', scopes: USERS_WRITE }, ({ actor, args }) => {
    const user = requireUserArg(args.req('user_id', 'user_not_found'));
    if (user.role === 'primary_owner' && user.id !== actor.userId) fail('cannot_invalidate_primary_owner');
    const wanted = Number(args.req('session_id', 'session_not_found'));
    const row = ctx.db.all<SessionRow>('SELECT * FROM sessions WHERE user_id = ?', user.id).find((entry) => sessionNumber(entry.token_hash) === wanted);
    if (!row) fail('session_not_found');
    revokeSessions(ctx, user.id, [row.token_hash]);
  });

  registry.add('admin.users.session.resetBulk', { auth: 'admin', scopes: USERS_WRITE }, async (call) => {
    const ids = list(call.args, 'user_ids');
    if (ids.length === 0 || ids.length > 1000) fail('invalid_arguments', { arg: 'user_ids' });
    // Every session here is a web session (the desktop app included); mobile_only resets nothing.
    if (call.args.bool('mobile_only')) return;
    const failed: string[] = [];
    for (const id of ids) {
      const user = getUser(ctx, id);
      if (!user) fail('user_not_found');
      if (user.is_bot === 1) fail('cannot_reset_bot');
      try {
        await invoke('admin.users.session.reset', call, { user_id: id });
      } catch {
        failed.push(id);
      }
    }
    if (failed.length) fail('failed_for_some_users', { failed_user_ids: failed });
  });

  registry.add('admin.users.session.getSettings', { auth: 'admin', scopes: USERS_READ }, ({ args }) => {
    const ids = list(args, 'user_ids');
    const settings: Record<string, unknown>[] = [];
    const none: string[] = [];
    for (const id of ids) {
      const user = requireUserArg(id);
      const prefs = prefsOf(user);
      if (typeof prefs.session_duration === 'number' || typeof prefs.session_browser_quit === 'boolean') {
        settings.push({ user_id: id, desktop_app_browser_quit: prefs.session_browser_quit === true, duration: prefs.session_duration ?? null });
      } else none.push(id);
    }
    return { session_settings: settings, no_settings_applied: none };
  });

  registry.add('admin.users.session.setSettings', { auth: 'admin', scopes: USERS_WRITE }, ({ args }) => {
    const ids = list(args, 'user_ids');
    if (ids.length === 0 || ids.length > 1000) fail('invalid_arguments', { arg: 'user_ids' });
    const hasDuration = args.has('duration');
    const hasQuit = args.has('desktop_app_browser_quit');
    if (!hasDuration && !hasQuit) fail('at_least_one_session_setting_required');
    const duration = hasDuration ? args.int('duration', 0) : null;
    if (duration !== null && (duration < MIN_SESSION || duration > MAX_SESSION)) fail('invalid_arguments', { arg: 'duration' });
    for (const id of ids) {
      const user = requireUserArg(id);
      if (user.is_bot === 1) fail('bots_not_allowed');
      const prefs = prefsOf(user);
      if (duration !== null) prefs.session_duration = duration;
      if (hasQuit) prefs.session_browser_quit = args.bool('desktop_app_browser_quit');
      ctx.db.run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify(prefs), id);
      // Sessions already open get the new length too.
      if (duration !== null) ctx.db.run('UPDATE sessions SET expires = created + ? WHERE user_id = ?', duration, id);
    }
  });

  registry.add('admin.users.session.clearSettings', { auth: 'admin', scopes: USERS_WRITE }, ({ args }) => {
    for (const id of list(args, 'user_ids')) {
      const user = requireUserArg(id);
      const prefs = prefsOf(user);
      delete prefs.session_duration;
      delete prefs.session_browser_quit;
      ctx.db.run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify(prefs), id);
    }
  });

  // ── Guest expiry ──────────────────────────────────────────────────────────

  const guestRow = (user: UserRow): UserRow & { guest: string; guest_expires: number } => user as UserRow & { guest: string; guest_expires: number };

  registry.add('admin.users.getExpiration', { auth: 'admin', scopes: USERS_READ }, ({ args }) => {
    const user = guestRow(requireUserArg(args.req('user_id', 'user_not_found')));
    if (!user.guest) fail('user_is_not_guest');
    return { user: { id: user.id, email: user.email ?? '', is_restricted: user.guest === 'multi', is_ultra_restricted: user.guest === 'single', expiration_ts: user.guest_expires } };
  });

  registry.add('admin.users.setExpiration', { auth: 'admin', scopes: USERS_WRITE }, ({ args }) => {
    if (args.str('team_id')) checkTeam(args, true);
    const user = guestRow(requireUserArg(args.req('user_id', 'user_not_found')));
    if (user.deleted === 1) fail('user_is_deactivated');
    if (!user.guest) fail('user_is_not_a_guest');
    const at = Number(args.req('expiration_ts', 'failed_to_validate_expiration'));
    if (!Number.isInteger(at) || at <= nowSeconds()) fail('failed_to_validate_expiration');
    ctx.db.run('UPDATE users SET guest_expires = ?, updated = ? WHERE id = ?', at, nowSeconds(), user.id);
    emitUserChange(ctx, user.id);
  });

  // ── Custom emoji ──────────────────────────────────────────────────────────

  registry.add('admin.emoji.list', { auth: 'admin', scopes: TEAMS_READ }, ({ args }) => {
    const urls = customEmoji(ctx);
    const rows = ctx.db.all<{ name: string; created_by: string; created: number }>('SELECT name, created_by, created FROM emoji ORDER BY name');
    const { items, next } = page(rows, args, 100);
    return {
      emoji: Object.fromEntries(items.map((row) => [row.name, { url: urls[row.name], date_created: row.created, uploaded_by: row.created_by }])),
      response_metadata: { next_cursor: next },
    };
  });

  registry.add('admin.emoji.rename', { auth: 'admin', scopes: TEAMS_WRITE }, ({ args }) => {
    const name = args.req('name', 'error_missing_name').trim().replace(/^:|:$/g, '');
    const next = args.req('new_name', 'error_bad_name_i18n').trim().replace(/^:|:$/g, '').toLowerCase();
    const row = ctx.db.get<{ alias_for: string | null }>('SELECT alias_for FROM emoji WHERE name = ?', name);
    if (!row) fail('error_invalid_emoji_to_rename');
    if (!next || next.length > 100 || !/^[\p{Ll}\p{Lo}\p{N}_+'-]+$/u.test(next)) fail('error_bad_name_i18n');
    if (ctx.db.get('SELECT 1 FROM emoji WHERE name = ?', next)) fail('error_name_taken');
    ctx.db.tx(() => {
      ctx.db.run('UPDATE emoji SET name = ? WHERE name = ?', next, name);
      ctx.db.run('UPDATE emoji SET alias_for = ? WHERE alias_for = ?', next, name);
    });
    ctx.bus.emit({ event: { type: 'emoji_changed', subtype: 'rename', old_name: name, new_name: next, value: customEmoji(ctx)[next], event_ts: ctx.clock.eventTs() }, audience: { all: true } });
  });

  // ── The workspace ─────────────────────────────────────────────────────────

  const byRole = (roles: string[]): string[] =>
    ctx.db.all<{ id: string }>(`SELECT id FROM users WHERE deleted = 0 AND is_bot = 0 AND role IN (${roles.map(() => '?').join(',')}) ORDER BY id`, ...roles).map((row) => row.id);

  registry.add('admin.teams.admins.list', { auth: 'admin', scopes: TEAMS_READ }, ({ args }) => {
    checkTeam(args, true);
    const { items, next } = page(byRole(['admin']), args, 100);
    return { admin_ids: items, response_metadata: { next_cursor: next } };
  });

  registry.add('admin.teams.owners.list', { auth: 'admin', scopes: TEAMS_READ }, ({ args }) => {
    checkTeam(args, true);
    const { items, next } = page(byRole(['owner', 'primary_owner']), args, 100);
    return { owner_ids: items, response_metadata: { next_cursor: next } };
  });

  registry.add('admin.teams.list', { auth: 'admin', scopes: TEAMS_READ }, () => {
    const primary = ctx.db.get<{ id: string; email: string | null }>("SELECT id, email FROM users WHERE role = 'primary_owner' LIMIT 1");
    const prefs = teamPrefs();
    return {
      teams: [
        {
          id: team().id,
          name: team().name,
          discoverability: typeof prefs.discoverability === 'string' ? prefs.discoverability : 'invite_only',
          primary_owner: { user_id: primary?.id ?? '', email: primary?.email ?? '' },
          team_url: `${ctx.config.publicUrl}/`,
        },
      ],
      response_metadata: { next_cursor: '' },
    };
  });

  registry.add('admin.teams.settings.info', { auth: 'admin', scopes: TEAMS_READ }, ({ args }) => {
    checkTeam(args, true);
    const prefs = teamPrefs();
    return {
      team: {
        id: team().id,
        name: team().name,
        domain: team().domain,
        email_domain: Array.isArray(prefs.signup_domains) ? (prefs.signup_domains as string[]).join(',') : '',
        icon: { image_default: true },
        enterprise_id: '',
        enterprise_name: '',
        default_channels: Array.isArray(prefs.default_channels) ? prefs.default_channels : [],
        description: typeof prefs.description === 'string' ? prefs.description : '',
        discoverability: typeof prefs.discoverability === 'string' ? prefs.discoverability : 'invite_only',
      },
    };
  });

  registry.add('admin.teams.settings.setDescription', { auth: 'admin', scopes: TEAMS_WRITE }, ({ args }) => {
    checkTeam(args, true);
    setTeamPref('description', args.req('description').slice(0, 250));
  });

  registry.add('admin.teams.settings.setDiscoverability', { auth: 'admin', scopes: TEAMS_WRITE }, ({ args }) => {
    checkTeam(args, true);
    const value = args.req('discoverability', 'discoverability_setting_invalid');
    if (!['open', 'invite_only', 'closed', 'unlisted'].includes(value)) fail('discoverability_setting_invalid');
    setTeamPref('discoverability', value);
  });

  // ── User groups' default channels ─────────────────────────────────────────

  const groupOf = (id: string): { id: string; channels: string } => {
    const group = ctx.db.get<{ id: string; channels: string }>('SELECT id, channels FROM usergroups WHERE id = ? AND date_delete = 0', id);
    if (!group) fail('usergroup_not_found');
    return group;
  };
  const channelsArg = (args: Args): string[] => {
    const ids = list(args, 'channel_ids');
    if (ids.length === 0 || ids.length > 100) fail('invalid_channels_limit');
    const invalid = ids.filter((id) => {
      const conv = getConv(ctx, id);
      return !conv || (conv.kind !== 'public' && conv.kind !== 'private');
    });
    if (invalid.length) fail('channel_not_found', { invalid_channels: invalid });
    return ids;
  };
  const saveChannels = (groupId: string, channels: string[]): void => {
    ctx.db.run('UPDATE usergroups SET channels = ?, date_update = ? WHERE id = ?', JSON.stringify(channels), nowSeconds(), groupId);
  };

  registry.add('admin.usergroups.addChannels', { auth: 'admin', scopes: GROUPS_WRITE }, ({ args }) => {
    if (args.str('team_id')) checkTeam(args, true);
    const group = groupOf(args.req('usergroup_id', 'usergroup_not_found'));
    const current = JSON.parse(group.channels) as string[];
    saveChannels(group.id, [...new Set([...current, ...channelsArg(args)])]);
  });

  registry.add('admin.usergroups.removeChannels', { auth: 'admin', scopes: GROUPS_WRITE }, ({ args }) => {
    const group = groupOf(args.req('usergroup_id', 'usergroup_not_found'));
    const removing = new Set(channelsArg(args));
    saveChannels(group.id, (JSON.parse(group.channels) as string[]).filter((id) => !removing.has(id)));
  });

  registry.add('admin.usergroups.listChannels', { auth: 'admin', scopes: GROUPS_READ }, ({ args }) => {
    if (args.str('team_id')) checkTeam(args, true);
    const group = groupOf(args.req('usergroup_id', 'usergroup_not_found'));
    const counts = args.bool('include_num_members');
    return {
      channels: (JSON.parse(group.channels) as string[]).flatMap((id) => {
        const conv = getConv(ctx, id);
        if (!conv) return [];
        return [{ id: conv.id, name: conv.name ?? '', team_id: team().id, ...(counts ? { num_members: memberIds(ctx, conv.id).length } : {}) }];
      }),
    };
  });

  // ── Channels ──────────────────────────────────────────────────────────────

  const channelArg = (args: Args): ConvRow => {
    const conv = getConv(ctx, args.req('channel_id', 'channel_not_found'));
    if (!conv || (conv.kind !== 'public' && conv.kind !== 'private')) fail('channel_not_found');
    return conv;
  };

  registry.add('admin.conversations.lookup', { auth: 'admin', scopes: CONV_READ }, ({ args }) => {
    const teams = list(args, 'team_ids');
    if (!teams.includes(team().id)) fail('no_valid_teams');
    const before = Number(args.req('last_message_activity_before', 'invalid_arguments'));
    const maxMembers = args.int('max_member_count', 1, { min: 0, max: 1_000_000 });
    const rows = ctx.db.all<{ id: string }>(
      `SELECT c.id FROM conversations c
       WHERE c.kind = 'public' AND c.is_archived = 0
         AND coalesce((SELECT max(CAST(m.ts AS REAL)) FROM messages m WHERE m.conversation_id = c.id), c.created) < ?
         AND (SELECT count(*) FROM members mm WHERE mm.conversation_id = c.id) <= ?
       ORDER BY c.id`,
      before,
      maxMembers,
    );
    const { items, next } = page(rows.map((row) => row.id), args, 1000);
    return { channels: items, response_metadata: { next_cursor: next } };
  });

  registry.add('admin.conversations.getConversationPrefs', { auth: 'admin', scopes: CONV_READ }, ({ args }) => {
    const conv = channelArg(args);
    if (conv.is_general === 1) fail('channel_type_not_supported');
    const admins = (conv as ConvRow & { post_policy?: string }).post_policy === 'admins';
    return {
      prefs: {
        who_can_post: { type: admins ? ['admin'] : [], user: [] },
        can_thread: { type: [], user: [] },
        enable_at_channel: { enabled: true },
        enable_at_here: { enabled: true },
      },
    };
  });

  registry.add('admin.conversations.invite', { auth: 'admin', scopes: CONV_WRITE }, ({ actor, args }) => {
    const conv = channelArg(args);
    if (conv.is_archived === 1) fail('channel_not_found');
    const ids = list(args, 'user_ids');
    if (ids.length === 0 || ids.length > 1000) fail('invalid_arguments', { arg: 'user_ids' });
    const failed: string[] = [];
    for (const id of ids) {
      const user = getUser(ctx, id);
      if (!user || user.deleted === 1) {
        failed.push(id);
        continue;
      }
      addMember(ctx, conv, id, { inviter: actor.userId });
    }
    if (failed.length) fail('failed_for_some_users', { failed_user_ids: failed });
  });

  registry.add('admin.conversations.create', { auth: 'admin', scopes: CONV_WRITE }, async (call) => {
    const { args } = call;
    if (!args.str('team_id') && !args.bool('org_wide')) fail('team_id_or_org_required');
    if (args.str('team_id')) checkTeam(args, true);
    const name = normalizeChannelName(args.req('name', 'invalid_name'));
    if (channelNameError(name)) fail('invalid_name');
    const created = await invoke('conversations.create', call, { name, is_private: args.bool('is_private') ? 'true' : 'false' });
    const id = (created.channel as { id: string }).id;
    const description = args.str('description');
    if (description) await invoke('conversations.setPurpose', call, { channel: id, purpose: description });
    return { channel_id: id };
  });

  registry.add('admin.conversations.convertToPublic', { auth: 'admin', scopes: CONV_WRITE }, ({ args }) => {
    const conv = channelArg(args);
    if (conv.kind !== 'private') fail('not_supported');
    ctx.db.run("UPDATE conversations SET kind = 'public', updated = ? WHERE id = ?", nowSeconds(), conv.id);
    // Everyone can find it now.
    ctx.bus.emit({ event: { type: 'channel_updated', channel: { id: conv.id } }, audience: { all: true }, clientOnly: true });
  });

  // ── Decided invite requests ───────────────────────────────────────────────

  interface RequestRow {
    id: string;
    email: string;
    reason: string;
    requested_by: string;
    status: string;
    decided_by: string | null;
    decided: number | null;
    created: number;
  }
  const decided = (status: 'approved' | 'denied'): RequestRow[] =>
    ctx.db.all<RequestRow>('SELECT * FROM invite_requests WHERE status = ? ORDER BY decided DESC, id', status);
  const requestToApi = (row: RequestRow): Record<string, unknown> => ({
    id: row.id,
    email: row.email,
    date_created: row.created,
    requester_ids: [row.requested_by],
    channel_ids: [],
    is_restricted: false,
    is_ultra_restricted: false,
    real_name: null,
    date_expire: null,
    request_reason: row.reason || null,
  });

  registry.add('admin.inviteRequests.approved.list', { auth: 'admin', scopes: INVITES_READ }, ({ args }) => {
    if (args.str('team_id')) checkTeam(args, true);
    const { items, next } = page(decided('approved'), args, 100);
    return {
      approved_requests: items.map((row) => ({
        invite_request: requestToApi(row),
        approved_by: { actor_id: row.decided_by ?? '', actor_type: 'user' },
        invite: { id: row.id, inviter_id: row.decided_by ?? '', email: row.email, date_created: row.decided ?? row.created, date_resent: null, is_bouncing: false },
      })),
      response_metadata: { next_cursor: next },
    };
  });

  registry.add('admin.inviteRequests.denied.list', { auth: 'admin', scopes: INVITES_READ }, ({ args }) => {
    if (args.str('team_id')) checkTeam(args, true);
    const { items, next } = page(decided('denied'), args, 100);
    return {
      denied_requests: items.map((row) => ({ invite_request: requestToApi(row), denied_by: { actor_type: 'user', actor_id: row.decided_by ?? '' } })),
      response_metadata: { next_cursor: next },
    };
  });
}
