import { call } from './api';
import { go, openModal } from './actions';
import { parseRoute } from './router';
import { conversation, conversationName, displayName, get, useStore } from './store';

/**
 * Inside the native apps (apps/mobile) the server's own web client runs in
 * the app's web view, which puts Capacitor's bridge on `window.Capacitor`.
 * There is no import of Capacitor here: the bridge is used only when present,
 * and in a browser nothing below does anything.
 *
 * In the app: notifications are the phone's own (registered with the server,
 * sent through the relay) instead of Web Push; a tapped notification opens its
 * message; a link that opens another server goes through the app's server
 * list; and the workspace menu offers the way back to that list.
 */

interface PluginListener {
  remove(): Promise<void>;
}

interface PushPlugin {
  checkPermissions(): Promise<{ receive: 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale' }>;
  requestPermissions(): Promise<{ receive: 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale' }>;
  register(): Promise<void>;
  unregister?(): Promise<void>;
  addListener(event: 'registration', listener: (token: { value: string }) => void): Promise<PluginListener>;
  addListener(event: 'registrationError', listener: (error: { error: string }) => void): Promise<PluginListener>;
  addListener(event: 'pushNotificationActionPerformed', listener: (action: { notification: { data?: Record<string, string> } }) => void): Promise<PluginListener>;
}

interface AppPlugin {
  addListener(event: 'appUrlOpen', listener: (event: { url: string }) => void): Promise<PluginListener>;
}

/** What another app shared (apps/mobile: ShareTargetPlugin.java on Android, ShareTargetPlugin.swift and the share extension on iOS). */
interface Shared {
  text?: string;
  files?: { name: string; type: string; data: string }[];
}

interface ShareTargetPlugin {
  take(): Promise<Shared>;
  addListener(event: 'shareReceived', listener: (share: Shared) => void): Promise<PluginListener>;
}

interface PreferencesPlugin {
  set(options: { key: string; value: string }): Promise<void>;
}

interface KeyboardPlugin {
  addListener(event: 'keyboardDidHide', listener: () => void): Promise<PluginListener>;
}

interface CapacitorBridge {
  isNativePlatform(): boolean;
  getPlatform(): 'ios' | 'android' | 'web';
  Plugins: { PushNotifications?: PushPlugin; App?: AppPlugin; ShareTarget?: ShareTargetPlugin; Preferences?: PreferencesPlugin; Keyboard?: KeyboardPlugin };
}

const TOKEN_KEY = 'native-push-token';

function bridge(): CapacitorBridge | null {
  const capacitor = (window as unknown as { Capacitor?: CapacitorBridge }).Capacitor;
  return capacitor?.isNativePlatform?.() ? capacitor : null;
}

export function isNativeApp(): boolean {
  return bridge() !== null;
}

/** The app's own page (the server list), where "Switch server" goes. */
export function serverListUrl(query = 'switch=1'): string {
  const origin = bridge()?.getPlatform() === 'android' ? 'https://localhost' : 'capacitor://localhost';
  return `${origin}/?${query}`;
}

function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Not remembered: registration simply happens again next time.
  }
}

/** Ask the phone for a push token and give it to the server. Resolves once the phone answers. */
function registerWithPhone(push: PushPlugin): Promise<boolean> {
  return new Promise((resolve) => {
    const listeners: Promise<PluginListener>[] = [];
    const finish = (ok: boolean): void => {
      for (const listener of listeners) void listener.then((handle) => handle.remove());
      resolve(ok);
    };
    listeners.push(
      push.addListener('registration', (token) => {
        storeToken(token.value);
        void call('client.push.registerDevice', { platform: bridge()?.getPlatform() ?? 'ios', device_token: token.value })
          .then(() => finish(true))
          .catch(() => finish(false));
      }),
    );
    listeners.push(
      push.addListener('registrationError', (error) => {
        console.warn('[native] push registration failed', error.error);
        finish(false);
      }),
    );
    void push.register().catch(() => finish(false));
  });
}

export type NativePushState = 'unsupported' | 'blocked' | 'off' | 'on';

/** Whether this phone gets this server's notifications. */
export async function nativePushState(): Promise<NativePushState> {
  const push = bridge()?.Plugins.PushNotifications;
  if (!push) return 'unsupported';
  const status = await call('client.push.status').catch(() => null);
  if (!status?.native_relay) return 'unsupported';
  const permission = (await push.checkPermissions()).receive;
  if (permission === 'denied') return 'blocked';
  return permission === 'granted' && storedToken() ? 'on' : 'off';
}

export async function enableNativePush(): Promise<NativePushState> {
  const push = bridge()?.Plugins.PushNotifications;
  if (!push) return 'unsupported';
  const permission = (await push.requestPermissions()).receive;
  if (permission !== 'granted') return 'blocked';
  return (await registerWithPhone(push)) ? 'on' : 'off';
}

export async function disableNativePush(): Promise<NativePushState> {
  const token = storedToken();
  if (token) await call('client.push.unregisterDevice', { device_token: token }).catch(() => undefined);
  storeToken(null);
  return 'off';
}

/** Before signing out: this phone should stop getting the account's notifications. */
export async function forgetThisPhone(): Promise<void> {
  if (isNativeApp()) await disableNativePush();
}

// ── Shared from another app ─────────────────────────────────────────────────

let shares = 0;

function receiveShare(share: Shared): void {
  const text = (share.text ?? '').slice(0, 40_000);
  const files = (share.files ?? []).slice(0, 10);
  if (!text && files.length === 0) return;
  // A new share replaces one still open (the id starts its dialog afresh).
  openModal({ kind: 'incomingShare', id: ++shares, text, files });
}

/** A share waits until someone is signed in and the workspace is on screen. */
function whenReady(then: () => void): void {
  if (get().phase === 'ready') {
    then();
    return;
  }
  const stop = useStore.subscribe((state) => {
    if (state.phase !== 'ready') return;
    stop();
    then();
  });
}

// ── Offline reading ─────────────────────────────────────────────────────────

const OFFLINE_CONVERSATIONS = 10;
const OFFLINE_MESSAGES = 40;
const recent: string[] = [];

/** Message text as plain reading text: people and channels by name, links by their label. */
function readable(text: string): string {
  const state = get();
  return text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_whole, id: string) => `@${displayName(state.users[id])}`)
    .replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_whole, id: string, name?: string) => `#${name || conversation(state, id)?.name || id}`)
    .replace(/<!(here|channel|everyone)>/g, '@$1')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>]+)>/g, '$1')
    // Bold and struck-through words read as plain words (underscores are left: names and links have them).
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,!?])/g, '$1$2')
    .replace(/(^|\s)~([^~\n]+)~(?=\s|$|[.,!?])/g, '$1$2')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Keep the last messages of the conversations looked at most recently in the
 * app's own storage. When this server cannot be reached the app shows them
 * from its own page (apps/mobile/www/offline.html): an iOS web view cannot
 * open the server's page without the network.
 */
function saveForOffline(preferences: PreferencesPlugin): void {
  const state = get();
  if (state.phase !== 'ready' || !state.team) return;
  const conversations = recent
    .map((id) => {
      const conv = conversation(state, id);
      const list = state.convs[id]?.list ?? [];
      if (!conv || list.length === 0) return null;
      return {
        id,
        name: conversationName(state, conv),
        direct: Boolean(conv.is_im || conv.is_mpim),
        messages: list
          .filter((message) => !message.pending && !message.subtype?.startsWith('channel_'))
          .slice(-OFFLINE_MESSAGES)
          .map((message) => ({
            ts: message.ts,
            user: message.username || displayName(state.users[message.user ?? '']) || message.bot_profile?.name || '',
            text: readable(message.text ?? '').slice(0, 2000),
            files: (message.files ?? []).map((file) => file.title || file.name).filter(Boolean),
          })),
      };
    })
    .filter((entry) => entry !== null);
  const snapshot = { server: window.location.origin, team: state.team.name, saved: Date.now(), conversations };
  void preferences.set({ key: `offline:${window.location.origin}`, value: JSON.stringify(snapshot) }).catch(() => undefined);
}

function keepForOffline(preferences: PreferencesPlugin): void {
  let timer = 0;
  let lastRoute = '';
  let lastList: unknown = null;
  useStore.subscribe((state) => {
    const route = state.route.name === 'conversation' ? state.route.id : '';
    if (route && route !== lastRoute) {
      const index = recent.indexOf(route);
      if (index >= 0) recent.splice(index, 1);
      recent.unshift(route);
      recent.length = Math.min(recent.length, OFFLINE_CONVERSATIONS);
    }
    const list = route ? state.convs[route]?.list : null;
    if (route === lastRoute && list === lastList) return;
    lastRoute = route;
    lastList = list;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => saveForOffline(preferences), 2000);
  });
  // Leaving the app (or the phone locking) saves what is on screen at once.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveForOffline(preferences);
  });
}

/** Set up the app's side: tapped notifications, links, shares, offline reading, and a fresh token when notifications are on. */
export function installNative(): void {
  const capacitor = bridge();
  if (!capacitor) return;
  document.documentElement.classList.add('native-app');
  // iOS scrolls the page to show a focused field and can leave it there once the keyboard
  // is gone (the app makes the web view shorter instead: Keyboard resize native).
  void capacitor.Plugins.Keyboard?.addListener('keyboardDidHide', () => window.scrollTo(0, 0));
  const push = capacitor.Plugins.PushNotifications;
  void push?.addListener('pushNotificationActionPerformed', (action) => {
    const data = action.notification.data ?? {};
    // A notification from another server opens that server; one from here opens the message.
    if (data.server && data.server !== window.location.origin) {
      window.location.href = `${data.server}${data.url ?? '/'}`;
      return;
    }
    if (data.url) {
      const url = new URL(data.url, window.location.origin);
      go(parseRoute({ pathname: url.pathname, search: url.search }));
    }
  });
  void capacitor.Plugins.App?.addListener('appUrlOpen', (event) => {
    try {
      const url = new URL(event.url);
      const server = url.searchParams.get('server');
      if (server && new URL(server).origin !== window.location.origin) window.location.href = serverListUrl(`open=${encodeURIComponent(server)}`);
    } catch {
      // Not a link this app understands.
    }
  });
  const share = capacitor.Plugins.ShareTarget;
  if (share) {
    void share.take().then((shared) => whenReady(() => receiveShare(shared)));
    void share.addListener('shareReceived', (shared) => whenReady(() => receiveShare(shared)));
  }
  if (capacitor.Plugins.Preferences) keepForOffline(capacitor.Plugins.Preferences);
  // Tokens change (a reinstall, a restore): send the current one again when notifications are on.
  if (push && storedToken()) {
    void push.checkPermissions().then((status) => {
      if (status.receive === 'granted') void registerWithPhone(push);
    });
  }
}
