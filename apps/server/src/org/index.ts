import type { Kernel } from '../app.ts';
import { Args, type MethodDef } from '../api/registry.ts';
import type { Actor, Ctx } from '../ctx.ts';
import { addMember, conversationExtensions, convToApi, getConv, getMember, removeMember, type ConvRow } from '../core/conversations.ts';
import { ApiError, fail } from '../core/errors.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import { getUser, isAdmin, type UserRow } from '../core/users.ts';
import { assignmentsOf, grantedByRole, ROLES } from './roles.ts';

/**
 * An organisation with several workspaces, as in Slack's Enterprise Grid.
 *
 * The workspace row (`team`) is the organisation and its first workspace,
 * which everyone belongs to. Further workspaces (`workspaces`) have their own
 * members and channels: a public channel of one is visible to its members
 * only, while an org-wide channel appears in all of them. Settings, policies
 * and people are the organisation's; nothing changes while there is only the
 * first workspace. Admin roles (`roles.ts`) let people who are not admins run
 * parts of the administration.
 */

interface WorkspaceRow {
  id: string;
  name: string;
  domain: string;
  description: string;
  discoverability: string;
  created: number;
  created_by: string;
}

type Json = Record<string, unknown>;
type Handler = MethodDef['handler'];

const DOMAIN = /^[a-z0-9][a-z0-9-]{0,20}$/;

export function workspaceById(ctx: Ctx, id: string): WorkspaceRow | undefined {
  return ctx.db.get<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', id);
}

/** The workspaces someone belongs to: the first (the organisation's own) and the further ones they were added to. */
export function workspacesOf(ctx: Ctx, userId: string): { id: string; name: string; domain: string; first: boolean }[] {
  const team = ctx.requireTeam();
  const further = ctx.db.all<WorkspaceRow>('SELECT w.* FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.name', userId);
  return [{ id: team.id, name: team.name, domain: team.domain, first: true }, ...further.map((row) => ({ id: row.id, name: row.name, domain: row.domain, first: false }))];
}

function allWorkspaceIds(ctx: Ctx): string[] {
  return [ctx.requireTeam().id, ...ctx.db.all<{ id: string }>('SELECT id FROM workspaces ORDER BY created').map((row) => row.id)];
}

let extended = false;

/** Org-wide channels in Slack's fields: shared between all the organisation's workspaces. */
function extendConversations(): void {
  if (extended) return;
  extended = true;
  conversationExtensions.push((ctx, conv, out) => {
    if (conv.org_wide !== 1 || (conv.kind !== 'public' && conv.kind !== 'private')) return;
    out.is_shared = true;
    out.is_org_shared = true;
    out.shared_team_ids = allWorkspaceIds(ctx);
  });
}

export function installOrg(kernel: Kernel): void {
  const { ctx, registry } = kernel;
  extendConversations();
  registry.grants.push((name, actor, args) => grantedByRole(ctx, actor, name, args.str('team_id')));

  /** Replace a method, keeping the original for the cases this module does not handle. */
  const wrap = (name: string, make: (original: Handler) => Handler): void => {
    const original = registry.get(name);
    if (!original) throw new Error(`cannot wrap missing method ${name}`);
    registry.add(name, { auth: original.auth === 'none' ? undefined : original.auth, scopes: original.scopes }, make(original.handler));
  };
  const isOrgAdmin = (actor: Actor): boolean => isAdmin(actor);
  /** A workspace argument: the organisation's own (null) or a further workspace. */
  const workspaceArg = (args: Args, name = 'team_id'): WorkspaceRow | null => {
    const id = args.str(name);
    if (!id || id === ctx.requireTeam().id) return null;
    return workspaceById(ctx, id) ?? fail('team_not_found');
  };
  const requireMember = (workspace: WorkspaceRow, userId: string): void => {
    if (!ctx.db.get('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?', workspace.id, userId)) fail('team_not_found');
  };
  const emitWorkspaces = (userIds: string[]): void => {
    for (const userId of userIds) {
      ctx.bus.emit({ event: { type: 'workspaces_changed', workspaces: workspacesOf(ctx, userId) }, audience: { users: [userId] }, clientOnly: true });
    }
  };

  // ── What the web client needs ─────────────────────────────────────────────

  wrap('client.boot', (original) => async (callArgs) => {
    const result = ((await original(callArgs)) ?? {}) as Json;
    const self = callArgs.actor.userId;
    return {
      ...result,
      workspaces: workspacesOf(ctx, self),
      admin_roles: assignmentsOf(ctx, self).map((entry) => ({ role_id: entry.role_id, entity_id: entry.entity_id })),
    };
  });

  registry.add('client.org.info', { auth: 'session' }, ({ actor }) => {
    const team = ctx.requireTeam();
    const canSeeAll = isOrgAdmin(actor) || assignmentsOf(ctx, actor.userId).some((entry) => ['Rl01', 'Rl02', 'Rl03'].includes(entry.role_id));
    const workspaces = canSeeAll ? ctx.db.all<WorkspaceRow>('SELECT * FROM workspaces ORDER BY name') : [];
    return {
      organisation: { id: team.id, name: team.name, domain: team.domain },
      workspaces: workspaces.map((row) => ({
        id: row.id,
        name: row.name,
        domain: row.domain,
        description: row.description,
        members: ctx.db.all<{ user_id: string }>('SELECT user_id FROM workspace_members WHERE workspace_id = ? ORDER BY created', row.id).map((entry) => entry.user_id),
      })),
      roles: Object.entries(ROLES).map(([id, role]) => ({ id, name: role.name, scope: role.scope })),
      assignments: canSeeAll ? ctx.db.all<{ role_id: string; entity_id: string; user_id: string; created: number }>('SELECT * FROM role_assignments ORDER BY created') : [],
    };
  });

  // ── Workspaces ────────────────────────────────────────────────────────────

  registry.add('admin.teams.create', { auth: 'admin', scopes: ['admin.teams:write'] }, ({ actor, args }) => {
    if (!isOrgAdmin(actor)) fail('not_an_admin');
    const name = args.req('team_name', 'must_provide_team_name').trim().slice(0, 80);
    const domain = args.req('team_domain', 'must_provide_team_domain').trim().toLowerCase();
    if (!DOMAIN.test(domain)) fail('bad_url');
    if (domain === ctx.requireTeam().domain || ctx.db.get('SELECT 1 FROM workspaces WHERE domain = ?', domain)) fail('domain_taken');
    if (name.toLowerCase() === ctx.requireTeam().name.toLowerCase() || ctx.db.get('SELECT 1 FROM workspaces WHERE lower(name) = lower(?)', name)) fail('name_taken_in_org');
    const discoverability = args.str('team_discoverability') ?? 'open';
    if (!['open', 'closed', 'invite_only', 'unlisted'].includes(discoverability)) fail('discoverability_setting_invalid');
    const id = newId('T');
    ctx.db.tx(() => {
      ctx.db.run(
        'INSERT INTO workspaces (id, name, domain, description, discoverability, created, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        name,
        domain,
        (args.str('team_description') ?? '').slice(0, 250),
        discoverability,
        nowSeconds(),
        actor.userId,
      );
      ctx.db.run('INSERT INTO workspace_members (workspace_id, user_id, created) VALUES (?, ?, ?)', id, actor.userId, nowSeconds());
    });
    emitWorkspaces([actor.userId]);
    return { team: id };
  });

  wrap('admin.teams.list', (original) => async (callArgs) => {
    const result = ((await original(callArgs)) ?? {}) as { teams?: Json[] };
    const further = ctx.db.all<WorkspaceRow>('SELECT * FROM workspaces ORDER BY created').map((row) => ({
      id: row.id,
      name: row.name,
      discoverability: row.discoverability,
      primary_owner: (result.teams?.[0]?.primary_owner as Json | undefined) ?? { user_id: '', email: '' },
      team_url: `${ctx.config.publicUrl}/`,
    }));
    return { ...result, teams: [...(result.teams ?? []), ...further] };
  });

  wrap('admin.teams.settings.info', (original) => async (callArgs) => {
    const workspace = workspaceArg(callArgs.args);
    if (!workspace) return original(callArgs);
    return {
      team: {
        id: workspace.id,
        name: workspace.name,
        domain: workspace.domain,
        email_domain: '',
        icon: { image_default: true },
        enterprise_id: ctx.requireTeam().id,
        enterprise_name: ctx.requireTeam().name,
        default_channels: [],
        description: workspace.description,
        discoverability: workspace.discoverability,
      },
    };
  });

  for (const [method, column, arg] of [
    ['admin.teams.settings.setName', 'name', 'name'],
    ['admin.teams.settings.setDescription', 'description', 'description'],
    ['admin.teams.settings.setDiscoverability', 'discoverability', 'discoverability'],
  ] as const) {
    wrap(method, (original) => async (callArgs) => {
      const workspace = workspaceArg(callArgs.args);
      if (!workspace) return original(callArgs);
      const value = callArgs.args.req(arg).trim();
      if (column === 'discoverability' && !['open', 'invite_only', 'closed', 'unlisted'].includes(value)) fail('discoverability_setting_invalid');
      ctx.db.run(`UPDATE workspaces SET ${column} = ? WHERE id = ?`, value.slice(0, column === 'name' ? 80 : 250), workspace.id);
      emitWorkspaces(ctx.db.all<{ user_id: string }>('SELECT user_id FROM workspace_members WHERE workspace_id = ?', workspace.id).map((row) => row.user_id));
      return {};
    });
  }

  // ── People in workspaces ──────────────────────────────────────────────────

  registry.add('admin.users.assign', { auth: 'admin', scopes: ['admin.users:write'] }, ({ actor, args }) => {
    const workspace = workspaceArg(args);
    const user = getUser(ctx, args.req('user_id', 'user_not_found'));
    if (!user || user.home) fail('user_not_found');
    if (user.is_bot === 1) fail('user_is_bot');
    if (user.deleted === 1) fail('user_cannot_be_added_to_workspace');
    // Everyone is in the organisation's first workspace already.
    if (!workspace) fail('user_already_team_member');
    if (!ctx.db.run('INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, created) VALUES (?, ?, ?)', workspace.id, user.id, nowSeconds()).changes) fail('user_already_team_member');
    const channels = (args.str('channel_ids') ?? '').split(',').map((id) => id.trim()).filter(Boolean);
    if (channels.length > 100) fail('too_many_channels');
    for (const id of channels) {
      const conv = getConv(ctx, id);
      if (!conv || conv.is_archived === 1 || (conv.kind !== 'public' && conv.kind !== 'private')) continue;
      if (conv.kind === 'private' && !getMember(ctx, conv.id, actor.userId)) fail('invitor_cannot_see_channel');
      addMember(ctx, conv, user.id, { inviter: actor.userId });
    }
    emitWorkspaces([user.id]);
  });

  wrap('admin.users.remove', (original) => async (callArgs) => {
    const workspace = workspaceArg(callArgs.args);
    if (!workspace) return original(callArgs);
    const userId = callArgs.args.req('user_id', 'user_not_found');
    if (!ctx.db.run('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?', workspace.id, userId).changes) fail('user_not_found');
    // They leave the workspace's channels too; org-wide ones stay theirs.
    for (const conv of ctx.db.all<ConvRow>("SELECT c.* FROM conversations c JOIN members m ON m.conversation_id = c.id WHERE m.user_id = ? AND c.workspace_id = ? AND c.org_wide = 0 AND c.kind IN ('public', 'private')", userId, workspace.id)) {
      removeMember(ctx, conv, userId);
    }
    emitWorkspaces([userId]);
    return {};
  });

  wrap('admin.users.list', (original) => async (callArgs) => {
    const workspace = workspaceArg(callArgs.args);
    const result = ((await original({ ...callArgs, args: new Args({ ...callArgs.args.raw, team_id: undefined } as never) })) ?? {}) as { users?: (Json & { id: string })[] };
    let users = result.users ?? [];
    if (workspace) {
      const inside = new Set(ctx.db.all<{ user_id: string }>('SELECT user_id FROM workspace_members WHERE workspace_id = ?', workspace.id).map((row) => row.user_id));
      users = users.filter((user) => inside.has(user.id));
    }
    return { ...result, users: users.map((user) => ({ ...user, workspaces: workspacesOf(ctx, user.id).map((entry) => entry.id) })) };
  });

  // ── Channels in workspaces ────────────────────────────────────────────────

  // Channels go into a workspace its own people (or a Channel Admin for it) create them in.
  wrap('conversations.create', (original) => (callArgs) => {
    const workspace = workspaceArg(callArgs.args);
    const { actor } = callArgs;
    if (workspace && !isOrgAdmin(actor) && !grantedByRole(ctx, actor, 'admin.conversations.create', workspace.id)) requireMember(workspace, actor.userId);
    return original(callArgs);
  });

  wrap('conversations.list', (original) => async (callArgs) => {
    const teamId = callArgs.args.str('team_id');
    const result = ((await original(callArgs)) ?? {}) as { channels?: (Json & { id: string })[] };
    if (!teamId) return result;
    if (teamId !== ctx.requireTeam().id && !workspaceById(ctx, teamId)) fail('team_not_found');
    return {
      ...result,
      channels: (result.channels ?? []).filter((channel) => {
        const conv = getConv(ctx, channel.id);
        if (!conv || conv.kind === 'im' || conv.kind === 'mpim') return true;
        return conv.org_wide === 1 || (conv.workspace_id ?? ctx.requireTeam().id) === teamId;
      }),
    };
  });

  const emitChannel = (id: string): void => {
    const conv = getConv(ctx, id);
    if (!conv) return;
    ctx.bus.emit({ event: { type: 'channel_updated', channel: convToApi(ctx, conv, null), event_ts: ctx.clock.eventTs() }, audience: { conversation: conv.id }, clientOnly: true });
  };

  registry.add('admin.conversations.setTeams', { auth: 'admin', scopes: ['admin.conversations:write'] }, ({ args }) => {
    const conv = getConv(ctx, args.req('channel_id', 'invalid_channel_id'));
    if (!conv) fail('channel_not_found');
    if (conv.kind !== 'public' && conv.kind !== 'private') fail('channel_type_not_supported');
    if (conv.is_general === 1) fail('default_org_wide_channel');
    if (args.bool('org_channel')) {
      ctx.db.run('UPDATE conversations SET org_wide = 1 WHERE id = ?', conv.id);
    } else {
      const targets = (args.str('target_team_ids') ?? args.str('team_id') ?? '').split(',').map((id) => id.trim()).filter(Boolean);
      if (targets.length === 0) fail('unsupported_arguments');
      const known = new Set(allWorkspaceIds(ctx));
      if (targets.some((id) => !known.has(id))) fail('invalid_target_team');
      if (targets.length === known.size) ctx.db.run('UPDATE conversations SET org_wide = 1 WHERE id = ?', conv.id);
      else if (targets.length === 1) ctx.db.run('UPDATE conversations SET workspace_id = ?, org_wide = 0 WHERE id = ?', targets[0] === ctx.requireTeam().id ? null : targets[0]!, conv.id);
      // A channel is in one workspace or in all of them here.
      else fail('too_many_target_teams');
    }
    emitChannel(conv.id);
  });

  registry.add('admin.conversations.getTeams', { auth: 'admin', scopes: ['admin.conversations:read'] }, ({ args }) => {
    const conv = getConv(ctx, args.req('channel_id', 'channel_not_found'));
    if (!conv) fail('channel_not_found');
    if (conv.kind !== 'public' && conv.kind !== 'private') fail('channel_type_not_supported');
    return { team_ids: conv.org_wide === 1 ? allWorkspaceIds(ctx) : [conv.workspace_id ?? ctx.requireTeam().id] };
  });

  // ── Admin roles ───────────────────────────────────────────────────────────

  const READ_ROLES = ['admin.roles:read'];
  const WRITE_ROLES = ['admin.roles:write'];

  registry.add('admin.roles.listAssignments', { auth: 'admin', scopes: READ_ROLES }, ({ args }) => {
    const roleIds = args.has('role_ids') ? args.list('role_ids') : [];
    if (roleIds.some((id) => !ROLES[id])) fail('invalid_role_id');
    const entityIds = args.has('entity_ids') ? args.list('entity_ids') : [];
    const sort = (args.str('sort_dir') ?? 'DESC').toUpperCase();
    if (sort !== 'ASC' && sort !== 'DESC') fail('invalid_sort');
    const limit = args.int('limit', 200, { min: 1, max: 200 });
    const offset = args.str('cursor') ? Number(Buffer.from(args.str('cursor')!, 'base64').toString('utf8')) : 0;
    if (!Number.isInteger(offset) || offset < 0) fail('invalid_cursor');
    const rows = ctx.db
      .all<{ role_id: string; entity_id: string; user_id: string; created: number }>(`SELECT * FROM role_assignments ORDER BY created ${sort}, role_id, user_id`)
      .filter((row) => (roleIds.length === 0 || roleIds.includes(row.role_id)) && (entityIds.length === 0 || entityIds.includes(row.entity_id)));
    const page = rows.slice(offset, offset + limit);
    return {
      role_assignments: page.map((row) => ({ role_id: row.role_id, entity_id: row.entity_id, user_id: row.user_id, date_create: row.created })),
      response_metadata: { next_cursor: offset + limit < rows.length ? Buffer.from(String(offset + limit)).toString('base64') : '' },
    };
  });

  const assignmentArgs = (args: Args): { roleId: string; entities: string[]; users: UserRow[] } => {
    const roleId = args.req('role_id', 'invalid_role_id');
    if (!ROLES[roleId]) fail('invalid_role_id');
    const entities = args.list('entity_ids');
    const userIds = args.list('user_ids');
    if (entities.length > 10) fail('too_many_entities');
    if (userIds.length > 10) fail('too_many_users');
    const org = ctx.requireTeam().id;
    const validEntity = (id: string): boolean => {
      if (id === org) return true;
      if (ROLES[roleId]!.scope === 'org') return false;
      if (workspaceById(ctx, id)) return true;
      // Channel Manager is held for a channel.
      return roleId === 'Rl0A' && /^[CG][A-Z0-9]+$/.test(id) && getConv(ctx, id) !== undefined;
    };
    const goodEntities = entities.filter(validEntity);
    const users = userIds.map((id) => getUser(ctx, id)).filter((user): user is UserRow => user !== undefined && user.deleted === 0 && user.is_bot === 0 && !user.home);
    if (goodEntities.length === 0) fail('no_valid_entities');
    if (users.length === 0) fail('no_valid_users');
    const rejectedEntities = entities.filter((id) => !goodEntities.includes(id));
    if (rejectedEntities.length) throw new ApiError('failed_for_some_entities', { rejected_entities: rejectedEntities.map((id) => ({ id, error: 'invalid_entity' })) });
    if (users.length < userIds.length) throw new ApiError('failed_for_some_users', { rejected_users: userIds.filter((id) => !users.some((user) => user.id === id)).map((id) => ({ id, error: 'invalid_user' })) });
    return { roleId, entities: goodEntities, users };
  };

  const notifyRoles = (userIds: string[]): void => {
    for (const userId of userIds) {
      ctx.bus.emit({ event: { type: 'admin_roles_changed', admin_roles: assignmentsOf(ctx, userId) }, audience: { users: [userId] }, clientOnly: true });
    }
  };

  registry.add('admin.roles.addAssignments', { auth: 'admin', scopes: WRITE_ROLES }, ({ actor, args }) => {
    const { roleId, entities, users } = assignmentArgs(args);
    // Only admins (not Role Admins) hand out Role Admin.
    if (roleId === 'Rl02' && !isOrgAdmin(actor)) fail('cannot_modify_role_admin');
    ctx.db.tx(() => {
      for (const entity of entities) {
        for (const user of users) {
          ctx.db.run('INSERT OR IGNORE INTO role_assignments (role_id, entity_id, user_id, created) VALUES (?, ?, ?, ?)', roleId, entity, user.id, nowSeconds());
          if (roleId === 'Rl0A' && /^[CG]/.test(entity)) ctx.db.run('INSERT OR IGNORE INTO channel_managers (conversation_id, user_id) VALUES (?, ?)', entity, user.id);
        }
      }
    });
    notifyRoles(users.map((user) => user.id));
    for (const entity of entities) if (roleId === 'Rl0A' && /^[CG]/.test(entity)) emitChannel(entity);
  });

  registry.add('admin.roles.removeAssignments', { auth: 'admin', scopes: WRITE_ROLES }, ({ actor, args }) => {
    const { roleId, entities, users } = assignmentArgs(args);
    if (roleId === 'Rl02' && !isOrgAdmin(actor)) fail('cannot_modify_role_admin');
    ctx.db.tx(() => {
      for (const entity of entities) {
        for (const user of users) {
          ctx.db.run('DELETE FROM role_assignments WHERE role_id = ? AND entity_id = ? AND user_id = ?', roleId, entity, user.id);
          if (roleId === 'Rl0A' && /^[CG]/.test(entity)) ctx.db.run('DELETE FROM channel_managers WHERE conversation_id = ? AND user_id = ?', entity, user.id);
        }
      }
    });
    notifyRoles(users.map((user) => user.id));
    for (const entity of entities) if (roleId === 'Rl0A' && /^[CG]/.test(entity)) emitChannel(entity);
  });

  // A person leaving the workspace keeps no roles.
  kernel.onClose.push(
    ctx.bus.subscribe(({ event }) => {
      if (event.type !== 'user_change') return;
      const user = event.user as { id?: string; deleted?: boolean } | undefined;
      if (user?.id && user.deleted) ctx.db.run('DELETE FROM role_assignments WHERE user_id = ?', user.id);
    }),
  );
}
