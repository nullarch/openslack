import { extractBlockMentions, extractMentions, type Message, type Team } from '@app/shared';
import { create } from 'zustand';
import { call, type Json } from './api';
import { get as getMain, set as setMain } from './store';

/**
 * Client state for accounts and workspace administration: what this person
 * may do, the workspace's user groups and profile fields, which channels are
 * public on the web, and the sign-in options the server offers.
 */

export interface Permissions {
  create_channels: boolean;
  invite: boolean;
  manage_emoji: boolean;
  at_channel: boolean;
  manage_usergroups: boolean;
  browse_channels: boolean;
  public_file_links: boolean;
}

export interface UserGroup {
  id: string;
  handle: string;
  name: string;
  description: string;
  users: string[];
  prefs: { channels: string[] };
  date_delete: number;
}

export interface ProfileField {
  id: string;
  label: string;
  hint: string;
  type: string;
  possible_values: string[] | null;
}

export interface Provider {
  id: string;
  label: string;
}

export type AccountsModal = { kind: 'groups' } | { kind: 'security' } | { kind: 'requestInvite' } | null;

interface AccountsState {
  mailEnabled: boolean;
  providers: Provider[];
  twoFactorSetupRequired: boolean;
  permissions: Permissions;
  usergroups: Record<string, UserGroup>;
  profileFields: ProfileField[];
  vapidKey: string | null;
  signupDomains: string[];
  pendingRequests: number;
  /** Public channels readable on the web. */
  web: Record<string, boolean>;
  modal: AccountsModal;
}

const EVERYTHING: Permissions = {
  create_channels: true,
  invite: true,
  manage_emoji: true,
  at_channel: true,
  manage_usergroups: true,
  browse_channels: true,
  public_file_links: true,
};

export const useAccounts = create<AccountsState>(() => ({
  mailEnabled: false,
  providers: [],
  twoFactorSetupRequired: false,
  permissions: EVERYTHING,
  usergroups: {},
  profileFields: [],
  vapidKey: null,
  signupDomains: [],
  pendingRequests: 0,
  web: {},
  modal: null,
}));

export const accounts = useAccounts.getState;
export const setAccounts = useAccounts.setState;

export function openAccountsModal(modal: AccountsModal): void {
  setAccounts({ modal });
}

export function closeAccountsModal(): void {
  setAccounts({ modal: null });
}

/** From `client.status`, before anyone has signed in. */
export function applyAccountsStatus(status: Json): void {
  setAccounts({
    mailEnabled: Boolean(status.mail_enabled),
    providers: Array.isArray(status.identity_providers) ? status.identity_providers : [],
    twoFactorSetupRequired: Boolean(status.two_factor_setup_required),
  });
}

function groupMap(list: unknown): Record<string, UserGroup> {
  const out: Record<string, UserGroup> = {};
  if (Array.isArray(list)) for (const group of list as UserGroup[]) if (!group.date_delete) out[group.id] = group;
  return out;
}

/** From `client.boot`. */
export function applyAccountsBoot(data: Json): void {
  const web: Record<string, boolean> = {};
  for (const channel of (data.channels ?? []) as { id: string; web_public?: boolean }[]) if (channel.web_public) web[channel.id] = true;
  setAccounts({
    mailEnabled: Boolean(data.mail_enabled),
    permissions: { ...EVERYTHING, ...(data.permissions ?? {}) },
    usergroups: groupMap(data.usergroups),
    profileFields: Array.isArray(data.profile_fields) ? data.profile_fields : [],
    vapidKey: typeof data.vapid_public_key === 'string' ? data.vapid_public_key : null,
    signupDomains: Array.isArray(data.signup_domains) ? data.signup_domains : [],
    web,
  });
  if (data.self?.is_admin) void refreshPendingRequests();
}

export async function refreshPermissions(): Promise<void> {
  try {
    const result = await call('client.permissions');
    setAccounts({ permissions: { ...EVERYTHING, ...result.permissions } });
  } catch {
    // Keep what we had; the server enforces it either way.
  }
}

export async function refreshPendingRequests(): Promise<void> {
  try {
    const result = await call('client.admin.inviteRequests.list');
    setAccounts({ pendingRequests: (result.requests as unknown[]).length });
  } catch {
    setAccounts({ pendingRequests: 0 });
  }
}

/** Realtime events this module owns. Returns nothing; other handlers still run. */
export function handleAccountsEvent(event: Json): void {
  switch (event.type) {
    case 'subteam_created':
    case 'subteam_updated': {
      const group = event.subteam as UserGroup;
      useAccounts.setState((state) => {
        const next = { ...state.usergroups };
        if (group.date_delete) delete next[group.id];
        else next[group.id] = group;
        return { usergroups: next };
      });
      break;
    }
    case 'subteam_members_changed': {
      const id = String(event.subteam_id);
      useAccounts.setState((state) => {
        const group = state.usergroups[id];
        if (!group) return {};
        const users = new Set(group.users);
        for (const user of event.added_users ?? []) users.add(user);
        for (const user of event.removed_users ?? []) users.delete(user);
        return { usergroups: { ...state.usergroups, [id]: { ...group, users: [...users] } } };
      });
      break;
    }
    case 'team_prefs_changed':
      void refreshPermissions();
      break;
    case 'user_change':
      // A change of one's own account type or role changes what one may do.
      if (event.user?.id && event.user.id === getMain().self?.id) void refreshPermissions();
      break;
    case 'invite_requests_changed':
      setAccounts({ pendingRequests: Number(event.pending ?? 0) });
      break;
    case 'channel_web_changed':
      useAccounts.setState((state) => ({ web: { ...state.web, [event.channel]: Boolean(event.web_public) } }));
      break;
    case 'team_profile_change':
      setAccounts({
        profileFields: ((event.profile?.fields ?? []) as (ProfileField & { is_hidden?: boolean })[]).filter((field) => !field.is_hidden),
      });
      break;
    case 'team_updated':
      setMain((state) => ({ team: state.team ? { ...state.team, ...(event.team as Team) } : state.team }));
      break;
  }
}

/** Groups a person belongs to. */
export function groupsOf(userId: string): string[] {
  return Object.values(accounts().usergroups)
    .filter((group) => group.users.includes(userId))
    .map((group) => group.id);
}

/** Whether a message mentions a group this person belongs to. */
export function mentionsMyGroup(message: Message, userId: string): boolean {
  const mine = groupsOf(userId);
  if (mine.length === 0) return false;
  const ids = [...extractMentions(message.text ?? '').groups, ...(message.blocks ? extractBlockMentions(message.blocks).groups : [])];
  return ids.some((id) => mine.includes(id));
}

/** Group handles for the composer: `@design` → `<!subteam^S…|@design>`. */
export function composeGroups(): { id: string; handle: string }[] {
  return Object.values(accounts().usergroups).map((group) => ({ id: group.id, handle: group.handle }));
}
