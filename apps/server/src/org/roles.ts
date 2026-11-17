import type { Actor, Ctx } from '../ctx.ts';

/**
 * Admin roles, by Slack's role ids, so `admin.roles.*` callers work unchanged.
 * Each opens a set of admin methods to someone who is not a workspace admin:
 * held for the organisation (the `team` id) it applies everywhere; held for a
 * further workspace it applies to calls that name that workspace (`team_id`);
 * Channel Manager held for a channel makes its holder a manager of that channel.
 * Roles listed without methods are recorded for compatibility and open nothing here.
 */
export interface RoleDef {
  name: string;
  /** Where it may be held: the organisation only, or also a workspace (and a channel, for Channel Manager). */
  scope: 'org' | 'team';
  methods: (string | RegExp)[];
}

export const ROLES: Record<string, RoleDef> = {
  Rl0L: { name: 'Analytics Admin', scope: 'team', methods: [/^admin\.analytics\./, 'client.admin.stats'] },
  Rl0C: { name: 'Audit Logs Admin', scope: 'team', methods: ['client.admin.audit.list', 'client.admin.auditToken'] },
  Rl01: { name: 'Channel Admin', scope: 'team', methods: [/^admin\.conversations\./, 'client.admin.setChannelWeb'] },
  Rl0A: { name: 'Channel Manager', scope: 'team', methods: [] },
  Rl05: { name: 'Conversation Admin', scope: 'team', methods: [/^client\.admin\.reports\./] },
  Rl09: { name: 'DLP Admin', scope: 'org', methods: [/^client\.admin\.dlp\./] },
  Rl0F: { name: 'Exports Admin', scope: 'org', methods: [] },
  Rl0D: { name: 'Integrations Manager', scope: 'org', methods: [/^client\.apps\./] },
  Rl04: { name: 'Legal Holds Admin', scope: 'org', methods: [/^client\.admin\.holds\./] },
  Rl0E: { name: 'Message Activity Manager', scope: 'org', methods: [] },
  Rl02: { name: 'Role Admin', scope: 'team', methods: [/^admin\.roles\./] },
  Rl0G: { name: 'Sales Admin', scope: 'org', methods: [] },
  Rl0J: {
    name: 'Security Admin',
    scope: 'org',
    methods: ['client.admin.ipAllowlist', 'client.admin.setIpAllowlist', 'client.admin.sessionSettings', 'client.admin.setSessionDuration', 'client.admin.sessions.resetAll', /^admin\.users\.session\./, /^admin\.barriers\./],
  },
  Rl0B: { name: 'Platform Developer', scope: 'team', methods: [] },
  Rl03: {
    name: 'User Admin',
    scope: 'team',
    methods: [/^admin\.users\.(list|invite|remove|assign|getExpiration|setExpiration)$/, /^admin\.inviteRequests\./, /^client\.admin\.inviteRequests\./, 'client.admin.setActive', 'client.admin.setAccountType'],
  },
  Rl0K: { name: 'Workflow Admin', scope: 'org', methods: [/^admin\.workflows\./] },
};

/** Whether a role opens a method. */
export function roleCovers(roleId: string, method: string): boolean {
  return (ROLES[roleId]?.methods ?? []).some((pattern) => (typeof pattern === 'string' ? pattern === method : pattern.test(method)));
}

/** The roles someone holds, with where. */
export function assignmentsOf(ctx: Ctx, userId: string): { role_id: string; entity_id: string }[] {
  return ctx.db.all<{ role_id: string; entity_id: string }>('SELECT role_id, entity_id FROM role_assignments WHERE user_id = ?', userId);
}

/**
 * Whether someone may call an admin method through a role: one held for the
 * organisation, or for the workspace the call names in `team_id`.
 */
export function grantedByRole(ctx: Ctx, actor: Actor, method: string, teamId: string | undefined): boolean {
  const org = ctx.team()?.id;
  return assignmentsOf(ctx, actor.userId).some((entry) => roleCovers(entry.role_id, method) && (entry.entity_id === org || (teamId !== undefined && entry.entity_id === teamId)));
}
