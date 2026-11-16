import { mrkdwnToPlain, parseMrkdwn, type Message } from '@app/shared';
import { S } from '../strings';
import { go, mentionsViewer } from './actions';
import { asset } from './api';
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

/**
 * Raise a desktop notification for a direct message or a mention that arrives
 * while the tab is not being looked at. The first time, ask in-app rather than
 * with an unprompted browser dialog.
 */
export function maybeNotify(channelId: string, message: Message): void {
  if (!supported()) return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  const state = get();
  const conv = state.channels[channelId];
  if (!conv || conv.is_muted || message.subtype === 'channel_join' || message.subtype === 'channel_leave') return;
  if (!mentionsViewer(conv, message)) return;
  if (Notification.permission === 'default') {
    set({ notifyPrompt: true });
    return;
  }
  if (Notification.permission !== 'granted') return;

  const author = state.users[message.user ?? ''];
  const name = message.username || displayName(author);
  const direct = conv.is_im || conv.is_mpim;
  const notification = new Notification(direct ? name : S.notify.inChannel(name, conversationName(state, conv)), {
    body: messagePreview(message).slice(0, 240),
    icon: author ? asset(author.profile.image_192) : '/favicon.svg',
    tag: `${channelId}:${message.ts}`,
  });
  notification.onclick = () => {
    window.focus();
    go({ name: 'conversation', id: channelId });
    notification.close();
  };
}
