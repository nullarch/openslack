import { extractBlockMentions, extractMentions, type BootData, type Conversation, type Message, type User } from '@app/shared';
import { S } from '../strings';
import { ApiError, call, isUnsupported, onAuthLost, onTwoFactorRequired, type Json } from './api';
import { applyAccountsBoot, applyAccountsStatus, mentionsMyGroup } from './accounts';
import { loadEmoji } from './emoji';
import { parseRoute, pushRoute, type Route } from './router';
import {
  conversation,
  currentId,
  EMPTY_CONV,
  EMPTY_THREAD,
  get,
  set,
  threadKey,
  type ConvState,
  type LocalMessage,
  type Modal,
  type Panel,
  type ThreadPrompt,
  type ThreadState,
} from './store';
import { applyTheme } from './theme';

const PAGE = 50;
const ZERO_TS = '0000000000.000000';

// ── Feedback ────────────────────────────────────────────────────────────────

let toastId = 0;

export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  const id = (toastId += 1);
  set((state) => ({ toasts: [...state.toasts, { id, text, kind }] }));
  window.setTimeout(() => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })), 5000);
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const known = (S.errors as Record<string, string | undefined>)[error.code] ?? S.accounts.errors[error.code];
    return known ?? S.errorFallback(error.code);
  }
  return S.errors.network_error;
}

/** Run an action; on failure show why and return undefined. */
export async function attempt<T>(action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    toast(errorText(error), 'error');
    return undefined;
  }
}

// ── Start-up ────────────────────────────────────────────────────────────────

let onBooted: (() => void) | null = null;

/** Lets the realtime module hook in without a circular import at load time. */
export function setOnBooted(hook: () => void): void {
  onBooted = hook;
}

/** Further work to start once the workspace is loaded, and again after a reconnect. */
export const afterBoot: (() => void)[] = [];

export async function start(): Promise<void> {
  window.addEventListener('popstate', () => void applyRoute(parseRoute(window.location)));
  try {
    const status = await call('client.status');
    set({ publicTeam: status.team });
    applyAccountsStatus(status);
    const route = get().route;
    if (status.setup_required) {
      go({ name: 'setup' }, true);
      set({ phase: 'setup' });
      return;
    }
    if (!status.signed_in) {
      if (route.name === 'join') {
        set({ phase: 'join' });
        return;
      }
      if (route.name === 'reset') {
        set({ phase: 'reset' });
        return;
      }
      if (route.name === 'conversation' || route.name === 'workflowLink') sessionStorage.setItem('after-signin', window.location.pathname + window.location.search);
      go({ name: 'signin' }, true);
      set({ phase: 'signin' });
      return;
    }
    if (status.two_factor_setup_required) {
      set({ phase: 'twofactor' });
      return;
    }
    await boot();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'two_factor_setup_required') {
      set({ phase: 'twofactor' });
      return;
    }
    set({ phase: 'fatal', fatal: errorText(error) });
  }
}

export function applyBoot(data: BootData): void {
  const users: Record<string, User> = {};
  for (const user of data.users) users[user.id] = user;
  const channels: Record<string, Conversation> = {};
  for (const channel of data.channels) channels[channel.id] = channel;
  set({
    self: data.self,
    team: data.team,
    users,
    channels,
    presence: data.presence,
    emoji: data.emoji,
    prefs: data.prefs,
    maxUploadBytes: data.max_upload_bytes,
  });
  applyAccountsBoot(data);
  applyTheme(data.prefs.theme);
}

/** Load everything needed for the first screen, then connect. Called after sign-in too. */
export async function boot(): Promise<void> {
  const [data] = await Promise.all([call('client.boot'), loadEmoji().catch(() => undefined)]);
  applyBoot(data as BootData);
  set((state) => ({ phase: 'ready', emojiVersion: state.emojiVersion + 1 }));
  onBooted?.();
  for (const hook of afterBoot) hook();
  void loadCommands();

  const saved = sessionStorage.getItem('after-signin');
  sessionStorage.removeItem('after-signin');
  let route = get().route;
  if (saved) {
    const url = new URL(saved, window.location.origin);
    route = parseRoute(url);
    window.history.replaceState(null, '', saved);
  }
  if (route.name === 'conversation' || route.name === 'search' || route.name === 'view' || route.name === 'agents' || route.name === 'workflows' || route.name === 'workflowLink') {
    await applyRoute(route);
  }
  else goHome(true);
}

export function defaultConversation(): string | null {
  const state = get();
  const last = localStorage.getItem(`last:${state.team?.id}`);
  if (last && state.channels[last]) return last;
  const all = Object.values(state.channels);
  return (all.find((channel) => channel.is_general) ?? all.find((channel) => channel.is_channel) ?? all[0])?.id ?? null;
}

export function goHome(replace = false): void {
  const id = defaultConversation();
  if (id) go({ name: 'conversation', id }, replace);
  else {
    pushRoute({ name: 'home' }, replace);
    set({ route: { name: 'home' } });
  }
}

export async function loadCommands(): Promise<void> {
  try {
    const result = await call('client.commands.list');
    set({ commands: result.commands ?? [] });
  } catch {
    set({ commands: [] });
  }
}

// ── Navigation ──────────────────────────────────────────────────────────────

export function go(route: Route, replace = false): void {
  pushRoute(route, replace);
  void applyRoute(route);
}

/** Channels the viewer chose "mark unread" in; they are not auto-read until left. */
const keepUnread = new Set<string>();

export async function applyRoute(route: Route): Promise<void> {
  const state = get();
  const previous = currentId(state);
  if (state.phase === 'ready' && (route.name === 'setup' || route.name === 'signin' || route.name === 'join' || route.name === 'home')) {
    goHome(true);
    return;
  }
  set({ route, drawer: false, editing: null });
  if (route.name !== 'conversation' || state.phase !== 'ready') return;

  const id = route.id;
  if (previous && previous !== id) keepUnread.delete(previous);
  let conv = conversation(get(), id);
  if (!conv) {
    try {
      const info = await call('conversations.info', { channel: id });
      conv = info.channel as Conversation;
      set((current) => ({ others: { ...current.others, [id]: info.channel } }));
    } catch {
      toast(S.errors.channel_not_found, 'error');
      const fallback = defaultConversation();
      if (fallback && fallback !== id) go({ name: 'conversation', id: fallback }, true);
      return;
    }
  }
  localStorage.setItem(`last:${get().team?.id}`, id);

  // Remember where "new" starts before anything marks the conversation read.
  if (previous !== id || !get().convs[id]?.loaded) {
    const unread = (conv.unread_count ?? 0) > 0;
    patchConv(id, { marker: unread ? (conv.last_read ?? null) : null });
  }

  const cached = get().convs[id];
  const isMember = get().channels[id] !== undefined;
  if (route.ts) {
    await jumpTo(id, route.ts);
  } else if (!cached?.loaded || cached.hasNewer || !isMember) {
    await loadLatest(id);
  }
  if (route.thread) openThread(id, route.thread);
  else if (route.ts) {
    // A permalink to a reply opens its thread.
    const target = get().convs[id]?.list.find((message) => message.ts === route.ts);
    if (!target) void openReplyThread(id, route.ts);
  }
}

async function openReplyThread(channel: string, ts: string): Promise<void> {
  try {
    const result = await call('conversations.replies', { channel, ts, limit: 1 });
    const message = result.messages?.[0] as Message | undefined;
    const parent = message?.thread_ts ?? ts;
    openThread(channel, parent);
    set({ highlight: { channel, ts, at: Date.now() } });
  } catch {
    // The message is gone; nothing to open.
  }
}

export function openModal(modal: Modal): void {
  set({ modal });
}

export function closeModal(): void {
  set({ modal: null });
}

export function setPanel(panel: Panel): void {
  set({ panel });
}

// ── Message lists ───────────────────────────────────────────────────────────

function patchConv(id: string, patch: Partial<ConvState>): void {
  set((state) => ({ convs: { ...state.convs, [id]: { ...(state.convs[id] ?? EMPTY_CONV), ...patch } } }));
}

function patchThread(key: string, patch: Partial<ThreadState>): void {
  set((state) => ({ threads: { ...state.threads, [key]: { ...(state.threads[key] ?? EMPTY_THREAD), ...patch } } }));
}

function ascending(messages: Message[]): LocalMessage[] {
  return [...messages].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/** Insert or replace by `ts`; a confirmed message also replaces the pending row it came from. */
export function upsert(list: LocalMessage[], message: LocalMessage): LocalMessage[] {
  let next = list;
  if (message.client_msg_id && !message.pending) {
    const index = next.findIndex((item) => item.local_id === message.client_msg_id && item.pending);
    if (index !== -1) next = [...next.slice(0, index), ...next.slice(index + 1)];
  }
  const existing = next.findIndex((item) => item.ts === message.ts);
  if (existing !== -1) {
    const copy = next === list ? [...next] : next;
    copy[existing] = message;
    return copy;
  }
  const out = next === list ? [...next] : next;
  let index = out.length;
  while (index > 0 && out[index - 1]!.ts > message.ts) index -= 1;
  out.splice(index, 0, message);
  return out;
}

export async function loadLatest(id: string): Promise<void> {
  patchConv(id, { loading: true });
  try {
    const result = await call('conversations.history', { channel: id, limit: PAGE });
    // Rows that exist only in this tab survive a reload of the list.
    const local = (get().convs[id]?.list ?? []).filter((message) => message.pending || message.failed || message.is_ephemeral);
    patchConv(id, {
      list: ascending([...result.messages, ...local]),
      loaded: true,
      loading: false,
      hasOlder: Boolean(result.has_more),
      hasNewer: false,
    });
  } catch (error) {
    patchConv(id, { loading: false });
    toast(errorText(error), 'error');
  }
}

/**
 * How many messages a conversation keeps loaded. Beyond it the far end is
 * dropped and loaded again when the reader scrolls back there, so a long
 * session does not grow the page without bound.
 */
export const MAX_LOADED = 300;

/** Drop messages from one end of a loaded list: `newest` keeps the newest, `oldest` keeps the oldest. */
export function trimLoaded(id: string, keep: 'newest' | 'oldest'): void {
  const conv = get().convs[id];
  if (!conv || conv.list.length <= MAX_LOADED) return;
  if (keep === 'newest') {
    patchConv(id, { list: conv.list.slice(conv.list.length - MAX_LOADED), hasOlder: true });
  } else {
    // Rows still being sent live at the newest end; keep them by not trimming yet.
    if (conv.list.some((message) => message.pending || message.failed)) return;
    patchConv(id, { list: conv.list.slice(0, MAX_LOADED), hasNewer: true });
  }
}

export async function loadOlder(id: string): Promise<void> {
  const conv = get().convs[id];
  if (!conv?.loaded || conv.loading || !conv.hasOlder || conv.list.length === 0) return;
  patchConv(id, { loading: true });
  try {
    const result = await call('conversations.history', { channel: id, limit: PAGE, latest: conv.list[0]!.ts });
    const current = get().convs[id] ?? EMPTY_CONV;
    patchConv(id, { list: [...ascending(result.messages), ...current.list], loading: false, hasOlder: Boolean(result.has_more) });
  } catch (error) {
    patchConv(id, { loading: false });
    toast(errorText(error), 'error');
  }
}

export async function loadNewer(id: string): Promise<void> {
  const conv = get().convs[id];
  if (!conv?.loaded || conv.loading || !conv.hasNewer) return;
  const confirmed = conv.list.filter((message) => !message.pending && !message.failed);
  const last = confirmed.at(-1);
  if (!last) return;
  patchConv(id, { loading: true });
  try {
    const result = await call('conversations.history', { channel: id, limit: PAGE, oldest: last.ts });
    let list = (get().convs[id] ?? EMPTY_CONV).list;
    for (const message of ascending(result.messages)) list = upsert(list, message);
    patchConv(id, { list, loading: false, hasNewer: Boolean(result.has_more) });
  } catch (error) {
    patchConv(id, { loading: false });
    toast(errorText(error), 'error');
  }
}

/** Fetch anything newer than what is shown (after a send that produced no local row, or a reconnect). */
export async function syncNewer(id: string): Promise<void> {
  const conv = get().convs[id];
  if (!conv?.loaded || conv.hasNewer) return;
  const last = conv.list.filter((message) => !message.pending && !message.failed).at(-1);
  try {
    const result = await call('conversations.history', last ? { channel: id, limit: 100, oldest: last.ts } : { channel: id, limit: PAGE });
    let list = (get().convs[id] ?? EMPTY_CONV).list;
    for (const message of ascending(result.messages)) list = upsert(list, message);
    patchConv(id, { list });
  } catch {
    // The next reconnect will try again.
  }
}

/** Show a specific message: reuse the loaded list when it is there, otherwise load the messages around it. */
export async function jumpTo(id: string, ts: string): Promise<void> {
  const conv = get().convs[id];
  if (!conv?.loaded || !conv.list.some((message) => message.ts === ts)) {
    patchConv(id, { loading: true });
    try {
      const [older, newer] = await Promise.all([
        call('conversations.history', { channel: id, latest: ts, inclusive: true, limit: 30 }),
        call('conversations.history', { channel: id, oldest: ts, limit: 30 }),
      ]);
      patchConv(id, {
        list: ascending([...older.messages, ...newer.messages]),
        loaded: true,
        loading: false,
        hasOlder: Boolean(older.has_more),
        hasNewer: Boolean(newer.has_more),
      });
    } catch (error) {
      patchConv(id, { loading: false });
      toast(errorText(error), 'error');
      return;
    }
  }
  set({ highlight: { channel: id, ts, at: Date.now() } });
}

/** Open a message from search or a link, whether it is a channel message or a thread reply. */
export function openMessage(channel: string, message: Message): void {
  const isReply = message.thread_ts !== undefined && message.thread_ts !== message.ts && message.subtype !== 'thread_broadcast';
  if (isReply) {
    go({ name: 'conversation', id: channel, ts: message.thread_ts });
    openThread(channel, message.thread_ts!);
    set({ highlight: { channel, ts: message.ts, at: Date.now() } });
  } else {
    go({ name: 'conversation', id: channel, ts: message.ts });
  }
}

// ── Mutating shared message state (also used by realtime events) ────────────

/** Apply `change` to a message wherever it is held: the channel list and any loaded thread. */
export function patchMessage(channel: string, ts: string, change: (message: LocalMessage) => LocalMessage): void {
  set((state) => {
    const next: Partial<typeof state> = {};
    const conv = state.convs[channel];
    if (conv) {
      const index = conv.list.findIndex((message) => message.ts === ts);
      if (index !== -1) {
        const list = [...conv.list];
        list[index] = change(list[index]!);
        next.convs = { ...state.convs, [channel]: { ...conv, list } };
      }
    }
    let threads = state.threads;
    for (const [key, thread] of Object.entries(state.threads)) {
      if (!key.startsWith(`${channel}:`)) continue;
      let changed = false;
      let parent = thread.parent;
      let replies = thread.replies;
      if (parent?.ts === ts) {
        parent = change(parent);
        changed = true;
      }
      const index = replies.findIndex((message) => message.ts === ts);
      if (index !== -1) {
        replies = [...replies];
        replies[index] = change(replies[index]!);
        changed = true;
      }
      if (changed) threads = { ...threads, [key]: { ...thread, parent, replies } };
    }
    if (threads !== state.threads) next.threads = threads;
    return next;
  });
}

export function removeMessage(channel: string, ts: string): void {
  set((state) => {
    const next: Partial<typeof state> = {};
    const conv = state.convs[channel];
    if (conv?.list.some((message) => message.ts === ts)) {
      next.convs = { ...state.convs, [channel]: { ...conv, list: conv.list.filter((message) => message.ts !== ts) } };
    }
    let threads = state.threads;
    for (const [key, thread] of Object.entries(state.threads)) {
      if (!key.startsWith(`${channel}:`)) continue;
      if (thread.replies.some((message) => message.ts === ts)) {
        threads = { ...threads, [key]: { ...thread, replies: thread.replies.filter((message) => message.ts !== ts) } };
      }
    }
    if (threads !== state.threads) next.threads = threads;
    return next;
  });
}

function isThreadReply(message: Message): boolean {
  return message.thread_ts !== undefined && message.thread_ts !== message.ts;
}

/** Put a message where it belongs: the channel list, its thread, or both for broadcast replies. */
export function placeMessage(channel: string, message: LocalMessage): void {
  const reply = isThreadReply(message);
  if (reply) {
    const key = threadKey(channel, message.thread_ts!);
    const thread = get().threads[key];
    if (thread?.loaded || message.pending) {
      // A real answer replaces the assistant's "working…" line and its suggestions.
      const answered = !message.pending && !message.is_ephemeral && message.user === thread?.statusUser;
      patchThread(key, {
        replies: upsert(thread?.replies ?? [], message),
        ...(answered ? { status: null, statusUser: null } : {}),
        ...(message.pending ? { prompts: null } : {}),
      });
    }
  }
  if (!reply || message.subtype === 'thread_broadcast') {
    const conv = get().convs[channel];
    if (conv?.loaded && (!conv.hasNewer || message.pending)) patchConv(channel, { list: upsert(conv.list, message) });
  }
}

export function mentionsViewer(conv: Conversation | undefined, message: Message): boolean {
  const self = get().self;
  if (!self || message.user === self.id) return false;
  if (conv?.is_im || conv?.is_mpim) return true;
  const text = extractMentions(message.text ?? '');
  if (text.broadcast || text.users.includes(self.id)) return true;
  if (mentionsMyGroup(message, self.id)) return true;
  if (!message.blocks) return false;
  const blocks = extractBlockMentions(message.blocks);
  return blocks.broadcast || blocks.users.includes(self.id);
}

// ── Sending ─────────────────────────────────────────────────────────────────

export interface Outgoing {
  channel: string;
  text: string;
  threadTs?: string;
  broadcast?: boolean;
}

/**
 * A placeholder timestamp for a message not yet confirmed. It ends in 999 so it
 * does not equal the timestamp the server is about to give the real message:
 * the server counts up from 000 within each millisecond, and on one machine
 * both read the same clock.
 */
function localTs(): string {
  return `${(Date.now() / 1000).toFixed(3)}999`;
}

/** Remove this tab's own row for a message (pending or failed), never a confirmed one. */
function removeLocal(channel: string, localId: string | undefined): void {
  if (!localId) return;
  set((state) => {
    const next: Partial<typeof state> = {};
    const mine = (message: LocalMessage): boolean => message.local_id === localId && (message.pending === true || message.failed === true);
    const conv = state.convs[channel];
    if (conv?.list.some(mine)) next.convs = { ...state.convs, [channel]: { ...conv, list: conv.list.filter((message) => !mine(message)) } };
    let threads = state.threads;
    for (const [key, thread] of Object.entries(state.threads)) {
      if (key.startsWith(`${channel}:`) && thread.replies.some(mine)) {
        threads = { ...threads, [key]: { ...thread, replies: thread.replies.filter((message) => !mine(message)) } };
      }
    }
    if (threads !== state.threads) next.threads = threads;
    return next;
  });
}

export async function sendMessage(out: Outgoing, retryOf?: LocalMessage): Promise<void> {
  const state = get();
  const self = state.self;
  if (!self) return;
  if (state.convs[out.channel]?.hasNewer && !out.threadTs) await loadLatest(out.channel);
  if (retryOf) removeLocal(out.channel, retryOf.local_id);
  const localId = crypto.randomUUID();
  const pending: LocalMessage = {
    type: 'message',
    ts: localTs(),
    user: self.id,
    text: out.text,
    pending: true,
    local_id: localId,
  };
  if (out.threadTs) pending.thread_ts = out.threadTs;
  placeMessage(out.channel, pending);
  try {
    const result = await call('chat.postMessage', {
      channel: out.channel,
      text: out.text,
      thread_ts: out.threadTs,
      reply_broadcast: out.broadcast ? true : undefined,
      client_msg_id: localId,
    });
    removeLocal(out.channel, localId);
    const confirmed = result.message as Message;
    // The message may already be here from the realtime connection, and already changed since
    // (an app attached a preview before this response arrived); that copy is the newer one.
    if (!isPlaced(out.channel, confirmed.ts)) placeMessage(out.channel, confirmed);
  } catch (error) {
    patchMessage(out.channel, pending.ts, (message) => (message.local_id === localId ? { ...message, pending: false, failed: true } : message));
    toast(errorText(error), 'error');
  }
}

/** Whether a confirmed message with this `ts` is already in the conversation or its thread. */
function isPlaced(channel: string, ts: string): boolean {
  const state = get();
  if (state.convs[channel]?.list.some((message) => message.ts === ts && !message.pending)) return true;
  return Object.entries(state.threads).some(
    ([key, thread]) => key.startsWith(`${channel}:`) && thread.replies.some((message) => message.ts === ts && !message.pending),
  );
}

export function retryMessage(channel: string, message: LocalMessage): void {
  void sendMessage({ channel, text: message.text, threadTs: message.thread_ts }, message);
}

export function discardFailed(channel: string, message: LocalMessage): void {
  removeLocal(channel, message.local_id);
}

export async function sendFiles(out: Outgoing, fileIds: string[]): Promise<boolean> {
  try {
    await call('files.completeUploadExternal', {
      files: fileIds.map((id) => ({ id })),
      channel_id: out.channel,
      initial_comment: out.text || undefined,
      thread_ts: out.threadTs,
    });
    void syncNewer(out.channel);
    if (out.threadTs) void loadThread(out.channel, out.threadTs);
    return true;
  } catch (error) {
    toast(errorText(error), 'error');
    return false;
  }
}

export async function editMessage(channel: string, ts: string, text: string): Promise<boolean> {
  try {
    const result = await call('chat.update', { channel, ts, text });
    patchMessage(channel, ts, () => result.message as Message);
    return true;
  } catch (error) {
    toast(errorText(error), 'error');
    return false;
  }
}

export async function deleteMessage(channel: string, ts: string): Promise<void> {
  await attempt(() => call('chat.delete', { channel, ts }));
}

export async function toggleReaction(channel: string, message: Message, name: string): Promise<void> {
  const self = get().self;
  if (!self || (message as LocalMessage).pending) return;
  const mine = message.reactions?.some((reaction) => reaction.name === name && reaction.users.includes(self.id));
  try {
    await call(mine ? 'reactions.remove' : 'reactions.add', { channel, timestamp: message.ts, name });
  } catch (error) {
    if (error instanceof ApiError && (error.code === 'already_reacted' || error.code === 'no_reaction')) return;
    toast(errorText(error), 'error');
  }
}

export async function setPinned(channel: string, ts: string, pinned: boolean): Promise<void> {
  await attempt(() => call(pinned ? 'pins.add' : 'pins.remove', { channel, timestamp: ts }));
}

export async function clickBlockAction(channel: string, message: Message, action: Record<string, unknown>, state?: Record<string, unknown>): Promise<void> {
  try {
    await call('client.interactions.blockAction', {
      channel,
      message_ts: message.ts,
      thread_ts: message.thread_ts,
      action,
      state,
    });
  } catch (error) {
    toast(isUnsupported(error) ? S.blocks.actionsUnsupported : errorText(error), 'error');
  }
}

export async function runCommand(channel: string, command: string, text: string, threadTs?: string): Promise<boolean> {
  try {
    await call('client.commands.run', { channel, command, text, thread_ts: threadTs });
    return true;
  } catch (error) {
    toast(isUnsupported(error) ? S.composer.commandsUnsupported : errorText(error), 'error');
    return false;
  }
}

// ── Read state ──────────────────────────────────────────────────────────────

const markTimers = new Map<string, number>();

function patchChannel(id: string, patch: Partial<Conversation>): void {
  set((state) => {
    if (state.channels[id]) return { channels: { ...state.channels, [id]: { ...state.channels[id]!, ...patch } } };
    if (state.others[id]) return { others: { ...state.others, [id]: { ...state.others[id]!, ...patch } } };
    return {};
  });
}

export { patchChannel };

export function markRead(channel: string, ts: string): void {
  patchChannel(channel, { unread_count: 0, unread_count_display: 0, mention_count: 0, last_read: ts });
  window.clearTimeout(markTimers.get(channel));
  markTimers.set(
    channel,
    window.setTimeout(() => {
      void call('conversations.mark', { channel, ts }).catch(() => undefined);
    }, 350),
  );
}

/** Called by the message list when the newest message is on screen and the tab has focus. */
export function maybeMarkRead(channel: string): void {
  if (keepUnread.has(channel)) return;
  const state = get();
  const conv = state.channels[channel];
  const messages = state.convs[channel];
  if (!conv || !messages?.loaded || messages.hasNewer) return;
  const last = messages.list.filter((message) => !message.pending && !message.failed && !message.is_ephemeral).at(-1);
  if (!last) return;
  // A mention inside a thread leaves a badge with nothing unread in the channel; marking again clears it.
  const nothingWaiting = (conv.unread_count ?? 0) === 0 && (conv.mention_count ?? 0) === 0;
  if (nothingWaiting && (conv.last_read ?? ZERO_TS) >= last.ts) return;
  markRead(channel, last.ts);
}

/** Make `message` and everything after it unread. */
export async function markUnreadFrom(channel: string, message: Message): Promise<void> {
  const list = get().convs[channel]?.list ?? [];
  const index = list.findIndex((item) => item.ts === message.ts);
  const previous = index > 0 ? list[index - 1]!.ts : ZERO_TS;
  keepUnread.add(channel);
  window.clearTimeout(markTimers.get(channel));
  patchConv(channel, { marker: previous });
  await attempt(() => call('conversations.mark', { channel, ts: previous }));
}

// ── Threads ─────────────────────────────────────────────────────────────────

export function openThread(channel: string, ts: string): void {
  set({ panel: { kind: 'thread', channel, ts } });
  void loadThread(channel, ts);
}

export async function loadThread(channel: string, ts: string): Promise<void> {
  const key = threadKey(channel, ts);
  try {
    const result = await call('conversations.replies', { channel, ts, limit: 1000 });
    const [parent, ...replies] = result.messages as Message[];
    const pending = (get().threads[key]?.replies ?? []).filter((message) => message.pending || message.failed);
    patchThread(key, { parent: parent ?? null, replies: [...replies, ...pending], loaded: true });
  } catch (error) {
    patchThread(key, { loaded: true });
    if (!(error instanceof ApiError && error.code === 'thread_not_found')) toast(errorText(error), 'error');
  }
}

export function setThreadStatus(channel: string, ts: string, status: string | null, user: string | null = null): void {
  patchThread(threadKey(channel, ts), { status, statusUser: status ? user : null });
}

export function setThreadTitle(channel: string, ts: string, title: string): void {
  patchThread(threadKey(channel, ts), { title: title || null });
}

export function setThreadPrompts(channel: string, ts: string, title: string, items: ThreadPrompt[]): void {
  patchThread(threadKey(channel, ts), { prompts: items.length > 0 ? { title, items } : null });
}

// ── Conversations referred to but not joined ───────────────────────────────

const infoRequests = new Set<string>();

/** Look up a conversation that text refers to, once, so its name can be shown. */
export function ensureConversationInfo(id: string): void {
  if (infoRequests.has(id) || conversation(get(), id)) return;
  infoRequests.add(id);
  call('conversations.info', { channel: id })
    .then((result) => {
      const channel = result.channel as Conversation;
      set((state) => (state.channels[id] ? {} : { others: { ...state.others, [id]: channel } }));
    })
    .catch(() => {
      // Not visible to the viewer: the link stays generic.
      set((state) => ({ hiddenChannels: { ...state.hiddenChannels, [id]: true } }));
    });
}

// ── Conversations ───────────────────────────────────────────────────────────

function adopt(channel: Conversation): void {
  set((state) => {
    const others = { ...state.others };
    delete others[channel.id];
    return { channels: { ...state.channels, [channel.id]: { ...state.channels[channel.id], ...channel } }, others };
  });
}

export { adopt as adoptChannel };

export async function openDirect(userIds: string[]): Promise<void> {
  const result = await attempt(() => call('conversations.open', { users: userIds.join(','), return_im: true }));
  if (!result) return;
  adopt(result.channel);
  go({ name: 'conversation', id: result.channel.id });
}

export async function joinChannel(id: string): Promise<void> {
  const result = await attempt(() => call('conversations.join', { channel: id }));
  if (!result) return;
  const info = await attempt(() => call('conversations.info', { channel: id }));
  adopt({ ...result.channel, ...(info?.channel ?? {}), is_member: true });
  void loadLatest(id);
}

export async function leaveChannel(id: string): Promise<void> {
  const result = await attempt(() => call('conversations.leave', { channel: id }));
  if (result) forgetChannel(id);
}

export async function closeDirect(id: string): Promise<void> {
  const result = await attempt(() => call('conversations.close', { channel: id }));
  if (result) forgetChannel(id);
}

/** Drop a conversation from the sidebar and move away from it if it is open. */
export function forgetChannel(id: string): void {
  const state = get();
  if (!state.channels[id]) return;
  const channels = { ...state.channels };
  const removed = channels[id]!;
  delete channels[id];
  const others = removed.is_private ? state.others : { ...state.others, [id]: { ...removed, is_member: false } };
  set({ channels, others, panel: state.panel && 'channel' in state.panel && state.panel.channel === id ? null : state.panel });
  if (currentId(state) === id) goHome(true);
}

export async function createChannel(name: string, isPrivate: boolean): Promise<Json | undefined> {
  const result = await call('conversations.create', { name, is_private: isPrivate });
  adopt({ ...result.channel, is_member: true, unread_count: 0, mention_count: 0 });
  go({ name: 'conversation', id: result.channel.id });
  return result.channel;
}

export async function setConversationPrefs(id: string, prefs: { starred?: boolean; muted?: boolean }): Promise<void> {
  patchChannel(id, {
    ...(prefs.starred !== undefined ? { is_starred: prefs.starred } : {}),
    ...(prefs.muted !== undefined ? { is_muted: prefs.muted } : {}),
  });
  await attempt(() => call('client.conversations.setPrefs', { channel: id, ...prefs }));
}

// ── Preferences and session ─────────────────────────────────────────────────

export async function setPrefs(patch: Record<string, unknown>): Promise<void> {
  set((state) => ({ prefs: { ...state.prefs, ...patch } }));
  if ('theme' in patch) applyTheme(patch.theme);
  await attempt(() => call('client.prefs.set', { prefs: patch }));
}

let leaving = false;

/**
 * The session is gone (signed out elsewhere, or the account was deactivated):
 * leave the workspace for the sign-in screen, once.
 */
export function sessionEnded(): void {
  if (leaving || get().phase !== 'ready') return;
  leaving = true;
  window.location.assign('/signin');
}

onAuthLost(sessionEnded);
// The workspace started requiring two-factor sign-in: set it up before going on.
onTwoFactorRequired(() => {
  if (get().phase === 'ready') window.location.assign('/');
});

export async function signOut(): Promise<void> {
  try {
    await call('client.signout');
  } finally {
    window.location.assign('/signin');
  }
}

// ── Typing ──────────────────────────────────────────────────────────────────

export function noteTyping(key: string, user: string): void {
  set((state) => ({ typing: { ...state.typing, [key]: { ...state.typing[key], [user]: Date.now() + 5000 } } }));
}

export function clearTyping(key: string, user: string): void {
  set((state) => {
    const current = state.typing[key];
    if (!current?.[user]) return {};
    const next = { ...current };
    delete next[user];
    return { typing: { ...state.typing, [key]: next } };
  });
}

window.setInterval(() => {
  const state = get();
  const now = Date.now();
  let changed = false;
  const typing: typeof state.typing = {};
  for (const [key, users] of Object.entries(state.typing)) {
    const live = Object.fromEntries(Object.entries(users).filter(([, until]) => until > now));
    if (Object.keys(live).length !== Object.keys(users).length) changed = true;
    if (Object.keys(live).length > 0) typing[key] = live;
  }
  if (changed) set({ typing });
}, 1500);
