import type { Conversation, FileObject, Message } from '@app/shared';
import { S } from '../strings';
import { whenText } from './time';
import { adoptChannel, afterBoot, attempt, errorText, patchChannel, toast } from './actions';
import { ApiError, call, type Json } from './api';
import { EMPTY_ATTENTION, get, set, threadKey, type AttentionState, type Bookmark, type DndSchedule, type DndStatus } from './store';

/**
 * Client side of messaging and attention: activity, followed threads, Do Not
 * Disturb, notification levels, saved items, drafts, scheduled messages,
 * bookmarks, forwarding and posting permissions.
 */

// ── State ───────────────────────────────────────────────────────────────────

export function patchAtt(patch: Partial<AttentionState> | ((att: AttentionState) => Partial<AttentionState>)): void {
  set((state) => ({ att: { ...state.att, ...(typeof patch === 'function' ? patch(state.att) : patch) } }));
}

/** Views listen for these to refresh what they show. */
export const attentionEvents = new EventTarget();
export type AttentionTopic = 'activity' | 'threads' | 'reminders' | 'scheduled' | 'saved' | 'drafts';

function notifyViews(topic: AttentionTopic): void {
  attentionEvents.dispatchEvent(new Event(topic));
}

export async function loadAttention(): Promise<void> {
  try {
    const data = await call('client.attention.boot');
    const unreadThreads: Record<string, true> = {};
    for (const item of data.unread_threads ?? []) unreadThreads[threadKey(item.channel, item.thread_ts)] = true;
    const saved: AttentionState['saved'] = {};
    for (const item of data.saved ?? []) saved[`${item.channel}:${item.ts}`] = item.state;
    const drafts: AttentionState['drafts'] = {};
    for (const item of data.drafts ?? []) drafts[draftKey(item.channel, item.thread_ts)] = { text: item.text, updated: item.updated };
    patchAtt({
      loaded: true,
      activityUnread: data.activity_unread ?? 0,
      unreadThreads,
      dnd: { self: data.dnd?.self ?? null, schedule: data.dnd?.schedule ?? null, users: data.dnd?.users ?? {} },
      saved,
      drafts,
      scheduledCount: data.scheduled_count ?? 0,
      messagePolicy: data.message_policy ?? EMPTY_ATTENTION.messagePolicy,
    });
  } catch {
    // An older server without these methods: the rest of the client works without them.
    patchAtt({ loaded: true });
  }
}

afterBoot.push(() => void loadAttention());

// Time-based state (DND windows, "due" labels) is re-evaluated every minute.
window.setInterval(() => patchAtt((att) => ({ tick: att.tick + 1 })), 60_000);

// ── Do Not Disturb ──────────────────────────────────────────────────────────

export function windowOpen(status: DndStatus | undefined | null, now = Date.now() / 1000): boolean {
  if (!status) return false;
  if (status.snooze_enabled && (status.snooze_endtime ?? 0) > now) return true;
  return status.next_dnd_end_ts > 1 && status.next_dnd_start_ts <= now && now < status.next_dnd_end_ts;
}

/** Whether someone's notifications are paused right now. */
export function userInDnd(userId: string | undefined): boolean {
  const state = get();
  if (!userId) return false;
  if (userId === state.self?.id) return windowOpen(state.att.dnd.self);
  return windowOpen(state.att.dnd.users[userId]);
}

/** When the viewer's pause ends, in seconds, or null. */
export function selfDndUntil(): number | null {
  const self = get().att.dnd.self;
  if (!self) return null;
  const now = Date.now() / 1000;
  if (self.snooze_enabled && (self.snooze_endtime ?? 0) > now) return self.snooze_endtime!;
  if (windowOpen(self, now)) return self.next_dnd_end_ts;
  return null;
}

export async function snooze(minutes: number): Promise<void> {
  const result = await attempt(() => call('dnd.setSnooze', { num_minutes: minutes }));
  if (result) patchAtt((att) => ({ dnd: { ...att.dnd, self: { ...(att.dnd.self ?? { dnd_enabled: false, next_dnd_start_ts: 1, next_dnd_end_ts: 1 }), snooze_enabled: true, snooze_endtime: result.snooze_endtime } } }));
}

export async function resumeNotifications(): Promise<void> {
  await attempt(() => call('dnd.endDnd'));
}

export async function saveDndSchedule(schedule: Partial<DndSchedule>): Promise<boolean> {
  const result = await attempt(() => call('client.dnd.setSchedule', schedule));
  if (!result) return false;
  patchAtt((att) => ({ dnd: { ...att.dnd, self: result.dnd_status, schedule: result.schedule } }));
  return true;
}

export async function notifyAnyway(channel: string, ts: string): Promise<void> {
  const result = await attempt(() => call('client.dnd.notifyAnyway', { channel, ts }));
  if (result) toast(S.att.dnd.notified);
}

// ── Notification level ──────────────────────────────────────────────────────

export type NotifyLevel = 'default' | 'all' | 'mentions' | 'nothing';

export async function setNotifyLevel(channel: string, level: NotifyLevel): Promise<void> {
  patchChannel(channel, { notify_level: level });
  const result = await attempt(() => call('client.conversations.setNotify', { channel, level }));
  if (result) adoptChannel(result.channel as Conversation);
}

// ── Activity ────────────────────────────────────────────────────────────────

export interface ActivityItem {
  id: string;
  type: 'mention' | 'thread_reply' | 'reaction' | 'invite' | 'keyword';
  created: number;
  is_unread: boolean;
  channel: string;
  ts: string;
  thread_ts?: string;
  actor: string | null;
  reaction?: string;
  keyword?: string;
  broadcast?: boolean;
  message?: Message;
}

export async function fetchActivity(args: { types?: string; unread_only?: boolean; cursor?: string }): Promise<{ items: ActivityItem[]; next: string }> {
  const result = await call('client.activity.list', { limit: 30, ...args });
  return { items: result.items as ActivityItem[], next: result.response_metadata?.next_cursor ?? '' };
}

export async function markActivity(target: { ids: string[] } | { all: true }, read = true): Promise<void> {
  const result = await attempt(() => call('client.activity.mark', { ...target, unread: !read }));
  if (result) patchAtt({ activityUnread: result.unread_count });
}

// ── Threads ─────────────────────────────────────────────────────────────────

export interface ThreadSummary {
  channel: string;
  thread_ts: string;
  root: Message & { subscribed?: boolean; last_read?: string };
  latest_replies: Message[];
  unread: boolean;
  last_read: string;
}

export async function fetchThreads(cursor?: string): Promise<{ threads: ThreadSummary[]; next: string }> {
  const result = await call('client.threads.list', { limit: 20, cursor });
  const unreadThreads: Record<string, true> = {};
  for (const item of result.unread ?? []) unreadThreads[threadKey(item.channel, item.thread_ts)] = true;
  patchAtt({ unreadThreads });
  return { threads: result.threads as ThreadSummary[], next: result.response_metadata?.next_cursor ?? '' };
}

const threadMarks = new Map<string, number>();

/** The viewer has seen a thread up to `ts`. Debounced, and only when it was unread. */
export function markThreadSeen(channel: string, threadTs: string, ts: string): void {
  const key = threadKey(channel, threadTs);
  if (!get().att.unreadThreads[key]) return;
  patchAtt((att) => {
    const unreadThreads = { ...att.unreadThreads };
    delete unreadThreads[key];
    return { unreadThreads };
  });
  window.clearTimeout(threadMarks.get(key));
  threadMarks.set(
    key,
    window.setTimeout(() => void call('client.threads.mark', { channel, thread_ts: threadTs, ts }).catch(() => undefined), 300),
  );
}

export async function setThreadFollow(channel: string, threadTs: string, subscribed: boolean): Promise<boolean> {
  const result = await attempt(() => call('client.threads.setSubscription', { channel, thread_ts: threadTs, subscribed }));
  if (!result) return !subscribed;
  toast(subscribed ? S.att.threads.followed : S.att.threads.unfollowed);
  return subscribed;
}

// ── Saved for later and reminders ───────────────────────────────────────────

export function savedState(channel: string, ts: string): AttentionState['saved'][string] | undefined {
  return get().att.saved[`${channel}:${ts}`];
}

export async function toggleSaved(channel: string, ts: string): Promise<void> {
  const key = `${channel}:${ts}`;
  const current = get().att.saved[key];
  if (current === 'in_progress') {
    patchAtt((att) => {
      const saved = { ...att.saved };
      delete saved[key];
      return { saved };
    });
    await attempt(() => call('client.saved.remove', { channel, ts }));
  } else {
    patchAtt((att) => ({ saved: { ...att.saved, [key]: 'in_progress' } }));
    const ok = await attempt(() => call('client.saved.add', { channel, ts }));
    if (ok) toast(S.att.later.saved);
  }
}

export async function setSavedState(channel: string, ts: string, state: 'in_progress' | 'archived' | 'completed'): Promise<void> {
  patchAtt((att) => ({ saved: { ...att.saved, [`${channel}:${ts}`]: state } }));
  await attempt(() => call('client.saved.update', { channel, ts, state }));
}

export async function removeSaved(channel: string, ts: string): Promise<void> {
  patchAtt((att) => {
    const saved = { ...att.saved };
    delete saved[`${channel}:${ts}`];
    return { saved };
  });
  await attempt(() => call('client.saved.remove', { channel, ts }));
}

/** Readable "when" for a reminder confirmation, in the interface language. */
export { whenText };

export async function remindAbout(channel: string, ts: string, time: string): Promise<void> {
  const result = await attempt(() => call('client.saved.remind', { channel, ts, time }));
  if (result) toast(S.att.later.reminderSet(whenText(result.reminder.time)));
}

// ── Drafts ──────────────────────────────────────────────────────────────────

export function draftKey(channel: string, threadTs?: string): string {
  return threadTs ? `${channel}:${threadTs}` : channel;
}

const CLIENT_ID = crypto.randomUUID();
const draftTimers = new Map<string, number>();

/** Keep a draft on the server (debounced) so it is there on other devices too. */
export function saveDraft(channel: string, threadTs: string | undefined, text: string): void {
  const key = draftKey(channel, threadTs);
  const current = get().att.drafts[key]?.text ?? '';
  if (current === text) return;
  patchAtt((att) => {
    const drafts = { ...att.drafts };
    if (text.trim()) drafts[key] = { text, updated: Math.floor(Date.now() / 1000) };
    else delete drafts[key];
    return { drafts };
  });
  window.clearTimeout(draftTimers.get(key));
  draftTimers.set(
    key,
    window.setTimeout(() => {
      void call('client.drafts.set', { channel, thread_ts: threadTs, text, client_id: CLIENT_ID }).catch(() => undefined);
    }, text.trim() ? 800 : 0),
  );
}

export function serverDraft(channel: string, threadTs?: string): string | undefined {
  return get().att.drafts[draftKey(channel, threadTs)]?.text;
}

/** Listeners that want to know when a draft arrives from another device (open composers). */
export const draftEvents = new EventTarget();

// ── Scheduled messages ──────────────────────────────────────────────────────

export async function scheduleMessage(channel: string, text: string, postAt: number, threadTs?: string, broadcast?: boolean): Promise<boolean> {
  const result = await attempt(() => call('chat.scheduleMessage', { channel, text, post_at: postAt, thread_ts: threadTs, reply_broadcast: broadcast || undefined }));
  if (!result) return false;
  toast(S.att.schedule.scheduled(whenText(postAt)));
  return true;
}

// ── Bookmarks ───────────────────────────────────────────────────────────────

export async function loadBookmarks(channel: string): Promise<void> {
  try {
    const result = await call('bookmarks.list', { channel_id: channel });
    patchAtt((att) => ({ bookmarks: { ...att.bookmarks, [channel]: result.bookmarks as Bookmark[] } }));
  } catch {
    patchAtt((att) => ({ bookmarks: { ...att.bookmarks, [channel]: [] } }));
  }
}

function upsertBookmark(bookmark: Bookmark): void {
  patchAtt((att) => {
    const list = [...(att.bookmarks[bookmark.channel_id] ?? [])];
    const index = list.findIndex((item) => item.id === bookmark.id);
    if (index === -1) list.push(bookmark);
    else list[index] = bookmark;
    list.sort((a, b) => a.rank.localeCompare(b.rank));
    return { bookmarks: { ...att.bookmarks, [bookmark.channel_id]: list } };
  });
}

export async function saveBookmark(channel: string, fields: { title: string; link: string }, id?: string): Promise<boolean> {
  try {
    const result = id
      ? await call('bookmarks.edit', { channel_id: channel, bookmark_id: id, ...fields })
      : await call('bookmarks.add', { channel_id: channel, type: 'link', ...fields });
    upsertBookmark(result.bookmark as Bookmark);
    return true;
  } catch (error) {
    toast(errorText(error), 'error');
    return false;
  }
}

export async function removeBookmark(channel: string, id: string): Promise<void> {
  const result = await attempt(() => call('bookmarks.remove', { channel_id: channel, bookmark_id: id }));
  if (result) patchAtt((att) => ({ bookmarks: { ...att.bookmarks, [channel]: (att.bookmarks[channel] ?? []).filter((item) => item.id !== id) } }));
}

// ── Forwarding ──────────────────────────────────────────────────────────────

export async function forwardMessage(channel: string, ts: string, to: string[], text: string): Promise<boolean> {
  const result = await attempt(() => call('client.messages.share', { channel, ts, to, text }));
  if (result) toast(S.att.forward.done);
  return Boolean(result);
}

export async function shareFile(file: FileObject, to: string[], text: string): Promise<boolean> {
  const result = await attempt(() => call('client.files.share', { file: file.id, to, text }));
  if (result) toast(S.att.forward.filesDone);
  return Boolean(result);
}

export async function removePreview(channel: string, ts: string, url: string): Promise<void> {
  await attempt(() => call('client.messages.removePreview', { channel, ts, url }));
}

// ── Posting permissions and the message policy ──────────────────────────────

export function isManager(conv: Conversation | undefined, userId: string | undefined): boolean {
  return Boolean(conv && userId && conv.managers?.includes(userId));
}

export function canPostIn(conv: Conversation | undefined): { top: boolean; thread: boolean; broadcastMention: boolean } {
  const state = get();
  const self = state.self;
  const privileged = Boolean(self && (self.is_admin || isManager(conv, self.id)));
  const props = conv?.properties;
  return {
    top: privileged || !props?.posting_restrictions,
    thread: privileged || !props?.threads_restrictions,
    broadcastMention: privileged || !props?.at_channel_restricted,
  };
}

export function canEditMessage(message: Message): boolean {
  const state = get();
  if (state.self?.is_admin) return true;
  const window = state.att.messagePolicy.msg_edit_window_mins;
  return window < 0 || Date.now() / 1000 - Number(message.ts) <= window * 60;
}

export function canDeleteOwn(): boolean {
  const state = get();
  return Boolean(state.self?.is_admin) || state.att.messagePolicy.allow_message_deletion !== 'admins';
}

// ── Recent searches (this browser only) ─────────────────────────────────────

function recentKey(): string {
  return `recent-searches:${get().team?.id ?? ''}`;
}

export function recentSearches(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(recentKey()) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function recordSearch(query: string): void {
  const text = query.trim();
  if (!text) return;
  const next = [text, ...recentSearches().filter((item) => item !== text)].slice(0, 8);
  try {
    localStorage.setItem(recentKey(), JSON.stringify(next));
  } catch {
    // Storage is full or off: recent searches are a convenience.
  }
}

export function clearRecentSearches(): void {
  try {
    localStorage.removeItem(recentKey());
  } catch {
    // Nothing to clear.
  }
}

// ── Events ──────────────────────────────────────────────────────────────────

/** Handle an event this module owns. Returns true when it did. */
export function handleAttentionEvent(event: Json): boolean {
  switch (event.type) {
    case 'activity_added':
      patchAtt({ activityUnread: event.unread_count });
      notifyViews('activity');
      onActivity?.(event.item as ActivityItem);
      return true;
    case 'activity_removed':
    case 'activity_marked':
      patchAtt({ activityUnread: event.unread_count });
      notifyViews('activity');
      return true;
    case 'thread_unread':
      patchAtt((att) => ({ unreadThreads: { ...att.unreadThreads, [threadKey(event.channel, event.thread_ts)]: true } }));
      notifyViews('threads');
      return true;
    case 'thread_marked':
    case 'thread_subscription_changed': {
      const key = threadKey(event.channel, event.thread_ts);
      if (event.type === 'thread_marked' || event.subscribed === false) {
        patchAtt((att) => {
          const unreadThreads = { ...att.unreadThreads };
          delete unreadThreads[key];
          return { unreadThreads };
        });
      }
      notifyViews('threads');
      return true;
    }
    case 'dnd_updated':
      patchAtt((att) => ({ dnd: { ...att.dnd, self: event.dnd_status, schedule: event.schedule ?? att.dnd.schedule } }));
      return true;
    case 'dnd_updated_user':
      if (event.user === get().self?.id) return true;
      patchAtt((att) => ({ dnd: { ...att.dnd, users: { ...att.dnd.users, [event.user]: event.dnd_status } } }));
      return true;
    case 'dnd_override':
      onOverride?.(event.channel, event.ts, event.user);
      return true;
    case 'scheduled_messages_changed':
      patchAtt((att) => ({ scheduledCount: Math.max(0, att.scheduledCount + (event.added ? 1 : event.removed || event.sent || event.failed ? -1 : 0)) }));
      notifyViews('scheduled');
      return true;
    case 'reminders_changed':
      notifyViews('reminders');
      return true;
    case 'saved_changed':
      patchAtt((att) => {
        const saved = { ...att.saved };
        if (event.removed) delete saved[`${event.removed.channel}:${event.removed.ts}`];
        if (event.item) saved[`${event.item.channel}:${event.item.ts}`] = event.item.state;
        return { saved };
      });
      notifyViews('saved');
      return true;
    case 'draft_changed': {
      const key = draftKey(event.channel, event.thread_ts);
      patchAtt((att) => {
        const drafts = { ...att.drafts };
        if (event.text) drafts[key] = { text: event.text, updated: event.updated };
        else delete drafts[key];
        return { drafts };
      });
      if (event.client_id !== CLIENT_ID) draftEvents.dispatchEvent(new CustomEvent('draft', { detail: { key, text: event.text } }));
      notifyViews('drafts');
      return true;
    }
    case 'bookmark_added':
    case 'bookmark_changed':
      if (get().att.bookmarks[event.channel_id]) upsertBookmark(event.bookmark as Bookmark);
      return true;
    case 'bookmark_removed':
      patchAtt((att) =>
        att.bookmarks[event.channel_id]
          ? { bookmarks: { ...att.bookmarks, [event.channel_id]: att.bookmarks[event.channel_id]!.filter((item) => item.id !== event.bookmark.id) } }
          : {},
      );
      return true;
    case 'message_policy_changed':
      patchAtt({ messagePolicy: event.policy });
      return true;
    default:
      return false;
  }
}

let onActivity: ((item: ActivityItem) => void) | null = null;
let onOverride: ((channel: string, ts: string, user: string) => void) | null = null;

/** Lets the notification module hook in without a circular import at load time. */
export function setAttentionNotifiers(activity: (item: ActivityItem) => void, override: (channel: string, ts: string, user: string) => void): void {
  onActivity = activity;
  onOverride = override;
}

export function isApiError(error: unknown, code: string): boolean {
  return error instanceof ApiError && error.code === code;
}
