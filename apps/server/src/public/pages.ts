import type { ServerResponse } from 'node:http';
import { BRAND, mrkdwnToPlain, parseMrkdwn } from '@app/shared';
import type { Kernel } from '../app.ts';
import { teamPrefs } from '../accounts/prefs.ts';
import { findInvite } from '../accounts/invites.ts';
import { getConv, resolveConv, type ConvRow } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { getFile, isInlineSafe, type FileRow } from '../core/files.ts';
import { getUser, type UserRow } from '../core/users.ts';
import type { Ctx } from '../ctx.ts';
import { blocksHtml, esc, mrkdwnHtml, type RenderLookup } from './render.ts';

/**
 * Public channels an admin opened to the web: server-rendered pages anyone can
 * read without signing in, with a sitemap for search engines. People appear
 * by display name only; files appear only when the admin allowed them.
 */

const PAGE_SIZE = 50;

interface MsgRow {
  ts: string;
  user_id: string | null;
  bot_id: string | null;
  subtype: string | null;
  text: string;
  blocks: string | null;
  attachments: string | null;
  files: string | null;
  username: string | null;
  thread_ts: string | null;
  reply_count: number;
  edited_ts: string | null;
}

function slugOf(conv: ConvRow): string {
  return encodeURIComponent(conv.name ?? conv.id);
}

export function publicPath(conv: ConvRow): string {
  return `/public/${conv.id}/${slugOf(conv)}`;
}

function webChannel(ctx: Ctx, id: string): ConvRow | undefined {
  const conv = getConv(ctx, id);
  return conv && conv.kind === 'public' && conv.web_public === 1 ? conv : undefined;
}

function webChannels(ctx: Ctx): ConvRow[] {
  return ctx.db.all<ConvRow>("SELECT * FROM conversations WHERE kind = 'public' AND web_public = 1 ORDER BY name");
}

function origin(ctx: Ctx): string {
  return ctx.config.publicUrl;
}

function nameOf(user: UserRow | undefined, fallback: string | null): string {
  if (!user) return fallback ?? 'Someone';
  return user.display_name || user.real_name || user.name;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [...words[0]!][0]! + [...words.at(-1)!][0]! : [...(words[0] ?? '?')].slice(0, 2).join('');
  return letters.toUpperCase();
}

function lookupFor(ctx: Ctx): RenderLookup {
  const users = new Map<string, string | undefined>();
  return {
    user(id) {
      if (!users.has(id)) users.set(id, getUser(ctx, id) ? nameOf(getUser(ctx, id), null) : undefined);
      return users.get(id);
    },
    channel(id) {
      const conv = getConv(ctx, id);
      // Private conversations stay nameless here.
      if (!conv || conv.kind !== 'public') return undefined;
      return { name: conv.name ?? '', href: conv.web_public === 1 ? publicPath(conv) : null };
    },
    customEmoji(name) {
      const row = ctx.db.get<{ created: number }>('SELECT created FROM emoji WHERE name = ?', name);
      return row ? `/emoji/${encodeURIComponent(name)}?v=${row.created}` : undefined;
    },
  };
}

function timeHtml(ts: string): string {
  const date = new Date(Number(ts.split('.')[0]) * 1000);
  const label = `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
  return `<time datetime="${date.toISOString()}">${label}</time>`;
}

function filesHtml(ctx: Ctx, conv: ConvRow, ids: string[]): string {
  if (ids.length === 0) return '';
  if (conv.web_files !== 1) return `<p class="note">${ids.length === 1 ? 'A file was shared here.' : `${ids.length} files were shared here.`}</p>`;
  return ids
    .map((id) => getFile(ctx, id))
    .filter((file): file is FileRow => file !== undefined && file.state !== 'pending')
    .map((file) => {
      const href = `/public/${conv.id}/files/${file.id}/${encodeURIComponent(file.name)}`;
      if (/^image\/(png|jpeg|gif|webp)$/.test(file.mimetype)) {
        return `<a href="${esc(href)}"><img class="file-image" src="${esc(href)}" alt="${esc(file.title)}" loading="lazy"></a>`;
      }
      return `<p class="file"><a href="${esc(href)}">${esc(file.title || file.name)}</a> <span class="note">${Math.max(1, Math.round(file.size / 1024))} KB</span></p>`;
    })
    .join('');
}

function reactionsHtml(ctx: Ctx, conv: ConvRow, ts: string, lookup: RenderLookup): string {
  const rows = ctx.db.all<{ name: string; n: number }>(
    'SELECT name, count(*) AS n FROM reactions WHERE conversation_id = ? AND ts = ? GROUP BY name ORDER BY min(created)',
    conv.id,
    ts,
  );
  if (!rows.length) return '';
  return `<p class="reactions">${rows
    .map((row) => `<span class="reaction">${mrkdwnHtml(`:${row.name}:`, lookup)} ${row.n}</span>`)
    .join('')}</p>`;
}

function messageHtml(ctx: Ctx, conv: ConvRow, row: MsgRow, lookup: RenderLookup, threadLink: boolean): string {
  const author = row.user_id ? getUser(ctx, row.user_id) : undefined;
  const name = row.username ?? nameOf(author, null);
  const color = author?.color || '5b6ee1';
  const app = author?.is_bot === 1 || row.bot_id ? '<span class="tag">App</span>' : '';
  let body: string;
  if (row.subtype === 'tombstone') body = '<p class="note">This message was deleted.</p>';
  else {
    const blocks = row.blocks ? (JSON.parse(row.blocks) as unknown[]) : null;
    const rendered = blocks ? blocksHtml(blocks, lookup) : '';
    body = rendered || (row.text ? `<p>${mrkdwnHtml(row.text, lookup)}</p>` : '');
    const attachments = row.attachments ? (JSON.parse(row.attachments) as Record<string, unknown>[]) : [];
    for (const attachment of attachments) {
      const title = typeof attachment.title === 'string' ? `<strong>${esc(attachment.title)}</strong>` : '';
      const text = typeof attachment.text === 'string' ? `<p>${mrkdwnHtml(attachment.text, lookup)}</p>` : '';
      if (title || text) body += `<div class="attachment">${title}${text}</div>`;
    }
    body += filesHtml(ctx, conv, row.files ? (JSON.parse(row.files) as string[]) : []);
  }
  const edited = row.edited_ts ? ' <span class="note">(edited)</span>' : '';
  const replies =
    threadLink && row.thread_ts === row.ts && row.reply_count > 0
      ? `<p class="replies"><a href="${publicPath(conv)}/t/${row.ts}">${row.reply_count} ${row.reply_count === 1 ? 'reply' : 'replies'}</a></p>`
      : '';
  return `<article class="msg" id="m${row.ts.replace('.', '')}">
<span class="avatar" style="background:#${esc(color)}" aria-hidden="true">${esc(initials(name))}</span>
<div class="msg-main"><header><strong class="who">${esc(name)}</strong>${app} <a class="when" href="${publicPath(conv)}${row.thread_ts && row.thread_ts !== row.ts ? `/t/${row.thread_ts}` : ''}#m${row.ts.replace('.', '')}">${timeHtml(row.ts)}</a>${edited}</header>
<div class="body">${body}</div>${reactionsHtml(ctx, conv, row.ts, lookup)}${replies}</div></article>`;
}

const STYLE = `:root{--bg:#f7f6f2;--card:#fff;--ink:#1d1c1d;--muted:#65635c;--line:#e3e1d9;--accent:#2f6fde;--code:#f1efe9;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1c1c1a;--ink:#ecebe6;--muted:#a19f97;--line:#2e2d2a;--accent:#7aa7ff;--code:#26251f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}.wrap{max-width:780px;margin:0 auto;padding:24px 16px 64px}
.top{display:flex;align-items:center;gap:12px;justify-content:space-between;flex-wrap:wrap;margin-bottom:18px}
.team{display:flex;align-items:center;gap:10px;font-weight:700;text-decoration:none;color:var(--ink)}.team img{width:28px;height:28px;border-radius:7px}
.cta{display:inline-block;background:var(--ink);color:var(--bg);text-decoration:none;font-weight:600;padding:8px 14px;border-radius:8px}
h1{font-size:26px;margin:0 0 4px;overflow-wrap:anywhere}.purpose{color:var(--muted);margin:0 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:6px 18px}
.msg{display:flex;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}.msg:last-child{border-bottom:0}
.avatar{flex:none;width:36px;height:36px;border-radius:9px;color:#fff;font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center}
.msg-main{min-width:0;flex:1}.msg header{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px}.when{color:var(--muted);font-size:12px;text-decoration:none}
.body p{margin:2px 0}.body{overflow-wrap:anywhere}.tag{font-size:11px;background:var(--code);border-radius:4px;padding:0 5px;color:var(--muted)}
code{background:var(--code);border-radius:4px;padding:1px 4px;font:13px ui-monospace,Menlo,monospace}pre{background:var(--code);border-radius:8px;padding:10px 12px;overflow:auto}pre code{background:none;padding:0}
pre .add{color:#2c8a4b}pre .del{color:#c0392b}blockquote{margin:4px 0;padding-left:10px;border-left:3px solid var(--line);color:var(--muted)}
.mention{background:color-mix(in srgb,var(--accent) 14%,transparent);border-radius:4px;padding:0 2px;text-decoration:none}
.emoji{height:1.2em;vertical-align:-0.25em}img.file-image,img.block-image{max-width:100%;max-height:360px;border-radius:8px;border:1px solid var(--line);margin-top:6px}
.note,.context{color:var(--muted);font-size:13px}.reactions{margin:6px 0 0;display:flex;flex-wrap:wrap;gap:6px}.reaction{border:1px solid var(--line);border-radius:999px;padding:0 8px;font-size:13px}
.replies{margin:4px 0 0;font-size:13px;font-weight:600}.attachment{border-left:3px solid var(--line);padding-left:10px;margin-top:6px}.fields{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.pager{display:flex;justify-content:space-between;margin:16px 0}.foot{margin-top:28px;color:var(--muted);font-size:13px;text-align:center}
ul.channels{list-style:none;padding:0;margin:0}ul.channels li{padding:12px 0;border-bottom:1px solid var(--line)}ul.channels li:last-child{border:0}`;

interface Page {
  title: string;
  description: string;
  canonical: string;
  body: string;
  type?: string;
}

function layout(ctx: Ctx, page: Page): string {
  const team = ctx.requireTeam();
  const code = teamPrefs(ctx).public_invite_code;
  const join = code && findInvite(ctx, code) ? `<a class="cta" href="/join/${encodeURIComponent(code)}">Join ${esc(team.name)}</a>` : `<a class="cta" href="/signin">Sign in</a>`;
  const url = `${origin(ctx)}${page.canonical}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)}</title>
<meta name="description" content="${esc(page.description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="${page.type ?? 'website'}"><meta property="og:site_name" content="${esc(team.name)}">
<meta property="og:title" content="${esc(page.title)}"><meta property="og:description" content="${esc(page.description)}">
<meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(origin(ctx))}/team-icon/512">
<meta name="twitter:card" content="summary"><meta name="generator" content="${esc(BRAND.name)}">
<link rel="icon" href="/team-icon/68">
<style>${STYLE}</style></head>
<body><div class="wrap"><nav class="top"><a class="team" href="/public"><img src="/team-icon/68" alt="">${esc(team.name)}</a>${join}</nav>
${page.body}
<p class="foot">Public channel of ${esc(team.name)} · <a href="${esc(BRAND.repo)}">${esc(BRAND.name)}</a></p></div></body></html>`;
}

function send(res: ServerResponse, status: number, html: string, cache = 'public, max-age=60'): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
    // Pages carry no script of their own and run none.
    'content-security-policy': "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    'referrer-policy': 'strict-origin-when-cross-origin',
  });
  res.end(html);
}

function notFound(ctx: Ctx, res: ServerResponse): void {
  if (!ctx.team()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  send(res, 404, layout(ctx, { title: 'Not found', description: '', canonical: '/public', body: '<h1>This page is not public</h1><p class="purpose">It may be private, or it was never shared on the web.</p>' }), 'no-store');
}

function plain(text: string, lookup: RenderLookup): string {
  return mrkdwnToPlain(parseMrkdwn(text), { user: (id) => lookup.user(id), channel: (id) => lookup.channel(id)?.name }).replace(/\s+/g, ' ').trim();
}

const COLUMNS = 'ts, user_id, bot_id, subtype, text, blocks, attachments, files, username, thread_ts, reply_count, edited_ts';
// Joins, topic changes and other system lines are housekeeping, not conversation.
const VISIBLE = "(subtype IS NULL OR (subtype NOT LIKE 'channel\\_%' ESCAPE '\\' AND subtype != 'pinned_item'))";

export function installPublicPages(kernel: Kernel): void {
  const { ctx, router } = kernel;

  router.add('GET', /^\/public\/?$/, ({ res }) => {
    const channels = webChannels(ctx);
    if (!ctx.team() || channels.length === 0) return notFound(ctx, res);
    const team = ctx.requireTeam();
    const items = channels
      .map((conv) => `<li><a href="${publicPath(conv)}"><strong>#${esc(conv.name)}</strong></a>${conv.purpose ? `<br><span class="note">${esc(conv.purpose)}</span>` : ''}</li>`)
      .join('');
    send(res, 200, layout(ctx, { title: `${team.name} — public channels`, description: `Public conversations from ${team.name}.`, canonical: '/public', body: `<h1>Public channels</h1><p class="purpose">Conversations ${esc(team.name)} shares with everyone.</p><div class="card"><ul class="channels">${items}</ul></div>` }));
  });

  router.add('GET', /^\/public\/([A-Z0-9]+)(?:\/([^/]*))?\/?$/, ({ res, url, params }) => {
    const conv = webChannel(ctx, params[0]!);
    if (!conv) return notFound(ctx, res);
    if (params[1] !== slugOf(conv)) {
      res.writeHead(301, { location: `${publicPath(conv)}${url.search}` });
      res.end();
      return;
    }
    const lookup = lookupFor(ctx);
    const before = /^\d{10}\.\d{6}$/.test(url.searchParams.get('before') ?? '') ? url.searchParams.get('before')! : null;
    const after = /^\d{10}\.\d{6}$/.test(url.searchParams.get('after') ?? '') ? url.searchParams.get('after')! : null;
    const top = `conversation_id = ? AND (thread_ts IS NULL OR thread_ts = ts OR is_broadcast = 1) AND ${VISIBLE}`;
    let rows: MsgRow[];
    if (after) {
      rows = ctx.db.all<MsgRow>(`SELECT ${COLUMNS} FROM messages WHERE ${top} AND ts > ? ORDER BY ts ASC LIMIT ?`, conv.id, after, PAGE_SIZE);
    } else {
      rows = ctx.db
        .all<MsgRow>(`SELECT ${COLUMNS} FROM messages WHERE ${top} AND ts < ? ORDER BY ts DESC LIMIT ?`, conv.id, before ?? '9999999999.999999', PAGE_SIZE)
        .reverse();
    }
    const first = rows[0]?.ts;
    const last = rows.at(-1)?.ts;
    const older = first && ctx.db.get(`SELECT 1 FROM messages WHERE ${top} AND ts < ? LIMIT 1`, conv.id, first);
    const newer = last && ctx.db.get(`SELECT 1 FROM messages WHERE ${top} AND ts > ? LIMIT 1`, conv.id, last);
    const pager = `<nav class="pager">${older ? `<a href="${publicPath(conv)}?before=${first}" rel="prev">← Older messages</a>` : '<span></span>'}${newer ? `<a href="${publicPath(conv)}?after=${last}" rel="next">Newer messages →</a>` : '<span></span>'}</nav>`;
    const description = conv.purpose || (rows.length ? plain(rows[rows.length - 1]!.text, lookup).slice(0, 160) : `#${conv.name ?? ''} on ${ctx.requireTeam().name}`);
    const list = rows.length ? rows.map((row) => messageHtml(ctx, conv, row, lookup, true)).join('') : '<p class="note">No messages yet.</p>';
    const canonical = before ? `${publicPath(conv)}?before=${before}` : after ? `${publicPath(conv)}?after=${after}` : publicPath(conv);
    send(
      res,
      200,
      layout(ctx, {
        title: `#${conv.name} — ${ctx.requireTeam().name}`,
        description,
        canonical,
        body: `<h1>#${esc(conv.name)}</h1>${conv.purpose ? `<p class="purpose">${esc(conv.purpose)}</p>` : '<p class="purpose"></p>'}${pager}<div class="card">${list}</div>${pager}`,
      }),
    );
  });

  router.add('GET', /^\/public\/([A-Z0-9]+)\/([^/]*)\/t\/(\d{10}\.\d{6})\/?$/, ({ res, params }) => {
    const conv = webChannel(ctx, params[0]!);
    if (!conv) return notFound(ctx, res);
    const ts = params[2]!;
    const parent = ctx.db.get<MsgRow>(`SELECT ${COLUMNS} FROM messages WHERE conversation_id = ? AND ts = ?`, conv.id, ts);
    if (!parent) return notFound(ctx, res);
    const lookup = lookupFor(ctx);
    const replies = ctx.db.all<MsgRow>(
      `SELECT ${COLUMNS} FROM messages WHERE conversation_id = ? AND thread_ts = ? AND ts != ? ORDER BY ts LIMIT 1000`,
      conv.id,
      ts,
      ts,
    );
    const title = plain(parent.text, lookup).slice(0, 80) || `Thread in #${conv.name}`;
    send(
      res,
      200,
      layout(ctx, {
        title: `${title} — #${conv.name}`,
        description: plain(parent.text, lookup).slice(0, 160),
        canonical: `${publicPath(conv)}/t/${ts}`,
        type: 'article',
        body: `<p class="purpose"><a href="${publicPath(conv)}">← #${esc(conv.name)}</a></p><div class="card">${messageHtml(ctx, conv, parent, lookup, false)}${replies.map((row) => messageHtml(ctx, conv, row, lookup, false)).join('')}</div>`,
      }),
    );
  });

  router.add('GET', /^\/public\/([A-Z0-9]+)\/files\/([A-Z0-9]+)\/[^/]*$/, async ({ res, params }) => {
    const conv = webChannel(ctx, params[0]!);
    const file = conv && conv.web_files === 1 ? getFile(ctx, params[1]!) : undefined;
    const shared = file && ctx.db.get('SELECT 1 FROM file_shares WHERE file_id = ? AND conversation_id = ?', file.id, conv!.id);
    const size = shared ? await ctx.storage.size(file.storage_key) : null;
    if (!file || !shared || size === null) return notFound(ctx, res);
    const inline = isInlineSafe(file.mimetype);
    res.writeHead(200, {
      'content-type': inline ? file.mimetype : 'application/octet-stream',
      'content-length': size,
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    ctx.storage.read(file.storage_key).pipe(res);
  });

  router.add('GET', /^\/robots\.txt$/, ({ res }) => {
    const open = ctx.team() !== undefined && webChannels(ctx).length > 0;
    const body = open
      ? `User-agent: *\nAllow: /public/\nDisallow: /\nSitemap: ${origin(ctx)}/sitemap.xml\n`
      : 'User-agent: *\nDisallow: /\n';
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' });
    res.end(body);
  });

  router.add('GET', /^\/sitemap\.xml$/, ({ res }) => {
    if (!ctx.team()) return notFound(ctx, res);
    const urls: { loc: string; lastmod?: string }[] = [];
    const channels = webChannels(ctx);
    if (channels.length) urls.push({ loc: '/public' });
    for (const conv of channels) {
      urls.push({ loc: publicPath(conv), lastmod: conv.last_ts });
      const threads = ctx.db.all<{ ts: string; latest_reply: string | null }>(
        `SELECT ts, latest_reply FROM messages WHERE conversation_id = ? AND thread_ts = ts AND reply_count > 0 ORDER BY ts DESC LIMIT 5000`,
        conv.id,
      );
      for (const thread of threads) urls.push({ loc: `${publicPath(conv)}/t/${thread.ts}`, lastmod: thread.latest_reply ?? thread.ts });
    }
    const iso = (ts: string | undefined): string => (ts && Number(ts) > 0 ? `<lastmod>${new Date(Number(ts.split('.')[0]) * 1000).toISOString()}</lastmod>` : '');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((url) => `<url><loc>${esc(origin(ctx) + url.loc)}</loc>${iso(url.lastmod)}</url>`)
      .join('\n')}\n</urlset>\n`;
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=300' });
    res.end(xml);
  });

  // Admins choose which public channels the web may read.
  kernel.registry.add('client.admin.setChannelWeb', { auth: 'admin' }, ({ actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    if (conv.kind !== 'public') fail('method_not_supported_for_channel_type');
    const enabled = args.bool('web_public');
    const files = enabled && args.bool('web_files');
    ctx.db.run('UPDATE conversations SET web_public = ?, web_files = ? WHERE id = ?', enabled ? 1 : 0, files ? 1 : 0, conv.id);
    ctx.bus.emit({
      event: { type: 'channel_web_changed', channel: conv.id, web_public: enabled, web_files: files, url: enabled ? `${origin(ctx)}${publicPath(conv)}` : null },
      audience: { all: true },
      clientOnly: true,
    });
    return { web_public: enabled, web_files: files, url: enabled ? `${origin(ctx)}${publicPath(conv)}` : null };
  });

  kernel.registry.add('client.webChannels', { auth: 'session' }, () => ({
    channels: webChannels(ctx).map((conv) => ({ id: conv.id, web_files: conv.web_files === 1, url: `${origin(ctx)}${publicPath(conv)}` })),
  }));
}
