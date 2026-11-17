import { getConv, memberIds } from '../core/conversations.ts';
import { getUser } from '../core/users.ts';
import type { Ctx } from '../ctx.ts';
import { addActivity, markActivityRead, removeActivity } from './activity.ts';
import { isNewMessage, isPerson, isReply, mentionsIn, plainOf, type EventBody } from './common.ts';
import { onReply } from './threads.ts';

/**
 * Turns what happens in conversations into per-person attention: activity rows,
 * thread following and keyword matches. It listens to the same events every
 * other part of the server sees.
 */

// ── Keywords ────────────────────────────────────────────────────────────────

const keywordCache = new Map<string, RegExp | null>();

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The pattern for someone's keywords (`highlight_words`, comma-separated, as Slack names the preference). */
export function keywordPattern(ctx: Ctx, userId: string): RegExp | null {
  if (keywordCache.has(userId)) return keywordCache.get(userId)!;
  const user = getUser(ctx, userId);
  let pattern: RegExp | null = null;
  if (user) {
    let words: string[] = [];
    try {
      const prefs = JSON.parse(user.prefs) as { highlight_words?: unknown };
      if (typeof prefs.highlight_words === 'string') words = prefs.highlight_words.split(',');
    } catch {
      // Unreadable preferences: no keywords.
    }
    const parts = words
      .map((word) => word.trim())
      .filter((word) => word.length > 0 && word.length <= 100)
      .slice(0, 50)
      .map((word) =>
        // Words in scripts without spaces (Korean particles attach to the word) match anywhere; others as whole words.
        /^[\p{Script=Latin}\p{N}_' -]+$/u.test(word) ? `(?<![\\p{L}\\p{N}_])${escape(word)}(?![\\p{L}\\p{N}_])` : escape(word),
      );
    if (parts.length > 0) pattern = new RegExp(parts.join('|'), 'iu');
  }
  keywordCache.set(userId, pattern);
  return pattern;
}

export function matchKeyword(ctx: Ctx, userId: string, text: string): string | null {
  const pattern = keywordPattern(ctx, userId);
  if (!pattern) return null;
  return pattern.exec(text)?.[0] ?? null;
}

// ── Listener ────────────────────────────────────────────────────────────────

function onMessage(ctx: Ctx, event: EventBody): void {
  const channel = String(event.channel);
  const ts = String(event.ts);
  const conv = getConv(ctx, channel);
  if (!conv) return;
  const author = typeof event.user === 'string' ? event.user : null;
  const reply = isReply(event);
  const threadTs = reply ? String(event.thread_ts) : null;
  const direct = conv.kind === 'im' || conv.kind === 'mpim';
  const mentions = mentionsIn(event);
  const members = new Set(memberIds(ctx, channel));
  const actor = author ?? '';

  // Who gets what, at most one item each for this message.
  const told = new Set<string>();
  if (!direct) {
    for (const userId of mentions.users) {
      if (userId === author || !members.has(userId) || !isPerson(ctx, userId)) continue;
      addActivity(ctx, userId, { kind: 'mention', channel, ts, threadTs, actor });
      told.add(userId);
    }
    if (mentions.broadcast) {
      for (const userId of members) {
        if (userId === author || told.has(userId) || !isPerson(ctx, userId)) continue;
        addActivity(ctx, userId, { kind: 'mention', channel, ts, threadTs, actor, detail: 'broadcast' });
        told.add(userId);
      }
    }
  }

  if (reply && threadTs) {
    const toTell = onReply(ctx, channel, threadTs, ts, author, mentions.users.filter((id) => members.has(id)));
    if (!direct) {
      for (const userId of toTell) {
        if (told.has(userId)) continue;
        addActivity(ctx, userId, { kind: 'thread_reply', channel, ts, threadTs, actor });
        told.add(userId);
      }
    }
  }

  if (!direct) {
    const text = plainOf(event);
    for (const userId of members) {
      if (userId === author || told.has(userId)) continue;
      const keyword = matchKeyword(ctx, userId, text);
      if (keyword && isPerson(ctx, userId)) {
        addActivity(ctx, userId, { kind: 'keyword', channel, ts, threadTs, actor, detail: keyword.toLowerCase() });
        told.add(userId);
      }
    }
  }
}

export function installWatch(ctx: Ctx): () => void {
  return ctx.bus.subscribe(({ event, audience }) => {
    switch (event.type) {
      case 'message':
        if (event.subtype === 'message_deleted' && typeof event.deleted_ts === 'string') {
          removeActivity(ctx, String(event.channel), event.deleted_ts);
        } else if (isNewMessage(event) && typeof event.channel === 'string' && typeof event.ts === 'string') {
          onMessage(ctx, event);
        }
        break;
      case 'reaction_added':
      case 'reaction_removed': {
        const item = event.item as { channel?: string; ts?: string } | undefined;
        const owner = typeof event.item_user === 'string' ? event.item_user : '';
        const reactor = String(event.user);
        if (!item?.channel || !item.ts || !owner || owner === reactor) break;
        const conv = getConv(ctx, item.channel);
        if (!conv || conv.kind === 'im' || conv.kind === 'mpim' || !isPerson(ctx, owner)) break;
        if (event.type === 'reaction_added') {
          const message = ctx.db.get<{ thread_ts: string | null }>('SELECT thread_ts FROM messages WHERE conversation_id = ? AND ts = ?', item.channel, item.ts);
          addActivity(ctx, owner, { kind: 'reaction', channel: item.channel, ts: item.ts, threadTs: message?.thread_ts ?? null, actor: reactor, detail: String(event.reaction) });
        } else {
          removeActivity(ctx, item.channel, item.ts, { kind: 'reaction', actor: reactor, detail: String(event.reaction) });
        }
        break;
      }
      case 'member_joined_channel': {
        const inviter = typeof event.inviter === 'string' ? event.inviter : null;
        const userId = String(event.user);
        if (!inviter || inviter === userId || !isPerson(ctx, userId)) break;
        const conv = getConv(ctx, String(event.channel));
        if (!conv || conv.kind === 'im' || conv.kind === 'mpim') break;
        addActivity(ctx, userId, { kind: 'invite', channel: conv.id, ts: String(event.event_ts), actor: inviter });
        break;
      }
      case 'channel_marked': {
        // Reading a channel reads the mentions in it.
        const userId = 'users' in audience ? audience.users[0] : undefined;
        if (userId && typeof event.channel === 'string' && typeof event.ts === 'string') {
          markActivityRead(ctx, userId, event.channel, event.ts, null);
        }
        break;
      }
      case 'pref_change': {
        const userId = 'users' in audience ? audience.users[0] : undefined;
        if (userId) keywordCache.delete(userId);
        break;
      }
      default:
        break;
    }
  });
}
