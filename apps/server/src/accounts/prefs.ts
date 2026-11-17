import type { Actor, Ctx } from '../ctx.ts';
import { fail } from '../core/errors.ts';
import { getUser } from '../core/users.ts';

/** Who may do something workspace-wide. */
export type Audience = 'everyone' | 'admins';

/** Workspace settings, stored as JSON on the team row. Every field is optional; defaults below. */
export interface TeamPrefs {
  default_channels?: string[];
  /** Email domains that may join (lower case, no `@`). Empty means any. */
  signup_domains?: string[];
  who_can_create_channels?: Audience;
  who_can_invite?: Audience;
  who_can_manage_emoji?: Audience;
  who_can_at_channel?: Audience;
  who_can_manage_usergroups?: Audience;
  /** Everyone must set up two-factor sign-in before using the workspace. */
  require_2fa?: boolean;
  /** Invite code behind the "Join" button on public channel pages; null hides the button. */
  public_invite_code?: string | null;
  /** Whether people may create public links to files (`files.sharedPublicURL`); on unless set to false. */
  public_file_links?: boolean;
}

export type Permission =
  | 'who_can_create_channels'
  | 'who_can_invite'
  | 'who_can_manage_emoji'
  | 'who_can_at_channel'
  | 'who_can_manage_usergroups';

export const PERMISSIONS: Permission[] = [
  'who_can_create_channels',
  'who_can_invite',
  'who_can_manage_emoji',
  'who_can_at_channel',
  'who_can_manage_usergroups',
];

export function teamPrefs(ctx: Ctx): TeamPrefs {
  const team = ctx.team();
  if (!team) return {};
  try {
    return JSON.parse(team.prefs) as TeamPrefs;
  } catch {
    return {};
  }
}

export function setTeamPrefs(ctx: Ctx, patch: Partial<TeamPrefs>): TeamPrefs {
  const prefs = { ...teamPrefs(ctx), ...patch };
  ctx.db.run('UPDATE team SET prefs = ? WHERE id = ?', JSON.stringify(prefs), ctx.requireTeam().id);
  ctx.invalidateTeam();
  return prefs;
}

function isAdminRole(role: string): boolean {
  return role === 'admin' || role === 'owner' || role === 'primary_owner';
}

/**
 * Whether a person may do something the workspace restricts. Guests may do
 * none of these; apps act with member rights.
 */
export function allowedTo(ctx: Ctx, userId: string, permission: Permission): boolean {
  const user = getUser(ctx, userId);
  if (!user || user.deleted === 1 || user.guest !== '') return false;
  if (user.is_bot === 1) return (teamPrefs(ctx)[permission] ?? 'everyone') === 'everyone';
  if (isAdminRole(user.role)) return true;
  return (teamPrefs(ctx)[permission] ?? 'everyone') === 'everyone';
}

export function requireAllowed(ctx: Ctx, actor: Actor, permission: Permission, error = 'restricted_action'): void {
  if (!allowedTo(ctx, actor.userId, permission)) fail(error);
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/** Whether an address may join under the approved-domains setting. */
export function domainAllowed(ctx: Ctx, email: string): boolean {
  const domains = teamPrefs(ctx).signup_domains ?? [];
  return domains.length === 0 || domains.includes(domainOf(email));
}

/** Normalise a domain list typed by an admin: `@Example.com, acme.co` → `['example.com', 'acme.co']`. */
export function parseDomains(input: unknown): string[] {
  const list = Array.isArray(input) ? input.map(String) : typeof input === 'string' ? input.split(/[\s,]+/) : [];
  const out = new Set<string>();
  for (const item of list) {
    const domain = item.trim().toLowerCase().replace(/^@/, '');
    if (!domain) continue;
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) || domain.length > 253) fail('invalid_domain', { domain });
    out.add(domain);
  }
  return [...out];
}
