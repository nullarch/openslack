import { convToApi } from '../../core/conversations.ts';
import { messageToApi } from '../../core/messages.ts';
import { parseQuery } from '../../core/search.ts';
import { findMessages } from '../../search/meilisearch.ts';
import { getUser } from '../../core/users.ts';
import type { Registry } from '../registry.ts';
import { permalink } from './chat.ts';

export function registerSearch(registry: Registry): void {
  /**
   * Search messages the caller may read. Unlike Slack, bot tokens may search
   * too: an agent sees public channels plus the conversations it belongs to.
   */
  registry.add('search.messages', { scopes: ['search:read', 'channels:history'] }, async ({ ctx, actor, args }) => {
    const text = args.req('query', 'no_query');
    const count = args.int('count', 20, { min: 1, max: 100 });
    const page = args.int('page', 1, { min: 1, max: 100 });
    const ascending = args.str('sort_dir') === 'asc';
    const query = parseQuery(ctx, actor.userId, text);
    // Slack's sort=score is relevance; it needs an engine that ranks (Meilisearch), and is newest first otherwise.
    const relevance = args.str('sort') === 'score';
    const result = await findMessages(ctx, actor.userId, query, { limit: count, offset: (page - 1) * count, ascending, relevance });

    const matches = result.hits.map(({ row, conv }) => {
      const author = row.user_id ? getUser(ctx, row.user_id) : undefined;
      const channel = convToApi(ctx, conv, actor.userId);
      return {
        ...messageToApi(ctx, row),
        iid: `${conv.id}-${row.ts}`,
        username: author?.name ?? row.username ?? '',
        channel: {
          id: conv.id,
          name: channel.name ?? channel.user ?? '',
          is_channel: channel.is_channel,
          is_group: false,
          is_im: channel.is_im,
          is_mpim: channel.is_mpim,
          is_private: channel.is_private,
          is_shared: false,
          is_org_shared: false,
          is_ext_shared: false,
          ...(channel.user ? { user: channel.user } : {}),
        },
        permalink: permalink(ctx, conv, row),
      };
    });
    const pages = Math.max(1, Math.ceil(result.total / count));
    return {
      query: text,
      messages: {
        total: result.total,
        pagination: {
          total_count: result.total,
          page,
          per_page: count,
          page_count: pages,
          first: result.total === 0 ? 0 : (page - 1) * count + 1,
          last: (page - 1) * count + matches.length,
        },
        paging: { count, total: result.total, page, pages },
        matches,
      },
    };
  });
}
