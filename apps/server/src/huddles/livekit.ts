import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The few pieces of LiveKit's protocol this server needs: access tokens for
 * clients, verification of webhooks, and two calls to its room API. Written
 * against LiveKit's published token and Twirp formats, with no SDK; the tests
 * check the results against the official `livekit-server-sdk`.
 */

export interface LiveKitConfig {
  /** Address browsers connect to, e.g. `wss://media.example.com`. */
  url: string;
  /** Address this server uses for the room API; defaults to `url` with http(s). */
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
}

export function liveKitFromEnv(env: NodeJS.ProcessEnv): LiveKitConfig | null {
  const url = env.LIVEKIT_URL?.trim();
  if (!url) return null;
  const apiKey = env.LIVEKIT_API_KEY?.trim() ?? '';
  const apiSecret = env.LIVEKIT_API_SECRET?.trim() ?? '';
  if (!apiKey || !apiSecret) throw new Error('LIVEKIT_URL is set but LIVEKIT_API_KEY / LIVEKIT_API_SECRET are missing');
  const apiUrl = (env.LIVEKIT_API_URL?.trim() || url).replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '');
  return { url: url.replace(/\/+$/, ''), apiUrl, apiKey, apiSecret };
}

const base64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

/** What a token lets its holder do in one room (LiveKit's `VideoGrant`). */
export interface VideoGrant {
  room: string;
  roomJoin?: boolean;
  roomAdmin?: boolean;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
}

export interface TokenOptions {
  identity: string;
  name?: string;
  ttlSeconds: number;
  video: VideoGrant;
  metadata?: string;
}

/** A LiveKit access token: a JWT signed with HS256 using the API secret. */
export function accessToken(config: LiveKitConfig, options: TokenOptions, now = Date.now()): string {
  const issued = Math.floor(now / 1000);
  const claims: Record<string, unknown> = {
    iss: config.apiKey,
    sub: options.identity,
    nbf: issued,
    exp: issued + options.ttlSeconds,
    video: options.video,
  };
  if (options.name) claims.name = options.name;
  if (options.metadata) claims.metadata = options.metadata;
  const head = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(claims));
  const signature = createHmac('sha256', config.apiSecret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

/** Decode and check a token signed with our secret; null when it is not valid now. */
export function verifyToken(config: LiveKitConfig, token: string, now = Date.now()): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, signature] = parts as [string, string, string];
  const expected = createHmac('sha256', config.apiSecret).update(`${head}.${body}`).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let header: { alg?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as { alg?: string };
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (header.alg !== 'HS256') return null;
  const seconds = Math.floor(now / 1000);
  // A little leeway for clock differences between this server and LiveKit.
  if (typeof claims.exp === 'number' && claims.exp + 60 < seconds) return null;
  if (typeof claims.nbf === 'number' && claims.nbf - 60 > seconds) return null;
  if (claims.iss !== config.apiKey) return null;
  return claims;
}

/**
 * A webhook from LiveKit carries, in its Authorization header, a token signed
 * with the API secret whose `sha256` claim is the base64 SHA-256 of the body.
 */
export function verifyWebhook(config: LiveKitConfig, body: Buffer, authorization: string | undefined, now = Date.now()): boolean {
  if (!authorization) return false;
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  const claims = verifyToken(config, token, now);
  if (!claims || typeof claims.sha256 !== 'string') return false;
  const digest = createHash('sha256').update(body).digest();
  const claimed = Buffer.from(claims.sha256, 'base64');
  return claimed.length === digest.length && timingSafeEqual(claimed, digest);
}

/** Call LiveKit's room API (Twirp over HTTP with JSON bodies). */
async function roomService<T>(config: LiveKitConfig, method: string, room: string, body: Record<string, unknown>): Promise<T> {
  const token = accessToken(config, { identity: 'server', ttlSeconds: 60, video: { room, roomAdmin: true } });
  const response = await fetch(`${config.apiUrl}/twirp/livekit.RoomService/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`LiveKit ${method} failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Identities connected to a room right now. A room that does not exist has nobody in it. */
export async function listParticipants(config: LiveKitConfig, room: string): Promise<string[]> {
  try {
    const result = await roomService<{ participants?: { identity: string }[] }>(config, 'ListParticipants', room, { room });
    return (result.participants ?? []).map((participant) => participant.identity);
  } catch (error) {
    if (error instanceof Error && /HTTP 404/.test(error.message)) return [];
    throw error;
  }
}

/** Close a room, disconnecting anyone still in it. */
export async function deleteRoom(config: LiveKitConfig, room: string): Promise<void> {
  try {
    await roomService(config, 'DeleteRoom', room, { room });
  } catch (error) {
    if (error instanceof Error && /HTTP 404/.test(error.message)) return;
    throw error;
  }
}
