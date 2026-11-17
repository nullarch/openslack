import type { BootData, Conversation, Message, Reaction, User } from '@app/shared';
import {
  adoptChannel,
  applyBoot,
  clearTyping,
  forgetChannel,
  loadLatest,
  loadThread,
  mentionsViewer,
  noteTyping,
  patchChannel,
  patchMessage,
  placeMessage,
  removeMessage,
  sessionEnded,
  setOnBooted,
  setThreadPrompts,
  setThreadStatus,
  setThreadTitle,
} from './actions';
import { call, type Json } from './api';
import { maybeNotify } from './notify';
import { handlePlatformEvent, restoreViews } from './platform';
import { currentId, get, set, type LocalMessage } from './store';
import { applyTheme } from './theme';

let socket: WebSocket | null = null;
let attempts = 0;
let everConnected = false;
let reconnectTimer = 0;
let pingTimer = 0;
let pongTimer = 0;
let pingId = 0;

/** What the message list reports about itself, so incoming messages know whether they are being read. */
export const viewing = { channel: null as string | null, atBottom: true };

function url(): string {
  return `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
}

export function connect(): void {
  window.clearTimeout(reconnectTimer);
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (!everConnected) set({ connection: 'connecting' });
  const current = new WebSocket(url());
  socket = current;
  current.onmessage = (message) => {
    let event: Json;
    try {
      event = JSON.parse(String(message.data));
    } catch {
      return;
    }
    handle(event);
  };
  current.onclose = () => {
    if (socket !== current) return;
    socket = null;
    stopHeartbeat();
    set({ connection: 'offline' });
    scheduleReconnect();
    // The server also closes connections when it ends a session; find out which it was.
    if (everConnected) void checkSession();
  };
  current.onerror = () => current.close();
}

async function checkSession(): Promise<void> {
  try {
    const status = await call('client.status');
    if (!status.signed_in) sessionEnded();
  } catch {
    // The server is unreachable; the reconnect loop keeps trying.
  }
}

function scheduleReconnect(): void {
  const delay = Math.min(15_000, 1000 * 2 ** attempts) + Math.random() * 500;
  attempts += 1;
  window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(connect, delay);
}

function startHeartbeat(): void {
  stopHeartbeat();
  pingTimer = window.setInterval(() => {
    pingId += 1;
    send({ type: 'ping', id: pingId });
    window.clearTimeout(pongTimer);
    pongTimer = window.setTimeout(() => socket?.close(), 10_000);
  }, 20_000);
}

function stopHeartbeat(): void {
  window.clearInterval(pingTimer);
  window.clearTimeout(pongTimer);
}

export function send(body: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body));
}

const typingSent = new Map<string, number>();

/** Tell others the viewer is typing, at most once every three seconds per place. */
export function sendTyping(channel: string, threadTs?: string): void {
  const key = threadTs ? `${channel}:${threadTs}` : channel;
  const now = Date.now();
  if (now - (typingSent.get(key) ?? 0) < 3000) return;
  typingSent.set(key, now);
  send(threadTs ? { type: 'typing', channel, thread_ts: threadTs } : { type: 'typing', channel });
}

/** After a dropped connection: reload the workspace and whatever is on screen. */
async function resync(): Promise<void> {
  try {
    const data = (await call('client.boot')) as BootData;
    applyBoot(data);
    const state = get();
    const current = currentId(state);
    // Cached lists may have missed events; keep only the open one and refetch it.
    set({ convs: current && state.convs[current] ? { [current]: state.convs[current] } : {}, threads: {} });
    if (current && !state.convs[current]?.hasNewer) await loadLatest(current);
    if (state.panel?.kind === 'thread') await loadThread(state.panel.channel, state.panel.ts);
  } catch {
    // Still offline or signed out; the reconnect loop handles it.
  }
}

// ── Events ──────────────────────────────────────────────────────────────────

function withReaction(message: LocalMessage, name: string, user: string, add: boolean): LocalMessage {
  const reactions: Reaction[] = (message.reactions ?? []).map((reaction) => ({ ...reaction, users: [...reaction.users] }));
  let entry = reactions.find((reaction) => reaction.name === name);
  if (add) {
    if (!entry) {
      entry = { name, users: [], count: 0 };
      reactions.push(entry);
    }
    if (!entry.users.includes(user)) entry.users.push(user);
  } else if (entry) {
    entry.users = entry.users.filter((id) => id !== user);
  }
  const kept = reactions.filter((reaction) => reaction.users.length > 0).map((reaction) => ({ ...reaction, count: reaction.users.length }));
  const next = { ...message };
  if (kept.length > 0) next.reactions = kept;
  else delete next.reactions;
  return next;
}

function handleMessage(event: Json): void {
  const channel = event.channel as string;
  if (event.subtype === 'message_changed') {
    // An app may rewrite an ephemeral message; it stays ephemeral.
    const changed = (event.is_ephemeral ? { ...event.message, is_ephemeral: true } : event.message) as Message;
    patchMessage(channel, changed.ts, () => changed);
    return;
  }
  if (event.subtype === 'message_deleted') {
    removeMessage(channel, event.deleted_ts);
    return;
  }
  if (event.subtype === 'message_replied') {
    patchMessage(channel, event.message.ts, () => event.message as Message);
    return;
  }

  const message = event as Message;
  const state = get();
  const self = state.self;
  if (message.user) {
    clearTyping(channel, message.user);
    if (message.thread_ts) clearTyping(`${channel}:${message.thread_ts}`, message.user);
  }
  placeMessage(channel, message);
  if (message.is_ephemeral) return;

  const conv = state.channels[channel];
  if (!conv || !self) return;
  const fromSelf = message.user === self.id;
  const system = message.subtype === 'channel_join' || message.subtype === 'channel_leave';
  const reply = message.thread_ts !== undefined && message.thread_ts !== message.ts && message.subtype !== 'thread_broadcast';
  const mention = mentionsViewer(conv, message);
  const beingRead = viewing.channel === channel && viewing.atBottom && document.hasFocus() && currentId(get()) === channel;

  if (!reply) {
    const patch: Partial<Conversation> = { latest_ts: message.ts };
    if (!fromSelf && !system && !beingRead) {
      patch.unread_count = (conv.unread_count ?? 0) + 1;
      patch.unread_count_display = patch.unread_count;
      if (mention) patch.mention_count = (conv.mention_count ?? 0) + 1;
    }
    patchChannel(channel, patch);
  } else if (mention && !beingRead) {
    patchChannel(channel, { mention_count: (conv.mention_count ?? 0) + 1 });
  }
  if (!fromSelf) maybeNotify(channel, message);
}

function handle(event: Json): void {
  switch (event.type) {
    case 'hello': {
      attempts = 0;
      set({ connection: 'online' });
      startHeartbeat();
      if (everConnected) void resync();
      everConnected = true;
      void restoreViews();
      break;
    }
    case 'pong':
      window.clearTimeout(pongTimer);
      break;
    case 'message':
      handleMessage(event);
      break;
    case 'reaction_added':
    case 'reaction_removed':
      patchMessage(event.item.channel, event.item.ts, (message) =>
        withReaction(message, event.reaction, event.user, event.type === 'reaction_added'),
      );
      break;
    case 'pin_added':
    case 'pin_removed': {
      const channel = event.channel_id as string;
      patchMessage(channel, event.item.message.ts, (message) => {
        const next = { ...message };
        if (event.type === 'pin_added') next.pinned_to = [channel];
        else delete next.pinned_to;
        return next;
      });
      break;
    }
    case 'channel_joined':
    case 'channel_prefs_changed':
      adoptChannel(event.channel as Conversation);
      break;
    case 'channel_left':
      forgetChannel(event.channel);
      break;
    case 'channel_updated': {
      const channel = event.channel as Conversation;
      patchChannel(channel.id, {
        name: channel.name,
        name_normalized: channel.name_normalized,
        topic: channel.topic,
        purpose: channel.purpose,
        is_archived: channel.is_archived,
      });
      break;
    }
    case 'channel_rename':
      patchChannel(event.channel.id, { name: event.channel.name, name_normalized: event.channel.name_normalized });
      break;
    case 'channel_archive':
      patchChannel(event.channel, { is_archived: true });
      break;
    case 'channel_unarchive':
      patchChannel(event.channel, { is_archived: false });
      break;
    case 'channel_marked':
      patchChannel(event.channel, {
        last_read: event.ts,
        unread_count: event.unread_count,
        unread_count_display: event.unread_count_display,
        mention_count: event.mention_count,
      });
      break;
    case 'member_joined_channel':
    case 'member_left_channel': {
      const state = get();
      const conv = state.channels[event.channel] ?? state.others[event.channel];
      if (conv?.num_members !== undefined) {
        patchChannel(event.channel, { num_members: Math.max(0, conv.num_members + (event.type === 'member_joined_channel' ? 1 : -1)) });
      }
      break;
    }
    case 'team_join':
    case 'user_change': {
      const user = event.user as User;
      if (user.deleted && user.id === get().self?.id) {
        sessionEnded();
        break;
      }
      set((state) => ({
        users: { ...state.users, [user.id]: user },
        // The viewer's own record keeps fields only they may see (email).
        self: state.self?.id === user.id ? { ...user, profile: { ...state.self.profile, ...user.profile } } : state.self,
      }));
      break;
    }
    case 'presence_change':
      set((state) => ({ presence: { ...state.presence, [event.user]: event.presence } }));
      break;
    case 'user_typing':
      noteTyping(event.thread_ts ? `${event.channel}:${event.thread_ts}` : event.channel, event.user);
      break;
    case 'emoji_changed':
      void call('emoji.list')
        .then((result) => set({ emoji: result.emoji }))
        .catch(() => undefined);
      break;
    case 'pref_change':
      set({ prefs: event.prefs });
      applyTheme(event.prefs?.theme);
      break;
    case 'team_rename':
      set((state) => ({ team: state.team ? { ...state.team, ...(event.team ?? {}), name: event.name } : state.team }));
      break;
    case 'assistant_thread_status':
      setThreadStatus(event.channel, event.thread_ts, event.status ? String(event.status) : null, event.user ?? null);
      break;
    case 'assistant_thread_title':
      setThreadTitle(event.channel, event.thread_ts, String(event.title ?? ''));
      break;
    case 'assistant_thread_prompts':
      if (event.thread_ts) {
        setThreadPrompts(event.channel, event.thread_ts, String(event.title ?? ''), Array.isArray(event.prompts) ? event.prompts : []);
      }
      break;
    case 'app_connection_changed':
      set((state) => ({ appConnections: { ...state.appConnections, [event.app_id]: Boolean(event.connected) } }));
      break;
    default:
      handlePlatformEvent(event);
      break;
  }
}

setOnBooted(connect);

window.addEventListener('online', () => {
  attempts = 0;
  connect();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !socket) {
    attempts = 0;
    connect();
  }
});
