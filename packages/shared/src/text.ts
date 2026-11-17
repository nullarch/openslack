/**
 * Small helpers for Slack-style message text (`mrkdwn`) that both the server and
 * the client need. The full mrkdwn → AST parser used for rendering lives in `mrkdwn.ts`.
 */

/** Escape the three characters Slack escapes in message text. */
export function escapeText(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function unescapeText(input: string): string {
  return input.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export interface Mentions {
  /** User ids mentioned as `<@U…>`. */
  users: string[];
  /** True when the text contains `<!channel>`, `<!here>` or `<!everyone>`. */
  broadcast: boolean;
  /** User group ids mentioned as `<!subteam^S…>`. */
  groups: string[];
}

const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
const BROADCAST_MENTION = /<!(?:channel|here|everyone)(?:\|[^>]*)?>/;
const GROUP_MENTION = /<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>/g;

/** Find mentions in mrkdwn text. Code spans are not excluded; Slack does not exclude them either. */
export function extractMentions(text: string): Mentions {
  const users = new Set<string>();
  for (const match of text.matchAll(USER_MENTION)) {
    if (match[1]) users.add(match[1]);
  }
  const groups = new Set<string>();
  for (const match of text.matchAll(GROUP_MENTION)) {
    if (match[1]) groups.add(match[1]);
  }
  return { users: [...users], broadcast: BROADCAST_MENTION.test(text), groups: [...groups] };
}

/** Collect mentions from `rich_text` blocks, which carry them as elements rather than text. */
export function extractBlockMentions(blocks: unknown): Mentions {
  const users = new Set<string>();
  const groups = new Set<string>();
  let broadcast = false;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record.type === 'user' && typeof record.user_id === 'string') users.add(record.user_id);
    if (record.type === 'broadcast') broadcast = true;
    if (record.type === 'usergroup' && typeof record.usergroup_id === 'string') groups.add(record.usergroup_id);
    if (typeof record.text === 'string' && (record.type === 'mrkdwn' || record.type === 'section')) {
      const found = extractMentions(record.text);
      for (const id of found.users) users.add(id);
      for (const id of found.groups) groups.add(id);
      broadcast ||= found.broadcast;
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') visit(value);
    }
  };
  visit(blocks);
  return { users: [...users], broadcast, groups: [...groups] };
}

/** Flatten blocks and attachments to searchable plain text. */
export function blocksToPlainText(blocks: unknown): string {
  const parts: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    for (const key of ['text', 'title', 'pretext', 'fallback', 'footer', 'alt_text', 'value', 'url']) {
      const value = record[key];
      if (typeof value === 'string' && key !== 'value') parts.push(value);
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') visit(value);
    }
  };
  visit(blocks);
  return parts.join(' ');
}

/** Slack channel names: lowercase letters (any script), digits, `-` and `_`, at most 80 characters. */
export function normalizeChannelName(input: string): string {
  return input.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
}

export function channelNameError(name: string): string | null {
  if (!name) return 'invalid_name_required';
  if (name.length > 80) return 'invalid_name_maxlength';
  if (!/^[\p{Ll}\p{Lo}\p{N}_-]+$/u.test(name)) return 'invalid_name_specials';
  return null;
}

/** Compare two message timestamps (`seconds.micros`). */
export function compareTs(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function tsToMillis(ts: string): number {
  return Math.floor(Number(ts) * 1000);
}
