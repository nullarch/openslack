/**
 * Standard emoji by shortcode. The data set is large, so it loads as its own
 * chunk; until then shortcodes render as text.
 */

interface EmojiEntry {
  id: string;
  name: string;
  keywords: string[];
  skins: { unified: string; native: string }[];
}

export interface EmojiData {
  emojis: Record<string, EmojiEntry>;
  aliases: Record<string, string>;
  categories: { id: string; emojis: string[] }[];
}

let data: EmojiData | null = null;
let loading: Promise<void> | null = null;

export function loadEmoji(): Promise<void> {
  loading ??= import('@emoji-mart/data').then((module) => {
    data = module.default as EmojiData;
  });
  return loading;
}

export function emojiData(): EmojiData | null {
  return data;
}

function entry(base: string): EmojiEntry | undefined {
  if (!data) return undefined;
  return data.emojis[base] ?? data.emojis[data.aliases[base] ?? ''];
}

/** The character for a shortcode such as `tada` or `+1::skin-tone-3`, or null when it is not standard. */
export function nativeEmoji(name: string): string | null {
  const [base = '', tone] = name.split('::skin-tone-');
  const found = entry(base);
  if (!found) return null;
  const skin = tone ? found.skins[Number(tone) - 1] : undefined;
  return (skin ?? found.skins[0])?.native ?? null;
}

/** Follow custom-emoji aliases to an image URL. */
export function customEmojiUrl(name: string, custom: Record<string, string>): string | null {
  let value = custom[name];
  for (let hops = 0; value && hops < 4; hops += 1) {
    if (!value.startsWith('alias:')) return value;
    const target = value.slice('alias:'.length);
    if (custom[target] === undefined) return null;
    value = custom[target];
  }
  return null;
}

export interface EmojiMatch {
  name: string;
  native?: string;
  url?: string;
}

const FREQUENT = ['+1', 'tada', 'heart', 'joy', 'eyes', 'pray', 'rocket', 'white_check_mark', 'fire', 'thinking_face', 'wave', '100'];

/** Shortcode completion: custom emoji first, then prefix matches, then matches anywhere in the name or keywords. */
export function searchEmoji(query: string, custom: Record<string, string>, limit = 8): EmojiMatch[] {
  const needle = query.toLowerCase();
  const out: EmojiMatch[] = [];
  const seen = new Set<string>();
  const add = (match: EmojiMatch): void => {
    if (seen.has(match.name) || out.length >= limit) return;
    seen.add(match.name);
    out.push(match);
  };
  for (const name of Object.keys(custom)) {
    if (name.includes(needle)) {
      const url = customEmojiUrl(name, custom);
      if (url) add({ name, url });
    }
  }
  if (!data) return out;
  for (const name of FREQUENT) {
    if (name.startsWith(needle)) add({ name, native: nativeEmoji(name) ?? undefined });
  }
  const entries = Object.values(data.emojis);
  for (const item of entries) {
    if (out.length >= limit) break;
    if (item.id.startsWith(needle)) add({ name: item.id, native: item.skins[0]?.native });
  }
  for (const item of entries) {
    if (out.length >= limit) break;
    if (item.id.includes(needle) || item.keywords.some((keyword) => keyword.startsWith(needle))) {
      add({ name: item.id, native: item.skins[0]?.native });
    }
  }
  return out;
}
