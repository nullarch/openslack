import type { Registry } from '../api/registry.ts';
import { getMember, resolveConv, type ConvRow } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import type { Actor, Ctx } from '../ctx.ts';

/** Slack's `bookmarks.*`: links pinned to the top of a conversation. Only `link` bookmarks. */

interface BookmarkRow {
  id: string;
  conversation_id: string;
  title: string;
  link: string;
  emoji: string;
  rank: string;
  created_by: string;
  updated_by: string;
  created: number;
  updated: number;
}

const MAX_PER_CONVERSATION = 100;

function toApi(ctx: Ctx, row: BookmarkRow): Record<string, unknown> {
  return {
    id: row.id,
    channel_id: row.conversation_id,
    title: row.title,
    link: row.link,
    emoji: row.emoji || null,
    icon_url: null,
    type: 'link',
    entity_id: null,
    date_created: row.created,
    date_updated: row.updated,
    rank: row.rank,
    last_updated_by_user_id: row.updated_by,
    last_updated_by_team_id: ctx.requireTeam().id,
    shortcut_id: null,
    app_id: null,
  };
}

function validLink(value: string): string {
  const link = value.trim();
  try {
    const url = new URL(link);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') fail('invalid_link');
  } catch {
    fail('invalid_link');
  }
  if (link.length > 2000) fail('invalid_link');
  return link;
}

function validTitle(value: string | undefined): string {
  const title = (value ?? '').trim();
  if (!title) fail('invalid_title');
  return title.slice(0, 250);
}

/** Bookmarks belong to a conversation; its members change them. */
function target(ctx: Ctx, actor: Actor, channelId: string | undefined): ConvRow {
  const conv = resolveConv(ctx, actor, channelId);
  if (!getMember(ctx, conv.id, actor.userId)) fail('not_in_channel');
  if (conv.is_archived === 1) fail('is_archived');
  return conv;
}

function get(ctx: Ctx, conv: ConvRow, id: string | undefined): BookmarkRow {
  const row = id ? ctx.db.get<BookmarkRow>('SELECT * FROM bookmarks WHERE id = ? AND conversation_id = ?', id, conv.id) : undefined;
  if (!row) fail('not_found');
  return row;
}

function emit(ctx: Ctx, type: string, conv: ConvRow, bookmark: Record<string, unknown>): void {
  ctx.bus.emit({ event: { type, channel_id: conv.id, bookmark, event_ts: ctx.clock.eventTs() }, audience: { conversation: conv.id } });
}

export function registerBookmarks(registry: Registry): void {
  registry.add('bookmarks.list', { scopes: ['bookmarks:read'] }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel_id', 'channel_not_found'));
    const rows = ctx.db.all<BookmarkRow>('SELECT * FROM bookmarks WHERE conversation_id = ? ORDER BY rank, created', conv.id);
    return { bookmarks: rows.map((row) => toApi(ctx, row)) };
  });

  registry.add('bookmarks.add', { scopes: ['bookmarks:write'] }, ({ ctx, actor, args }) => {
    const conv = target(ctx, actor, args.req('channel_id', 'channel_not_found'));
    if (args.req('type', 'invalid_bookmark_type') !== 'link') fail('invalid_bookmark_type');
    const title = validTitle(args.str('title'));
    const link = validLink(args.req('link', 'invalid_link'));
    const count = ctx.db.get<{ n: number; last: string | null }>('SELECT count(*) AS n, max(rank) AS last FROM bookmarks WHERE conversation_id = ?', conv.id)!;
    if (count.n >= MAX_PER_CONVERSATION) fail('too_many_bookmarks');
    const rank = String(Number(count.last ?? '0') + 1).padStart(6, '0');
    const now = nowSeconds();
    const id = `Bk${newId('', 10)}`;
    ctx.db.run(
      `INSERT INTO bookmarks (id, conversation_id, title, link, emoji, rank, created_by, updated_by, created, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      conv.id,
      title,
      link,
      (args.str('emoji') ?? '').trim().slice(0, 100),
      rank,
      actor.userId,
      actor.userId,
      now,
      now,
    );
    const bookmark = toApi(ctx, get(ctx, conv, id));
    emit(ctx, 'bookmark_added', conv, bookmark);
    return { bookmark };
  });

  registry.add('bookmarks.edit', { scopes: ['bookmarks:write'] }, ({ ctx, actor, args }) => {
    const conv = target(ctx, actor, args.req('channel_id', 'channel_not_found'));
    const row = get(ctx, conv, args.str('bookmark_id'));
    const title = args.has('title') ? validTitle(args.str('title')) : row.title;
    const link = args.has('link') ? validLink(args.req('link')) : row.link;
    const emoji = args.has('emoji') ? (args.str('emoji') ?? '').trim().slice(0, 100) : row.emoji;
    ctx.db.run(
      'UPDATE bookmarks SET title = ?, link = ?, emoji = ?, updated_by = ?, updated = ? WHERE id = ?',
      title,
      link,
      emoji,
      actor.userId,
      nowSeconds(),
      row.id,
    );
    const bookmark = toApi(ctx, get(ctx, conv, row.id));
    emit(ctx, 'bookmark_changed', conv, bookmark);
    return { bookmark };
  });

  registry.add('bookmarks.remove', { scopes: ['bookmarks:write'] }, ({ ctx, actor, args }) => {
    const conv = target(ctx, actor, args.req('channel_id', 'channel_not_found'));
    const row = get(ctx, conv, args.str('bookmark_id'));
    ctx.db.run('DELETE FROM bookmarks WHERE id = ?', row.id);
    emit(ctx, 'bookmark_removed', conv, toApi(ctx, row));
  });
}
