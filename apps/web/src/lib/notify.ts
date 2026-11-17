import { mrkdwnToPlain, parseMrkdwn, type Conversation, type Message } from '@app/shared';
import { S } from '../strings';
import { go, mentionsViewer, openThread } from './actions';
import { asset } from './api';
import { setAttentionNotifiers, userInDnd, type ActivityItem } from './attention';
import { nativeEmoji } from './emoji';
import { conversation, conversationName, displayName, get, set } from './store';

function supported(): boolean {
  return typeof Notification !== 'undefined';
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return supported() ? Notification.permission : 'unsupported';
}

export async function enableNotifications(): Promise<void> {
  set({ notifyPrompt: false });
  if (supported()) await Notification.requestPermission();
}

export function messagePreview(message: Message): string {
  const state = get();
  const text = mrkdwnToPlain(parseMrkdwn(message.text ?? ''), {
    user: (id) => (state.users[id] ? displayName(state.users[id]) : undefined),
    channel: (id) => conversation(state, id)?.name,
    emoji: (name) => nativeEmoji(name) ?? undefined,
  }).trim();
  if (text) return text;
  if (message.files?.length) return S.notify.sentFile(message.files[0]!.name);
  return S.notify.sentMessage;
}

/** May a notification be shown at all right now? Asks in-app the first time instead of an unprompted browser dialog. */
function allowed(): boolean {
  if (!supported()) return false;
  if (document.visibilityState === 'visible' && document.hasFocus()) return false;
  if (Notification.permission === 'default') {
    set({ notifyPrompt: true });
    return false;
  }
  return Notification.permission === 'granted';
}

function show(conv: Conversation, message: Message, open: () => void, title?: string): void {
  const state = get();
  const author = state.users[message.user ?? ''];
  const name = message.username || displayName(author);
  const direct = conv.is_im || conv.is_mpim;
  const notification = new Notification(title ?? (direct ? name : S.notify.inChannel(name, conversationName(state, conv))), {
    body: messagePreview(message).slice(0, 240),
    icon: author ? asset(author.profile.image_192) : '/favicon.svg',
    tag: `${conv.id}:${message.ts}`,
  });
  notification.onclick = () => {
    window.focus();
    open();
    notification.close();
  };
}

function isReply(message: Message): boolean {
  return message.thread_ts !== undefined && message.thread_ts !== message.ts && message.subtype !== 'thread_broadcast';
}

/**
 * A new message arrived while the tab is not being looked at. Direct messages
 * and mentions notify by default; a conversation set to "all new messages"
 * notifies for every top-level message, "nothing" never. Paused notifications
 * (Do Not Disturb) hold everything. Replies in followed threads and keywords
 * arrive as activity instead (below).
 */
export function maybeNotify(channelId: string, message: Message): void {
  const state = get();
  const conv = state.channels[channelId];
  if (!conv || conv.is_muted || message.subtype === 'channel_join' || message.subtype === 'channel_leave') return;
  const level = conv.notify_level ?? 'default';
  if (level === 'nothing') return;
  const mention = mentionsViewer(conv, message);
  const everything = level === 'all' && !isReply(message);
  if (!mention && !everything) return;
  if (userInDnd(state.self?.id)) return;
  if (!allowed()) return;
  show(conv, message, () => go({ name: 'conversation', id: channelId }));
}

/** Replies in a followed thread and keyword matches notify too (mentions are handled above). */
function notifyActivity(item: ActivityItem): void {
  if (item.type !== 'thread_reply' && item.type !== 'keyword') return;
  const state = get();
  const conv = state.channels[item.channel];
  if (!conv || conv.is_muted || (conv.notify_level ?? 'default') === 'nothing' || !item.message) return;
  if (userInDnd(state.self?.id) || !allowed()) return;
  const thread = item.thread_ts;
  show(conv, item.message, () => {
    go({ name: 'conversation', id: item.channel });
    if (thread) openThread(item.channel, thread);
  });
}

/** Someone asked for their direct message to reach the viewer despite paused notifications. */
function notifyOverride(channel: string, ts: string, user: string): void {
  const state = get();
  const conv = state.channels[channel];
  if (!conv || !supported() || Notification.permission !== 'granted') return;
  const message = state.convs[channel]?.list.find((item) => item.ts === ts) ?? { type: 'message', ts, user, text: S.notify.sentMessage };
  show(conv, message, () => go({ name: 'conversation', id: channel, ts }));
}

setAttentionNotifiers(notifyActivity, notifyOverride);
