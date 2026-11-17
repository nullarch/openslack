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
  mode: 'hosted';
  is_external: boolean;
  external_type: string;
  is_public: boolean;
  public_url_shared: boolean;
  display_as_bot: boolean;
  username: string;
  url_private: string;
  url_private_download: string;
  permalink: string;
  original_w?: number;
  original_h?: number;
  thumb_360?: string;
  thumb_360_w?: number;
  thumb_360_h?: number;
  alt_txt?: string;
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
