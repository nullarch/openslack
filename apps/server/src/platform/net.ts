import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { BRAND } from '@app/shared';
import type { Ctx } from '../ctx.ts';

/** Why a delivery failed, in the vocabulary of the `X-Slack-Retry-Reason` header. */
export type FailureReason =
  | 'http_timeout'
  | 'too_many_redirects'
  | 'connection_failed'
  | 'ssl_error'
  | 'http_error'
  | 'unknown_error'
  | 'blocked_address';

export class OutboundError extends Error {
  readonly reason: FailureReason;

  constructor(reason: FailureReason, detail = '') {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
  }
}

export interface OutboundResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface PostOptions {
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  /** Permit loopback, private and link-local targets. */
  allowPrivate: boolean;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 2;

function isPrivateV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** Loopback, private-range, link-local, unique-local and unspecified addresses. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateV4(address);
  if (family !== 6) return true;
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateV4(mapped[1]!);
  return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

/**
 * Whether apps may be reached at private addresses. Explicitly set with
 * `ALLOW_PRIVATE_APP_URLS=1` or `=0`. Unset, it follows the server's own
 * address: a server that runs on localhost (local development) may call apps on
 * localhost; a server with a public address may not reach into its network.
 */
export function allowPrivateTargets(ctx: Ctx): boolean {
  const flag = process.env.ALLOW_PRIVATE_APP_URLS;
  if (flag === '1') return true;
  if (flag === '0') return false;
  try {
    const host = new URL(ctx.config.publicUrl).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || (isIP(host) !== 0 && isPrivateAddress(host));
  } catch {
    return false;
  }
}

function postOnce(target: URL, options: PostOptions): Promise<OutboundResponse> {
  return new Promise((resolve, reject) => {
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) !== 0 && !options.allowPrivate && isPrivateAddress(host)) {
      reject(new OutboundError('blocked_address', host));
      return;
    }
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      target,
      {
        method: 'POST',
        headers: {
          'user-agent': `${BRAND.slug}-delivery/1.0`,
          accept: 'application/json,*/*',
          ...options.headers,
          'content-length': Buffer.byteLength(options.body),
        },
        // The address is checked at connection time, so a hostname cannot be
        // re-pointed at a private address between the check and the request.
        lookup(hostname, lookupOptions, callback) {
          dnsLookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
            if (error) {
              callback(error, '', 0);
              return;
            }
            const list = addresses as LookupAddress[];
            if (!options.allowPrivate && list.some((entry) => isPrivateAddress(entry.address))) {
              callback(new OutboundError('blocked_address', hostname), '', 0);
              return;
            }
            if ((lookupOptions as { all?: boolean }).all) {
              (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, list);
            } else {
              callback(null, list[0]!.address, list[0]!.family);
            }
          });
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', (error) => {
          clearTimeout(timer);
          reject(new OutboundError('connection_failed', error.message));
        });
      },
    );
    // One deadline for the whole exchange: connecting, sending and reading the answer.
    const timer = setTimeout(() => {
      req.destroy(new OutboundError('http_timeout'));
    }, options.timeoutMs);
    req.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error instanceof OutboundError) reject(error);
      else if (/CERT|SSL|TLS/i.test(`${error.code ?? ''} ${error.message}`)) reject(new OutboundError('ssl_error', error.message));
      else reject(new OutboundError('connection_failed', error.message));
    });
    req.end(options.body);
  });
}

/**
 * POST to an app's URL. Follows at most two redirects, re-checking the address
 * each time. Rejects with an `OutboundError` whose `reason` says what went wrong;
 * a response with any status resolves.
 */
export async function post(url: string, options: PostOptions): Promise<OutboundResponse> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new OutboundError('connection_failed', 'invalid URL');
  }
  for (let hop = 0; ; hop += 1) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new OutboundError('connection_failed', 'unsupported protocol');
    }
    const response = await postOnce(target, options);
    const location = response.headers.location;
    if (![301, 302, 307, 308].includes(response.status) || !location) return response;
    if (hop >= MAX_REDIRECTS) throw new OutboundError('too_many_redirects');
    target = new URL(location, target);
  }
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
