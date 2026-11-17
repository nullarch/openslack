import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import type { Ctx } from '../ctx.ts';

/**
 * This server's identity towards other servers: an Ed25519 key pair made on
 * first use and kept in `server_values`. Every request one server sends
 * another is signed with it; the receiver checks the signature against the
 * key it pinned when the two connected.
 */

const KEY_NAME = 'federation_key';
/** A signed request older (or newer) than this is refused. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface ServerKey {
  privateKey: KeyObject;
  /** The raw public key, base64url: what peers pin. */
  publicKey: string;
}

const keys = new WeakMap<Ctx, ServerKey>();

export function serverKey(ctx: Ctx): ServerKey {
  const known = keys.get(ctx);
  if (known) return known;
  let row = ctx.db.get<{ value: string }>('SELECT value FROM server_values WHERE name = ?', KEY_NAME);
  if (!row) {
    const { privateKey } = generateKeyPairSync('ed25519');
    // Two processes starting together may both make one; the first stored wins.
    ctx.db.run('INSERT OR IGNORE INTO server_values (name, value) VALUES (?, ?)', KEY_NAME, JSON.stringify(privateKey.export({ format: 'jwk' })));
    row = ctx.db.get<{ value: string }>('SELECT value FROM server_values WHERE name = ?', KEY_NAME)!;
  }
  const jwk = JSON.parse(row.value) as { x: string };
  const key: ServerKey = { privateKey: createPrivateKey({ key: jwk as never, format: 'jwk' }), publicKey: jwk.x };
  keys.set(ctx, key);
  return key;
}

function publicKeyObject(raw: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
}

/** Whether `raw` is a well-formed Ed25519 public key. */
export function validPublicKey(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return false;
  try {
    publicKeyObject(raw);
    return true;
  } catch {
    return false;
  }
}

/** What is signed: the method, the path, the time and a digest of the body. */
function signingString(method: string, path: string, date: string, body: string | Buffer): string {
  return `${method.toUpperCase()}\n${path}\n${date}\n${createHash('sha256').update(body).digest('hex')}`;
}

/** Headers that sign a request (or a response) from this server. */
export function signedHeaders(ctx: Ctx, method: string, path: string, body: string | Buffer): Record<string, string> {
  const date = String(Date.now());
  const signature = sign(null, Buffer.from(signingString(method, path, date, body)), serverKey(ctx).privateKey).toString('base64url');
  return {
    'x-federation-server': ctx.config.publicUrl,
    'x-federation-date': date,
    'x-federation-signature': signature,
  };
}

/** Check a signature made with `publicKey`, and that it is recent. */
export function verifySigned(
  publicKey: string,
  method: string,
  path: string,
  body: string | Buffer,
  headers: { date: unknown; signature: unknown },
): boolean {
  const date = typeof headers.date === 'string' ? headers.date : '';
  const signature = typeof headers.signature === 'string' ? headers.signature : '';
  if (!/^\d{10,16}$/.test(date) || Math.abs(Date.now() - Number(date)) > MAX_CLOCK_SKEW_MS) return false;
  try {
    return verify(null, Buffer.from(signingString(method, path, date, body)), publicKeyObject(publicKey), Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}
