/**
 * Parser for Slack's message markup (`mrkdwn`): `*bold*`, `_italic_`, `~strike~`,
 * `` `code` ``, fenced code, `>` quotes, `<url|label>` links, `<@U…>` mentions,
 * `<#C…>` channel links, `<!here>` broadcasts and `:emoji:` shortcodes.
 *
 * It produces a small tree that a client renders and that `mrkdwnToPlain`
 * flattens for notifications and previews. Nothing here produces HTML.
 */

export type MrkdwnNode =
  | { type: 'text'; text: string }
  | { type: 'bold' | 'italic' | 'strike'; children: MrkdwnNode[] }
  | { type: 'code'; text: string }
  | { type: 'pre'; text: string }
  | { type: 'quote'; children: MrkdwnNode[] }
  | { type: 'link'; url: string; children: MrkdwnNode[] }
  | { type: 'user'; id: string; label?: string }
  | { type: 'channel'; id: string; label?: string }
  | { type: 'usergroup'; id: string; label?: string }
  | { type: 'broadcast'; range: 'here' | 'channel' | 'everyone' }
  | { type: 'date'; timestamp: number; format: string; fallback: string }
  | { type: 'emoji'; name: string }
  | { type: 'br' };

const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

function unescapeEntities(input: string): string {
  return input.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function pushText(out: MrkdwnNode[], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.type === 'text') last.text += text;
  else out.push({ type: 'text', text });
}

/** Parse the inside of `<…>`. Returns null when it is not a recognised token. */
function parseAngle(body: string): MrkdwnNode | null {
  const bar = body.indexOf('|');
  const target = bar === -1 ? body : body.slice(0, bar);
  const label = bar === -1 ? undefined : unescapeEntities(body.slice(bar + 1));
  if (/^@[UW][A-Z0-9]+$/.test(target)) {
    return label ? { type: 'user', id: target.slice(1), label } : { type: 'user', id: target.slice(1) };
  }
  if (/^#[CDG][A-Z0-9]+$/.test(target)) {
    return label ? { type: 'channel', id: target.slice(1), label } : { type: 'channel', id: target.slice(1) };
  }
  if (target === '!here' || target === '!channel' || target === '!everyone') {
    return { type: 'broadcast', range: target.slice(1) as 'here' | 'channel' | 'everyone' };
  }
  if (target === '!group') return { type: 'broadcast', range: 'channel' };
  const subteam = /^!subteam\^([A-Z0-9]+)$/.exec(target);
  if (subteam) return label ? { type: 'usergroup', id: subteam[1]!, label } : { type: 'usergroup', id: subteam[1]! };
  const date = /^!date\^(\d+)\^([^^]*)(?:\^.*)?$/.exec(target);
  if (date) return { type: 'date', timestamp: Number(date[1]), format: date[2]!, fallback: label ?? '' };
  if (/^(https?:\/\/|mailto:|tel:)\S+$/i.test(target)) {
    const url = unescapeEntities(target);
    return { type: 'link', url, children: label ? parseInline(label, false) : [{ type: 'text', text: url }] };
  }
  return null;
}

/** Length of the bare URL starting at `start`, without trailing punctuation that belongs to the sentence. */
function bareUrlLength(input: string, start: number): number {
  const match = /^https?:\/\/[^\s<>]+/i.exec(input.slice(start));
  if (!match) return 0;
  // An escaped angle bracket ends the URL; it belongs to the surrounding text.
  let url = match[0].replace(/(&gt;|&lt;).*$/, '');
  for (;;) {
    const last = url[url.length - 1];
    if (last === undefined) break;
    if (/[.,;:!?'"*_~]/.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ')') {
      const opens = url.split('(').length - 1;
      const closes = url.split(')').length - 1;
      if (closes > opens) {
        url = url.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return /^https?:\/\/./i.test(url) ? url.length : 0;
}

/** Find the closing delimiter for emphasis opened at `open`, or -1. */
function findClose(input: string, open: number, mark: string): number {
  for (let j = open + 2; j < input.length; j += 1) {
    const char = input[j]!;
    if (char === '\n') return -1;
    if (char !== mark) continue;
    if (SPACE.test(input[j - 1]!)) continue;
    const after = input[j + 1];
    if (after !== undefined && WORD.test(after)) continue;
    return j;
  }
  return -1;
}

function parseInline(input: string, autolink = true): MrkdwnNode[] {
  const out: MrkdwnNode[] = [];
  let buffer = '';
  const flush = (): void => {
    pushText(out, unescapeEntities(buffer));
    buffer = '';
  };
  let i = 0;
  while (i < input.length) {
    const char = input[i]!;
    const before = i === 0 ? '' : input[i - 1]!;

    if (char === '\n') {
      flush();
      out.push({ type: 'br' });
      i += 1;
      continue;
    }

    if (char === '<') {
      const end = input.indexOf('>', i + 1);
      if (end !== -1 && !input.slice(i + 1, end).includes('\n')) {
        const node = parseAngle(input.slice(i + 1, end));
        if (node) {
          flush();
          out.push(node);
          i = end + 1;
          continue;
        }
      }
    }

    if (char === '`') {
      const end = input.indexOf('`', i + 1);
      if (end > i + 1 && !input.slice(i + 1, end).includes('\n')) {
        flush();
        out.push({ type: 'code', text: unescapeEntities(input.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    if ((char === '*' || char === '_' || char === '~') && (before === '' || !WORD.test(before))) {
      const next = input[i + 1];
      if (next !== undefined && !SPACE.test(next) && next !== char) {
        const close = findClose(input, i, char);
        if (close !== -1) {
          flush();
          const type = char === '*' ? 'bold' : char === '_' ? 'italic' : 'strike';
          out.push({ type, children: parseInline(input.slice(i + 1, close), autolink) });
          i = close + 1;
          continue;
        }
      }
    }

    if (char === ':') {
      const match = /^:([a-z0-9_+'-]+(?:::skin-tone-[2-6])?):/i.exec(input.slice(i));
      if (match && (before === '' || !WORD.test(before) || before === ':')) {
        flush();
        out.push({ type: 'emoji', name: match[1]!.toLowerCase() });
        i += match[0].length;
        continue;
      }
    }

    if (autolink && (char === 'h' || char === 'H') && (before === '' || !WORD.test(before))) {
      const length = bareUrlLength(input, i);
      if (length > 0) {
        flush();
        const url = unescapeEntities(input.slice(i, i + length));
        out.push({ type: 'link', url, children: [{ type: 'text', text: url }] });
        i += length;
        continue;
      }
    }

    buffer += char;
    i += 1;
  }
  flush();
  return out;
}

function isQuoteLine(line: string): boolean {
  return /^(&gt;|>)(?!&gt;|>)/.test(line) || /^(&gt;|>){3}/.test(line);
}

/** Parse the text between code fences: quote lines become quote nodes, the rest is inline. */
function parseProse(input: string): MrkdwnNode[] {
  const out: MrkdwnNode[] = [];
  const lines = input.split('\n');
  // Quotes are blocks, so no line break is emitted where prose meets a quote.
  let plain: string[] = [];
  const flushPlain = (): void => {
    if (plain.length === 0) return;
    out.push(...parseInline(plain.join('\n')));
    plain = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const triple = /^(&gt;|>){3}\s?/.exec(line);
    if (triple) {
      // `>>>` quotes everything that follows.
      flushPlain();
      const rest = [line.slice(triple[0].length), ...lines.slice(index + 1)].join('\n');
      out.push({ type: 'quote', children: parseInline(rest) });
      return out;
    }
    if (isQuoteLine(line)) {
      flushPlain();
      const quoted: string[] = [];
      while (index < lines.length && isQuoteLine(lines[index]!) && !/^(&gt;|>){3}/.test(lines[index]!)) {
        quoted.push(lines[index]!.replace(/^(&gt;|>)\s?/, ''));
        index += 1;
      }
      index -= 1;
      out.push({ type: 'quote', children: parseInline(quoted.join('\n')) });
      continue;
    }
    plain.push(line);
  }
  flushPlain();
  return out;
}

export function parseMrkdwn(input: string): MrkdwnNode[] {
  const out: MrkdwnNode[] = [];
  const fence = /```([\s\S]*?)```/g;
  let cursor = 0;
  for (const match of input.matchAll(fence)) {
    const before = input.slice(cursor, match.index);
    if (before) out.push(...parseProse(before.replace(/\n$/, '')));
    out.push({ type: 'pre', text: unescapeEntities(match[1]!.replace(/^\n/, '').replace(/\n$/, '')) });
    cursor = match.index + match[0].length;
  }
  const rest = input.slice(cursor);
  if (rest) out.push(...parseProse(cursor > 0 ? rest.replace(/^\n/, '') : rest));
  return out;
}

export interface PlainLookup {
  user?: (id: string) => string | undefined;
  channel?: (id: string) => string | undefined;
  emoji?: (name: string) => string | undefined;
}

/** Flatten parsed text to one plain string, for notifications, previews and titles. */
export function mrkdwnToPlain(nodes: MrkdwnNode[], lookup: PlainLookup = {}): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'code':
      case 'pre':
        out += node.text;
        break;
      case 'bold':
      case 'italic':
      case 'strike':
      case 'quote':
        out += mrkdwnToPlain(node.children, lookup);
        break;
      case 'link': {
        out += mrkdwnToPlain(node.children, lookup);
        break;
      }
      case 'user':
        out += `@${lookup.user?.(node.id) ?? node.label ?? node.id}`;
        break;
      case 'channel':
        out += `#${lookup.channel?.(node.id) ?? node.label ?? node.id}`;
        break;
      case 'usergroup':
        out += node.label ?? `@${node.id}`;
        break;
      case 'broadcast':
        out += `@${node.range}`;
        break;
      case 'date':
        out += node.fallback || new Date(node.timestamp * 1000).toLocaleString();
        break;
      case 'emoji':
        out += lookup.emoji?.(node.name) ?? `:${node.name}:`;
        break;
      case 'br':
        out += '\n';
        break;
    }
  }
  return out;
}
