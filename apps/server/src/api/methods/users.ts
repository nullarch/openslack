import type { Ctx } from '../../ctx.ts';
import { convToApi, getConv, type MemberRow } from '../../core/conversations.ts';
import { fail } from '../../core/errors.ts';
import { getFile } from '../../core/files.ts';
import { nowSeconds } from '../../core/ids.ts';
import { emitUserChange, getUser, isAdmin, presenceOf, requireUser, userToApi, type UserRow } from '../../core/users.ts';
import { pageByOffset, type Registry } from '../registry.ts';
import { teamToApi } from './client.ts';

const PROFILE_FIELDS = {
  real_name: 80,
  display_name: 80,
  title: 120,
  phone: 40,
  status_text: 100,
  status_emoji: 100,
} as const;

function applyProfile(ctx: Ctx, target: UserRow, profile: Record<string, unknown>): void {
  const updates: Record<string, string | number> = {};
  for (const [field, max] of Object.entries(PROFILE_FIELDS)) {
    const value = profile[field];
    if (typeof value === 'string') updates[field] = value.trim().slice(0, max);
  }
  // Slack splits names; this server stores one full name.
  if (updates.real_name === undefined && (typeof profile.first_name === 'string' || typeof profile.last_name === 'string')) {
    updates.real_name = [profile.first_name, profile.last_name].filter((part) => typeof part === 'string' && part).join(' ');
  }
  if (updates.real_name === '') fail('invalid_name');
  if (profile.status_expiration !== undefined) {
    const expiration = Math.trunc(Number(profile.status_expiration));
    updates.status_expiration = Number.isFinite(expiration) && expiration > 0 ? expiration : 0;
  }
  if (typeof profile.tz === 'string') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: profile.tz });
      updates.tz = profile.tz;
    } catch {
      fail('invalid_timezone');
    }
  }
  const fields = Object.keys(updates);
  if (fields.length === 0) return;
  ctx.db.run(
    `UPDATE users SET ${fields.map((field) => `${field} = ?`).join(', ')}, updated = ? WHERE id = ?`,
    ...fields.map((field) => updates[field]!),
    nowSeconds(),
    target.id,
  );
  emitUserChange(ctx, target.id);
}

export function registerUsers(registry: Registry): void {
  registry.addPublic('api.test', ({ args }) => {
    if (args.has('error')) fail(args.req('error'), { args: args.raw });
    return { args: args.raw };
  });

  registry.add('auth.test', {}, ({ ctx, actor }) => {
    const team = ctx.requireTeam();
    const user = requireUser(ctx, actor.userId);
    const result: Record<string, unknown> = {
      url: `${ctx.config.publicUrl}/`,
      team: team.name,
      user: user.name,
      team_id: team.id,
      user_id: user.id,
      is_enterprise_install: false,
    };
    if (user.bot_id) result.bot_id = user.bot_id;
    if (actor.appId) result.app_id = actor.appId;
    return result;
  });

  registry.add('team.info', { scopes: ['team:read'] }, ({ ctx }) => ({ team: teamToApi(ctx) }));

  registry.add('users.list', { scopes: ['users:read'] }, ({ ctx, actor, args }) => {
    const rows = ctx.db.all<UserRow>("SELECT * FROM users WHERE home = '' ORDER BY created, id");
    const { page, response_metadata } = pageByOffset(rows, args.str('cursor'), args.int('limit', 1000, { min: 1, max: 1000 }));
    return { members: page.map((row) => userToApi(ctx, row, actor)), cache_ts: nowSeconds(), response_metadata };
  });

  registry.add('users.info', { scopes: ['users:read'] }, ({ ctx, actor, args }) => {
    return { user: userToApi(ctx, requireUser(ctx, args.req('user', 'user_not_found')), actor) };
  });

  registry.add('users.lookupByEmail', { scopes: ['users:read.email'] }, ({ ctx, actor, args }) => {
    const row = ctx.db.get<UserRow>('SELECT * FROM users WHERE email = ?', args.req('email').trim().toLowerCase());
    if (!row) fail('users_not_found');
    return { user: userToApi(ctx, row, actor) };
  });

  registry.add('users.profile.get', { scopes: ['users.profile:read', 'users:read'] }, ({ ctx, actor, args }) => {
    const row = requireUser(ctx, args.str('user') || actor.userId);
    return { profile: userToApi(ctx, row, actor).profile };
  });

  registry.add('users.profile.set', { scopes: ['users.profile:write'] }, ({ ctx, actor, args }) => {
    const targetId = args.str('user') || actor.userId;
    if (targetId !== actor.userId && !isAdmin(actor)) fail('cannot_update_admin_user');
    const target = requireUser(ctx, targetId);
    let profile = args.json<Record<string, unknown>>('profile');
    if (!profile && args.has('name')) profile = { [args.req('name')]: args.str('value') ?? '' };
    if (!profile || typeof profile !== 'object') fail('invalid_profile');
    applyProfile(ctx, target, profile);
    return { profile: userToApi(ctx, requireUser(ctx, targetId), actor).profile };
  });

  /** Set the caller's photo from a file uploaded through the normal upload flow. */
  registry.add('users.setPhoto', { scopes: ['users.profile:write'] }, ({ ctx, actor, args }) => {
    const file = getFile(ctx, args.req('file_id')) ?? fail('file_not_found');
    if (file.user_id !== actor.userId || file.state === 'pending') fail('file_not_found');
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.mimetype)) fail('bad_image');
    ctx.db.run('UPDATE users SET avatar_key = ?, updated = ? WHERE id = ?', file.storage_key, nowSeconds(), actor.userId);
    emitUserChange(ctx, actor.userId);
    return { profile: userToApi(ctx, requireUser(ctx, actor.userId), actor).profile };
  });

  registry.add('users.deletePhoto', { scopes: ['users.profile:write'] }, ({ ctx, actor }) => {
    ctx.db.run('UPDATE users SET avatar_key = NULL, updated = ? WHERE id = ?', nowSeconds(), actor.userId);
    emitUserChange(ctx, actor.userId);
  });

  registry.add('users.getPresence', { scopes: ['users:read'] }, ({ ctx, actor, args }) => {
    const row = requireUser(ctx, args.str('user') || actor.userId);
    const presence = presenceOf(ctx, row);
    const result: Record<string, unknown> = { presence };
    if (row.id === actor.userId) {
      result.online = ctx.presence.isOnline(row.id);
      result.auto_away = false;
      result.manual_away = row.manual_presence === 'away';
      result.connection_count = ctx.presence.isOnline(row.id) ? 1 : 0;
    }
    return result;
  });

  registry.add('users.setPresence', { scopes: ['users:write'] }, ({ ctx, actor, args }) => {
    const presence = args.req('presence');
    if (presence !== 'auto' && presence !== 'away') fail('invalid_presence');
    ctx.db.run('UPDATE users SET manual_presence = ? WHERE id = ?', presence, actor.userId);
    const row = requireUser(ctx, actor.userId);
    ctx.bus.emit({
      event: { type: 'presence_change', user: row.id, presence: presenceOf(ctx, row) },
      audience: { all: true },
      clientOnly: true,
    });
  });

  /** Conversations a user belongs to. */
  registry.add(
    'users.conversations',
    { scopes: ['channels:read', 'groups:read', 'im:read', 'mpim:read'] },
    ({ ctx, actor, args }) => {
      const userId = args.str('user') || actor.userId;
      if (!getUser(ctx, userId)) fail('user_not_found');
      const types = new Set(args.has('types') ? args.list('types') : ['public_channel']);
      const kinds: string[] = [];
      if (types.has('public_channel')) kinds.push('public');
      if (types.has('private_channel')) kinds.push('private');
      if (types.has('im')) kinds.push('im');
      if (types.has('mpim')) kinds.push('mpim');
      const excludeArchived = args.bool('exclude_archived');
      const memberships = ctx.db.all<MemberRow>('SELECT * FROM members WHERE user_id = ? ORDER BY joined', userId);
      const channels = [];
      for (const member of memberships) {
        const conv = getConv(ctx, member.conversation_id);
        if (!conv || !kinds.includes(conv.kind)) continue;
        if (excludeArchived && conv.is_archived === 1) continue;
        // Someone else's private memberships are visible only where the caller is a member too.
        if (userId !== actor.userId && conv.kind !== 'public') {
          if (!ctx.db.get('SELECT 1 FROM members WHERE conversation_id = ? AND user_id = ?', conv.id, actor.userId)) continue;
        }
        channels.push(convToApi(ctx, conv, actor.userId));
      }
      const { page, response_metadata } = pageByOffset(channels, args.str('cursor'), args.int('limit', 100, { min: 1, max: 1000 }));
      return { channels: page, response_metadata };
    },
  );

  registry.add('bots.info', { scopes: ['users:read'] }, ({ ctx, args }) => {
    const row = ctx.db.get<UserRow>('SELECT * FROM users WHERE bot_id = ?', args.req('bot', 'bot_not_found'));
    if (!row) fail('bot_not_found');
    const api = userToApi(ctx, row);
    return {
      bot: {
        id: row.bot_id,
        deleted: row.deleted === 1,
        name: row.real_name || row.name,
        updated: row.updated,
        app_id: row.app_id,
        user_id: row.id,
        icons: { image_36: api.profile.image_32, image_48: api.profile.image_48, image_72: api.profile.image_72 },
      },
    };
  });
}
