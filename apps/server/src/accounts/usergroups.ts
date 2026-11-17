import type { Kernel } from '../app.ts';
import type { Args } from '../api/registry.ts';
import { addMember, canSee, getConv } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import { getUser } from '../core/users.ts';
import type { Actor, Ctx } from '../ctx.ts';
import { isGuest } from '../core/guests.ts';
import { allowedTo } from './prefs.ts';

/**
 * User groups (`@design`, `@oncall`) in Slack's shapes: a mention of the
 * group reaches every member, and a group's default channels are joined by
 * whoever is added to it.
 */

export interface GroupRow {
  id: string;
  name: string;
  handle: string;
  description: string;
  channels: string;
  created_by: string;
  updated_by: string;
  deleted_by: string | null;
  date_create: number;
  date_update: number;
  date_delete: number;
}

const READ = ['usergroups:read'];
const WRITE = ['usergroups:write'];

export function groupMembers(ctx: Ctx, id: string): string[] {
  return ctx.db
    .all<{ user_id: string }>('SELECT user_id FROM usergroup_members WHERE usergroup_id = ? ORDER BY user_id', id)
    .map((row) => row.user_id);
}

export function groupToApi(ctx: Ctx, row: GroupRow, options: { users?: boolean; count?: boolean } = {}): Record<string, unknown> {
  const members = groupMembers(ctx, row.id);
  const channels = JSON.parse(row.channels) as string[];
  const out: Record<string, unknown> = {
    id: row.id,
    team_id: ctx.requireTeam().id,
    is_usergroup: true,
    is_subteam: true,
    name: row.name,
    description: row.description,
    handle: row.handle,
    is_external: false,
    date_create: row.date_create,
    date_update: row.date_update,
    date_delete: row.date_delete,
    auto_type: null,
    created_by: row.created_by,
    updated_by: row.updated_by,
    deleted_by: row.deleted_by,
    prefs: { channels, groups: [] },
    channel_count: channels.length,
  };
  if (options.users) out.users = members;
  if (options.count) out.user_count = members.length;
  return out;
}

function findGroup(ctx: Ctx, id: string | undefined): GroupRow {
  const row = id ? ctx.db.get<GroupRow>('SELECT * FROM usergroups WHERE id = ?', id) : undefined;
  if (!row) fail('no_such_subteam');
  return row;
}

function requireManage(ctx: Ctx, actor: Actor): void {
  if (!allowedTo(ctx, actor.userId, 'who_can_manage_usergroups')) fail('permission_denied');
}

function cleanHandle(input: string): string {
  const handle = input.trim().replace(/^@/, '').toLowerCase();
  if (!handle || handle.length > 21 || !/^[\p{Ll}\p{Lo}\p{N}._-]+$/u.test(handle)) fail('invalid_handle');
  return handle;
}

function checkUnique(ctx: Ctx, name: string, handle: string, except: string | null): void {
  if (ctx.db.get('SELECT 1 FROM usergroups WHERE name = ? AND id IS NOT ?', name, except)) fail('name_already_exists');
  // A handle may not shadow a person's or another group's @name.
  if (ctx.db.get('SELECT 1 FROM usergroups WHERE handle = ? AND id IS NOT ?', handle, except)) fail('handle_already_exists');
  if (ctx.db.get('SELECT 1 FROM users WHERE name = ?', handle)) fail('handle_already_exists');
  if (['here', 'channel', 'everyone'].includes(handle)) fail('handle_already_exists');
}

function channelsArg(ctx: Ctx, actor: Actor, args: Args): string[] | undefined {
  if (args.raw.channels === undefined) return undefined;
  const ids = args.list('channels');
  for (const id of ids) {
    const conv = getConv(ctx, id);
    if (!conv || !canSee(ctx, conv, actor.userId) || (conv.kind !== 'public' && conv.kind !== 'private')) fail('channel_not_found');
  }
  return [...new Set(ids)];
}

function usersArg(ctx: Ctx, args: Args, name: string): string[] {
  const ids = [...new Set(args.list(name))];
  for (const id of ids) {
    const user = getUser(ctx, id);
    if (!user || user.deleted === 1 || user.is_bot === 1) fail('invalid_users', { user: id });
  }
  return ids;
}

/** Put new members into the group's default channels. */
function joinDefaults(ctx: Ctx, row: GroupRow, users: string[]): void {
  for (const id of JSON.parse(row.channels) as string[]) {
    const conv = getConv(ctx, id);
    if (!conv || conv.is_archived === 1) continue;
    for (const user of users) {
      // Guests never get more channels than an admin gave them.
      if (isGuest(ctx, user)) continue;
      addMember(ctx, conv, user);
    }
  }
}

function emit(ctx: Ctx, type: string, row: GroupRow, extra: Record<string, unknown> = {}): void {
  const fresh = findGroup(ctx, row.id);
  ctx.bus.emit({
    event: { type, subteam: groupToApi(ctx, fresh, { users: true, count: true }), event_ts: ctx.clock.eventTs(), ...extra },
    audience: { all: true },
  });
}

function setMembers(ctx: Ctx, row: GroupRow, actor: Actor, users: string[]): void {
  const before = new Set(groupMembers(ctx, row.id));
  const after = new Set(users);
  const added = users.filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id));
  const previous = row.date_update;
  const now = nowSeconds();
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM usergroup_members WHERE usergroup_id = ?', row.id);
    for (const id of users) ctx.db.run('INSERT INTO usergroup_members (usergroup_id, user_id) VALUES (?, ?)', row.id, id);
    ctx.db.run('UPDATE usergroups SET date_update = ?, updated_by = ? WHERE id = ?', now, actor.userId, row.id);
  });
  if (added.length === 0 && removed.length === 0) return;
  joinDefaults(ctx, row, added);
  const team = ctx.requireTeam().id;
  ctx.bus.emit({
    event: {
      type: 'subteam_members_changed',
      subteam_id: row.id,
      team_id: team,
      date_previous_update: previous,
      date_update: now,
      added_users: added,
      added_users_count: String(added.length),
      removed_users: removed,
      removed_users_count: String(removed.length),
      event_ts: ctx.clock.eventTs(),
    },
    audience: { all: true },
  });
  if (added.length) ctx.bus.emit({ event: { type: 'subteam_self_added', subteam_id: row.id }, audience: { users: added } });
  if (removed.length) ctx.bus.emit({ event: { type: 'subteam_self_removed', subteam_id: row.id }, audience: { users: removed } });
}

/** All active groups with members, for the client's boot. Guests see none. */
export function groupsForBoot(ctx: Ctx, viewerId: string): Record<string, unknown>[] {
  if (isGuest(ctx, viewerId)) return [];
  return ctx.db
    .all<GroupRow>('SELECT * FROM usergroups WHERE date_delete = 0 ORDER BY handle')
    .map((row) => groupToApi(ctx, row, { users: true, count: true }));
}

export function installUsergroups(kernel: Kernel): void {
  const { ctx, registry } = kernel;

  registry.add('usergroups.create', { scopes: WRITE }, ({ actor, args }) => {
    requireManage(ctx, actor);
    const name = args.req('name', 'invalid_name').trim().slice(0, 80);
    if (!name) fail('invalid_name');
    const handle = cleanHandle(args.str('handle') || name.replace(/\s+/g, '-'));
    checkUnique(ctx, name, handle, null);
    const channels = channelsArg(ctx, actor, args) ?? [];
    const id = newId('S');
    const now = nowSeconds();
    ctx.db.run(
      `INSERT INTO usergroups (id, name, handle, description, channels, created_by, updated_by, date_create, date_update)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      name,
      handle,
      (args.str('description') ?? '').slice(0, 250),
      JSON.stringify(channels),
      actor.userId,
      actor.userId,
      now,
      now,
    );
    const row = findGroup(ctx, id);
    emit(ctx, 'subteam_created', row);
    // Not in Slack's create, but saves a round trip for the people who set up a group with members.
    if (args.raw.users !== undefined) setMembers(ctx, row, actor, usersArg(ctx, args, 'users'));
    return { usergroup: groupToApi(ctx, findGroup(ctx, id), { users: true, count: args.bool('include_count') }) };
  });

  registry.add('usergroups.update', { scopes: WRITE }, ({ actor, args }) => {
    requireManage(ctx, actor);
    const row = findGroup(ctx, args.str('usergroup'));
    const name = args.has('name') ? args.req('name').trim().slice(0, 80) : row.name;
    if (!name) fail('invalid_name');
    const handle = args.has('handle') ? cleanHandle(args.req('handle')) : row.handle;
    checkUnique(ctx, name, handle, row.id);
    const channels = channelsArg(ctx, actor, args);
    ctx.db.run(
      'UPDATE usergroups SET name = ?, handle = ?, description = ?, channels = ?, updated_by = ?, date_update = ? WHERE id = ?',
      name,
      handle,
      args.has('description') || args.raw.description === '' ? (args.str('description') ?? '').slice(0, 250) : row.description,
      channels ? JSON.stringify(channels) : row.channels,
      actor.userId,
      nowSeconds(),
      row.id,
    );
    if (channels) joinDefaults(ctx, findGroup(ctx, row.id), groupMembers(ctx, row.id));
    emit(ctx, 'subteam_updated', row);
    return { usergroup: groupToApi(ctx, findGroup(ctx, row.id), { users: true, count: args.bool('include_count') }) };
  });

  const setEnabled = (enabled: boolean) => ({ actor, args }: { actor: Actor; args: Args }) => {
    requireManage(ctx, actor);
    const row = findGroup(ctx, args.str('usergroup'));
    ctx.db.run(
      'UPDATE usergroups SET date_delete = ?, deleted_by = ?, updated_by = ?, date_update = ? WHERE id = ?',
      enabled ? 0 : nowSeconds(),
      enabled ? null : actor.userId,
      actor.userId,
      nowSeconds(),
      row.id,
    );
    emit(ctx, 'subteam_updated', row);
    return { usergroup: groupToApi(ctx, findGroup(ctx, row.id), { users: true, count: args.bool('include_count') }) };
  };
  registry.add('usergroups.disable', { scopes: WRITE }, setEnabled(false));
  registry.add('usergroups.enable', { scopes: WRITE }, setEnabled(true));

  registry.add('usergroups.list', { scopes: READ }, ({ actor, args }) => {
    if (isGuest(ctx, actor.userId)) return { usergroups: [] };
    const rows = ctx.db.all<GroupRow>(
      `SELECT * FROM usergroups ${args.bool('include_disabled') ? '' : 'WHERE date_delete = 0'} ORDER BY handle`,
    );
    return {
      usergroups: rows.map((row) => groupToApi(ctx, row, { users: args.bool('include_users'), count: args.bool('include_count') })),
    };
  });

  registry.add('usergroups.users.list', { scopes: READ }, ({ actor, args }) => {
    if (isGuest(ctx, actor.userId)) fail('no_such_subteam');
    const row = findGroup(ctx, args.str('usergroup'));
    if (row.date_delete !== 0 && !args.bool('include_disabled')) fail('no_such_subteam');
    return { users: groupMembers(ctx, row.id) };
  });

  registry.add('usergroups.users.update', { scopes: WRITE }, ({ actor, args }) => {
    requireManage(ctx, actor);
    const row = findGroup(ctx, args.str('usergroup'));
    if (args.raw.users === undefined) fail('no_users_provided');
    setMembers(ctx, row, actor, usersArg(ctx, args, 'users'));
    return { usergroup: groupToApi(ctx, findGroup(ctx, row.id), { users: true, count: args.bool('include_count') }) };
  });
}
