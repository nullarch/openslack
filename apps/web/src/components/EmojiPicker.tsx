import Picker from '@emoji-mart/react';
import { useEffect, useMemo, useRef } from 'react';
import { asset } from '../lib/api';
import { customEmojiUrl, emojiData } from '../lib/emoji';
import { useStore } from '../lib/store';
import { resolvedTheme } from '../lib/theme';
import { S } from '../strings';

interface Picked {
  id: string;
  skin?: number;
  native?: string;
}

/**
 * The picker library marks its category buttons and emoji buttons with states
 * (`aria-selected`, positions in the set) that a plain button cannot carry,
 * and its styles depend on them. Rather than remove them, give the elements the
 * roles those states belong to: category tabs, and per category a listbox of
 * options named by its heading. Its own live region already reads out the emoji
 * the arrow keys reach from the search field.
 */
function describe(root: ShadowRoot): void {
  if (!root.querySelector('style[data-a11y]')) {
    // The search field's clear button is a 14px target; give it the 24px WCAG 2.5.8 asks for.
    const style = document.createElement('style');
    style.dataset.a11y = '';
    style.textContent = '.search .delete { box-sizing: content-box; padding: 5px; margin-right: -5px; }';
    root.append(style);
  }
  const search = root.querySelector<HTMLInputElement>('input[type="search"]');
  if (search && !search.hasAttribute('aria-label')) search.setAttribute('aria-label', search.placeholder);
  const tabs = root.querySelectorAll<HTMLElement>('#nav button');
  const bar = tabs[0]?.parentElement;
  if (bar && bar.getAttribute('role') !== 'tablist') {
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', S.a11y.emojiCategories);
  }
  for (const tab of tabs) if (tab.getAttribute('role') !== 'tab') tab.setAttribute('role', 'tab');
  for (const category of root.querySelectorAll<HTMLElement>('.category')) {
    const grid = category.children[1] as HTMLElement | undefined;
    if (!grid) continue;
    if (grid.getAttribute('role') !== 'listbox') grid.setAttribute('role', 'listbox');
    const name = category.children[0]?.textContent?.trim() || S.a11y.emojiResults;
    if (grid.getAttribute('aria-label') !== name) grid.setAttribute('aria-label', name);
    for (const button of grid.querySelectorAll<HTMLElement>('button:not([role])')) button.setAttribute('role', 'option');
  }
}

/**
 * The full emoji picker. It is its own chunk: this module pulls in the picker
 * library, which is only needed once someone opens it.
 */
export default function EmojiPicker({ onPick }: { onPick: (name: string) => void }) {
  const custom = useStore((state) => state.emoji);
  const categories = useMemo(() => {
    const emojis = Object.keys(custom)
      .map((name) => ({ name, url: customEmojiUrl(name, custom) }))
      .filter((item): item is { name: string; url: string } => item.url !== null)
      .map((item) => ({ id: item.name, name: item.name, keywords: [item.name], skins: [{ src: asset(item.url) }] }));
    return emojis.length > 0 ? [{ id: 'custom', name: S.admin.emoji, emojis }] : [];
  }, [custom]);

  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = wrapper.current;
    if (!host) return;
    let inner: MutationObserver | null = null;
    const attach = (): boolean => {
      const root = host.querySelector('em-emoji-picker')?.shadowRoot;
      if (!root) return false;
      describe(root);
      inner = new MutationObserver(() => describe(root));
      inner.observe(root, { childList: true, subtree: true });
      return true;
    };
    if (attach()) return () => inner?.disconnect();
    const outer = new MutationObserver(() => {
      if (attach()) outer.disconnect();
    });
    outer.observe(host, { childList: true, subtree: true });
    return () => {
      outer.disconnect();
      inner?.disconnect();
    };
  }, []);

  return (
    <div ref={wrapper} className="emoji-picker-host">
    <Picker
      data={emojiData()}
      custom={categories}
      theme={resolvedTheme()}
      autoFocus
      previewPosition="none"
      skinTonePosition="search"
      maxFrequentRows={2}
      onEmojiSelect={(emoji: Picked) => {
        // Skin 1 is the default tone; Slack names tones 2–6.
        onPick(emoji.skin && emoji.skin > 1 && emoji.native ? `${emoji.id}::skin-tone-${emoji.skin}` : emoji.id);
      }}
    />
    </div>
  );
}
