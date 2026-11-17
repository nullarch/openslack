import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import type { Ctx } from '../ctx.ts';

/**
 * Where a request comes from, and whether that address may use the
 * workspace. Behind reverse proxies, TRUST_PROXY says how many of them add an
 * X-Forwarded-For entry; the client is the entry that many hops from the end.
 * The workspace's IP allowlist (CIDR ranges) keeps browsers, and optionally
 * API tokens, from being used anywhere else. IP_ALLOWLIST_DISABLED=1 lifts it
 * (for an admin who locked themselves out).
 */

export interface AllowlistPolicy {
  cidrs: string[];
  /** Also refuse API tokens (apps, SCIM, audit collectors) from other addresses. */
  applies_to_tokens: boolean;
}

function normalize(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped ? mapped[1]! : ip;
}

export function clientIp(ctx: Ctx, req: IncomingMessage): string {
  const direct = normalize(req.socket.remoteAddress ?? '');
  const hops = ctx.config.trustProxy ?? 0;
  if (hops <= 0) return direct;
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const chain = [...forwarded, direct];
  return normalize(chain[Math.max(0, chain.length - 1 - hops)] ?? direct);
}

/** Parse "10.0.0.0/8", "2001:db8::/32" or a single address; null when invalid. */
export function parseCidr(value: string): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } | null {
  const [address = '', bits] = value.trim().split('/');
  const version = isIP(normalize(address));
  if (!version) return null;
  const family = version === 4 ? 'ipv4' : 'ipv6';
  const max = version === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { address: normalize(address), prefix, family };
}

export function allowlistPolicy(ctx: Ctx): AllowlistPolicy {
  try {
    const raw = (JSON.parse(ctx.team()?.prefs ?? '{}') as { ip_allowlist?: Partial<AllowlistPolicy> }).ip_allowlist ?? {};
    return { cidrs: Array.isArray(raw.cidrs) ? raw.cidrs.filter((cidr) => parseCidr(String(cidr))) : [], applies_to_tokens: raw.applies_to_tokens === true };
  } catch {
    return { cidrs: [], applies_to_tokens: false };
  }
}

export function inRanges(cidrs: string[], ip: string): boolean {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const parsed = parseCidr(cidr);
    if (parsed) list.addSubnet(parsed.address, parsed.prefix, parsed.family);
  }
  const address = normalize(ip);
  const version = isIP(address);
  if (!version) return false;
  return list.check(address, version === 4 ? 'ipv4' : 'ipv6');
}

/** Whether this request's address may use the workspace with this kind of credential. */
export function addressAllowed(ctx: Ctx, req: IncomingMessage, kind: 'session' | 'token' | 'signin'): boolean {
  if (ctx.config.ipAllowlistDisabled) return true;
  const policy = allowlistPolicy(ctx);
  if (policy.cidrs.length === 0) return true;
  if (kind === 'token' && !policy.applies_to_tokens) return true;
  return inRanges(policy.cidrs, clientIp(ctx, req));
}
