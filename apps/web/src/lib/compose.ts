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

/** A typed `@name`, `@here` or `#channel`, resolved. */
export type Resolved = { kind: 'user'; id: string } | { kind: 'usergroup'; id: string; handle: string } | { kind: 'broadcast'; id: string } | { kind: 'channel'; id: string };

interface Matchers {
  /** `@name` after something that is not a letter, digit or `@`; group 1 is what came before, group 2 the name. */
  mention: RegExp | null;
  user: (name: string) => Resolved | null;
  channel: (name: string) => Resolved | null;
}

const CHANNEL = /(^|[^\p{L}\p{N}&#])#([\p{L}\p{N}_-]+)/gu;

function matchers(lookup: ComposeLookup): Matchers {
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
  const channels = new Map(lookup.channels.map((channel) => [channel.name.toLowerCase(), channel.id]));
  return {
    mention: names.length > 0 ? new RegExp(`(^|[^\\p{L}\\p{N}@])@(${names.join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null,
    user: (name) => {
      const key = name.toLowerCase();
      const id = byName.get(key);
      if (id) return { kind: 'user', id };
      const group = groups.get(key);
      if (group) return { kind: 'usergroup', id: group, handle: key };
      return BROADCASTS.includes(key) ? { kind: 'broadcast', id: key } : null;
    },
    channel: (name) => {
      const id = channels.get(name.toLowerCase());
      return id ? { kind: 'channel', id } : null;
    },
  };
}

function token(resolved: Resolved): string {
  if (resolved.kind === 'user') return `<@${resolved.id}>`;
  if (resolved.kind === 'usergroup') return `<!subteam^${resolved.id}|@${resolved.handle}>`;
  if (resolved.kind === 'broadcast') return `<!${resolved.id}>`;
  return `<#${resolved.id}>`;
}

const CODE = /```[\s\S]*?```|`[^`\n]+`/g;

function escapeAll(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Turn typed text into mrkdwn: escape `& < >`, then encode `@name`, `#channel`
 * and `@here`. Code spans and fences are only escaped: what is typed in code stays as typed.
 */
export function encodeMessage(input: string, lookup: ComposeLookup): string {
  const match = matchers(lookup);
  let out = '';
  let cursor = 0;
  for (const hit of input.matchAll(CODE)) {
    out += encodeProse(input.slice(cursor, hit.index), match) + escapeAll(hit[0]);
    cursor = hit.index + hit[0].length;
  }
  return out + encodeProse(input.slice(cursor), match);
}

function encodeProse(input: string, match: Matchers): string {
  if (!input) return '';
  // Tokens typed in raw mrkdwn form (`<https://…|label>`) pass through untouched.
  const kept: string[] = [];
  let text = input.replace(RAW_TOKEN, (raw) => {
    kept.push(raw);
    return `\u0000${kept.length - 1}\u0000`;
  });
  text = escapeAll(text);

  if (match.mention) {
    text = text.replace(match.mention, (whole, lead: string, name: string) => {
      const resolved = match.user(name);
      return resolved ? `${lead}${token(resolved)}` : whole;
    });
  }
  text = text.replace(CHANNEL, (whole, lead: string, name: string) => {
    const resolved = match.channel(name);
    return resolved ? `${lead}${token(resolved)}` : whole;
  });

  return text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => kept[Number(index)] ?? '');
}

/**
 * The same names `encodeMessage` would encode, found in plain text: pieces of
 * text and resolved mentions in order. The rich composer uses it for names
 * typed out in full rather than picked from the list.
 */
export function splitMentions(input: string, lookup: ComposeLookup): (string | Resolved)[] {
  const match = matchers(lookup);
  const found: { start: number; end: number; resolved: Resolved }[] = [];
  if (match.mention) {
    for (const hit of input.matchAll(match.mention)) {
      const resolved = match.user(hit[2]!);
      const start = hit.index + hit[1]!.length;
      if (resolved) found.push({ start, end: start + 1 + hit[2]!.length, resolved });
    }
  }
  for (const hit of input.matchAll(CHANNEL)) {
    const resolved = match.channel(hit[2]!);
    const start = hit.index + hit[1]!.length;
    if (resolved) found.push({ start, end: start + 1 + hit[2]!.length, resolved });
  }
  found.sort((a, b) => a.start - b.start);
  const out: (string | Resolved)[] = [];
  let cursor = 0;
  for (const item of found) {
    if (item.start < cursor) continue;
    if (item.start > cursor) out.push(input.slice(cursor, item.start));
    out.push(item.resolved);
    cursor = item.end;
  }
  if (cursor < input.length) out.push(input.slice(cursor));
  return out;
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
