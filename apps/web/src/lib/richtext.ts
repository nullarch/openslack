/**
 * The rich composer's document and what is sent from it.
 *
 * The editor (TipTap, ProseMirror underneath) holds a document; a message is
 * sent as Slack's client sends one: `text` in mrkdwn, for everything that reads
 * text, and a `rich_text` block with the same content, for apps that read
 * structure. Drafts keep the typed form the markup composer shows (`@Maya`,
 * `*bold*`), so a draft moves between the two composers and between devices.
 *
 * Everything here works on plain JSON (ProseMirror's `toJSON` shape), with no
 * editor or browser, so it is tested under Node.
 */

import { parseMrkdwn, type MrkdwnNode } from '@app/shared';
import { decodeMessage, encodeMessage, splitMentions, type ComposeLookup } from './compose.ts';

// ── Shapes ──────────────────────────────────────────────────────────────────

/** A ProseMirror node as JSON. Node and mark names are those of the composer's schema. */
export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  marks?: DocMark[];
  text?: string;
}

export interface DocMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export type MentionKind = 'user' | 'channel' | 'usergroup' | 'broadcast';

export interface RichStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
}

export type RichInline =
  | { type: 'text'; text: string; style?: RichStyle }
  | { type: 'link'; url: string; text?: string; style?: RichStyle }
  | { type: 'user'; user_id: string; style?: RichStyle }
  | { type: 'channel'; channel_id: string; style?: RichStyle }
  | { type: 'usergroup'; usergroup_id: string; style?: RichStyle }
  | { type: 'broadcast'; range: string; style?: RichStyle }
  | { type: 'emoji'; name: string; unicode?: string; skin_tone?: number; style?: RichStyle }
  | { type: 'date'; timestamp: number; format: string; fallback?: string };

export interface RichSection {
  type: 'rich_text_section';
  elements: RichInline[];
}

export interface RichList {
  type: 'rich_text_list';
  style: 'bullet' | 'ordered';
  indent: number;
  offset?: number;
  border: 0;
  elements: RichSection[];
}

export type RichElement = RichSection | RichList | { type: 'rich_text_preformatted'; border: 0; elements: RichInline[] } | { type: 'rich_text_quote'; elements: RichInline[] };

export interface RichTextBlock {
  type: 'rich_text';
  elements: RichElement[];
  /** A Block Kit block like any other (`block_id` and the rest). */
  [key: string]: unknown;
}

/** What the conversions need to know about the workspace. */
export interface RichLookup {
  /** Names people can be mentioned by, for names typed out in full; without it they stay text. */
  compose?: ComposeLookup;
  userName: (id: string) => string | undefined;
  channelName: (id: string) => string | undefined;
  groupHandle: (id: string) => string | undefined;
  /** Whether a shortcode (`tada`, `+1::skin-tone-3`, a custom name) is an emoji this workspace knows. */
  isEmoji: (name: string) => boolean;
  /** The character of a standard emoji, or null for custom and unknown ones. */
  emojiChar: (name: string) => string | null;
}

export const EMPTY_DOC: DocNode = { type: 'doc', content: [{ type: 'paragraph' }] };

const STYLES = ['bold', 'italic', 'strike', 'code'] as const;
type StyleName = (typeof STYLES)[number];

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sameStyle(a: RichStyle | undefined, b: RichStyle | undefined): boolean {
  return STYLES.every((name) => Boolean(a?.[name]) === Boolean(b?.[name]));
}

function styleOf(marks: DocMark[] | undefined): RichStyle | undefined {
  const style: RichStyle = {};
  for (const mark of marks ?? []) if ((STYLES as readonly string[]).includes(mark.type)) style[mark.type as StyleName] = true;
  return Object.keys(style).length > 0 ? style : undefined;
}

function withStyle<T extends RichInline>(element: T, style: RichStyle | undefined): T {
  return style && element.type !== 'date' ? { ...element, style: { ...style } } : element;
}

/** Add text to a run of inline elements, joining it to the text before when they look the same. */
function pushText(out: RichInline[], text: string, style?: RichStyle): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.type === 'text' && sameStyle(last.style, style)) last.text += text;
  else out.push(withStyle({ type: 'text', text }, style));
}

function pushAll(out: RichInline[], elements: RichInline[]): void {
  for (const element of elements) {
    if (element.type === 'text') pushText(out, element.text, element.style);
    else out.push(element);
  }
}

function codePoints(value: string): string {
  return [...value].map((char) => char.codePointAt(0)!.toString(16)).join('-');
}

// ── Document → rich_text ────────────────────────────────────────────────────

function isBlank(node: DocNode): boolean {
  if (node.type !== 'paragraph') return false;
  return (node.content ?? []).every((child) => (child.type === 'text' && !(child.text ?? '').trim()) || child.type === 'hardBreak');
}

function mentionElement(attrs: Record<string, unknown> | undefined): RichInline | null {
  const id = String(attrs?.id ?? '');
  if (!id) return null;
  switch (attrs?.kind) {
    case 'channel':
      return { type: 'channel', channel_id: id };
    case 'usergroup':
      return { type: 'usergroup', usergroup_id: id };
    case 'broadcast':
      return { type: 'broadcast', range: id };
    default:
      return { type: 'user', user_id: id };
  }
}

function emojiElement(name: string, lookup: RichLookup): RichInline {
  const [base = name, tone] = name.split('::skin-tone-');
  const element: RichInline & { type: 'emoji' } = { type: 'emoji', name: base };
  const char = lookup.emojiChar(name);
  if (char) element.unicode = codePoints(char);
  if (tone) element.skin_tone = Number(tone);
  return element;
}

/** A shortcode as mrkdwn reads one: not glued to a word before it. */
const SHORTCODE = /(?<![\p{L}\p{N}]):([a-z0-9_+'-]+(?:::skin-tone-[2-6])?):/giu;

/** Text with the `:shortcodes:` of known emoji taken out as emoji. */
function splitShortcodes(text: string, lookup: RichLookup): (string | { emoji: string })[] {
  if (!text.includes(':')) return [text];
  const out: (string | { emoji: string })[] = [];
  let cursor = 0;
  for (const hit of text.matchAll(SHORTCODE)) {
    const name = hit[1]!.toLowerCase();
    if (!lookup.isEmoji(name) || hit.index < cursor) continue;
    if (hit.index > cursor) out.push(text.slice(cursor, hit.index));
    out.push({ emoji: name });
    cursor = hit.index + hit[0].length;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

function inlines(content: DocNode[] | undefined, lookup: RichLookup): RichInline[] {
  const out: RichInline[] = [];
  for (const node of content ?? []) {
    const style = styleOf(node.marks);
    if (node.type === 'text') {
      const text = node.text ?? '';
      const link = node.marks?.find((mark) => mark.type === 'link');
      if (link) {
        const url = String(link.attrs?.href ?? '');
        out.push(withStyle(text && text !== url ? { type: 'link', url, text } : { type: 'link', url }, style));
      } else if (style?.code || !lookup.compose) {
        pushText(out, text, style);
      } else {
        // Names and `:shortcodes:` typed out in full count as picked, as in the markup composer.
        for (const piece of splitMentions(text, lookup.compose)) {
          if (typeof piece !== 'string') {
            const element = mentionElement({ kind: piece.kind, id: piece.id });
            if (element) out.push(withStyle(element, style));
            continue;
          }
          for (const part of splitShortcodes(piece, lookup)) {
            if (typeof part === 'string') pushText(out, part, style);
            else out.push(withStyle(emojiElement(part.emoji, lookup), style));
          }
        }
      }
    } else if (node.type === 'mention') {
      const element = mentionElement(node.attrs);
      if (element) out.push(withStyle(element, style));
    } else if (node.type === 'emoji') {
      out.push(withStyle(emojiElement(String(node.attrs?.name ?? ''), lookup), style));
    } else if (node.type === 'hardBreak') {
      pushText(out, '\n');
    }
  }
  return out;
}

function plainOf(node: DocNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  return (node.content ?? []).map(plainOf).join(node.type === 'codeBlock' || node.type === 'paragraph' ? '' : '\n');
}

/** Blocks that `rich_text` cannot nest (a list in a quote, code in a list) become lines of text. */
function flatten(nodes: DocNode[] | undefined, lookup: RichLookup): RichInline[] {
  const out: RichInline[] = [];
  const line = (): void => {
    if (out.length > 0) pushText(out, '\n');
  };
  for (const node of nodes ?? []) {
    if (node.type === 'paragraph') {
      line();
      pushAll(out, inlines(node.content, lookup));
    } else if (node.type === 'bulletList' || node.type === 'orderedList') {
      const start = Number(node.attrs?.start ?? 1) || 1;
      (node.content ?? []).forEach((item, index) => {
        line();
        pushText(out, node.type === 'orderedList' ? `${start + index}. ` : '• ');
        pushAll(out, flatten(item.content, lookup));
      });
    } else if (node.type === 'blockquote') {
      line();
      pushAll(out, flatten(node.content, lookup));
    } else {
      line();
      pushText(out, plainOf(node));
    }
  }
  return out;
}

function addList(list: DocNode, indent: number, out: RichElement[], lookup: RichLookup): void {
  const style = list.type === 'orderedList' ? 'ordered' : 'bullet';
  let done = style === 'ordered' ? Math.max(0, (Number(list.attrs?.start ?? 1) || 1) - 1) : 0;
  let items: RichSection[] = [];
  const flush = (): void => {
    if (items.length === 0) return;
    out.push({ type: 'rich_text_list', style, indent, ...(done > 0 ? { offset: done } : {}), border: 0, elements: items });
    done += items.length;
    items = [];
  };
  for (const item of list.content ?? []) {
    const own: DocNode[] = [];
    const nested: DocNode[] = [];
    for (const child of item.content ?? []) (child.type === 'bulletList' || child.type === 'orderedList' ? nested : own).push(child);
    items.push({ type: 'rich_text_section', elements: flatten(own, lookup) });
    // A nested list is its own element, one step further in, and the outer list continues after it.
    for (const child of nested) {
      flush();
      addList(child, indent + 1, out, lookup);
    }
  }
  flush();
}

/** The `rich_text` block for a document, or null when there is nothing in it. */
export function docToRichText(doc: DocNode, lookup: RichLookup): RichTextBlock | null {
  const nodes = [...(doc.content ?? [])];
  while (nodes.length > 0 && isBlank(nodes[0]!)) nodes.shift();
  while (nodes.length > 0 && isBlank(nodes[nodes.length - 1]!)) nodes.pop();
  const elements: RichElement[] = [];
  let section: RichInline[] | null = null;
  const flushSection = (): void => {
    if (section && section.length > 0) elements.push({ type: 'rich_text_section', elements: section });
    section = null;
  };
  for (const node of nodes) {
    if (node.type === 'paragraph') {
      // Consecutive lines are one section with line breaks, as Slack's client writes them.
      if (section) pushText(section, '\n');
      else section = [];
      pushAll(section, inlines(node.content, lookup));
    } else if (node.type === 'bulletList' || node.type === 'orderedList') {
      flushSection();
      addList(node, 0, elements, lookup);
    } else if (node.type === 'codeBlock') {
      flushSection();
      const text = plainOf(node);
      if (text) elements.push({ type: 'rich_text_preformatted', border: 0, elements: [{ type: 'text', text }] });
    } else if (node.type === 'blockquote') {
      flushSection();
      const quoted = flatten(node.content, lookup);
      if (quoted.length > 0) elements.push({ type: 'rich_text_quote', elements: quoted });
    } else {
      flushSection();
      const text = plainOf(node);
      if (text) elements.push({ type: 'rich_text_section', elements: [{ type: 'text', text }] });
    }
  }
  flushSection();
  trimEnds(elements);
  return elements.length > 0 ? { type: 'rich_text', elements } : null;
}

/** Spaces at the very start and end of a message are not part of it. */
function trimEnds(elements: RichElement[]): void {
  const first = elements[0];
  if (first?.type === 'rich_text_section' && first.elements[0]?.type === 'text') {
    first.elements[0].text = first.elements[0].text.replace(/^\s+/, '');
    if (!first.elements[0].text) first.elements.shift();
  }
  const last = elements[elements.length - 1];
  const tail = last?.type === 'rich_text_section' ? last.elements[last.elements.length - 1] : undefined;
  if (last?.type === 'rich_text_section' && tail?.type === 'text') {
    tail.text = tail.text.replace(/\s+$/, '');
    if (!tail.text) last.elements.pop();
  }
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index]!;
    if (element.type === 'rich_text_section' && element.elements.length === 0) elements.splice(index, 1);
  }
}

// ── rich_text → mrkdwn ──────────────────────────────────────────────────────

const MARKER: Record<StyleName, string> = { bold: '*', italic: '_', strike: '~', code: '`' };
const BULLETS = ['•', '◦', '▪'];

function atom(element: RichInline, lookup: Pick<RichLookup, 'groupHandle'> | undefined): string {
  switch (element.type) {
    case 'text':
      return escapeText(element.text);
    case 'link': {
      const url = escapeText(element.url).replace(/\|/g, '%7C');
      return element.text && element.text !== element.url ? `<${url}|${escapeText(element.text)}>` : `<${url}>`;
    }
    case 'user':
      return `<@${element.user_id}>`;
    case 'channel':
      return `<#${element.channel_id}>`;
    case 'usergroup': {
      const handle = lookup?.groupHandle(element.usergroup_id);
      return handle ? `<!subteam^${element.usergroup_id}|@${handle}>` : `<!subteam^${element.usergroup_id}>`;
    }
    case 'broadcast':
      return `<!${element.range}>`;
    case 'emoji':
      return `:${element.name}${element.skin_tone && element.skin_tone > 1 ? `::skin-tone-${element.skin_tone}` : ''}:`;
    case 'date':
      return `<!date^${element.timestamp}^${element.format}|${escapeText(element.fallback ?? '')}>`;
  }
}

/**
 * Inline elements as mrkdwn. Markers open and close around runs of the same
 * style (`*bold _both_*`), sit next to the words they wrap rather than the
 * spaces around them, and close at line ends, where mrkdwn ends them anyway.
 */
function inlineMrkdwn(elements: RichInline[], lookup: Pick<RichLookup, 'groupHandle'> | undefined): string {
  interface Item {
    marks: StyleName[];
    body: string;
    text: boolean;
  }
  const items: Item[] = [];
  for (const element of elements) {
    const style = element.type === 'date' ? undefined : element.style;
    const marks = STYLES.filter((name) => style?.[name]);
    if (element.type !== 'text') {
      // Inside backticks a mention or link would show as its raw token.
      items.push({ marks: marks.filter((name) => name !== 'code'), body: atom(element, lookup), text: false });
      continue;
    }
    element.text.split('\n').forEach((line, index) => {
      if (index > 0) items.push({ marks: [], body: '\n', text: false });
      if (line) items.push({ marks, body: escapeText(line), text: true });
    });
  }
  let out = '';
  let open: StyleName[] = [];
  let pending = '';
  for (const item of items) {
    // Spaces alone change nothing: they belong to whichever run they sit in.
    const marks = item.text && item.body.trim() === '' ? open : item.marks;
    let keep = 0;
    while (keep < open.length && keep < marks.length && open[keep] === marks[keep]) keep += 1;
    out += open
      .slice(keep)
      .reverse()
      .map((name) => MARKER[name])
      .join('');
    out += pending;
    pending = '';
    open = open.slice(0, keep);
    let body = item.body;
    const opening = marks.slice(keep);
    if (opening.length > 0 && item.text) {
      const lead = /^\s*/.exec(body)![0];
      out += lead;
      body = body.slice(lead.length);
    }
    out += opening.map((name) => MARKER[name]).join('');
    open = [...open, ...opening];
    if (item.text && open.length > 0) {
      const trail = /\s*$/.exec(body)![0];
      body = body.slice(0, body.length - trail.length);
      pending = trail;
    }
    out += body;
  }
  out += open
    .reverse()
    .map((name) => MARKER[name])
    .join('');
  return out + pending;
}

function preText(elements: RichInline[]): string {
  return elements.map((element) => (element.type === 'text' ? element.text : element.type === 'link' ? element.text || element.url : '')).join('');
}

/** The mrkdwn `text` sent with a `rich_text` block: what apps and notifications read. */
export function richTextToMrkdwn(block: RichTextBlock, lookup?: Pick<RichLookup, 'groupHandle'>): string {
  const lines: string[] = [];
  for (const element of block.elements) {
    switch (element.type) {
      case 'rich_text_section':
        lines.push(inlineMrkdwn(element.elements, lookup));
        break;
      case 'rich_text_list': {
        const pad = '    '.repeat(element.indent);
        element.elements.forEach((item, index) => {
          const marker = element.style === 'ordered' ? `${(element.offset ?? 0) + index + 1}.` : BULLETS[element.indent % BULLETS.length];
          lines.push(`${pad}${marker} ${inlineMrkdwn(item.elements, lookup)}`);
        });
        break;
      }
      case 'rich_text_preformatted':
        lines.push(`\`\`\`\n${escapeText(preText(element.elements))}\n\`\`\``);
        break;
      case 'rich_text_quote':
        lines.push(
          inlineMrkdwn(element.elements, lookup)
            .split('\n')
            .map((line) => `&gt; ${line}`)
            .join('\n'),
        );
        break;
    }
  }
  return lines.join('\n');
}

// ── mrkdwn → document ───────────────────────────────────────────────────────

function textNode(text: string, marks: DocMark[]): DocNode {
  return marks.length > 0 ? { type: 'text', text, marks: marks.map((mark) => ({ ...mark })) } : { type: 'text', text };
}

function mentionNode(kind: MentionKind, id: string, label: string, marks: DocMark[]): DocNode {
  const node: DocNode = { type: 'mention', attrs: { kind, id, label } };
  if (marks.length > 0) node.marks = marks.map((mark) => ({ ...mark }));
  return node;
}

function emojiNode(name: string, marks: DocMark[]): DocNode {
  const node: DocNode = { type: 'emoji', attrs: { name } };
  if (marks.length > 0) node.marks = marks.map((mark) => ({ ...mark }));
  return node;
}

/** Join neighbouring text nodes with the same marks, as ProseMirror keeps them. */
function tidy(content: DocNode[]): DocNode[] {
  const out: DocNode[] = [];
  for (const node of content) {
    const last = out[out.length - 1];
    if (node.type === 'text' && !node.text) continue;
    if (node.type === 'text' && last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])) {
      last.text = (last.text ?? '') + (node.text ?? '');
    } else out.push(node);
  }
  return out;
}

function paragraph(content: DocNode[]): DocNode {
  const tidied = tidy(content);
  return tidied.length > 0 ? { type: 'paragraph', content: tidied } : { type: 'paragraph' };
}

function addMark(marks: DocMark[], mark: DocMark): DocMark[] {
  return marks.some((item) => item.type === mark.type) ? marks : [...marks, mark];
}

/** Inline mrkdwn nodes as document lines: each `br` starts a new line. */
function mrkdwnLines(nodes: MrkdwnNode[], lookup: RichLookup): DocNode[][] {
  const lines: DocNode[][] = [[]];
  const visit = (list: MrkdwnNode[], marks: DocMark[]): void => {
    for (const node of list) {
      const line = lines[lines.length - 1]!;
      switch (node.type) {
        case 'text':
          line.push(textNode(node.text, marks));
          break;
        case 'bold':
        case 'italic':
        case 'strike':
          visit(node.children, addMark(marks, { type: node.type }));
          break;
        case 'code':
          line.push(textNode(node.text, addMark(marks, { type: 'code' })));
          break;
        case 'link':
          visit(node.children, addMark(marks, { type: 'link', attrs: { href: node.url } }));
          break;
        case 'user':
          line.push(mentionNode('user', node.id, lookup.userName(node.id) ?? node.label ?? node.id, marks));
          break;
        case 'channel':
          line.push(mentionNode('channel', node.id, lookup.channelName(node.id) ?? node.label ?? node.id, marks));
          break;
        case 'usergroup':
          line.push(mentionNode('usergroup', node.id, node.label?.replace(/^@/, '') || lookup.groupHandle(node.id) || node.id, marks));
          break;
        case 'broadcast':
          line.push(mentionNode('broadcast', node.range, node.range, marks));
          break;
        case 'date':
          line.push(textNode(node.fallback || new Date(node.timestamp * 1000).toISOString(), marks));
          break;
        case 'emoji':
          line.push(lookup.isEmoji(node.name) ? emojiNode(node.name, marks) : textNode(`:${node.name}:`, marks));
          break;
        case 'br':
          lines.push([]);
          break;
        default:
          // Code fences and quotes are blocks; the parser does not put them inside a line.
          break;
      }
    }
  };
  visit(nodes, []);
  return lines;
}

interface ListLine {
  level: number;
  ordered: boolean;
  number: number;
  paragraph: DocNode;
}

const LIST_LINE = /^( *)(?:([•◦▪-])|(\d{1,3})\.) /;

/** A paragraph that starts like a list item (`• `, `- `, `1. `), as the composer writes lists into text. */
function listLine(node: DocNode): ListLine | null {
  const first = node.content?.[0];
  if (node.type !== 'paragraph' || first?.type !== 'text' || first.marks?.length) return null;
  const match = LIST_LINE.exec(first.text ?? '');
  if (!match) return null;
  const rest = (first.text ?? '').slice(match[0].length);
  const content = [...(rest ? [{ ...first, text: rest }] : []), ...(node.content ?? []).slice(1)];
  return {
    level: match[1]!.length === 0 ? 0 : Math.ceil(match[1]!.length / 4),
    ordered: match[3] !== undefined,
    number: match[3] !== undefined ? Number(match[3]) : 1,
    paragraph: paragraph(content),
  };
}

function buildLists(run: ListLine[], level: number): DocNode[] {
  const lists: DocNode[] = [];
  let current: DocNode | null = null;
  let index = 0;
  while (index < run.length) {
    const line = run[index]!;
    if (line.level > level && current) {
      const nested: ListLine[] = [];
      while (index < run.length && run[index]!.level > level) nested.push(run[index++]!);
      const items = current.content!;
      items[items.length - 1]!.content!.push(...buildLists(nested, level + 1));
      continue;
    }
    const type = line.ordered ? 'orderedList' : 'bulletList';
    if (!current || current.type !== type) {
      current = { type, ...(line.ordered && line.number !== 1 ? { attrs: { start: line.number } } : {}), content: [] };
      lists.push(current);
    }
    current.content!.push({ type: 'listItem', content: [line.paragraph] });
    index += 1;
  }
  return lists;
}

function listify(blocks: DocNode[]): DocNode[] {
  const out: DocNode[] = [];
  let index = 0;
  while (index < blocks.length) {
    const run: ListLine[] = [];
    for (let line = listLine(blocks[index]!); line; line = index < blocks.length ? listLine(blocks[index]!) : null) {
      run.push(line);
      index += 1;
    }
    if (run.length > 0) out.push(...buildLists(run, run[0]!.level));
    else out.push(blocks[index++]!);
  }
  return out;
}

/**
 * The document for stored mrkdwn. With `lists`, lines that start like list
 * items become lists again (drafts, and messages without blocks being edited);
 * without, the document says exactly what the text shows.
 */
export function mrkdwnToDoc(mrkdwn: string, lookup: RichLookup, options: { lists?: boolean } = {}): DocNode {
  const blocks: DocNode[] = [];
  let pending: MrkdwnNode[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    for (const line of mrkdwnLines(pending, lookup)) blocks.push(paragraph(line));
    pending = [];
  };
  // The parser already drops the line break on either side of a code fence or quote,
  // so a break found next to one is a blank line the writer left there.
  for (const node of parseMrkdwn(mrkdwn)) {
    if (node.type === 'pre') {
      flush();
      blocks.push(node.text ? { type: 'codeBlock', content: [{ type: 'text', text: node.text }] } : { type: 'codeBlock' });
    } else if (node.type === 'quote') {
      flush();
      blocks.push({ type: 'blockquote', content: mrkdwnLines(node.children, lookup).map(paragraph) });
    } else pending.push(node);
  }
  flush();
  const content = options.lists ? listify(blocks) : blocks;
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] };
}

// ── rich_text → document ────────────────────────────────────────────────────

function marksOf(style: RichStyle | undefined): DocMark[] {
  return STYLES.filter((name) => style?.[name]).map((name) => ({ type: name }));
}

function richLines(elements: RichInline[], lookup: RichLookup): DocNode[][] {
  const lines: DocNode[][] = [[]];
  for (const element of elements) {
    const line = lines[lines.length - 1]!;
    const marks = element.type === 'date' ? [] : marksOf(element.style);
    switch (element.type) {
      case 'text':
        element.text.split('\n').forEach((part, index) => {
          if (index > 0) lines.push([]);
          if (part) lines[lines.length - 1]!.push(textNode(part, marks));
        });
        break;
      case 'link':
        line.push(textNode(element.text || element.url, [...marks, { type: 'link', attrs: { href: element.url } }]));
        break;
      case 'user':
        line.push(mentionNode('user', element.user_id, lookup.userName(element.user_id) ?? element.user_id, marks));
        break;
      case 'channel':
        line.push(mentionNode('channel', element.channel_id, lookup.channelName(element.channel_id) ?? element.channel_id, marks));
        break;
      case 'usergroup':
        line.push(mentionNode('usergroup', element.usergroup_id, lookup.groupHandle(element.usergroup_id) ?? element.usergroup_id, marks));
        break;
      case 'broadcast':
        line.push(mentionNode('broadcast', element.range, element.range, marks));
        break;
      case 'emoji': {
        const name = element.skin_tone && element.skin_tone > 1 ? `${element.name}::skin-tone-${element.skin_tone}` : element.name;
        line.push(emojiNode(name, marks));
        break;
      }
      case 'date':
        line.push(textNode(element.fallback || new Date(element.timestamp * 1000).toISOString(), []));
        break;
    }
  }
  return lines;
}

/** The document for a message's `rich_text` blocks, to edit it as it was written. */
export function richTextToDoc(blocks: RichTextBlock[], lookup: RichLookup): DocNode {
  const content: DocNode[] = [];
  let run: ListLine[] = [];
  const flushRun = (): void => {
    if (run.length > 0) content.push(...buildLists(run, 0));
    run = [];
  };
  for (const block of blocks) {
    for (const element of block.elements ?? []) {
      if (element.type === 'rich_text_list') {
        element.elements.forEach((item, index) => {
          const [first = [], ...rest] = richLines(item.elements ?? [], lookup);
          // Lines after the first stay in the item, joined by spaces: an item is one paragraph here.
          const joined = rest.reduce<DocNode[]>((all, line) => [...all, { type: 'text', text: ' ' }, ...line], first);
          run.push({ level: element.indent ?? 0, ordered: element.style === 'ordered', number: (element.offset ?? 0) + index + 1, paragraph: paragraph(joined) });
        });
        continue;
      }
      flushRun();
      if (element.type === 'rich_text_section') {
        for (const line of richLines(element.elements ?? [], lookup)) content.push(paragraph(line));
      } else if (element.type === 'rich_text_preformatted') {
        const text = preText(element.elements ?? []);
        content.push(text ? { type: 'codeBlock', content: [{ type: 'text', text }] } : { type: 'codeBlock' });
      } else if (element.type === 'rich_text_quote') {
        content.push({ type: 'blockquote', content: richLines(element.elements ?? [], lookup).map(paragraph) });
      }
    }
  }
  flushRun();
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] };
}

// ── Putting it together ─────────────────────────────────────────────────────

export interface Outgoing {
  text: string;
  blocks: RichTextBlock[];
}

/** What to send for a document: mrkdwn and the block. Empty text means nothing to send. */
export function composeRich(doc: DocNode, lookup: RichLookup): Outgoing {
  const block = docToRichText(doc, lookup);
  return block ? { text: richTextToMrkdwn(block, lookup), blocks: [block] } : { text: '', blocks: [] };
}

const NO_NAMES: ComposeLookup = { users: [], channels: [] };

/** What to send from the markup composer: the encoded text as before, and its block. */
export function composeMarkup(typed: string, lookup: RichLookup): Outgoing {
  const text = encodeMessage(typed, lookup.compose ?? NO_NAMES);
  // The names were encoded already; what is left as text stays text.
  const block = text ? docToRichText(mrkdwnToDoc(text, lookup), { ...lookup, compose: undefined }) : null;
  return { text, blocks: block ? [block] : [] };
}

/** The typed form of a document, as the markup composer shows it: kept as the draft. */
export function docToMarkup(doc: DocNode, lookup: RichLookup): string {
  // Names typed out in full read the same either way, so they are not looked up.
  const block = docToRichText(doc, { ...lookup, compose: undefined });
  if (!block) return '';
  return decodeMessage(richTextToMrkdwn(block, lookup), { userName: lookup.userName, channelName: lookup.channelName });
}

/** A typed draft (or a rewrite from writing help) as a document. */
export function markupToDoc(typed: string, lookup: RichLookup): DocNode {
  return mrkdwnToDoc(encodeMessage(typed, lookup.compose ?? NO_NAMES), lookup, { lists: true });
}

/** Whether a message's blocks are only `rich_text`: the kind a person writes, which an edit replaces. */
export function onlyRichText(blocks: unknown): blocks is RichTextBlock[] {
  return Array.isArray(blocks) && blocks.length > 0 && blocks.every((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'rich_text');
}
