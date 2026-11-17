import type { Conversation, FileObject, Message, Team, User } from '@app/shared';
import { create } from 'zustand';
import { parseRoute, type Route } from './router';

/** A message as the client holds it: the API shape plus local send state. */
export interface LocalMessage extends Message {
  /** Sent from this tab and not yet confirmed by the server. */
  pending?: boolean;
  /** The send failed; the row offers a retry. */
  failed?: boolean;
  /** Matches the `client_msg_id` of the confirmed message. */
  local_id?: string;
}

export interface ConvState {
  /** Ascending by `ts`. */
  list: LocalMessage[];
  loaded: boolean;
  loading: boolean;
  hasOlder: boolean;
  /** True when the list stops short of the newest message (after jumping into history). */
  hasNewer: boolean;
  /** Messages after this ts were unread when the conversation was opened. */
  marker: string | null;
}

export interface ThreadPrompt {
  title: string;
  message: string;
}

export interface ThreadState {
  parent: LocalMessage | null;
  replies: LocalMessage[];
  loaded: boolean;
  /** What an assistant says it is doing ("is thinking…"), while it works. */
  status: string | null;
  /** The app whose status this is. */
  statusUser: string | null;
  /** A title an assistant gave the thread. */
  title: string | null;
  /** Suggested messages an assistant offers; choosing one sends it. */
  prompts: { title: string; items: ThreadPrompt[] } | null;
}

export type Panel =
  | { kind: 'thread'; channel: string; ts: string }
  | { kind: 'profile'; user: string }
  | { kind: 'details'; channel: string; tab: 'about' | 'members' | 'pins' | 'files' }
  | null;

export type AdminTab = 'members' | 'emoji' | 'apps' | 'workspace' | 'analytics' | 'audit' | 'reports';

export type Modal =
  | { kind: 'createChannel' }
  | { kind: 'browse' }
  | { kind: 'newDm' }
  | { kind: 'invite' }
  | { kind: 'preferences' }
  | { kind: 'editProfile' }
  | { kind: 'admin'; tab: AdminTab }
  | { kind: 'switcher' }
  | { kind: 'image'; file: FileObject }
  | { kind: 'addPeople'; channel: string }
  | { kind: 'forward'; channel: string; ts: string }
  | { kind: 'shareFile'; file: FileObject }
  | { kind: 'schedule'; channel: string; threadTs?: string; text: string; broadcast?: boolean }
  | { kind: 'dndSchedule' }
  | { kind: 'snippet'; channel: string; threadTs?: string }
  | { kind: 'bookmark'; channel: string; bookmark?: Bookmark }
  | null;

/** Slack's bookmark object, as `bookmarks.list` returns it. */
export interface Bookmark {
  id: string;
  channel_id: string;
  title: string;
  link: string;
  emoji: string | null;
  rank: string;
}

/** Slack's Do Not Disturb status. Snooze fields are only present for the viewer. */
export interface DndStatus {
  dnd_enabled: boolean;
  next_dnd_start_ts: number;
  next_dnd_end_ts: number;
  snooze_enabled?: boolean;
  snooze_endtime?: number;
}

export interface DndSchedule {
  enabled: boolean;
  start: string;
  end: string;
  days: number[];
}

/** What needs the viewer's attention, and how they control it. */
export interface AttentionState {
  loaded: boolean;
  activityUnread: number;
  /** `channel:thread_ts` of followed threads with unread replies. */
  unreadThreads: Record<string, true>;
  dnd: { self: DndStatus | null; schedule: DndSchedule | null; users: Record<string, DndStatus> };
  /** `channel:ts` → state, for messages saved for later. */
  saved: Record<string, 'in_progress' | 'archived' | 'completed'>;
  /** `channel` or `channel:thread_ts` → draft text kept on the server. */
  drafts: Record<string, { text: string; updated: number }>;
  scheduledCount: number;
  messagePolicy: { msg_edit_window_mins: number; allow_message_deletion: 'everyone' | 'admins' };
  /** Bookmarks by conversation, once loaded. */
  bookmarks: Record<string, Bookmark[]>;
  /** Conversations where images and video are collapsed (/collapse). */
  collapsed: Record<string, true>;
  /** Bumped every minute so time-based state (DND windows) re-renders. */
  tick: number;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

export interface SlashCommand {
  command: string;
  description: string;
  usage_hint: string;
  app_id: string;
  app_name: string;
}

export interface AppState {
  phase: 'loading' | 'setup' | 'signin' | 'join' | 'reset' | 'twofactor' | 'ready' | 'fatal';
  fatal: string | null;
  /** The workspace as shown on the sign-in screens, before boot. */
  publicTeam: Team | null;

  self: User | null;
  team: Team | null;
  users: Record<string, User>;
  presence: Record<string, 'active' | 'away'>;
  /** Conversations in the sidebar: the viewer's memberships. */
  channels: Record<string, Conversation>;
  /** Conversations looked at without joining. */
  others: Record<string, Conversation>;
  emoji: Record<string, string>;
  prefs: Record<string, unknown>;
  maxUploadBytes: number;
  commands: SlashCommand[];

  convs: Record<string, ConvState>;
  threads: Record<string, ThreadState>;
  /** Who is typing, by conversation id (or `conversation:thread_ts`), with expiry times. */
  typing: Record<string, Record<string, number>>;

  route: Route;
  panel: Panel;
  modal: Modal;
  /** A message to scroll to and flash. */
  highlight: { channel: string; ts: string; at: number } | null;
  editing: { channel: string; ts: string } | null;
  drawer: boolean;
  connection: 'connecting' | 'online' | 'offline';
  toasts: Toast[];
  /** Bumped when the emoji data set finishes loading, so text re-renders. */
  emojiVersion: number;
  notifyPrompt: boolean;
  /** Live Socket Mode state per app id, as events report it. */
  appConnections: Record<string, boolean>;
  /** Conversations that text links to but the viewer may not see. */
  hiddenChannels: Record<string, true>;
  att: AttentionState;
}

export const EMPTY_ATTENTION: AttentionState = {
  loaded: false,
  activityUnread: 0,
  unreadThreads: {},
  dnd: { self: null, schedule: null, users: {} },
  saved: {},
  drafts: {},
  scheduledCount: 0,
  messagePolicy: { msg_edit_window_mins: -1, allow_message_deletion: 'everyone' },
  bookmarks: {},
  collapsed: {},
  tick: 0,
};

export const useStore = create<AppState>(() => ({
  phase: 'loading',
  fatal: null,
  publicTeam: null,
  self: null,
  team: null,
  users: {},
  presence: {},
  channels: {},
  others: {},
  emoji: {},
  prefs: {},
  maxUploadBytes: 0,
  commands: [],
  convs: {},
  threads: {},
  typing: {},
  route: parseRoute(window.location),
  panel: null,
  modal: null,
  highlight: null,
  editing: null,
  drawer: false,
  connection: 'connecting',
  toasts: [],
  emojiVersion: 0,
  notifyPrompt: false,
  appConnections: {},
  hiddenChannels: {},
  att: EMPTY_ATTENTION,
}));

export const get = useStore.getState;
export const set = useStore.setState;

export const EMPTY_CONV: ConvState = { list: [], loaded: false, loading: false, hasOlder: false, hasNewer: false, marker: null };
export const EMPTY_THREAD: ThreadState = { parent: null, replies: [], loaded: false, status: null, statusUser: null, title: null, prompts: null };

export function threadKey(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}

export function conversation(state: AppState, id: string | null | undefined): Conversation | undefined {
  if (!id) return undefined;
  return state.channels[id] ?? state.others[id];
}

export function currentId(state: AppState): string | null {
  return state.route.name === 'conversation' ? state.route.id : null;
}

/** How a person's name is shown everywhere. */
export function displayName(user: User | undefined): string {
  if (!user) return 'Unknown';
  return user.profile.display_name || user.real_name || user.name;
}

/** The label of a conversation: channel name, the other person, or the members of a group. */
export function conversationName(state: AppState, conv: Conversation | undefined): string {
  if (!conv) return '';
  if (conv.is_im) return displayName(state.users[conv.user ?? '']);
  if (conv.is_mpim) {
    const others = (conv.members ?? []).filter((id) => id !== state.self?.id);
    return others.map((id) => displayName(state.users[id])).join(', ');
  }
  return conv.name ?? '';
}
