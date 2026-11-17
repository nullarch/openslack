import { safeInsets } from '../../lib/safeArea';
import { Extension, mergeAttributes, type AnyExtension, type ChainedCommands } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import Mention from '@tiptap/extension-mention';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { PluginKey } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionOptions, type SuggestionProps } from '@tiptap/suggestion';
import { nativeEmoji, searchEmoji } from '../../lib/emoji';
import { displayName, get } from '../../lib/store';
import { T } from './text';

/**
 * The editor's schema and helpers, shared by the live canvas and read-only
 * version previews. Node and mark names are the server's contract (see
 * `apps/server/src/docs/markdown.ts`), so keep them in step.
 */

export interface MenuEntry {
  id: string;
  label: string;
  hint?: string;
}

/** A small keyboard-driven popup for `@`, `#`, `:` and `/` suggestions, without a positioning library. */
export function suggestionPopup<T extends MenuEntry>(empty: string): SuggestionOptions<T>['render'] {
  return () => {
    let element: HTMLDivElement | null = null;
    let items: T[] = [];
    let index = 0;
    let choose: (item: T) => void = () => {};
    const draw = (): void => {
      if (!element) return;
      element.replaceChildren();
      if (items.length === 0) {
        const note = document.createElement('div');
        note.className = 'suggest-empty';
        note.textContent = empty;
        element.append(note);
        return;
      }
      items.forEach((item, position) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `suggest-item ${position === index ? 'is-on' : ''}`;
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(position === index));
        const label = document.createElement('span');
        label.textContent = item.label;
        button.append(label);
        if (item.hint) {
          const hint = document.createElement('span');
          hint.className = 'suggest-hint';
          hint.textContent = item.hint;
          button.append(hint);
        }
        button.addEventListener('mousedown', (event) => {
          event.preventDefault();
          choose(item);
        });
        element!.append(button);
      });
    };
    const place = (rect: DOMRect | null | undefined): void => {
      if (!element || !rect) return;
      const safe = safeInsets();
      const width = Math.min(280, window.innerWidth - 16);
      element.style.left = `${Math.max(8 + safe.left, Math.min(rect.left, window.innerWidth - width - 8 - safe.right))}px`;
      const below = rect.bottom + 6;
      const height = element.offsetHeight || 200;
      element.style.top = `${below + height > window.innerHeight - safe.bottom ? Math.max(8 + safe.top, rect.top - height - 6) : below}px`;
    };
    const take = (props: SuggestionProps<T>): void => {
      items = props.items;
      choose = (item) => props.command(item);
      index = 0;
      draw();
      place(props.clientRect?.());
    };
    return {
      onStart: (props: SuggestionProps<T>) => {
        element = document.createElement('div');
        element.className = 'suggest-menu';
        element.setAttribute('role', 'listbox');
        document.body.append(element);
        take(props);
      },
      onUpdate: take,
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        if (event.key === 'Escape') {
          element?.remove();
          element = null;
          return true;
        }
        if (!items.length) return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          index = (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
          draw();
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          choose(items[index]!);
          return true;
        }
        return false;
      },
      onExit: () => {
        element?.remove();
        element = null;
      },
    };
  };
}

function people(query: string): MenuEntry[] {
  const q = query.toLowerCase();
  return Object.values(get().users)
    .filter((user) => !user.deleted && [user.name, user.real_name, user.profile.display_name].some((value) => value?.toLowerCase().includes(q)))
    .slice(0, 8)
    .map((user) => ({ id: user.id, label: displayName(user), hint: user.name }));
}

function channels(query: string): MenuEntry[] {
  const q = query.toLowerCase();
  const state = get();
  return [...Object.values(state.channels), ...Object.values(state.others)]
    .filter((conv) => conv.is_channel && !conv.is_archived && (conv.name ?? '').toLowerCase().includes(q))
    .slice(0, 8)
    .map((conv) => ({ id: conv.id, label: conv.name ?? conv.id }));
}

interface SlashItem extends MenuEntry {
  run: (chain: ChainedCommands) => void;
}

export function slashItems(onImage: () => void): SlashItem[] {
  const t = T.toolbar;
  return [
    { id: 'p', label: t.paragraph, run: (c) => c.setParagraph().run() },
    { id: 'h1', label: t.h1, hint: '#', run: (c) => c.setHeading({ level: 1 }).run() },
    { id: 'h2', label: t.h2, hint: '##', run: (c) => c.setHeading({ level: 2 }).run() },
    { id: 'h3', label: t.h3, hint: '###', run: (c) => c.setHeading({ level: 3 }).run() },
    { id: 'bullet', label: t.bullet, hint: '-', run: (c) => c.toggleBulletList().run() },
    { id: 'ordered', label: t.ordered, hint: '1.', run: (c) => c.toggleOrderedList().run() },
    { id: 'check', label: t.checklist, hint: '[ ]', run: (c) => c.toggleTaskList().run() },
    { id: 'quote', label: t.quote, hint: '>', run: (c) => c.toggleBlockquote().run() },
    { id: 'code', label: t.codeBlock, hint: '```', run: (c) => c.toggleCodeBlock().run() },
    { id: 'divider', label: t.divider, hint: '---', run: (c) => c.setHorizontalRule().run() },
    { id: 'table', label: t.table, run: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    {
      id: 'image',
      label: t.image,
      run: (c) => {
        c.run();
        onImage();
      },
    },
  ];
}

/** `/` opens a menu of blocks. */
function slashCommands(onImage: () => void): AnyExtension {
  return Extension.create({
    name: 'slashCommands',
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem>({
          editor: this.editor,
          char: '/',
          pluginKey: new PluginKey('slashCommands'),
          allowSpaces: false,
          startOfLine: false,
          items: ({ query }) => slashItems(onImage).filter((item) => item.label.toLowerCase().includes(query.toLowerCase()) || item.id.startsWith(query.toLowerCase())),
          command: ({ editor, range, props }) => props.run(editor.chain().focus().deleteRange(range)),
          render: suggestionPopup<SlashItem>(T.noPeopleMatch),
        }),
      ];
    },
  });
}

/** `:smile` suggests emoji and inserts the character itself. */
function emojiSuggestions(): AnyExtension {
  return Extension.create({
    name: 'emojiSuggestions',
    addProseMirrorPlugins() {
      return [
        Suggestion<MenuEntry>({
          editor: this.editor,
          char: ':',
          pluginKey: new PluginKey('emojiSuggestions'),
          items: ({ query }) =>
            query.length < 2
              ? []
              : searchEmoji(query, {}, 8)
                  .filter((match) => match.native)
                  .map((match) => ({ id: match.name, label: `${match.native} :${match.name}:` })),
          command: ({ editor, range, props }) => {
            editor
              .chain()
              .focus()
              .deleteRange(range)
              .insertContent(nativeEmoji(props.id) ?? `:${props.id}:`)
              .run();
          },
          render: suggestionPopup<MenuEntry>(''),
        }),
      ];
    },
  });
}

export interface KitOptions {
  live: boolean;
  selfId: string;
  placeholder?: string;
  onImage?: () => void;
}

/** Everything but collaboration: the schema plus, for the live editor, the typing helpers. */
export function editorKit(options: KitOptions): AnyExtension[] {
  const mention = Mention.configure({
    HTMLAttributes: { class: 'mention' },
    renderHTML: ({ node, options: mentionOptions }) => {
      const char = String(node.attrs.mentionSuggestionChar ?? '@');
      const classes = ['mention', char === '#' ? 'is-channel' : 'is-person', node.attrs.id === options.selfId ? 'is-me' : ''].filter(Boolean).join(' ');
      return ['span', mergeAttributes(mentionOptions.HTMLAttributes, { class: classes, 'data-id': node.attrs.id, 'data-mention-suggestion-char': char }), `${char}${node.attrs.label ?? node.attrs.id}`];
    },
    suggestions: options.live
      ? [
          { char: '@', items: ({ query }) => people(query), render: suggestionPopup<MenuEntry>(T.noPeopleMatch) },
          { char: '#', items: ({ query }) => channels(query), render: suggestionPopup<MenuEntry>(T.noChannelsMatch) },
        ]
      : [],
  });
  const kit: AnyExtension[] = [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // Collaboration brings its own undo, which only undoes your own changes.
      undoRedo: false,
      link: { openOnClick: !options.live, autolink: true, defaultProtocol: 'https', HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' } },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Image.configure({ inline: false, allowBase64: false }),
    mention,
  ];
  if (options.live) {
    kit.push(slashCommands(options.onImage ?? (() => {})), emojiSuggestions());
  }
  return kit;
}
