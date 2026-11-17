import { createECDH, createHmac, createPrivateKey, createCipheriv, randomBytes, sign, type KeyObject } from 'node:crypto';
import { BRAND, mrkdwnToPlain, parseMrkdwn } from '@app/shared';
import type { Kernel } from '../app.ts';
import { getConv, getMember, type ConvRow } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { nowSeconds } from '../core/ids.ts';
import { getUser } from '../core/users.ts';
import type { Ctx } from '../ctx.ts';
import { allowPrivateTargets, isPrivateAddress, post } from '../platform/net.ts';

/**
 * Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption
 * (RFC 8291), straight to the browser's push service: no relay in between.
 * Mentions and direct messages are pushed to people with no open tab.
 */

const KEY_NAME = 'vapid_private_jwk';

interface Vapid {
  publicKey: string;
  privateKey: KeyObject;
}

let cached: { dataDir: string; vapid: Vapid } | null = null;

/** The server's VAPID key pair, generated and stored on first use. */
export function vapid(ctx: Ctx): Vapid {
  if (cached?.dataDir === ctx.config.dataDir) return cached.vapid;
  let row = ctx.db.get<{ value: string }>('SELECT value FROM server_values WHERE name = ?', KEY_NAME);
  if (!row) {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const publicRaw = ecdh.getPublicKey();
    const jwk = {
      kty: 'EC',
      crv: 'P-256',
      d: ecdh.getPrivateKey().toString('base64url'),
      x: publicRaw.subarray(1, 33).toString('base64url'),
      y: publicRaw.subarray(33, 65).toString('base64url'),
    };
    ctx.db.run('INSERT OR IGNORE INTO server_values (name, value) VALUES (?, ?)', KEY_NAME, JSON.stringify(jwk));
    row = ctx.db.get<{ value: string }>('SELECT value FROM server_values WHERE name = ?', KEY_NAME)!;
  }
  const jwk = JSON.parse(row.value) as { x: string; y: string };
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
  const result = { publicKey, privateKey: createPrivateKey({ key: JSON.parse(row.value), format: 'jwk' }) };
  cached = { dataDir: ctx.config.dataDir, vapid: result };
  return result;
}

function vapidHeader(ctx: Ctx, endpoint: string): string {
  const keys = vapid(ctx);
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const subject = ctx.config.mailFrom?.match(/<?([^<>\s]+@[^<>\s]+)>?/)?.[1];
  const claims = {
    aud: new URL(endpoint).origin,
    exp: nowSeconds() + 12 * 3600,
    sub: subject ? `mailto:${subject}` : ctx.config.publicUrl.startsWith('https://') ? ctx.config.publicUrl : 'mailto:admin@localhost',
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${header}.${body}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `vapid t=${header}.${body}.${signature}, k=${keys.publicKey}`;
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** Encrypt a payload for one subscription (RFC 8291, a single aes128gcm record). */
export function encryptPayload(payload: Buffer, p256dh: string, auth: string): Buffer {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  const local = createECDH('prime256v1');
  local.generateKeys();
  const asPublic = local.getPublicKey();
  const shared = local.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const salt = randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, sealed]);
}

interface SubscriptionRow {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
}

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/** Send to every device a person subscribed. Gone subscriptions are removed. */
export async function pushTo(ctx: Ctx, userId: string, message: PushMessage): Promise<number> {
  const subscriptions = ctx.db.all<SubscriptionRow>('SELECT * FROM push_subscriptions WHERE user_id = ?', userId);
  let delivered = 0;
  for (const subscription of subscriptions) {
    try {
      const response = await post(subscription.endpoint, {
        headers: {
          authorization: vapidHeader(ctx, subscription.endpoint),
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(24 * 3600),
          urgency: 'high',
        },
        body: encryptPayload(Buffer.from(JSON.stringify(message)), subscription.p256dh, subscription.auth),
        timeoutMs: 10_000,
        allowPrivate: allowPrivateTargets(ctx),
      });
      if (response.status === 404 || response.status === 410) {
        ctx.db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', subscription.endpoint);
      } else if (response.status >= 200 && response.status < 300) {
        delivered += 1;
      }
    } catch {
      // A push service that cannot be reached now may be reachable later; keep the subscription.
    }
  }
  return delivered;
}

const PUSHABLE_SUBTYPES = new Set([undefined, 'thread_broadcast', 'file_share', 'bot_message', 'me_message']);

function previewText(ctx: Ctx, text: string): string {
  return mrkdwnToPlain(parseMrkdwn(text), {
    user: (id) => {
      const user = getUser(ctx, id);
      return user ? user.display_name || user.real_name || user.name : undefined;
    },
    channel: (id) => getConv(ctx, id)?.name ?? undefined,
  })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Who should get a push for a new message: DM members, and people it mentions, who have no tab open and have not muted it. */
function recipients(ctx: Ctx, conv: ConvRow, ts: string, author: string | undefined): string[] {
  let ids: string[];
  if (conv.kind === 'im' || conv.kind === 'mpim') {
    ids = ctx.db.all<{ user_id: string }>('SELECT user_id FROM members WHERE conversation_id = ?', conv.id).map((row) => row.user_id);
  } else {
    const mentioned = ctx.db.all<{ user_id: string }>('SELECT user_id FROM mentions WHERE conversation_id = ? AND ts = ?', conv.id, ts).map((row) => row.user_id);
    ids = mentioned.includes('*')
      ? ctx.db.all<{ user_id: string }>('SELECT user_id FROM members WHERE conversation_id = ?', conv.id).map((row) => row.user_id)
      : mentioned;
  }
  return [...new Set(ids)].filter((id) => {
    if (id === author || ctx.presence.isOnline(id)) return false;
    const member = getMember(ctx, conv.id, id);
    if (!member || member.is_muted === 1) return false;
    const user = getUser(ctx, id);
    return user !== undefined && user.deleted === 0 && user.is_bot === 0;
  });
}

export function installPush(kernel: Kernel): void {
  const { ctx, registry, router } = kernel;

  // The installable app carries the workspace's name.
  router.add('GET', /^\/manifest\.webmanifest$/, ({ res }) => {
    const name = ctx.team()?.name ?? BRAND.name;
    const manifest = {
      name,
      short_name: name.length > 12 ? name.slice(0, 12) : name,
      description: BRAND.tagline,
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#0f2a33',
      theme_color: '#0f2a33',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    };
    const body = JSON.stringify(manifest);
    res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'public, max-age=3600', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });

  registry.add('client.push.status', { auth: 'session' }, ({ actor }) => ({
    vapid_public_key: vapid(ctx).publicKey,
    subscriptions: ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM push_subscriptions WHERE user_id = ?', actor.userId)?.n ?? 0,
  }));

  registry.add('client.push.subscribe', { auth: 'session' }, ({ actor, args }) => {
    const subscription = args.json<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>('subscription');
    const endpoint = subscription?.endpoint ?? '';
    const p256dh = subscription?.keys?.p256dh ?? '';
    const auth = subscription?.keys?.auth ?? '';
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      fail('invalid_subscription');
    }
    const local = allowPrivateTargets(ctx);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) fail('invalid_subscription');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!local && (host === 'localhost' || isPrivateAddress(host))) fail('invalid_subscription');
    if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) fail('invalid_subscription');
    ctx.db.run(
      `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      endpoint,
      actor.userId,
      p256dh,
      auth,
      nowSeconds(),
    );
  });

  registry.add('client.push.unsubscribe', { auth: 'session' }, ({ actor, args }) => {
    ctx.db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', args.req('endpoint'), actor.userId);
  });

  const unsubscribe = ctx.bus.subscribe((busEvent) => {
    const event = busEvent.event;
    if (event.type !== 'message' || busEvent.clientOnly || event.hidden || event.is_ephemeral) return;
    if (!PUSHABLE_SUBTYPES.has(event.subtype as string | undefined)) return;
    const conv = typeof event.channel === 'string' ? getConv(ctx, event.channel) : undefined;
    if (!conv || typeof event.ts !== 'string') return;
    // Only people with a subscription cost anything to look at.
    if (!ctx.db.get('SELECT 1 FROM push_subscriptions LIMIT 1')) return;
    const author = typeof event.user === 'string' ? event.user : undefined;
    const targets = recipients(ctx, conv, event.ts, author);
    if (targets.length === 0) return;
    const sender = author ? getUser(ctx, author) : undefined;
    const name = (typeof event.username === 'string' && event.username) || (sender ? sender.display_name || sender.real_name || sender.name : 'Someone');
    const text = typeof event.text === 'string' ? previewText(ctx, event.text) : '';
    const message: PushMessage = {
      title: conv.kind === 'im' || conv.kind === 'mpim' ? name : `${name} in #${conv.name ?? ''}`,
      body: text || (Array.isArray(event.files) && event.files.length ? 'Sent a file' : 'Sent a message'),
      url: `/c/${conv.id}?ts=${event.ts}`,
      tag: `${conv.id}:${event.ts}`,
    };
    for (const userId of targets) void pushTo(ctx, userId, message);
  });
  kernel.onClose.push(unsubscribe);
}
