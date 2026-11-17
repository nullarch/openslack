import { parseMrkdwn, type MrkdwnNode } from '@app/shared';

/**
 * Safe HTML for public pages. Everything that came from people is escaped;
 * the only markup produced is what these functions write. Links are limited
 * to http(s) and mailto, and carry rel="nofollow ugc noopener".
 */

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPE[char]!);
}

export function safeUrl(url: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(url.trim()) ? url.trim() : null;
}

/** A small set of common shortcodes; anything else shows as `:name:`. */
const EMOJI: Record<string, string> = {
  smile: '😄', slightly_smiling_face: '🙂', grinning: '😀', joy: '😂', laughing: '😆', wink: '😉', heart: '❤️',
  heart_eyes: '😍', thinking_face: '🤔', thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎', clap: '👏',
  pray: '🙏', raised_hands: '🙌', wave: '👋', ok_hand: '👌', muscle: '💪', eyes: '👀', fire: '🔥', tada: '🎉',
  rocket: '🚀', star: '⭐', sparkles: '✨', white_check_mark: '✅', heavy_check_mark: '✔️', x: '❌', warning: '⚠️',
  bulb: '💡', memo: '📝', calendar: '📅', point_right: '👉', point_up: '☝️', sob: '😭', cry: '😢', sweat_smile: '😅',
  rofl: '🤣', sunglasses: '😎', party_popper: '🎉', coffee: '☕', bug: '🐛', zap: '⚡', lock: '🔒', link: '🔗',
  question: '❓', exclamation: '❗', bangbang: '‼️', 100: '💯', palm_tree: '🌴', headphones: '🎧', ramen: '🍜',
  two: '2️⃣', one: '1️⃣', three: '3️⃣', chart_with_upwards_trend: '📈', hourglass: '⌛', construction: '🚧',
  speech_balloon: '💬', mega: '📣', loudspeaker: '📢', bell: '🔔', books: '📚', package: '📦', gear: '⚙️',
};

export interface RenderLookup {
  user(id: string): string | undefined;
  /** Name of a channel and, when it is public on the web, its page. */
  channel(id: string): { name: string; href: string | null } | undefined;
  customEmoji(name: string): string | undefined;
}

export function emojiHtml(name: string, lookup: RenderLookup): string {
  const base = name.replace(/::skin-tone-\d$/, '');
  const native = EMOJI[base];
  if (native) return `<span class="emoji" title=":${esc(base)}:">${native}</span>`;
  const custom = lookup.customEmoji(base);
  if (custom) return `<img class="emoji" src="${esc(custom)}" alt=":${esc(base)}:" title=":${esc(base)}:" loading="lazy">`;
  return `<span class="emoji-text">:${esc(base)}:</span>`;
}

function nodesHtml(nodes: MrkdwnNode[], lookup: RenderLookup): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
          return esc(node.text);
        case 'bold':
          return `<strong>${nodesHtml(node.children, lookup)}</strong>`;
        case 'italic':
          return `<em>${nodesHtml(node.children, lookup)}</em>`;
        case 'strike':
          return `<del>${nodesHtml(node.children, lookup)}</del>`;
        case 'code':
          return `<code>${esc(node.text)}</code>`;
        case 'pre':
          return `<pre><code>${esc(node.text)}</code></pre>`;
        case 'quote':
          return `<blockquote>${nodesHtml(node.children, lookup)}</blockquote>`;
        case 'link': {
          const href = safeUrl(node.url);
          const inner = nodesHtml(node.children, lookup);
          return href ? `<a href="${esc(href)}" rel="nofollow ugc noopener">${inner}</a>` : inner;
        }
        case 'user':
          return `<span class="mention">@${esc(lookup.user(node.id) ?? node.label ?? 'someone')}</span>`;
        case 'usergroup':
          return `<span class="mention">${esc(node.label ?? '@group')}</span>`;
        case 'channel': {
          const channel = lookup.channel(node.id);
          const name = esc(channel?.name ?? node.label ?? 'channel');
          return channel?.href ? `<a class="mention" href="${esc(channel.href)}">#${name}</a>` : `<span class="mention">#${name}</span>`;
        }
        case 'broadcast':
          return `<span class="mention">@${node.range}</span>`;
        case 'date':
          return `<time datetime="${new Date(node.timestamp * 1000).toISOString()}">${esc(node.fallback || new Date(node.timestamp * 1000).toUTCString())}</time>`;
        case 'emoji':
          return emojiHtml(node.name, lookup);
        case 'br':
          return '<br>';
      }
    })
    .join('');
}

export function mrkdwnHtml(text: string, lookup: RenderLookup): string {
  return nodesHtml(parseMrkdwn(text), lookup);
}

// ── Standard Markdown, as apps and agents send it in `markdown` blocks ──────

/** Emphasis, mentions and emoji on text that is already escaped and holds no markup yet. */
function inlineStyles(escaped: string, lookup: RenderLookup): string {
  let html = escaped;
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/g, '$1<em>$2</em>');
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?])/g, '$1<em>$2</em>');
  html = html.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  html = html.replace(/&lt;@([UW][A-Z0-9]+)(?:\|[^&]*)?&gt;/g, (_all, id: string) => `<span class="mention">@${esc(lookup.user(id) ?? 'someone')}</span>`);
  return html.replace(/:([a-z0-9_+-]+):/g, (_all, name: string) => emojiHtml(name, lookup));
}

function inlineMarkdown(text: string, lookup: RenderLookup): string {
  // Code spans and links are cut out first, so styling never reaches inside a URL or code.
  return text
    .split(/(`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\))/g)
    .map((part) => {
      if (/^`[^`\n]+`$/.test(part)) return `<code>${esc(part.slice(1, -1))}</code>`;
      const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(part);
      if (link) {
        const label = inlineStyles(esc(link[1]), lookup);
        const href = safeUrl(link[2]!);
        return href ? `<a href="${esc(href)}" rel="nofollow ugc noopener">${label}</a>` : label;
      }
      return inlineStyles(esc(part), lookup);
    })
    .join('');
}

export function markdownHtml(text: string, lookup: RenderLookup): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushParagraph = (): void => {
    if (paragraph.length) out.push(`<p>${paragraph.map((line) => inlineMarkdown(line, lookup)).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (list) out.push(`<${list.ordered ? 'ol' : 'ul'}>${list.items.map((item) => `<li>${inlineMarkdown(item, lookup)}</li>`).join('')}</${list.ordered ? 'ol' : 'ul'}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      for (i += 1; i < lines.length && !/^```\s*$/.test(lines[i]!); i += 1) code.push(lines[i]!);
      const body = code
        .map((row) =>
          fence[1] === 'diff' && /^[+-]/.test(row) ? `<span class="${row.startsWith('+') ? 'add' : 'del'}">${esc(row)}</span>` : esc(row),
        )
        .join('\n');
      out.push(`<pre><code>${body}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(6, heading[1]!.length + 2);
      out.push(`<h${level}>${inlineMarkdown(heading[2]!, lookup)}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushParagraph();
      flushList();
      out.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ''), lookup)}</blockquote>`);
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return out.join('');
}

// ── Block Kit, read-only ────────────────────────────────────────────────────

type Loose = Record<string, unknown>;

function textObject(value: unknown, lookup: RenderLookup): string {
  if (!value || typeof value !== 'object') return '';
  const text = value as Loose;
  if (typeof text.text !== 'string') return '';
  return text.type === 'mrkdwn' ? mrkdwnHtml(text.text, lookup) : esc(text.text);
}

function richElements(elements: unknown, lookup: RenderLookup): string {
  if (!Array.isArray(elements)) return '';
  return elements
    .map((raw) => {
      const element = raw as Loose;
      const style = (element.style ?? {}) as Loose;
      let html = '';
      switch (element.type) {
        case 'text':
          html = esc(element.text).replace(/\n/g, '<br>');
          break;
        case 'link': {
          const href = typeof element.url === 'string' ? safeUrl(element.url) : null;
          const label = esc(element.text ?? element.url);
          html = href ? `<a href="${esc(href)}" rel="nofollow ugc noopener">${label}</a>` : label;
          break;
        }
        case 'user':
          html = `<span class="mention">@${esc(lookup.user(String(element.user_id)) ?? 'someone')}</span>`;
          break;
        case 'channel':
          html = `<span class="mention">#${esc(lookup.channel(String(element.channel_id))?.name ?? 'channel')}</span>`;
          break;
        case 'usergroup':
          html = '<span class="mention">@group</span>';
          break;
        case 'broadcast':
          html = `<span class="mention">@${esc(element.range)}</span>`;
          break;
        case 'emoji':
          html = emojiHtml(String(element.name), lookup);
          break;
        default:
          html = '';
      }
      if (style.code) html = `<code>${html}</code>`;
      if (style.bold) html = `<strong>${html}</strong>`;
      if (style.italic) html = `<em>${html}</em>`;
      if (style.strike) html = `<del>${html}</del>`;
      return html;
    })
    .join('');
}

function richText(block: Loose, lookup: RenderLookup): string {
  const parts = Array.isArray(block.elements) ? (block.elements as Loose[]) : [];
  return parts
    .map((part) => {
      switch (part.type) {
        case 'rich_text_section':
          return `<p>${richElements(part.elements, lookup)}</p>`;
        case 'rich_text_preformatted':
          return `<pre><code>${richElements(part.elements, lookup)}</code></pre>`;
        case 'rich_text_quote':
          return `<blockquote>${richElements(part.elements, lookup)}</blockquote>`;
        case 'rich_text_list': {
          const tag = part.style === 'ordered' ? 'ol' : 'ul';
          const items = Array.isArray(part.elements) ? (part.elements as Loose[]) : [];
          return `<${tag}>${items.map((item) => `<li>${richElements(item.elements, lookup)}</li>`).join('')}</${tag}>`;
        }
        default:
          return '';
      }
    })
    .join('');
}

/** Read-only rendering of the blocks a page can show. Interactive parts are left out. */
export function blocksHtml(blocks: unknown, lookup: RenderLookup): string {
  if (!Array.isArray(blocks)) return '';
  return (blocks as Loose[])
    .map((block) => {
      switch (block.type) {
        case 'markdown':
          return typeof block.text === 'string' ? `<div class="md">${markdownHtml(block.text, lookup)}</div>` : '';
        case 'rich_text':
          return richText(block, lookup);
        case 'section': {
          const fields = Array.isArray(block.fields) ? (block.fields as unknown[]).map((field) => `<div>${textObject(field, lookup)}</div>`).join('') : '';
          return `<div class="section">${textObject(block.text, lookup) ? `<p>${textObject(block.text, lookup)}</p>` : ''}${fields ? `<div class="fields">${fields}</div>` : ''}</div>`;
        }
        case 'header':
          return `<h3>${textObject(block.text, lookup)}</h3>`;
        case 'context':
          return `<p class="context">${(Array.isArray(block.elements) ? (block.elements as unknown[]) : []).map((element) => textObject(element, lookup)).join(' · ')}</p>`;
        case 'divider':
          return '<hr>';
        case 'image': {
          const href = typeof block.image_url === 'string' ? safeUrl(block.image_url) : null;
          return href ? `<img class="block-image" src="${esc(href)}" alt="${esc(block.alt_text)}" loading="lazy" referrerpolicy="no-referrer">` : '';
        }
        default:
          return '';
      }
    })
    .join('');
}
