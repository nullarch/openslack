import { call } from './api';
import { disableNativePush, enableNativePush, isNativeApp, nativePushState } from './native';

/**
 * The service worker (offline shell and push) and this device's push
 * subscription. The worker is registered in production builds only, so the
 * dev server's hot reload is never cached.
 */

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD || isNativeApp()) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

export type PushState = 'unsupported' | 'blocked' | 'off' | 'on';

function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null;
  return (await navigator.serviceWorker.getRegistration('/')) ?? (await navigator.serviceWorker.register('/sw.js'));
}

export async function pushState(): Promise<PushState> {
  // In the native apps, the phone's own notifications (through the server's relay).
  if (isNativeApp()) return nativePushState();
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  // A subscription needs the permission, so without it there is nothing to look
  // up; asking anyway wedges the page in WebKit builds with no push service.
  if (Notification.permission !== 'granted') return 'off';
  try {
    const reg = await registration();
    const subscription = await reg?.pushManager.getSubscription();
    return subscription ? 'on' : 'off';
  } catch {
    // The API is there but no push service answers (headless browsers, some
    // private modes): WebKit throws IndexSizeError, Firefox an AbortError.
    return 'unsupported';
  }
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export async function enablePush(vapidKey: string): Promise<PushState> {
  if (isNativeApp()) return enableNativePush();
  const reg = await registration();
  if (!reg) return 'unsupported';
  if ((await Notification.requestPermission()) !== 'granted') return 'blocked';
  await navigator.serviceWorker.ready;
  const subscription = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidKey) }));
  await call('client.push.subscribe', { subscription: subscription.toJSON() });
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  if (isNativeApp()) return disableNativePush();
  const reg = await registration();
  const subscription = await reg?.pushManager.getSubscription();
  if (subscription) {
    await call('client.push.unsubscribe', { endpoint: subscription.endpoint }).catch(() => undefined);
    await subscription.unsubscribe();
  }
  return 'off';
}
