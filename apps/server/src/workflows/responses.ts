import { runInNewContext } from 'node:vm';
import type { Kernel } from '../app.ts';
import { canSee, getConv, type ConvRow } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import { postMessage } from '../core/messages.ts';
import { createUser, getUser, uniqueHandle } from '../core/users.ts';
import type { Ctx } from '../ctx.ts';

/**
 * Custom responses: when a message in chosen channels matches a phrase, a
 * built-in bot answers with a canned reply. Admins manage them. Rules with no
 * channels apply to every public channel; a rule may name private channels its
 * creator belongs to.
 */

interface ResponseRow {
  id: string;
  match_type: 'exact' | 'contains' | 'regex';
  pattern: string;
  reply: string;
  channels: string;
  enabled: number;
  created_by: string;
  created: number;
}

const MAX_PATTERN = 200;
const MAX_REPLY = 2000;
const MAX_RULES = 200;
const MAX_MATCHED_TEXT = 4000;
const REGEX_TIMEOUT_MS = 50;
const COOLDOWN_MS = 5_000;

/**
 * Refuse patterns that can take exponential time: nested or adjacent repeats
 * over the same group, backreferences, and lookbehind. Matching also runs under
 * a time limit, so this is the first of two defences.
 */
export function regexProblem(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN) return `Patterns are limited to ${MAX_PATTERN} characters.`;
  try {
    new RegExp(pattern, 'iu');
  } catch {
    return 'That is not a valid regular expression.';
  }
  if (/\\[1-9]|\\k</.test(pattern)) return 'Backreferences are not allowed.';
  if (/\(\?<[=!]/.test(pattern)) return 'Lookbehind is not allowed.';
  // A group that can repeat, itself followed by a repeat: (a+)+, (a|b)*, (x{2,})+ …
  if (/\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/.test(pattern)) return 'Nested repeats like (a+)+ are not allowed.';
  if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/.test(pattern)) return 'Repeated alternatives like (a|b)* are not allowed.';
  return null;
}

function matches(rule: ResponseRow, text: string): boolean {
  const body = text.slice(0, MAX_MATCHED_TEXT);
  if (rule.match_type === 'exact') return body.trim().toLowerCase() === rule.pattern.trim().toLowerCase();
  if (rule.match_type === 'contains') return body.toLowerCase().includes(rule.pattern.toLowerCase());
  try {
    return runInNewContext('pattern.test(text)', { pattern: new RegExp(rule.pattern, 'iu'), text: body }, { timeout: REGEX_TIMEOUT_MS }) === true;
  } catch {
    // Too slow or broken: treat as no match.
    return false;
  }
}

function responder(ctx: Ctx): string {
  const prefs = JSON.parse(ctx.requireTeam().prefs) as Record<string, unknown>;
  const existing = typeof prefs.responses_bot === 'string' ? getUser(ctx, prefs.responses_bot) : undefined;
  if (existing) return existing.id;
  const bot = createUser(ctx, { realName: 'Responses', displayName: 'Responses', isBot: true, botId: newId('B'), handle: uniqueHandle(ctx, 'responses') });
  ctx.db.run("UPDATE team SET prefs = json_set(prefs, '$.responses_bot', ?)", bot.id);
  ctx.invalidateTeam();
  return bot.id;
}

function toApi(row: ResponseRow): Record<string, unknown> {
  return {
    id: row.id,
    match_type: row.match_type,
    pattern: row.pattern,
    reply: row.reply,
    channels: JSON.parse(row.channels) as string[],
    enabled: row.enabled === 1,
    created_by: row.created_by,
    created: row.created,
  };
}

export function installResponses(kernel: Kernel): void {
  const { ctx, registry } = kernel;
  const lastFired = new Map<string, number>();

  registry.add('client.responses.list', { auth: 'admin' }, () => ({
    responses: ctx.db.all<ResponseRow>('SELECT * FROM custom_responses ORDER BY created').map(toApi),
  }));

  registry.add('client.responses.save', { auth: 'admin' }, ({ actor, args }) => {
    const matchType = args.req('match_type');
    if (matchType !== 'exact' && matchType !== 'contains' && matchType !== 'regex') fail('invalid_match_type');
    const pattern = args.req('pattern');
    if (pattern.length > MAX_PATTERN) fail('pattern_too_long', { max_length: MAX_PATTERN });
    if (matchType === 'regex') {
      const problem = regexProblem(pattern);
      if (problem) fail('invalid_pattern', { detail: problem });
    }
    const reply = args.req('reply').slice(0, MAX_REPLY);
    const channels = args.list('channels');
    for (const id of channels) {
      const conv = getConv(ctx, id);
      // Only conversations the rule's author can see, and not direct messages.
      if (!conv || conv.kind === 'im' || conv.kind === 'mpim' || !canSee(ctx, conv, actor.userId)) fail('channel_not_found', { channel: id });
    }
    const id = args.str('id');
    if (id) {
      const changed = ctx.db.run(
        'UPDATE custom_responses SET match_type = ?, pattern = ?, reply = ?, channels = ?, enabled = ? WHERE id = ?',
        matchType,
        pattern,
        reply,
        JSON.stringify(channels),
        args.bool('enabled', true) ? 1 : 0,
        id,
      );
      if (changed.changes === 0) fail('not_found');
      return { response: toApi(ctx.db.get<ResponseRow>('SELECT * FROM custom_responses WHERE id = ?', id)!) };
    }
    if ((ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM custom_responses')?.n ?? 0) >= MAX_RULES) fail('too_many_responses');
    const newRule = newId('R');
    ctx.db.run(
      'INSERT INTO custom_responses (id, match_type, pattern, reply, channels, enabled, created_by, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      newRule,
      matchType,
      pattern,
      reply,
      JSON.stringify(channels),
      args.bool('enabled', true) ? 1 : 0,
      actor.userId,
      nowSeconds(),
    );
    return { response: toApi(ctx.db.get<ResponseRow>('SELECT * FROM custom_responses WHERE id = ?', newRule)!) };
  });

  registry.add('client.responses.delete', { auth: 'admin' }, ({ args }) => {
    if (ctx.db.run('DELETE FROM custom_responses WHERE id = ?', args.req('id')).changes === 0) fail('not_found');
  });

  const unsubscribe = ctx.bus.subscribe(({ event }) => {
    if (event.type !== 'message' || event.hidden || typeof event.text !== 'string' || !event.text) return;
    if (event.subtype !== undefined && event.subtype !== 'thread_broadcast' && event.subtype !== 'file_share') return;
    if (event.bot_id || typeof event.user !== 'string') return;
    const author = getUser(ctx, event.user);
    if (!author || author.is_bot === 1) return;
    const conv = typeof event.channel === 'string' ? getConv(ctx, event.channel) : undefined;
    if (!conv || conv.kind === 'im' || conv.kind === 'mpim') return;
    const rules = ctx.db.all<ResponseRow>('SELECT * FROM custom_responses WHERE enabled = 1 ORDER BY created');
    for (const rule of rules) {
      const channels = JSON.parse(rule.channels) as string[];
      if (channels.length ? !channels.includes(conv.id) : conv.kind !== 'public') continue;
      if (!matches(rule, event.text)) continue;
      const key = `${rule.id}:${conv.id}`;
      const now = Date.now();
      if ((lastFired.get(key) ?? 0) > now - COOLDOWN_MS) return;
      lastFired.set(key, now);
      reply(ctx, conv, rule, typeof event.thread_ts === 'string' ? event.thread_ts : null);
      return; // one answer per message
    }
  });
  kernel.onClose.push(unsubscribe);
}

function reply(ctx: Ctx, conv: ConvRow, rule: ResponseRow, threadTs: string | null): void {
  // Answer after the triggering message has gone out to everyone.
  setImmediate(() => {
    try {
      const bot = responder(ctx);
      postMessage(ctx, { conv: getConv(ctx, conv.id)!, userId: bot, text: rule.reply, threadTs });
    } catch (error) {
      console.error('[responses] reply failed', error);
    }
  });
}
