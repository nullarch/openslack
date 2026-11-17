import { publicToViewerSql } from '../core/conversations.ts';
import type { Kernel } from '../app.ts';
import type { ConvRow } from '../core/conversations.ts';
import { isGuest } from '../core/guests.ts';
import type { MsgRow } from '../core/messages.ts';
import { searchMessages, type SearchHit, type SearchOptions, type SearchQuery, type SearchResult } from '../core/search.ts';
import type { Ctx } from '../ctx.ts';

/**
 * Message search through Meilisearch, for workspaces that want relevance
 * ranking and typo tolerance (or a very large history) instead of the
 * built-in SQLite index. Optional: set MEILISEARCH_URL (and MEILISEARCH_KEY).
 *
 * The database stays the source of truth. Triggers on `messages` queue every
 * change in `search_outbox`, so nothing is missed while this server or
 * Meilisearch is down (an import run from the command line included); a
 * worker sends the queue in batches. Each search is restricted to the
 * conversations the person may read, the hits are re-read from the database
 * and checked again, and when Meilisearch cannot answer the built-in index
 * does.
 */

export interface MeiliConfig {
  url: string;
  key: string | null;
  index: string;
}

export function meiliFromEnv(env: NodeJS.ProcessEnv): MeiliConfig | null {
  if (!env.MEILISEARCH_URL) return null;
  return { url: env.MEILISEARCH_URL.replace(/\/+$/, ''), key: env.MEILISEARCH_KEY || null, index: env.MEILISEARCH_INDEX || 'messages' };
}

const SKIPPED = new Set(['channel_join', 'channel_leave', 'tombstone']);
const BATCH = 1000;

interface Document {
  id: string;
  conversation_id: string;
  ts: number;
  user_id: string | null;
  text: string;
  thread: boolean;
  has_link: boolean;
  has_file: boolean;
}

export function toDocument(row: MsgRow): Document | null {
  if (row.subtype && SKIPPED.has(row.subtype)) return null;
  const text = row.plain ?? '';
  return {
    id: String(row.id),
    conversation_id: row.conversation_id,
    ts: Number(row.ts),
    user_id: row.user_id,
    text,
    thread: row.thread_ts !== null,
    has_link: /https?:\/\//.test(text),
    has_file: row.files !== null,
  };
}

/** Modifiers Meilisearch has no data for: such searches go to the built-in index. */
export function needsDatabase(query: SearchQuery): boolean {
  return Boolean(query.hasPin || query.hasReaction);
}

/** The Meilisearch request for a search by someone who may read `allowed`. */
export function searchRequest(query: SearchQuery, allowed: string[], options: SearchOptions & { relevance?: boolean }): Record<string, unknown> {
  const filter: string[] = [`conversation_id IN [${allowed.map((id) => JSON.stringify(id)).join(', ')}]`];
  if (query.inConversation) filter.push(`conversation_id = ${JSON.stringify(query.inConversation)}`);
  if (query.fromUser) filter.push(`user_id = ${JSON.stringify(query.fromUser)}`);
  if (query.before !== undefined) filter.push(`ts < ${query.before}`);
  if (query.after !== undefined) filter.push(`ts >= ${query.after}`);
  if (query.hasLink) filter.push('has_link = true');
  if (query.hasFile) filter.push('has_file = true');
  if (query.inThread) filter.push('thread = true');
  return {
    q: query.terms.join(' '),
    filter,
    // Like Slack: every term must be there (with typo tolerance).
    matchingStrategy: 'all',
    limit: options.limit,
    offset: options.offset,
    attributesToRetrieve: ['id'],
    ...(options.relevance ? {} : { sort: [`ts:${options.ascending ? 'asc' : 'desc'}`] }),
  };
}

/** Conversations someone may search: public ones (not for guests) and those they belong to. */
function readable(ctx: Ctx, viewerId: string): string[] {
  const rows = isGuest(ctx, viewerId)
    ? ctx.db.all<{ id: string }>('SELECT conversation_id AS id FROM members WHERE user_id = ?', viewerId)
    : ctx.db.all<{ id: string }>(
        `SELECT c.id FROM conversations c WHERE ${publicToViewerSql(ctx, viewerId).sql} UNION SELECT conversation_id FROM members WHERE user_id = ?`,
        viewerId,
        viewerId,
      );
  return rows.map((row) => row.id);
}

class Meili {
  readonly config: MeiliConfig;

  constructor(config: MeiliConfig) {
    this.config = config;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.config.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(this.config.key ? { authorization: `Bearer ${this.config.key}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    const json = text ? (JSON.parse(text) as T & { code?: string; message?: string }) : ({} as T);
    if (!response.ok) throw Object.assign(new Error(`Meilisearch ${response.status}: ${(json as { message?: string }).message ?? text.slice(0, 200)}`), { code: (json as { code?: string }).code });
    return json;
  }

  get indexPath(): string {
    return `/indexes/${encodeURIComponent(this.config.index)}`;
  }
}

/** Search through Meilisearch; null when it cannot answer (the caller uses the built-in index). */
export type ExternalSearch = (viewerId: string, query: SearchQuery, options: SearchOptions & { relevance?: boolean }) => Promise<SearchResult | null>;

export function installMeilisearch(kernel: Kernel): void {
  const { ctx } = kernel;
  const config = ctx.config.meilisearch ?? null;
  if (!config) {
    // Not in use: no queue grows, and a later connection starts from a full copy.
    ctx.db.run('DROP TRIGGER IF EXISTS search_outbox_insert');
    ctx.db.run('DROP TRIGGER IF EXISTS search_outbox_update');
    ctx.db.run('DROP TRIGGER IF EXISTS search_outbox_delete');
    ctx.db.run('DELETE FROM search_outbox');
    ctx.db.run("DELETE FROM settings WHERE key = 'meilisearch_index'");
    return;
  }
  const meili = new Meili(config);
  ctx.db.run("CREATE TRIGGER IF NOT EXISTS search_outbox_insert AFTER INSERT ON messages BEGIN INSERT INTO search_outbox (message_id, op) VALUES (new.id, 'upsert'); END");
  ctx.db.run("CREATE TRIGGER IF NOT EXISTS search_outbox_update AFTER UPDATE OF plain, files, thread_ts, subtype ON messages BEGIN INSERT INTO search_outbox (message_id, op) VALUES (new.id, 'upsert'); END");
  ctx.db.run("CREATE TRIGGER IF NOT EXISTS search_outbox_delete AFTER DELETE ON messages BEGIN INSERT INTO search_outbox (message_id, op) VALUES (old.id, 'delete'); END");
  // A new index (or a new address for it) gets every message once.
  const known = ctx.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'meilisearch_index'")?.value;
  const identity = `${config.url}#${config.index}`;
  if (known !== identity) {
    ctx.db.tx(() => {
      ctx.db.run('DELETE FROM search_outbox');
      ctx.db.run("INSERT INTO search_outbox (message_id, op) SELECT id, 'upsert' FROM messages ORDER BY id");
      ctx.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('meilisearch_index', ?)", identity);
    });
  }

  let ready = false;
  let failingSince = 0;
  const logFailure = (error: unknown): void => {
    if (Date.now() - failingSince > 60_000) {
      failingSince = Date.now();
      if (!ctx.config.quiet) console.warn(`[search] Meilisearch: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const prepare = async (): Promise<void> => {
    if (ready) return;
    try {
      await meili.request('POST', '/indexes', { uid: config.index, primaryKey: 'id' });
    } catch (error) {
      if ((error as { code?: string }).code !== 'index_already_exists') throw error;
    }
    await meili.request('PATCH', `${meili.indexPath}/settings`, {
      searchableAttributes: ['text'],
      filterableAttributes: ['conversation_id', 'user_id', 'ts', 'thread', 'has_link', 'has_file'],
      sortableAttributes: ['ts'],
    });
    ready = true;
  };

  // Send the queue: newest state of each message, deletions as deletions. The leader sends it.
  let draining = false;
  const drain = async (): Promise<void> => {
    if (draining || !ctx.instances.isLeader()) return;
    draining = true;
    try {
      await prepare();
      for (;;) {
        const batch = ctx.db.all<{ seq: number; message_id: number; op: string }>('SELECT seq, message_id, op FROM search_outbox ORDER BY seq LIMIT ?', BATCH);
        if (batch.length === 0) break;
        const ids = [...new Set(batch.map((item) => item.message_id))];
        const rows = new Map(
          ctx.db.all<MsgRow>(`SELECT * FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).map((row) => [row.id, row]),
        );
        const upserts: Document[] = [];
        const deletes: string[] = [];
        for (const id of ids) {
          const row = rows.get(id);
          const document = row ? toDocument(row) : null;
          if (document) upserts.push(document);
          else deletes.push(String(id));
        }
        if (upserts.length) await meili.request('POST', `${meili.indexPath}/documents`, upserts);
        if (deletes.length) await meili.request('POST', `${meili.indexPath}/documents/delete-batch`, deletes);
        ctx.db.run('DELETE FROM search_outbox WHERE seq <= ?', batch.at(-1)!.seq);
      }
      failingSince = 0;
    } catch (error) {
      logFailure(error);
    } finally {
      draining = false;
    }
  };
  const timer = setInterval(() => void drain(), 1000);
  timer.unref();
  void drain();
  kernel.onClose.push(() => clearInterval(timer));

  const search: ExternalSearch = async (viewerId, query, options) => {
    if (needsDatabase(query)) return null;
    // Until everything is copied, the built-in index has the full picture.
    if (!ready || ctx.db.get("SELECT 1 FROM search_outbox WHERE op = 'upsert' LIMIT 1 OFFSET 500")) return null;
    const allowed = readable(ctx, viewerId);
    if (allowed.length === 0) return { hits: [], total: 0 };
    try {
      const result = await meili.request<{ hits: { id: string }[]; estimatedTotalHits?: number; totalHits?: number }>('POST', `${meili.indexPath}/search`, searchRequest(query, allowed, options));
      const ids = result.hits.map((hit) => Number(hit.id)).filter(Number.isFinite);
      const rows = ids.length ? ctx.db.all<MsgRow>(`SELECT * FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
      const byId = new Map(rows.map((row) => [row.id, row]));
      const permitted = new Set(allowed);
      const convs = new Map<string, ConvRow | undefined>();
      const hits: SearchHit[] = [];
      for (const id of ids) {
        const row = byId.get(id);
        // Checked again here: the index may be a moment behind a membership change.
        if (!row || !permitted.has(row.conversation_id)) continue;
        if (!convs.has(row.conversation_id)) convs.set(row.conversation_id, ctx.db.get<ConvRow>('SELECT * FROM conversations WHERE id = ?', row.conversation_id));
        const conv = convs.get(row.conversation_id);
        if (conv) hits.push({ row, conv });
      }
      return { hits, total: result.totalHits ?? result.estimatedTotalHits ?? hits.length };
    } catch (error) {
      logFailure(error);
      return null;
    }
  };
  ctx.externalSearch = search;
}

/** Search messages: Meilisearch when connected and able, otherwise the built-in index. */
export async function findMessages(ctx: Ctx, viewerId: string, query: SearchQuery, options: SearchOptions & { relevance?: boolean }): Promise<SearchResult> {
  if (query.impossible) return { hits: [], total: 0 };
  const external = ctx.externalSearch ? await ctx.externalSearch(viewerId, query, options) : null;
  return external ?? searchMessages(ctx, viewerId, query, options);
}
