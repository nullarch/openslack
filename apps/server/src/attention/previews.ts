import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { BRAND, type Attachment } from '@app/shared';
import { sendJson, type Router } from '../api/http.ts';
import type { Registry } from '../api/registry.ts';
import { authenticate } from '../core/auth.ts';
import { getConv, resolveConv } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { parseImageSize } from '../core/files.ts';
import { sha256 } from '../core/ids.ts';
import { getMessage, requireMessage, updateMessage } from '../core/messages.ts';
import { isAdmin } from '../core/users.ts';
import type { Ctx } from '../ctx.ts';
import { allowPrivateTargets, isPrivateAddress } from '../platform/net.ts';
import { isNewMessage, parseJson, type EventBody } from './common.ts';

/**
 * Link previews: when someone posts a link, the server fetches the page's
 * title, description and image and adds them to the message as a Slack-style
 * unfurl attachment. Fetching is guarded the same way app requests are: no
 * private or loopback addresses unless the server itself runs locally, every
 * redirect re-checked, and limits on time and size. Images are stored here and
 * served from this server, so readers' browsers never contact the linked site.
 * `LINK_PREVIEWS=0` turns it off. Apps that unfurl their own links
 * (`chat.unfurl`) are a separate path.
 */

const MAX_LINKS = 3;
const PAGE_BYTES = 512 * 1024;
const IMAGE_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const FRESH_SECONDS = 24 * 3600;
const RETRY_SECONDS = 3600;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Places that decide a URL is not ours to preview (an app unfurls that domain). */
export const previewSkips: ((url: URL, ctx: Ctx) => boolean)[] = [];

interface Fetched {
  status: number;
  type: string;
  body: Buffer;
  url: URL;
  truncated: boolean;
}

class Refused extends Error {}

function fetchOnce(target: URL, allowPrivate: boolean, maxBytes: number, accept: string): Promise<{ res: IncomingMessage; body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) !== 0 && !allowPrivate && isPrivateAddress(host)) {
      reject(new Refused('blocked address'));
      return;
    }
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      target,
      {
        method: 'GET',
        headers: { 'user-agent': `Mozilla/5.0 (compatible; ${BRAND.slug}-preview/1.0)`, accept, 'accept-language': 'en' },
        lookup(hostname, options, callback) {
          dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
            if (error) {
              callback(error, '', 0);
              return;
            }
            const list = addresses as LookupAddress[];
            if (!allowPrivate && list.some((entry) => isPrivateAddress(entry.address))) {
              callback(new Refused('blocked address'), '', 0);
              return;
            }
            if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
            else callback(null, list[0]!.address, list[0]!.family);
          });
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            // Enough for the head of a page; for an image, too large.
            clearTimeout(timer);
            req.destroy();
            resolve({ res, body: Buffer.concat(chunks), truncated: true });
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ res, body: Buffer.concat(chunks), truncated: false });
        });
        res.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Refused('timeout')), TIMEOUT_MS);
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
}

async function fetchGuarded(ctx: Ctx, url: string, maxBytes: number, accept: string): Promise<Fetched> {
  const allowPrivate = allowPrivateTargets(ctx);
  let target = new URL(url);
  for (let hop = 0; ; hop += 1) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Refused('protocol');
    const { res, body, truncated } = await fetchOnce(target, allowPrivate, maxBytes, accept);
    const location = res.headers.location;
    if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && location) {
      if (hop >= MAX_REDIRECTS) throw new Refused('too many redirects');
      target = new URL(location, target);
      continue;
    }
    const type = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    return { status: res.statusCode ?? 0, type, body, url: target, truncated };
  }
}

// ── Reading a page ──────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text: string): string {
  return text
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
      if (code[0] === '#') {
        const value = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : whole;
      }
      return ENTITIES[code.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

export interface PageInfo {
  title?: string;
  description?: string;
  site?: string;
  image?: string;
}

export function readPage(html: string): PageInfo {
  const head = html.slice(0, PAGE_BYTES);
  const meta: Record<string, string> = {};
  for (const tag of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs: Record<string, string> = {};
    for (const attr of tag[0].matchAll(/([a-zA-Z_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[attr[1]!.toLowerCase()] = attr[3] ?? attr[4] ?? attr[5] ?? '';
    }
    const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
    if (key && attrs.content !== undefined && meta[key] === undefined) meta[key] = decode(attrs.content);
  }
  const title = meta['og:title'] ?? meta['twitter:title'] ?? (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ? decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)![1]!) : undefined);
  return {
    title: title || undefined,
    description: meta['og:description'] ?? meta['twitter:description'] ?? meta.description,
    site: meta['og:site_name'],
    image: meta['og:image'] ?? meta['og:image:url'] ?? meta['twitter:image'] ?? meta['twitter:image:src'],
  };
}

function sniffImage(head: Buffer): string | null {
  if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (head.length >= 6 && head.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Fetch and store an image; returns its served URL and size, or null. */
async function storeImage(ctx: Ctx, url: string): Promise<{ url: string; width?: number; height?: number; bytes: number } | null> {
  try {
    const fetched = await fetchGuarded(ctx, url, IMAGE_BYTES, 'image/png,image/jpeg,image/gif,image/webp');
    if (fetched.status !== 200 || fetched.body.length === 0 || fetched.truncated) return null;
    const type = sniffImage(fetched.body);
    if (!type || !IMAGE_TYPES.has(type)) return null;
    const key = `lp${sha256(url).slice(0, 40)}`;
    await ctx.storage.putBuffer(key, fetched.body);
    const size = parseImageSize(fetched.body.subarray(0, 256 * 1024));
    return { url: `${ctx.config.publicUrl}/previews/${key}`, bytes: fetched.body.length, ...(size ? { width: size.width, height: size.height } : {}) };
  } catch {
    return null;
  }
}

async function buildPreview(ctx: Ctx, url: string): Promise<Attachment | null> {
  const fetched = await fetchGuarded(ctx, url, PAGE_BYTES, 'text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.1');
  if (fetched.status < 200 || fetched.status >= 300) return null;
  const host = fetched.url.hostname.replace(/^www\./, '');
  if (fetched.type.startsWith('image/')) {
    const image = await storeImage(ctx, fetched.url.toString());
    if (!image) return null;
    return { fallback: url, original_url: url, from_url: url, image_url: image.url, image_width: image.width, image_height: image.height, image_bytes: image.bytes, service_name: host };
  }
  if (fetched.type !== 'text/html' && fetched.type !== 'application/xhtml+xml') return null;
  const info = readPage(fetched.body.toString('utf8'));
  if (!info.title && !info.description) return null;
  const attachment: Attachment = {
    fallback: [info.site ?? host, info.title].filter(Boolean).join(': '),
    original_url: url,
    from_url: url,
    title: info.title?.slice(0, 200),
    title_link: url,
    text: info.description?.slice(0, 400),
    service_name: info.site?.slice(0, 80) ?? host,
  };
  if (info.image) {
    let imageUrl: string | null = null;
    try {
      imageUrl = new URL(info.image, fetched.url).toString();
    } catch {
      imageUrl = null;
    }
    const image = imageUrl ? await storeImage(ctx, imageUrl) : null;
    if (image) {
      attachment.image_url = image.url;
      if (image.width) attachment.image_width = image.width;
      if (image.height) attachment.image_height = image.height;
      attachment.image_bytes = image.bytes;
    }
  }
  return attachment;
}

async function previewFor(ctx: Ctx, url: string): Promise<Attachment | null> {
  const now = Math.floor(Date.now() / 1000);
  const cached = ctx.db.get<{ status: string; data: string | null; fetched: number }>('SELECT status, data, fetched FROM link_previews WHERE url = ?', url);
  if (cached) {
    const age = now - cached.fetched;
    if (cached.status === 'ok' && age < FRESH_SECONDS) return parseJson<Attachment>(cached.data) ?? null;
    if (cached.status !== 'ok' && age < (cached.status === 'none' ? FRESH_SECONDS : RETRY_SECONDS)) return null;
  }
  let attachment: Attachment | null = null;
  let status = 'none';
  try {
    attachment = await buildPreview(ctx, url);
    status = attachment ? 'ok' : 'none';
  } catch {
    status = 'error';
  }
  ctx.db.run(
    'INSERT OR REPLACE INTO link_previews (url, status, data, fetched) VALUES (?, ?, ?, ?)',
    url,
    status,
    attachment ? JSON.stringify(attachment) : null,
    now,
  );
  return attachment;
}

// ── Messages ────────────────────────────────────────────────────────────────

/** Links written as `<https://…>` / `<https://…|label>` or bare, at most three, in order. */
export function linksIn(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>|(?<![<|\w/])(https?:\/\/[^\s<>]+)/g)) {
    let url = match[1] ?? match[2]!.replace(/[.,;:!?)\]'"]+$/, '');
    url = url.replace(/&amp;/g, '&');
    if (!out.includes(url)) out.push(url);
    if (out.length === MAX_LINKS) break;
  }
  return out;
}

function claimedByApp(ctx: Ctx, url: URL): boolean {
  if (previewSkips.some((skip) => skip(url, ctx))) return true;
  // Apps may declare the domains they unfurl in their configuration.
  for (const row of ctx.db.all<{ config: string }>('SELECT config FROM apps')) {
    const config = parseJson<{ unfurl_domains?: unknown; domains?: unknown }>(row.config);
    const domains = [config?.unfurl_domains, config?.domains].flatMap((value) => (Array.isArray(value) ? value.map(String) : []));
    if (domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return true;
  }
  return false;
}

async function unfurl(ctx: Ctx, channel: string, ts: string, urls: string[]): Promise<void> {
  const own = (() => {
    try {
      return new URL(ctx.config.publicUrl).host;
    } catch {
      return '';
    }
  })();
  const previews: Attachment[] = [];
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.host === own || claimedByApp(ctx, parsed)) continue;
    const preview = await previewFor(ctx, url);
    if (preview) previews.push(preview);
  }
  if (previews.length === 0) return;
  const conv = getConv(ctx, channel);
  const row = conv ? getMessage(ctx, channel, ts) : undefined;
  if (!conv || !row || row.subtype === 'tombstone') return;
  const existing = parseJson<Attachment[]>(row.attachments) ?? [];
  const covered = new Set(existing.map((item) => String(item.original_url ?? item.from_url ?? '')));
  const fresh = previews.filter((item) => !covered.has(String(item.original_url)));
  if (fresh.length === 0) return;
  fresh.forEach((item, index) => (item.id = existing.length + index + 1));
  updateMessage(ctx, conv, row, { attachments: [...existing, ...fresh] });
}

export function linkPreviewsEnabled(ctx: Ctx): boolean {
  return ctx.config.linkPreviews === true;
}

export function installPreviews(ctx: Ctx, registry: Registry, router: Router): () => void {
  registry.add('client.messages.removePreview', { auth: 'session' }, ({ ctx: c, actor, args }) => {
    const conv = resolveConv(c, actor, args.req('channel', 'channel_not_found'));
    const row = requireMessage(c, conv.id, args.reqTs('ts'));
    if (row.user_id !== actor.userId && !isAdmin(actor)) fail('cant_update_message');
    const url = args.req('url');
    const existing = parseJson<Attachment[]>(row.attachments) ?? [];
    const kept = existing.filter((item) => item.original_url !== url);
    if (kept.length === existing.length) fail('not_found');
    updateMessage(c, conv, row, { attachments: kept });
  });

  router.add('GET', /^\/previews\/(lp[0-9a-f]{40})$/, async ({ req, res, params }) => {
    const { actor } = authenticate(ctx, req, undefined);
    const key = params[0]!;
    const size = actor ? await ctx.storage.size(key) : null;
    if (!actor || size === null) {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    const head: Buffer[] = [];
    for await (const chunk of ctx.storage.read(key, { start: 0, end: 15 })) head.push(chunk as Buffer);
    const type = sniffImage(Buffer.concat(head)) ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': size,
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
    ctx.storage.read(key).pipe(res);
  });

  return ctx.bus.subscribe(({ event }) => {
    if (!linkPreviewsEnabled(ctx) || !isNewMessage(event as EventBody)) return;
    if (event.bot_id || (Array.isArray(event.attachments) && event.attachments.length > 0)) return;
    const urls = linksIn(String(event.text ?? ''));
    if (urls.length === 0 || typeof event.channel !== 'string' || typeof event.ts !== 'string') return;
    void unfurl(ctx, event.channel, event.ts, urls).catch((error: unknown) => console.error('[previews] failed', error));
  });
}
