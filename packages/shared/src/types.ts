import type { HuddleRoom } from './huddles.ts';
/**
 * Wire types shared by the server, the web client and tests.
 * Shapes follow Slack's published objects; fields this project adds are marked "ext".
 */

export type Role = 'primary_owner' | 'owner' | 'admin' | 'member';

export interface UserProfile {
  title: string;
  phone: string;
  real_name: string;
  real_name_normalized: string;
  display_name: string;
  display_name_normalized: string;
  status_text: string;
  status_emoji: string;
  status_expiration: number;
  avatar_hash: string;
  email?: string;
  image_24: string;
  image_32: string;
  image_48: string;
  image_72: string;
  image_192: string;
  image_512: string;
  team: string;
  bot_id?: string;
  api_app_id?: string;
  /** Custom profile fields the workspace defines (see `team.profile.get`). */
  fields?: Record<string, { value: string; alt: string }>;
  /** Guests only: when the account stops working (seconds, 0 for never). */
  guest_expiration_ts?: number;
  guest_invited_by?: string;
}

export interface User {
  id: string;
  team_id: string;
  name: string;
  deleted: boolean;
  color: string;
  real_name: string;
  tz: string;
  tz_label: string;
  tz_offset: number;
  profile: UserProfile;
  is_admin: boolean;
  is_owner: boolean;
  is_primary_owner: boolean;
  is_restricted: boolean;
  is_ultra_restricted: boolean;
  is_bot: boolean;
  is_app_user: boolean;
  /** ext: the organisation of someone from another server (a shared channel); absent for this workspace's people. */
  team_name?: string;
  updated: number;
}

export interface Topic {
  value: string;
  creator: string;
  last_set: number;
}

export interface Conversation {
  id: string;
  name?: string;
  name_normalized?: string;
  is_channel: boolean;
  is_group: boolean;
  is_im: boolean;
  is_mpim: boolean;
  is_private: boolean;
  is_archived: boolean;
  is_general: boolean;
  is_shared: boolean;
  is_ext_shared: boolean;
  is_org_shared: boolean;
  /** Shared channels: every team in it, the team that shared it, and the other teams. */
  shared_team_ids?: string[];
  conversation_host_id?: string;
  connected_team_ids?: string[];
  /** ext: the other organisation, for channels and direct messages shared with another server. */
  shared_with?: { id: string; name: string };
  created: number;
  updated: number;
  creator?: string;
  context_team_id: string;
  is_member?: boolean;
  topic?: Topic;
  purpose?: Topic;
  previous_names?: string[];
  num_members?: number;
  /** IM only: the other person. */
  user?: string;
  is_user_deleted?: boolean;
  is_open?: boolean;
  /** ext: mpim member ids. */
  members?: string[];
  /** Present for the viewer's own memberships. */
  last_read?: string;
  unread_count?: number;
  unread_count_display?: number;
  /** ext: unread messages that mention the viewer. */
  mention_count?: number;
  /** ext: ts of the newest top-level message. */
  latest_ts?: string;
  /** ext */
  is_starred?: boolean;
  /** ext */
  is_muted?: boolean;
  /** ext: which messages notify the viewer here. `default` follows the workspace default (mentions). */
  notify_level?: 'default' | 'all' | 'mentions' | 'nothing';
  /** Slack's channel properties: posting restrictions, and what a code channel (an agent's channel) shows. */
  properties?: {
    posting_restrictions?: { type: string[] };
    threads_restrictions?: { type: string[] };
    at_channel_restricted?: boolean;
    at_here_restricted?: boolean;
    agent_session?: AgentSessionProperty;
    code_channel?: CodeChannelProperty;
    agent_resource?: { url?: string; resource_type?: string; title?: string; provider?: string };
    record_channel?: { record_id: string; record_type: 'agent_channel' };
  };
  /** ext: channel managers. */
  managers?: string[];
}

/** The session of a code channel: one for the whole channel, shared by its agents. */
export interface AgentSessionProperty {
  status: 'active' | 'processing' | 'suspended' | 'closed';
  encoded_agent_bot_user_ids: string[];
  title: string;
  origin_link?: { channel_id: string; ts: string };
}

/** An entry of a code channel's context bar (`agents.conversations.setProperties`). */
export interface ContextBarItem {
  key: string;
  label: string;
  icon?: 'branch' | 'folder' | 'hierarchy' | 'life-ring' | 'link' | 'globe' | 'terminal' | 'code' | 'search' | 'lock';
  url?: string;
  item_type: 'info' | 'action';
  bot_user_id: string;
}

/** A view tab of a code channel (`agents.conversations.setView`). */
export interface AgentSessionView {
  view_id: string;
  type: 'html' | 'diff' | 'block_kit' | 'canvas' | 'pull_request';
  file_id: string;
  view_key?: string;
  name: string;
  date_added: number;
  content_version: number;
  /** ext: the canvas a canvas view shows. */
  canvas_id?: string;
}

export interface CodeChannelProperty {
  context_bar_items?: ContextBarItem[];
  summary_message?: { message_ts: string; thread_ts?: string };
  agent_session_views?: AgentSessionView[];
}

export interface Reaction {
  name: string;
  users: string[];
  count: number;
}

export interface FileObject {
  id: string;
  created: number;
  timestamp: number;
  name: string;
  title: string;
  mimetype: string;
  filetype: string;
  pretty_type: string;
  user: string;
  user_team: string;
  editable: boolean;
  size: number;
  mode: 'hosted' | 'snippet' | 'external';
  is_external: boolean;
  external_type: string;
  is_public: boolean;
  public_url_shared: boolean;
  /** Present while the file has a public link. */
  permalink_public?: string;
  display_as_bot: boolean;
  username: string;
  url_private: string;
  /** Absent for remote files, whose bytes are not here. */
  url_private_download?: string;
  permalink: string;
  original_w?: number;
  original_h?: number;
  thumb_360?: string;
  thumb_360_w?: number;
  thumb_360_h?: number;
  thumb_720?: string;
  thumb_720_w?: number;
  thumb_720_h?: number;
  alt_txt?: string;
  /** Captions of a recording (clips), as Slack reports audio and video transcriptions; `vtt_url` serves them as WebVTT. */
  /** Remote files (`files.remote.*`): the app's id for it and where it lives. */
  external_id?: string;
  external_url?: string;
  transcription?: { status: 'complete'; locale: string; preview: { content: string; has_more: boolean }; vtt_url: string };
  channels: string[];
  groups: string[];
  ims: string[];
  has_rich_preview: boolean;
  file_access: 'visible';
}

// Block Kit is validated structurally where it matters; elsewhere it is passed through.
export type Block = { type: string; block_id?: string; [key: string]: unknown };
export type Attachment = { [key: string]: unknown };

export interface BotProfile {
  id: string;
  app_id: string;
  name: string;
  icons: { image_36: string; image_48: string; image_72: string };
  deleted: boolean;
  updated: number;
  team_id: string;
}

export interface Message {
  type: 'message';
  subtype?: string;
  ts: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  bot_profile?: BotProfile;
  username?: string;
  icons?: { emoji?: string; image_64?: string };
  team?: string;
  text: string;
  blocks?: Block[];
  attachments?: Attachment[];
  files?: FileObject[];
  upload?: boolean;
  metadata?: { event_type: string; event_payload: Record<string, unknown> };
  client_msg_id?: string;
  thread_ts?: string;
  parent_user_id?: string;
  reply_count?: number;
  reply_users_count?: number;
  reply_users?: string[];
  latest_reply?: string;
  is_locked?: boolean;
  subscribed?: boolean;
  edited?: { user: string; ts: string };
  reactions?: Reaction[];
  pinned_to?: string[];
  /** ext: the message is still being streamed by an app. */
  streaming?: boolean;
  /** ext: the huddle a `huddle_thread` message stands for. */
  room?: HuddleRoom;
  /** Present only on ephemeral messages. */
  is_ephemeral?: boolean;
  /** Present in events, not in history. */
  channel?: string;
  channel_type?: 'channel' | 'group' | 'im' | 'mpim';
  event_ts?: string;
}

export interface Team {
  id: string;
  name: string;
  domain: string;
  url: string;
  icon: { image_68: string; image_132: string; image_default: boolean };
}

/** Result of `client.boot`: everything the web client needs to draw its first screen. */
export interface BootData {
  self: User;
  team: Team;
  users: User[];
  /** Conversations the viewer belongs to, with read state. */
  channels: Conversation[];
  /** Custom emoji: name → image URL or `alias:other`. */
  emoji: Record<string, string>;
  /** user id → presence */
  presence: Record<string, 'active' | 'away'>;
  prefs: Record<string, unknown>;
  ws_url: string;
  max_upload_bytes: number;
  server_version: string;
  /** The organisation's workspaces the viewer is in; the first is the organisation's own. */
  workspaces?: WorkspaceInfo[];
  /** Admin roles the viewer holds (Slack's role ids), and for what: the organisation, a workspace or a channel. */
  admin_roles?: AdminRoleAssignment[];
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  domain: string;
  /** The organisation's own workspace, which everyone is in. */
  first: boolean;
}

export interface AdminRoleAssignment {
  role_id: string;
  entity_id: string;
}

/** Events delivered over the client WebSocket. Shapes follow Slack's event types. */
export interface RealtimeEvent {
  type: string;
  [key: string]: unknown;
}

export interface ApiOk {
  ok: true;
  [key: string]: unknown;
}
export interface ApiErr {
  ok: false;
  error: string;
  [key: string]: unknown;
}
export type ApiResult = ApiOk | ApiErr;
