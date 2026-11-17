import { call } from './api';
import { go } from './actions';
import { parseRoute } from './router';

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

interface CapacitorBridge {
  isNativePlatform(): boolean;
  getPlatform(): 'ios' | 'android' | 'web';
  Plugins: { PushNotifications?: PushPlugin; App?: AppPlugin };
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

/** Set up the app's side: tapped notifications, links, and a fresh token when notifications are on. */
export function installNative(): void {
  const capacitor = bridge();
  if (!capacitor) return;
  document.documentElement.classList.add('native-app');
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
  // Tokens change (a reinstall, a restore): send the current one again when notifications are on.
  if (push && storedToken()) {
    void push.checkPermissions().then((status) => {
      if (status.receive === 'granted') void registerWithPhone(push);
    });
  }
}
