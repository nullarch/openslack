import type { Kernel } from '../app.ts';
import type { Ctx } from '../ctx.ts';
import { fail } from '../core/errors.ts';
import { nowSeconds } from '../core/ids.ts';
import { signedHeaders } from '../federation/keys.ts';
import { allowPrivateTargets, post } from '../platform/net.ts';
import type { PushMessage } from './webpush.ts';

/**
 * Push for the native apps. A phone's push token works only with the
 * credentials of whoever published the app, which a self-hosted server does
 * not have; the server hands each notification to the relay
 * (`PUSH_RELAY_URL`, apps/push-relay), signed with its own key, and the relay
 * passes it to Apple or Google. The relay keeps nothing. Without a relay the
 * apps still work, and get messages while they are open.
 */

const PLATFORMS = new Set(['ios', 'android']);
const PATH = '/v1/push';

interface DeviceRow {
  token: string;
  user_id: string;
  platform: 'ios' | 'android';
}

interface RelayResult {
  token: string;
  ok: boolean;
  error?: string;
}

export function nativePushAvailable(ctx: Ctx): boolean {
  return Boolean(ctx.config.pushRelayUrl);
}

export function hasDevices(ctx: Ctx): boolean {
  return ctx.db.get('SELECT 1 FROM push_devices LIMIT 1') !== undefined;
}

/** Send one notification to every phone a person registered. Tokens the relay reports gone are removed. */
export async function pushToDevices(ctx: Ctx, userId: string, message: PushMessage): Promise<number> {
  const relay = ctx.config.pushRelayUrl;
  if (!relay) return 0;
  const devices = ctx.db.all<DeviceRow>('SELECT token, user_id, platform FROM push_devices WHERE user_id = ?', userId);
  if (devices.length === 0) return 0;
  const body = JSON.stringify({
    notifications: devices.map((device) => ({
      platform: device.platform,
      token: device.token,
      title: message.title,
      body: message.body,
      // Grouped on the phone per conversation; the tap opens the message.
      collapse_id: message.tag.slice(0, 64),
      data: { url: message.url, server: ctx.config.publicUrl },
    })),
  });
  try {
    const response = await post(`${relay}${PATH}`, {
      headers: { 'content-type': 'application/json', ...signedHeaders(ctx, 'POST', PATH, body) },
      body,
      timeoutMs: 10_000,
      allowPrivate: allowPrivateTargets(ctx),
    });
    if (response.status < 200 || response.status >= 300) return 0;
    const results = (JSON.parse(response.body) as { results?: RelayResult[] }).results ?? [];
    let delivered = 0;
    for (const result of results) {
      if (result.ok) delivered += 1;
      else if (result.error === 'unregistered') ctx.db.run('DELETE FROM push_devices WHERE token = ?', result.token);
    }
    return delivered;
  } catch {
    // The relay may be back later; keep the devices.
    return 0;
  }
}

export function installNativePush(kernel: Kernel): void {
  const { ctx, registry } = kernel;

  registry.add('client.push.registerDevice', { auth: 'session' }, ({ actor, args }) => {
    const platform = args.req('platform');
    // Not `token`: that argument name carries API credentials.
    const token = args.req('device_token');
    if (!PLATFORMS.has(platform) || !/^[A-Za-z0-9_:.\-]{16,4096}$/.test(token)) fail('invalid_arguments');
    // A phone belongs to whoever signed in on it last.
    ctx.db.run(
      'INSERT INTO push_devices (token, user_id, platform, created, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform, updated = excluded.updated',
      token,
      actor.userId,
      platform,
      nowSeconds(),
      nowSeconds(),
    );
    return { relay: nativePushAvailable(ctx) };
  });

  registry.add('client.push.unregisterDevice', { auth: 'session' }, ({ actor, args }) => {
    ctx.db.run('DELETE FROM push_devices WHERE token = ? AND user_id = ?', args.req('device_token'), actor.userId);
  });
}
