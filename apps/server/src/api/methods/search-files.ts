import { publicToViewerSql } from '../../core/conversations.ts';
import type { Param } from '../../db/db.ts';
import type { Actor, Ctx } from '../../ctx.ts';
import { fileToApi, type FileRow } from '../../core/files.ts';
import { parseQuery } from '../../core/search.ts';
import type { Args, Registry } from '../registry.ts';

/**
 * `search.files` and `search.all`. Files are found by name, title and the text inside them, within
 * the conversations the caller can see, with the same modifiers as messages
 * (`in:`, `from:`, `before:`, `after:`, `on:`).
 */

function fileSearch(ctx: Ctx, actor: Actor, args: Args): Record<string, unknown> {
  const text = args.req('query', 'no_query');
  const count = args.int('count', 20, { min: 1, max: 100 });
  const page = args.int('page', 1, { min: 1, max: 100 });
  const query = parseQuery(ctx, actor.userId, text);
  // Guests search only the conversations they belong to.
  const publicToViewer = publicToViewerSql(ctx, actor.userId);

  const where: string[] = [
    "f.state = 'shared'",
    `EXISTS (SELECT 1 FROM file_shares s JOIN conversations c ON c.id = s.conversation_id
       WHERE s.file_id = f.id
         AND (${publicToViewer.sql} OR EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = c.id AND m.user_id = ?))
         ${query.inConversation ? 'AND c.id = ?' : ''})`,
  ];
  const params: Param[] = [...publicToViewer.params, actor.userId];
  if (query.inConversation) params.push(query.inConversation);
  for (const term of query.terms) {
    // The name, the title, or the text inside the file (trigram index; shorter terms scan it).
    where.push("(f.name LIKE ? ESCAPE '\\' OR f.title LIKE ? ESCAPE '\\' OR f.id IN (SELECT file_id FROM file_text WHERE body LIKE ? ESCAPE '\\'))");
    const like = `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    params.push(like, like, like);
  }
  if (query.fromUser) {
    where.push('f.user_id = ?');
    params.push(query.fromUser);
  }
  if (query.before !== undefined) {
    where.push('f.created < ?');
    params.push(query.before);
  }
  if (query.after !== undefined) {
    where.push('f.created >= ?');
    params.push(query.after);
  }
  const empty = query.impossible || (query.terms.length === 0 && where.length === 2 && !query.inConversation);
  const sql = `FROM files f WHERE ${where.join(' AND ')}`;
  const total = empty ? 0 : (ctx.db.get<{ n: number }>(`SELECT count(*) AS n ${sql}`, ...params)?.n ?? 0);
  const rows = empty
    ? []
    : ctx.db.all<FileRow>(
        `SELECT f.* ${sql} ORDER BY f.created ${args.str('sort_dir') === 'asc' ? 'ASC' : 'DESC'}, f.id LIMIT ? OFFSET ?`,
        ...params,
        count,
        (page - 1) * count,
      );
  const matches = rows.map((row) => fileToApi(ctx, row));
  const pages = Math.max(1, Math.ceil(total / count));
  return {
    total,
    pagination: {
      total_count: total,
      page,
      per_page: count,
      page_count: pages,
      first: total === 0 ? 0 : (page - 1) * count + 1,
      last: (page - 1) * count + matches.length,
    },
    paging: { count, total, page, pages },
    matches,
  };
}

export function registerSearchFiles(registry: Registry): void {
  registry.add('search.files', { scopes: ['search:read', 'files:read'] }, ({ ctx, actor, args }) => ({
    query: args.req('query', 'no_query'),
    files: fileSearch(ctx, actor, args),
  }));

  registry.add('search.all', { scopes: ['search:read'] }, async (call) => {
    const messages = registry.get('search.messages');
    const found = messages ? ((await messages.handler(call)) ?? {}) : {};
    return {
      query: call.args.req('query', 'no_query'),
      messages: (found as Record<string, unknown>).messages ?? { total: 0, matches: [] },
      files: fileSearch(call.ctx, call.actor, call.args),
      posts: { total: 0, matches: [] },
    };
  });
}
