import { createHash } from 'node:crypto';
import * as Y from 'yjs';

/**
 * Canvas content lives in a Yjs XML fragment named `default`, in the shape
 * the editor's collaboration binding (y-prosemirror, used by TipTap) writes:
 * block nodes are XML elements named after the editor's node types
 * (`paragraph`, `heading` with `level`, `bulletList` > `listItem`, `taskList` >
 * `taskItem` with `checked`, `blockquote`, `codeBlock`, `horizontalRule`,
 * `image`, `table` > `tableRow` > `tableHeader`/`tableCell`), text runs are
 * XML text with marks as formatting attributes (`bold`, `italic`, `strike`,
 * `code`, `link` with `href`), and mentions are inline `mention` elements.
 *
 * The API speaks Markdown in Slack's canvas dialect (`![](@U123)` mentions a
 * person, `![](#C123)` a channel); this module converts both ways.
 */

export const FIELD = 'default';

type Marks = Record<string, Record<string, unknown>>;

type Inline =
  | { type: 'text'; text: string; marks: Marks }
  | { type: 'mention'; id: string; char: '@' | '#'; label: string }
  | { type: 'hardBreak' };

type Block =
  | { type: 'paragraph'; inline: Inline[] }
  | { type: 'heading'; level: number; inline: Inline[] }
  | { type: 'bulletList' | 'orderedList'; items: Block[][] }
  | { type: 'taskList'; items: { checked: boolean; blocks: Block[] }[] }
  | { type: 'blockquote'; blocks: Block[] }
  | { type: 'codeBlock'; language: string | null; text: string }
  | { type: 'horizontalRule' }
  | { type: 'image'; src: string; alt: string }
  | { type: 'table'; rows: Inline[][][] };

export interface Labels {
  user(id: string): string;
  channel(id: string): string;
}

// ── Markdown → blocks ───────────────────────────────────────────────────────

const LIST_LINE = /^(\s*)([-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/;

function parseInline(source: string, labels: Labels): Inline[] {
  const out: Inline[] = [];
  const push = (text: string, marks: Marks): void => {
    if (!text) return;
    const last = out.at(-1);
    if (last && last.type === 'text' && JSON.stringify(last.marks) === JSON.stringify(marks)) last.text += text;
    else out.push({ type: 'text', text, marks: { ...marks } });
  };
  const walk = (text: string, marks: Marks): void => {
    let i = 0;
    let buffer = '';
    const flush = (): void => {
      push(buffer, marks);
      buffer = '';
    };
    while (i < text.length) {
      const rest = text.slice(i);
      let match: RegExpExecArray | null;
      if ((match = /^`([^`]+)`/.exec(rest))) {
        flush();
        push(match[1]!, { ...marks, code: {} });
      } else if ((match = /^!\[[^\]]*\]\(([@#])([A-Z0-9]+)\)/.exec(rest))) {
        flush();
        const char = match[1] as '@' | '#';
        const id = match[2]!;
        out.push({ type: 'mention', id, char, label: char === '@' ? labels.user(id) : labels.channel(id) });
      } else if ((match = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/.exec(rest))) {
        flush();
        out.push({ type: 'mention', id: match[1]!, char: '@', label: labels.user(match[1]!) });
      } else if ((match = /^<#([CG][A-Z0-9]+)(?:\|[^>]*)?>/.exec(rest))) {
        flush();
        out.push({ type: 'mention', id: match[1]!, char: '#', label: labels.channel(match[1]!) });
      } else if ((match = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
        flush();
        walk(match[1]!, { ...marks, link: { href: match[2]! } });
      } else if ((match = /^<(https?:\/\/[^|>\s]+)(?:\|([^>]+))?>/.exec(rest))) {
        flush();
        walk(match[2] ?? match[1]!, { ...marks, link: { href: match[1]! } });
      } else if ((match = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest))) {
        flush();
        walk(match[2]!, { ...marks, bold: {} });
      } else if ((match = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) {
        flush();
        walk(match[1]!, { ...marks, strike: {} });
      } else if ((match = /^([*_])(?=\S)([\s\S]*?\S)\1(?![*_\w])/.exec(rest)) && (i === 0 || !/\w/.test(text[i - 1]!))) {
        flush();
        walk(match[2]!, { ...marks, italic: {} });
      } else {
        buffer += text[i];
        i += 1;
        continue;
      }
      i += match[0].length;
    }
    flush();
  };
  walk(source, {});
  return out;
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

export function parseMarkdown(markdown: string, labels: Labels): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    let match: RegExpExecArray | null;
    if ((match = /^\s*```\s*([\w+-]*)\s*$/.exec(line))) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i += 1;
      blocks.push({ type: 'codeBlock', language: match[1] || null, text: body.join('\n') });
      continue;
    }
    if ((match = /^(#{1,6})\s+(.*)$/.exec(line))) {
      blocks.push({ type: 'heading', level: Math.min(3, match[1]!.length), inline: parseInline(match[2]!.trim(), labels) });
      i += 1;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'horizontalRule' });
      i += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) inner.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'blockquote', blocks: parseMarkdown(inner.join('\n'), labels) });
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const rows: Inline[][][] = [parseTableRow(line).map((cell) => parseInline(cell, labels))];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) rows.push(parseTableRow(lines[i++]!).map((cell) => parseInline(cell, labels)));
      blocks.push({ type: 'table', rows });
      continue;
    }
    if ((match = /^!\[([^\]]*)\]\(((?:https?:\/\/|\/)[^)\s]+)\)\s*$/.exec(line.trim()))) {
      blocks.push({ type: 'image', alt: match[1]!, src: match[2]! });
      i += 1;
      continue;
    }
    if (LIST_LINE.test(line)) {
      const group: string[] = [];
      while (i < lines.length && (LIST_LINE.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && group.length > 0))) group.push(lines[i++]!);
      blocks.push(...parseList(group, labels));
      continue;
    }
    blocks.push({ type: 'paragraph', inline: parseInline(line.trim(), labels) });
    i += 1;
  }
  return blocks;
}

/** A run of list lines: top-level items at the smallest indent, deeper lines nested in the item above. */
function parseList(group: string[], labels: Labels): Block[] {
  const indentOf = (line: string): number => /^(\s*)/.exec(line)![1]!.length;
  const base = Math.min(...group.map(indentOf));
  const out: Block[] = [];
  let i = 0;
  while (i < group.length) {
    const match = LIST_LINE.exec(group[i]!)!;
    const task = match[3] !== undefined;
    const ordered = /\d/.test(match[2]!);
    const type: 'bulletList' | 'orderedList' | 'taskList' = task ? 'taskList' : ordered ? 'orderedList' : 'bulletList';
    const items: { checked: boolean; blocks: Block[] }[] = [];
    while (i < group.length) {
      const line = group[i]!;
      const current = LIST_LINE.exec(line);
      if (!current || indentOf(line) !== base) break;
      const currentType = current[3] !== undefined ? 'taskList' : /\d/.test(current[2]!) ? 'orderedList' : 'bulletList';
      if (currentType !== type) break;
      const nested: string[] = [];
      i += 1;
      while (i < group.length && indentOf(group[i]!) > base) nested.push(group[i++]!);
      const blocks: Block[] = [{ type: 'paragraph', inline: parseInline(current[4]!.trim(), labels) }];
      if (nested.length) blocks.push(...parseList(nested, labels));
      items.push({ checked: /x/i.test(current[3] ?? ''), blocks });
    }
    if (type === 'taskList') out.push({ type, items });
    else out.push({ type, items: items.map((item) => item.blocks) });
  }
  return out;
}

// ── Blocks → Yjs ────────────────────────────────────────────────────────────

function inlineToY(inline: Inline[]): (Y.XmlText | Y.XmlElement)[] {
  const out: (Y.XmlText | Y.XmlElement)[] = [];
  let text: Y.XmlText | null = null;
  let length = 0;
  for (const part of inline) {
    if (part.type === 'text') {
      if (!text) {
        text = new Y.XmlText();
        length = 0;
        out.push(text);
      }
      // Always pass the marks (even none): without them Yjs carries over the formatting before the insert.
      text.insert(length, part.text, { ...part.marks });
      length += part.text.length;
    } else {
      text = null;
      const element = new Y.XmlElement(part.type);
      if (part.type === 'mention') {
        element.setAttribute('id', part.id);
        element.setAttribute('label', part.label);
        element.setAttribute('mentionSuggestionChar', part.char);
      }
      out.push(element);
    }
  }
  return out;
}

function element(name: string, attrs: Record<string, unknown>, children: (Y.XmlText | Y.XmlElement)[]): Y.XmlElement {
  const el = new Y.XmlElement(name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value as string);
  if (children.length) el.insert(0, children);
  return el;
}

function paragraph(inline: Inline[]): Y.XmlElement {
  return element('paragraph', {}, inlineToY(inline));
}

export function blocksToY(blocks: Block[]): Y.XmlElement[] {
  return blocks.map((block): Y.XmlElement => {
    switch (block.type) {
      case 'paragraph':
        return paragraph(block.inline);
      case 'heading':
        return element('heading', { level: block.level }, inlineToY(block.inline));
      case 'bulletList':
      case 'orderedList':
        return element(
          block.type,
          block.type === 'orderedList' ? { start: 1 } : {},
          block.items.map((item) => element('listItem', {}, blocksToY(item))),
        );
      case 'taskList':
        return element('taskList', {}, block.items.map((item) => element('taskItem', { checked: item.checked }, blocksToY(item.blocks))));
      case 'blockquote':
        return element('blockquote', {}, blocksToY(block.blocks.length ? block.blocks : [{ type: 'paragraph', inline: [] }]));
      case 'codeBlock': {
        const text = new Y.XmlText();
        if (block.text) text.insert(0, block.text);
        return element('codeBlock', { language: block.language }, [text]);
      }
      case 'horizontalRule':
        return element('horizontalRule', {}, []);
      case 'image':
        return element('image', { src: block.src, alt: block.alt, title: null }, []);
      case 'table':
        return element(
          'table',
          {},
          block.rows.map((row, index) =>
            element(
              'tableRow',
              {},
              row.map((cell) => element(index === 0 ? 'tableHeader' : 'tableCell', { colspan: 1, rowspan: 1, colwidth: null }, [paragraph(cell)])),
            ),
          ),
        );
    }
  });
}

export function markdownToY(markdown: string, labels: Labels): Y.XmlElement[] {
  return blocksToY(parseMarkdown(markdown, labels));
}

// ── Yjs → Markdown and plain text ───────────────────────────────────────────

function inlineMarkdown(el: Y.XmlElement): string {
  let out = '';
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as { insert: unknown; attributes?: Marks }[]) {
        if (typeof op.insert !== 'string') continue;
        let text = op.insert;
        const marks = op.attributes ?? {};
        if (marks.code) text = `\`${text}\``;
        else {
          if (marks.bold) text = `**${text}**`;
          if (marks.italic) text = `_${text}_`;
          if (marks.strike) text = `~~${text}~~`;
        }
        if (marks.link && typeof marks.link.href === 'string') text = `[${text}](${marks.link.href})`;
        out += text;
      }
    } else if (child instanceof Y.XmlElement) {
      if (child.nodeName === 'mention') {
        const char = child.getAttribute('mentionSuggestionChar') === '#' ? '#' : '@';
        out += `![](${char}${String(child.getAttribute('id') ?? '')})`;
      } else if (child.nodeName === 'hardBreak') out += '\n';
      else out += inlineMarkdown(child);
    }
  }
  return out;
}

function isChecked(value: unknown): boolean {
  return value === true || value === 'true';
}

function blockMarkdown(el: Y.XmlElement, indent = ''): string[] {
  const name = el.nodeName;
  const children = el.toArray().filter((child): child is Y.XmlElement => child instanceof Y.XmlElement);
  switch (name) {
    case 'paragraph':
      return [indent + inlineMarkdown(el)];
    case 'heading':
      return [`${'#'.repeat(Math.max(1, Math.min(3, Number(el.getAttribute('level') ?? 1))))} ${inlineMarkdown(el)}`];
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return children.flatMap((item, index) => {
        const marker =
          name === 'orderedList' ? `${index + 1}.` : name === 'taskList' ? `- [${isChecked(item.getAttribute('checked')) ? 'x' : ' '}]` : '-';
        const parts = item.toArray().filter((child): child is Y.XmlElement => child instanceof Y.XmlElement);
        const [first, ...rest] = parts;
        const lines = [`${indent}${marker} ${first ? inlineMarkdown(first) : ''}`];
        for (const part of rest) lines.push(...blockMarkdown(part, `${indent}  `));
        return lines;
      });
    case 'blockquote':
      return children.flatMap((child) => blockMarkdown(child)).map((line) => `> ${line}`);
    case 'codeBlock': {
      const language = el.getAttribute('language');
      return [`\`\`\`${typeof language === 'string' ? language : ''}`, el.toArray().map((child) => (child instanceof Y.XmlText ? child.toString() : '')).join(''), '```'];
    }
    case 'horizontalRule':
      return ['---'];
    case 'image':
      return [`![${String(el.getAttribute('alt') ?? '')}](${String(el.getAttribute('src') ?? '')})`];
    case 'table': {
      const rows = children.map((row) =>
        row
          .toArray()
          .filter((cell): cell is Y.XmlElement => cell instanceof Y.XmlElement)
          .map((cell) =>
            cell
              .toArray()
              .filter((child): child is Y.XmlElement => child instanceof Y.XmlElement)
              .map((child) => inlineMarkdown(child))
              .join(' ')
              .replace(/\|/g, '\\|'),
          ),
      );
      if (rows.length === 0) return [];
      const width = Math.max(...rows.map((row) => row.length));
      const line = (cells: string[]): string => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
      return [line(rows[0]!), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)];
    }
    default:
      return children.flatMap((child) => blockMarkdown(child, indent));
  }
}

export function fragmentToMarkdown(fragment: Y.XmlFragment): string {
  return fragment
    .toArray()
    .filter((child): child is Y.XmlElement => child instanceof Y.XmlElement)
    .map((block) => blockMarkdown(block).join('\n'))
    .join('\n\n');
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inlineHtml(el: Y.XmlElement): string {
  let out = '';
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as { insert: unknown; attributes?: Marks }[]) {
        if (typeof op.insert !== 'string') continue;
        const marks = op.attributes ?? {};
        let text = escapeHtml(op.insert);
        if (marks.code) text = `<code>${text}</code>`;
        if (marks.bold) text = `<strong>${text}</strong>`;
        if (marks.italic) text = `<em>${text}</em>`;
        if (marks.strike) text = `<s>${text}</s>`;
        const href = marks.link?.href;
        if (typeof href === 'string' && /^(https?:|mailto:|\/)/i.test(href)) text = `<a href="${escapeHtml(href)}">${text}</a>`;
        out += text;
      }
    } else if (child instanceof Y.XmlElement) {
      if (child.nodeName === 'mention') {
        const char = child.getAttribute('mentionSuggestionChar') === '#' ? '#' : '@';
        out += `<span data-type="mention" data-id="${escapeHtml(String(child.getAttribute('id') ?? ''))}">${char}${escapeHtml(String(child.getAttribute('label') ?? ''))}</span>`;
      } else if (child.nodeName === 'hardBreak') out += '<br>';
      else out += inlineHtml(child);
    }
  }
  return out;
}

function blockHtml(el: Y.XmlElement): string {
  const children = (): string =>
    el
      .toArray()
      .filter((child): child is Y.XmlElement => child instanceof Y.XmlElement)
      .map(blockHtml)
      .join('');
  switch (el.nodeName) {
    case 'paragraph':
      return `<p>${inlineHtml(el)}</p>`;
    case 'heading': {
      const level = Math.max(1, Math.min(3, Number(el.getAttribute('level') ?? 1)));
      return `<h${level}>${inlineHtml(el)}</h${level}>`;
    }
    case 'bulletList':
      return `<ul>${children()}</ul>`;
    case 'orderedList':
      return `<ol>${children()}</ol>`;
    case 'taskList':
      return `<ul data-type="taskList">${children()}</ul>`;
    case 'listItem':
      return `<li>${children()}</li>`;
    case 'taskItem':
      return `<li data-checked="${isChecked(el.getAttribute('checked'))}">${children()}</li>`;
    case 'blockquote':
      return `<blockquote>${children()}</blockquote>`;
    case 'codeBlock':
      return `<pre><code>${escapeHtml(el.toArray().map((child) => (child instanceof Y.XmlText ? child.toString() : '')).join(''))}</code></pre>`;
    case 'horizontalRule':
      return '<hr>';
    case 'image':
      return `<img src="${escapeHtml(String(el.getAttribute('src') ?? ''))}" alt="${escapeHtml(String(el.getAttribute('alt') ?? ''))}">`;
    case 'table':
      return `<table>${children()}</table>`;
    case 'tableRow':
      return `<tr>${children()}</tr>`;
    case 'tableHeader':
      return `<th>${children()}</th>`;
    case 'tableCell':
      return `<td>${children()}</td>`;
    default:
      return children();
  }
}

/** The canvas as HTML, for `canvases.getContent` with `content_type: html`. */
export function fragmentToHtml(fragment: Y.XmlFragment): string {
  return fragment
    .toArray()
    .filter((child): child is Y.XmlElement => child instanceof Y.XmlElement)
    .map(blockHtml)
    .join('\n');
}

/** Words only, for search and summaries: no Markdown syntax, mentions as their labels. */
export function fragmentToPlain(fragment: Y.XmlFragment | Y.XmlElement): string {
  const parts: string[] = [];
  const visit = (node: Y.XmlElement | Y.XmlText | Y.XmlFragment): void => {
    if (node instanceof Y.XmlText) {
      for (const op of node.toDelta() as { insert: unknown }[]) if (typeof op.insert === 'string') parts.push(op.insert);
      return;
    }
    if (node instanceof Y.XmlElement && node.nodeName === 'mention') {
      parts.push(`${node.getAttribute('mentionSuggestionChar') === '#' ? '#' : '@'}${String(node.getAttribute('label') ?? '')}`);
      return;
    }
    for (const child of node.toArray()) visit(child as Y.XmlElement | Y.XmlText);
    if (node instanceof Y.XmlElement && !['mention', 'hardBreak'].includes(node.nodeName)) parts.push('\n');
  };
  visit(fragment);
  return parts.join('').replace(/\n{2,}/g, '\n').trim();
}

/** Plain text of one Y text run, without the XML formatting `toString()` adds. */
export function textOf(el: Y.XmlElement): string {
  return fragmentToPlain(el);
}

/** People mentioned anywhere in the canvas. */
export function mentionedUsers(fragment: Y.XmlFragment): string[] {
  const found = new Set<string>();
  const visit = (node: Y.XmlElement | Y.XmlFragment): void => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'mention' && child.getAttribute('mentionSuggestionChar') !== '#') {
        const id = child.getAttribute('id');
        if (typeof id === 'string') found.add(id);
      } else visit(child);
    }
  };
  visit(fragment);
  return [...found];
}

// ── Sections ────────────────────────────────────────────────────────────────

export interface Section {
  id: string;
  index: number;
  kind: 'h1' | 'h2' | 'h3' | 'other';
  text: string;
}

/**
 * Top-level blocks with ids that stay the same while the block's text does:
 * a hash of its kind and text, plus a counter for identical blocks. Ids follow
 * Slack's `temp:C:` shape.
 */
export function sections(fragment: Y.XmlFragment): Section[] {
  const seen = new Map<string, number>();
  return fragment
    .toArray()
    .filter((child): child is Y.XmlElement => child instanceof Y.XmlElement)
    .map((block, index) => {
      const level = Number(block.getAttribute('level') ?? 0);
      const kind = block.nodeName === 'heading' ? (level <= 1 ? 'h1' : level === 2 ? 'h2' : 'h3') : 'other';
      const text = fragmentToPlain(block);
      const key = `${kind}\u0000${text}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      const hash = createHash('sha1').update(`${key}\u0000${n}`).digest('hex').slice(0, 24).toUpperCase();
      return { id: `temp:C:${hash}`, index, kind, text };
    });
}
