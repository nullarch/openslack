import { normalizeChannelName } from '@app/shared';
import type { Param } from '../db/db.ts';
import type { Ctx } from '../ctx.ts';
import type { ConvRow } from './conversations.ts';
import { isGuest } from './guests.ts';
import type { MsgRow } from './messages.ts';

export interface SearchQuery {
  /** Free-text terms; all must match. */
  terms: string[];
  inConversation?: string;
  fromUser?: string;
  before?: number;
  after?: number;
  hasLink?: boolean;
  hasReaction?: boolean;
  hasPin?: boolean;
  hasFile?: boolean;
  inThread?: boolean;
  /** Set when a modifier named something that does not exist; such a query matches nothing. */
  impossible?: boolean;
}

function dayStart(value: string): number | null {
  if (value === 'today') return new Date(new Date().toISOString().slice(0, 10)).getTime() / 1000;
  if (value === 'yesterday') return new Date(new Date().toISOString().slice(0, 10)).getTime() / 1000 - 86_400;
  const match = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3] ?? 1));
  return Number.isNaN(time) ? null : time / 1000;
}

/**
 * Parse a search string with Slack's modifiers: `in:`, `from:`, `before:`,
 * `after:`, `on:`, `has:`, `is:thread`, quoted phrases, and bare terms.
 */
export function parseQuery(ctx: Ctx, viewerId: string, input: string): SearchQuery {
  const query: SearchQuery = { terms: [] };
  const tokens = input.match(/"[^"]*"|\S+/g) ?? [];
  for (const token of tokens) {
    const modifier = /^(in|from|before|after|on|during|has|is):(.+)$/i.exec(token);
    if (!modifier) {
      const term = token.replace(/^"|"$/g, '').trim();
      if (term) query.terms.push(term);
      continue;
    }
    const key = modifier[1]!.toLowerCase();
    const value = modifier[2]!.replace(/^"|"$/g, '');
    if (key === 'in') {
      if (value.startsWith('@') || /^<@/.test(value)) {
        const user = findUser(ctx, value);
        const conv = user
          ? ctx.db.get<{ id: string }>(
              'SELECT id FROM conversations WHERE im_key = ?',
              [...new Set([viewerId, user])].sort().join(','),
            )
          : undefined;
        if (conv) query.inConversation = conv.id;
        else query.impossible = true;
      } else {
        const id = /^<#([A-Z0-9]+)/.exec(value)?.[1];
        const conv = id
          ? ctx.db.get<{ id: string }>('SELECT id FROM conversations WHERE id = ?', id)
          : ctx.db.get<{ id: string }>(
              "SELECT id FROM conversations WHERE name = ? AND kind IN ('public', 'private')",
              normalizeChannelName(value),
            );
        if (conv) query.inConversation = conv.id;
        else query.impossible = true;
      }
    } else if (key === 'from') {
      const user = value === 'me' ? viewerId : findUser(ctx, value);
      if (user) query.fromUser = user;
      else query.impossible = true;
    } else if (key === 'before') {
      const day = dayStart(value);
      if (day !== null) query.before = day;
    } else if (key === 'after') {
      const day = dayStart(value);
      if (day !== null) query.after = day + 86_400;
    } else if (key === 'on' || key === 'during') {
      const day = dayStart(value);
      if (day !== null) {
        query.after = day;
        query.before = day + 86_400;
      }
    } else if (key === 'has') {
      if (value === 'link') query.hasLink = true;
      else if (value === 'reaction') query.hasReaction = true;
      else if (value === 'pin') query.hasPin = true;
      else if (value === 'file') query.hasFile = true;
      else if (value.startsWith(':')) query.hasReaction = true;
    } else if (key === 'is' && value === 'thread') {
      query.inThread = true;
    }
  }
  return query;
}

function findUser(ctx: Ctx, value: string): string | null {
  const id = /^<@([A-Z0-9]+)/.exec(value)?.[1];
  if (id) return id;
  const handle = value.replace(/^@/, '').toLowerCase();
  const row = ctx.db.get<{ id: string }>(
    'SELECT id FROM users WHERE lower(name) = ? OR lower(display_name) = ? OR lower(real_name) = ? LIMIT 1',
    handle,
    handle,
    handle,
  );
  return row?.id ?? null;
}

export interface SearchHit {
  row: MsgRow;
  conv: ConvRow;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
}

export interface SearchOptions {
  limit: number;
  offset: number;
  /** Oldest first instead of newest first. */
  ascending?: boolean;
}

/**
 * Search messages the viewer may read: public channels plus conversations they
 * belong to. Terms of three or more characters use the trigram index; shorter
 * ones (common in Korean, Japanese and Chinese) fall back to a substring scan.
 */
export function searchMessages(ctx: Ctx, viewerId: string, query: SearchQuery, options: SearchOptions): SearchResult {
  if (query.impossible) return { hits: [], total: 0 };
  // Guests search only the conversations they belong to.
  const publicToViewer = isGuest(ctx, viewerId) ? '0' : "c.kind = 'public'";
  const where: string[] = [
    `(${publicToViewer} OR EXISTS (SELECT 1 FROM members mm WHERE mm.conversation_id = c.id AND mm.user_id = ?))`,
    "(m.subtype IS NULL OR m.subtype NOT IN ('channel_join', 'channel_leave', 'tombstone'))",
  ];
  const params: Param[] = [viewerId];

  const indexed = query.terms.filter((term) => [...term].length >= 3);
  const short = query.terms.filter((term) => [...term].length < 3);
  if (indexed.length > 0) {
    where.push('m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)');
    params.push(indexed.map((term) => `"${term.replace(/"/g, '""')}"`).join(' AND '));
  }
  for (const term of short) {
    where.push("m.plain LIKE ? ESCAPE '\\'");
    params.push(`%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
  }
  if (query.inConversation) {
    where.push('m.conversation_id = ?');
    params.push(query.inConversation);
  }
  if (query.fromUser) {
    where.push('m.user_id = ?');
    params.push(query.fromUser);
  }
  if (query.before !== undefined) {
    where.push('m.ts < ?');
    params.push(`${String(query.before).padStart(10, '0')}.000000`);
  }
  if (query.after !== undefined) {
    where.push('m.ts >= ?');
    params.push(`${String(query.after).padStart(10, '0')}.000000`);
  }
  if (query.hasLink) where.push("(m.plain LIKE '%http://%' OR m.plain LIKE '%https://%')");
  if (query.hasFile) where.push('m.files IS NOT NULL');
  if (query.hasReaction) {
    where.push('EXISTS (SELECT 1 FROM reactions r WHERE r.conversation_id = m.conversation_id AND r.ts = m.ts)');
  }
  if (query.hasPin) {
    where.push('EXISTS (SELECT 1 FROM pins p WHERE p.conversation_id = m.conversation_id AND p.ts = m.ts)');
  }
  if (query.inThread) where.push('m.thread_ts IS NOT NULL');

  const hasFilter = query.terms.length > 0 || where.length > 2;
  if (!hasFilter) return { hits: [], total: 0 };

  const from = `FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE ${where.join(' AND ')}`;
  const total = ctx.db.get<{ n: number }>(`SELECT count(*) AS n ${from}`, ...params)?.n ?? 0;
  const rows = ctx.db.all<MsgRow>(
    `SELECT m.* ${from} ORDER BY m.ts ${options.ascending ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`,
    ...params,
    options.limit,
    options.offset,
  );
  const convs = new Map<string, ConvRow>();
  const hits: SearchHit[] = [];
  for (const row of rows) {
    let conv = convs.get(row.conversation_id);
    if (!conv) {
      conv = ctx.db.get<ConvRow>('SELECT * FROM conversations WHERE id = ?', row.conversation_id);
      if (!conv) continue;
      convs.set(row.conversation_id, conv);
    }
    hits.push({ row, conv });
  }
  return { hits, total };
}
