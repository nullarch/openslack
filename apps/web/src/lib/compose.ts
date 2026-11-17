/**
 * Converts between what a person types in the composer and the mrkdwn the
 * server stores. Kept free of browser APIs so it can be unit-tested with Node.
 */

export interface ComposeUser {
  id: string;
  /** Every name the person can be mentioned by: display name, full name, handle. */
  names: string[];
}

export interface ComposeChannel {
  id: string;
  name: string;
}

export interface ComposeLookup {
  users: ComposeUser[];
  channels: ComposeChannel[];
  /** User groups, mentioned as `@handle`. */
  groups?: { id: string; handle: string }[];
}

const RAW_TOKEN = /<(?:https?:\/\/|mailto:|tel:|@[UW][A-Z0-9]+|#[CDG][A-Z0-9]+|!(?:here|channel|everyone|subteam\^|date\^))[^<>\n]*>/g;
const BROADCASTS = ['here', 'channel', 'everyone'];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Turn typed text into mrkdwn: escape `& < >`, then encode `@name`, `#channel` and `@here`. */
export function encodeMessage(input: string, lookup: ComposeLookup): string {
  // Tokens typed in raw mrkdwn form (`<https://…|label>`) pass through untouched.
  const kept: string[] = [];
  let text = input.replace(RAW_TOKEN, (token) => {
    kept.push(token);
    return `\u0000${kept.length - 1}\u0000`;
  });
  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const byName = new Map<string, string>();
  for (const user of lookup.users) {
    for (const name of user.names) {
      const key = name.trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, user.id);
    }
  }
  // A group handle wins over a person with the same name only when no person has it.
  const groups = new Map<string, string>();
  for (const group of lookup.groups ?? []) {
    const key = group.handle.toLowerCase();
    if (!byName.has(key)) groups.set(key, group.id);
  }
  const names = [...byName.keys(), ...groups.keys(), ...BROADCASTS].sort((a, b) => b.length - a.length).map(escapeRegExp);
  if (names.length > 0) {
    const mention = new RegExp(`(^|[^\\p{L}\\p{N}@])@(${names.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
    text = text.replace(mention, (_match, lead: string, name: string) => {
      const key = name.toLowerCase();
      const id = byName.get(key);
      if (id) return `${lead}<@${id}>`;
      const group = groups.get(key);
      if (group) return `${lead}<!subteam^${group}|@${key}>`;
      return `${lead}<!${key}>`;
    });
  }

  const channels = new Map(lookup.channels.map((channel) => [channel.name.toLowerCase(), channel.id]));
  text = text.replace(/(^|[^\p{L}\p{N}&#])#([\p{L}\p{N}_-]+)/gu, (match, lead: string, name: string) => {
    const id = channels.get(name.toLowerCase());
    return id ? `${lead}<#${id}>` : match;
  });

  return text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => kept[Number(index)] ?? '');
}

export interface DecodeLookup {
  userName: (id: string) => string | undefined;
  channelName: (id: string) => string | undefined;
}

/** Turn stored mrkdwn back into editable text. Labelled links stay in `<url|label>` form. */
export function decodeMessage(input: string, lookup: DecodeLookup): string {
  return input
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (match, id: string) => {
      const name = lookup.userName(id);
      return name ? `@${name}` : match;
    })
    .replace(/<#([CDG][A-Z0-9]+)(?:\|([^>]*))?>/g, (match, id: string, label?: string) => {
      const name = lookup.channelName(id) ?? label;
      return name ? `#${name}` : match;
    })
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<!subteam\^[A-Z0-9]+\|(@[^>]+)>/g, '$1')
    .replace(/<(https?:\/\/[^|>\s]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export interface Trigger {
  kind: 'user' | 'channel' | 'emoji' | 'command';
  query: string;
  /** Index in the text where the trigger character sits. */
  start: number;
}

/** Find an autocomplete trigger ending at the caret, if any. */
export function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const command = /^\/([a-z0-9_-]*)$/i.exec(before);
  if (command) return { kind: 'command', query: command[1]!.toLowerCase(), start: 0 };
  const user = /(^|[\s(])@([\p{L}\p{N}._-]*)$/u.exec(before);
  if (user) return { kind: 'user', query: user[2]!.toLowerCase(), start: before.length - user[2]!.length - 1 };
  const channel = /(^|[\s(])#([\p{L}\p{N}_-]*)$/u.exec(before);
  if (channel) return { kind: 'channel', query: channel[2]!.toLowerCase(), start: before.length - channel[2]!.length - 1 };
  const emoji = /(^|[\s(]):([a-z0-9_+-]{2,})$/i.exec(before);
  if (emoji) return { kind: 'emoji', query: emoji[2]!.toLowerCase(), start: before.length - emoji[2]!.length - 1 };
  return null;
}

export interface Edit {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

/** Wrap the selection in a pair of marks (`*…*`), or insert the pair and place the caret inside. */
export function wrapSelection(text: string, start: number, end: number, open: string, close = open): Edit {
  const selected = text.slice(start, end);
  const next = text.slice(0, start) + open + selected + close + text.slice(end);
  if (selected) return { text: next, selectionStart: start + open.length, selectionEnd: end + open.length };
  return { text: next, selectionStart: start + open.length, selectionEnd: start + open.length };
}

/** Prefix every line touched by the selection (used for quotes). */
export function prefixLines(text: string, start: number, end: number, prefix: string): Edit {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEndIndex = text.indexOf('\n', end);
  const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const all = lines.every((line) => line.startsWith(prefix));
  const changed = lines.map((line) => (all ? line.slice(prefix.length) : prefix + line)).join('\n');
  const next = text.slice(0, lineStart) + changed + text.slice(lineEnd);
  return { text: next, selectionStart: lineStart, selectionEnd: lineStart + changed.length };
}
