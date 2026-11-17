import { useEffect, useState } from 'react';
import { accounts, composeGroups } from './accounts';
import type { ComposeLookup } from './compose';
import { customEmojiUrl, nativeEmoji } from './emoji';
import type { DocNode, RichLookup } from './richtext';
import { conversation, displayName, get } from './store';

/**
 * What the composer and the in-place editor know of the rich editor, which is a
 * chunk of its own (`components/editor/RichInput.tsx`). The chunk starts loading
 * as soon as this module is imported, so it is there by the time a conversation opens.
 */

export type FormatKind = 'bold' | 'italic' | 'strike' | 'code' | 'block' | 'quote' | 'bullet' | 'ordered' | 'link';

export interface RichHandle {
  focus(): void;
  json(): DocNode;
  /** Replace everything, caret at the end, without an undo step or a change event. */
  setContent(doc: DocNode): void;
  isEmpty(): boolean;
  format(kind: Exclude<FormatKind, 'link'>): void;
  active(): Record<FormatKind, boolean>;
  insertText(text: string): void;
  /** Insert mentions or emoji (and a space after), over `range` when given. */
  insertNodes(nodes: DocNode[], range?: { from: number; to: number }): void;
  /** The text before the caret in its line, where that line starts in the document, and whether it is the first line. */
  context(): { text: string; start: number; first: boolean } | null;
  selectedText(): string;
  /** Link the selection (or insert the address), or with an empty address remove the link. */
  setLink(href: string): void;
  /** What Enter does in an ordinary editor (Shift+Enter here). */
  newline(): void;
  element(): HTMLElement | null;
}

export interface RichInputProps {
  /** On the editable element itself: `composer-input` or `edit-input`. */
  className: string;
  wrapClassName?: string;
  label: string;
  placeholder: string;
  initial: DocNode;
  autoFocus?: boolean;
  /** The editable element announces a list of suggestions. */
  autocomplete?: boolean;
  selfId?: string;
  onChange?: () => void;
  onSelect?: () => void;
  /** Return true when the key was handled. */
  onKeyDown?: (event: KeyboardEvent) => boolean;
  onFiles?: (files: File[]) => void;
  onBlur?: () => void;
}

type RichInputComponent = (typeof import('../components/editor/RichInput'))['default'];

let loaded: RichInputComponent | null = null;
let loading: Promise<RichInputComponent> | null = null;

function loadRichInput(): Promise<RichInputComponent> {
  loading ??= import('../components/editor/RichInput').then(
    (module) => (loaded = module.default),
    (error: unknown) => {
      // Offline, or a deploy replaced the chunk: the next composer tries again.
      loading = null;
      throw error;
    },
  );
  return loading;
}

void loadRichInput().catch(() => undefined);

/**
 * The rich editor once its chunk is here (null until then), and whether loading
 * it failed, in which case the markup composer stands in.
 */
export function useRichInput(wanted: boolean): { Input: RichInputComponent | null; failed: boolean } {
  const [, redraw] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!wanted || loaded) return;
    let live = true;
    loadRichInput().then(
      () => live && redraw((count) => count + 1),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [wanted]);
  return { Input: wanted ? loaded : null, failed: wanted && !loaded && failed };
}

/** Whether this person writes with markup (`*bold*` shown as typed) rather than formatting they see. */
export function markupComposer(prefs: Record<string, unknown>): boolean {
  return prefs.compose_markup === true;
}

/** Names people, groups and channels can be typed by. */
export function composeLookup(): ComposeLookup {
  const state = get();
  return {
    users: Object.values(state.users)
      .filter((user) => !user.deleted)
      .map((user) => ({ id: user.id, names: [user.profile.display_name, user.real_name, user.name].filter(Boolean) })),
    channels: [...Object.values(state.channels), ...Object.values(state.others)]
      .filter((channel) => channel.is_channel && channel.name)
      .map((channel) => ({ id: channel.id, name: channel.name! })),
    groups: composeGroups(),
  };
}

/**
 * Everything the conversions in `lib/richtext.ts` need, from the store. Without
 * `names`, names typed out in full are left as typed (drafts, which keep the
 * typed form anyway), which spares matching every name on each keystroke.
 */
export function richLookup(names = true): RichLookup {
  const state = get();
  return {
    compose: names ? composeLookup() : undefined,
    userName: (id) => {
      const user = state.users[id];
      return user ? displayName(user) : undefined;
    },
    channelName: (id) => conversation(state, id)?.name ?? undefined,
    groupHandle: (id) => accounts().usergroups[id]?.handle,
    isEmoji: (name) => nativeEmoji(name) !== null || customEmojiUrl(name.split('::')[0] ?? name, state.emoji) !== null,
    emojiChar: (name) => nativeEmoji(name),
  };
}
