import type { Attachment, Block } from '@app/shared';
import { unescapeText } from '@app/shared';
import { sharedMap, type SharedMap } from '../core/transient.ts';
import type { Kernel } from '../app.ts';
import { getConv, getMember } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { newHex } from '../core/ids.ts';
import { getMessage, updateMessage } from '../core/messages.ts';
import { appConfig, getApp, listApps, type AppRow } from './apps.ts';
import { sendToApp, type Delivery } from './dispatch.ts';
import type { Json } from './elements.ts';

/**
 * App unfurls: when someone posts a link to a domain an app registered, the
 * app hears `link_shared` and may answer with `chat.unfurl`, which attaches
 * its preview to the message.
 */

const MAX_LINKS = 10;
const UNFURL_ID_TTL_MS = 60 * 60_000;
/** Posts where a link should be unfurled; edits, joins and the like are not. */
const UNFURLABLE_SUBTYPES = new Set(['thread_broadcast', 'file_share', 'me_message', 'bot_message']);

/** `<url|label>` or `<url>` (group 1), or a bare URL (group 2), in order of appearance. */
const TEXT_LINK = /<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>|(?<![<|(\w])(https?:\/\/[^\s<>|]+)/g;
const BARE = /(?<![<|(\w])https?:\/\/[^\s<>|]+/g;
const MARKDOWN_LINK = /\]\((https?:\/\/[^)\s]+)\)/g;

function tidy(url: string): string | null {
  const trimmed = unescapeText(url).replace(/[).,!?;:'"\]]+$/, '');
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Links in a message: `<url|label>` and bare URLs in text, link elements in rich text, links in Markdown blocks. */
export function linksIn(text: string, blocks: unknown): string[] {
  const found: string[] = [];
  const add = (url: string | undefined): void => {
    const clean = url ? tidy(url) : null;
    if (clean && !found.includes(clean)) found.push(clean);
  };
  for (const match of text.matchAll(TEXT_LINK)) add(match[1] ?? match[2]);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Json;
    if (record.type === 'link' && typeof record.url === 'string') add(record.url);
    if (record.type === 'markdown' && typeof record.text === 'string') {
      for (const match of record.text.matchAll(MARKDOWN_LINK)) add(match[1]);
      for (const match of record.text.replace(MARKDOWN_LINK, ' ').matchAll(BARE)) add(match[0]);
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') visit(value);
    }
  };
  visit(blocks);
  return found;
}

/** The registered domain a URL falls under (the domain itself or a subdomain of it), if any. */
export function matchingDomain(url: string, domains: string[]): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return domains.find((domain) => host === domain || host.endsWith(`.${domain}`)) ?? null;
}

interface PendingUnfurl {
  channel: string;
  ts: string;
  appId: string;
  expires: number;
}

export class Unfurls {
  private readonly delivery: Delivery;
  /** Unfurl ids handed to apps; the app's chat.unfurl may reach another process. */
  private readonly pending: SharedMap<PendingUnfurl>;

  constructor(delivery: Delivery) {
    this.delivery = delivery;
    this.pending = sharedMap<PendingUnfurl>(delivery.ctx.transient, 'unfurl_id');
  }

  install(kernel: Kernel): void {
    const { ctx } = this.delivery;
    kernel.onClose.push(
      ctx.bus.subscribe((busEvent) => {
        const event = busEvent.event;
        if (busEvent.clientOnly || event.type !== 'message') return;
        if (typeof event.subtype === 'string' && !UNFURLABLE_SUBTYPES.has(event.subtype)) return;
        if (typeof event.channel !== 'string' || typeof event.ts !== 'string') return;
        const links = linksIn(typeof event.text === 'string' ? event.text : '', event.blocks);
        if (links.length === 0) return;
        for (const app of listApps(ctx)) this.offer(app, event, links);
      }),
    );

    kernel.registry.add('chat.unfurl', { scopes: ['links:write', 'chat:write'] }, ({ actor, args }) => {
      if (!actor.isBot || !actor.appId) fail('not_allowed_token_type');
      const app = getApp(ctx, actor.appId) ?? fail('invalid_auth');

      let channelId: string;
      let ts: string;
      if (args.has('unfurl_id') || args.has('source')) {
        const source = args.str('source');
        if (!source) fail('missing_source');
        if (source !== 'conversations_history') fail('invalid_source');
        const entry = this.pending.get(args.req('unfurl_id', 'missing_unfurl_id'));
        if (!entry || entry.appId !== app.id || entry.expires <= Date.now()) fail('invalid_unfurl_id');
        channelId = entry.channel;
        ts = entry.ts;
      } else {
        channelId = args.req('channel', 'missing_channel');
        ts = args.reqTs('ts', 'missing_ts');
      }
      const conv = getConv(ctx, channelId);
      // The app must be able to see the conversation: a public channel, or one its bot belongs to.
      if (!conv || (conv.kind !== 'public' && !getMember(ctx, conv.id, app.bot_user_id))) fail('cannot_find_channel');
      const row = getMessage(ctx, conv.id, ts);
      if (!row) fail('cannot_find_message');

      const unfurls = args.json<Json>('unfurls');
      if (unfurls === undefined) fail('missing_unfurls');
      if (!unfurls || typeof unfurls !== 'object' || Array.isArray(unfurls)) fail('invalid_unfurls_format');

      const posted = linksIn(row.text, row.blocks ? JSON.parse(row.blocks) : undefined);
      const domains = appConfig(app).unfurl_domains;
      const additions: Attachment[] = [];
      for (const [rawUrl, value] of Object.entries(unfurls)) {
        const url = tidy(rawUrl);
        if (!url || !posted.includes(url)) fail('cannot_unfurl_message');
        if (!matchingDomain(url, domains)) fail('cannot_unfurl_url');
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail('cannot_parse_attachment');
        const preview = value as Json;
        const attachment: Json = {
          ...(Array.isArray(preview.blocks) ? { blocks: preview.blocks as Block[] } : preview),
          app_unfurl_url: url,
          is_app_unfurl: true,
          app_id: app.id,
          bot_id: app.bot_id,
        };
        if (typeof attachment.fallback !== 'string') attachment.fallback = typeof preview.title === 'string' ? preview.title : url;
        additions.push(attachment);
      }

      const unfurled = new Set(additions.map((entry) => String(entry.app_unfurl_url)));
      const existing: Attachment[] = row.attachments ? (JSON.parse(row.attachments) as Attachment[]) : [];
      // An app's preview replaces any earlier preview of the same link, its own or a generic one.
      const kept = existing.filter((entry) => {
        const from = [entry.app_unfurl_url, entry.from_url, entry.original_url].filter((value) => typeof value === 'string');
        return !from.some((value) => unfurled.has(tidy(String(value)) ?? ''));
      });
      updateMessage(ctx, conv, row, { attachments: [...kept, ...additions] });
      return {};
    });
  }

  /** Send `link_shared` to an app for the links in a new message that fall under its domains. */
  private offer(app: AppRow, event: Json, links: string[]): void {
    const { ctx } = this.delivery;
    // Apps do not hear about links in their own messages.
    if (event.app_id === app.id || event.bot_id === app.bot_id || event.user === app.bot_user_id) return;
    const domains = appConfig(app).unfurl_domains;
    if (domains.length === 0) return;
    const matches = links
      .map((url) => ({ url, domain: matchingDomain(url, domains) }))
      .filter((entry): entry is { url: string; domain: string } => entry.domain !== null)
      .slice(0, MAX_LINKS);
    if (matches.length === 0) return;
    const conv = getConv(ctx, String(event.channel));
    if (!conv) return;
    const member = getMember(ctx, conv.id, app.bot_user_id) !== undefined;
    // Links in private conversations reach only apps that are in them.
    if (!member && conv.kind !== 'public') return;

    const unfurlId = `${conv.id}.${String(event.ts)}.${newHex(32)}`;
    this.pending.set(unfurlId, { channel: conv.id, ts: String(event.ts), appId: app.id, expires: Date.now() + UNFURL_ID_TTL_MS });
    const shared: Json = {
      type: 'link_shared',
      channel: conv.id,
      is_bot_user_member: member,
      user: event.user,
      message_ts: event.ts,
      unfurl_id: unfurlId,
      source: 'conversations_history',
      links: matches.map(({ url, domain }) => ({ domain, url })),
      user_locale: 'en-US',
      event_ts: ctx.clock.eventTs(),
    };
    if (typeof event.thread_ts === 'string' && event.thread_ts !== event.ts) shared.thread_ts = event.thread_ts;
    sendToApp(this.delivery, app, 'link_shared', shared as { type: string });
  }


}
