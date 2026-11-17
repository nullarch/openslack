import { Extension, InputRule, markInputRule, Node, textblockTypeInputRule, wrappingInputRule, type Editor } from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';
import { Fragment, Slice } from '@tiptap/pm/model';
import { Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import { EditorContent, useEditor, type UseEditorOptions } from '@tiptap/react';
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { asset } from '../../lib/api';
import { customEmojiUrl, nativeEmoji } from '../../lib/emoji';
import { EMPTY_DOC, type DocNode } from '../../lib/richtext';
import type { FormatKind, RichHandle, RichInputProps } from '../../lib/richInput';
import { get } from '../../lib/store';

/**
 * The editable part of the rich composer and of editing a message in place:
 * TipTap (ProseMirror) with the formatting a message can carry. The schema's
 * names are what `lib/richtext.ts` reads. Loaded as its own chunk, which it
 * shares with the canvas editor.
 */

const PREFIX: Record<string, string> = { user: '@', usergroup: '@', broadcast: '@', channel: '#' };

/** An inline chip for a person, group, `@here` or channel, picked from the suggestions. */
const Mention = Node.create<{ selfId: string }>({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addOptions() {
    return { selfId: '' };
  },
  addAttributes() {
    return {
      kind: { default: 'user', rendered: false, parseHTML: (element) => element.getAttribute('data-mention') ?? 'user' },
      id: { default: '', rendered: false, parseHTML: (element) => element.getAttribute('data-id') ?? '' },
      label: { default: '', rendered: false, parseHTML: (element) => element.getAttribute('data-label') ?? element.textContent?.replace(/^[@#]/, '') ?? '' },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-mention]' }];
  },
  renderHTML({ node }) {
    const kind = String(node.attrs.kind);
    const classes = ['mention', `is-${kind}`, kind === 'broadcast' || node.attrs.id === this.options.selfId ? 'is-me' : ''].filter(Boolean).join(' ');
    return ['span', { class: classes, 'data-mention': kind, 'data-id': node.attrs.id, 'data-label': node.attrs.label }, `${PREFIX[kind] ?? '@'}${node.attrs.label}`];
  },
  renderText({ node }) {
    return `${PREFIX[String(node.attrs.kind)] ?? '@'}${node.attrs.label}`;
  },
});

/** An emoji, shown as itself (or its custom image) and sent as `:name:`. */
const Emoji = Node.create({
  name: 'emoji',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return { name: { default: '', rendered: false, parseHTML: (element) => element.getAttribute('data-emoji') ?? '' } };
  },
  parseHTML() {
    return [{ tag: 'span[data-emoji]' }, { tag: 'img[data-emoji]' }];
  },
  renderHTML({ node }) {
    const name = String(node.attrs.name);
    const url = customEmojiUrl(name.split('::')[0] ?? name, get().emoji);
    if (url) return ['img', { class: 'emoji emoji-custom', src: asset(url), alt: `:${name}:`, title: `:${name}:`, draggable: 'false', 'data-emoji': name }];
    const char = nativeEmoji(name);
    return ['span', { class: 'emoji', 'data-emoji': name, title: `:${name}:` }, char ?? `:${name}:`];
  },
  renderText({ node }) {
    const name = String(node.attrs.name);
    return nativeEmoji(name) ?? `:${name}:`;
  },
});

function knownEmoji(name: string): boolean {
  return nativeEmoji(name) !== null || customEmojiUrl(name.split('::')[0] ?? name, get().emoji) !== null;
}

/**
 * Slack's markup converts as it is typed: `*bold*`, `_italic_`, `~strike~`,
 * ```` ``` ````, `• `, and a known `:shortcode:` becomes its emoji. Slack's shortcuts.
 */
const Markup = Extension.create({
  name: 'markup',
  addInputRules() {
    const { marks, nodes } = this.editor.schema;
    return [
      markInputRule({ find: /(?:^|\s)(\*([^*\s](?:[^*]*[^*\s])?)\*)$/, type: marks.bold! }),
      markInputRule({ find: /(?:^|\s)(_([^_\s](?:[^_]*[^_\s])?)_)$/, type: marks.italic! }),
      markInputRule({ find: /(?:^|\s)(~([^~\s](?:[^~]*[^~\s])?)~)$/, type: marks.strike! }),
      textblockTypeInputRule({ find: /^```$/, type: nodes.codeBlock! }),
      wrappingInputRule({ find: /^\s*•\s$/, type: nodes.bulletList! }),
      new InputRule({
        find: /(?<![\p{L}\p{N}]):([a-z0-9_+'-]+(?:::skin-tone-[2-6])?):$/iu,
        handler: ({ state, range, match }) => {
          const name = match[1]!.toLowerCase();
          if (!knownEmoji(name)) return null;
          state.tr.replaceWith(range.from, range.to, nodes.emoji!.create({ name }));
        },
      }),
    ];
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-x': () => this.editor.commands.toggleStrike(),
      'Mod-Shift-c': () => this.editor.commands.toggleCode(),
      'Mod-Alt-Shift-c': () => this.editor.commands.toggleCodeBlock(),
      'Mod-Shift-9': () => this.editor.commands.toggleBlockquote(),
    };
  },
});

function toJSON(editor: Editor): DocNode {
  return editor.getJSON() as DocNode;
}

/** A blank last line in a code block: the second new line there leaves the block, as in a list or quote. */
function leaveCode(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.parent.type.name !== 'codeBlock') return false;
  if ($from.parentOffset !== $from.parent.content.size || !$from.parent.textContent.endsWith('\n')) return false;
  return editor
    .chain()
    .command(({ tr }) => {
      tr.delete($from.pos - 1, $from.pos);
      return true;
    })
    .exitCode()
    .run();
}

/**
 * Take the browser's selection when it is ahead of the editor's. ProseMirror
 * learns of a selection made outside it (select-all from a script, keys pressed
 * in quick succession) from `selectionchange`, which the browser may deliver
 * after the next key; that key must act on what is selected on screen.
 */
function catchUpSelection(view: EditorView): void {
  const { selection, doc } = view.state;
  // Selections only the editor can draw (everything, a node) are its own; an input
  // method composing a character (Hangul, kana) owns the selection until it is done.
  if (!(selection instanceof TextSelection) || view.composing) return;
  const dom = view.dom.ownerDocument.getSelection();
  if (!dom?.anchorNode || !dom.focusNode || !view.dom.contains(dom.anchorNode) || !view.dom.contains(dom.focusNode)) return;
  try {
    const anchor = view.posAtDOM(dom.anchorNode, dom.anchorOffset);
    const head = view.posAtDOM(dom.focusNode, dom.focusOffset);
    if (anchor === selection.anchor && head === selection.head) return;
    const next = TextSelection.between(doc.resolve(anchor), doc.resolve(head));
    if (!next.eq(selection)) view.dispatch(view.state.tr.setSelection(next));
  } catch {
    // A position the document does not have: leave the selection as it is.
  }
}

const RichInput = forwardRef<RichHandle, RichInputProps>(function RichInput(props, ref) {
  const latest = useRef(props);
  latest.current = props;

  // Built once: what changes between renders (callbacks) is read through `latest`, so the
  // editor is never reconfigured while someone types.
  const options = useRef<UseEditorOptions | null>(null);
  options.current ??= {
    extensions: [
      StarterKit.configure({
        heading: false,
        horizontalRule: false,
        underline: false,
        dropcursor: false,
        gapcursor: false,
        code: { HTMLAttributes: { class: 'code-inline' } },
        codeBlock: { exitOnTripleEnter: false, HTMLAttributes: { class: 'code-block' } },
        blockquote: { HTMLAttributes: { class: 'quote' } },
        bulletList: { HTMLAttributes: { class: 'rich-list' } },
        orderedList: { HTMLAttributes: { class: 'rich-list' } },
        link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https', HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null } },
      }),
      Placeholder.configure({ placeholder: props.placeholder }),
      Mention.configure({ selfId: props.selfId ?? '' }),
      Emoji,
      Markup,
    ],
    // Slack's markup instead of Markdown's: the defaults (`**bold**`, `*italic*`) are left off.
    enableInputRules: ['markup', 'code', 'blockquote', 'bulletList', 'orderedList'],
    // Pasted text keeps its asterisks and underscores (code, file names); only addresses become links.
    enablePasteRules: ['link'],
    content: props.initial,
    editorProps: {
      attributes: {
        class: props.className,
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': props.label,
        ...(props.placeholder ? { 'aria-placeholder': props.placeholder } : {}),
        ...(props.autocomplete ? { 'aria-autocomplete': 'list' } : {}),
      },
      handleKeyDown: (view, event) => {
        catchUpSelection(view);
        return latest.current.onKeyDown?.(event) ?? false;
      },
      handleDOMEvents: {
        // ProseMirror swallows Escape. Unless used here (closing the suggestions, leaving an
        // edit), it belongs to what is around the editor: a thread panel, a dialog, the drawer.
        keydown: (_view, event) => {
          if (event.key !== 'Escape') return false;
          if (latest.current.onKeyDown?.(event)) event.preventDefault();
          return true;
        },
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length === 0) return false;
        latest.current.onFiles?.(files);
        return true;
      },
      // Files dropped here are attachments; the conversation around picks them up.
      handleDrop: (_view, event) => (event.dataTransfer?.files.length ?? 0) > 0,
      // One paragraph per line, blank lines kept (ProseMirror would fold them).
      clipboardTextParser: (text, _context, _plain, view) => {
        const { schema } = view.state;
        const lines = text.replace(/\r\n?/g, '\n').split('\n');
        const paragraphs = lines.map((line) => schema.nodes.paragraph!.create(null, line ? schema.text(line) : null));
        return new Slice(Fragment.from(paragraphs), 1, 1);
      },
    },
    onUpdate: () => latest.current.onChange?.(),
    onSelectionUpdate: () => latest.current.onSelect?.(),
    onBlur: () => latest.current.onBlur?.(),
  };
  const editor = useEditor(options.current);

  useImperativeHandle(
    ref,
    (): RichHandle => ({
      focus: () => {
        editor.commands.focus();
      },
      json: () => toJSON(editor),
      setContent: (doc) => {
        let node;
        try {
          node = editor.schema.nodeFromJSON(doc);
        } catch {
          node = editor.schema.nodeFromJSON(EMPTY_DOC);
        }
        // Not an edit to undo back into: a sent message, a draft from elsewhere, a rewrite.
        const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, node.content).setMeta('addToHistory', false).setMeta('preventUpdate', true);
        tr.setSelection(Selection.atEnd(tr.doc));
        editor.view.dispatch(tr);
      },
      isEmpty: () => editor.isEmpty,
      format: (kind: FormatKind) => {
        const chain = editor.chain().focus();
        if (kind === 'bold') chain.toggleBold();
        else if (kind === 'italic') chain.toggleItalic();
        else if (kind === 'strike') chain.toggleStrike();
        else if (kind === 'code') chain.toggleCode();
        else if (kind === 'block') chain.toggleCodeBlock();
        else if (kind === 'quote') chain.toggleBlockquote();
        else if (kind === 'bullet') chain.toggleBulletList();
        else if (kind === 'ordered') chain.toggleOrderedList();
        chain.run();
      },
      active: () => ({
        bold: editor.isActive('bold'),
        italic: editor.isActive('italic'),
        strike: editor.isActive('strike'),
        code: editor.isActive('code'),
        block: editor.isActive('codeBlock'),
        quote: editor.isActive('blockquote'),
        bullet: editor.isActive('bulletList'),
        ordered: editor.isActive('orderedList'),
        link: editor.isActive('link'),
      }),
      insertText: (text) => {
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            tr.insertText(text);
            return true;
          })
          .run();
      },
      insertNodes: (nodes, range) => {
        const content = [...nodes, { type: 'text', text: ' ' }];
        const chain = editor.chain().focus();
        if (range) chain.insertContentAt(range, content);
        else chain.insertContent(content);
        chain.run();
      },
      context: () => {
        const { selection } = editor.state;
        if (!selection.empty) return null;
        const { $from } = selection;
        if (!$from.parent.isTextblock || $from.parent.type.spec.code) return null;
        return {
          text: $from.parent.textBetween(0, $from.parentOffset, undefined, '￼'),
          start: $from.start(),
          first: $from.depth === 1 && $from.index(0) === 0,
        };
      },
      selectedText: () => {
        const { from, to } = editor.state.selection;
        return editor.state.doc.textBetween(from, to, ' ');
      },
      setLink: (href) => {
        const { empty } = editor.state.selection;
        if (!href) {
          editor.chain().focus().extendMarkRange('link').unsetLink().run();
          return;
        }
        if (empty && !editor.isActive('link')) {
          editor
            .chain()
            .focus()
            .insertContent([
              { type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] },
              { type: 'text', text: ' ' },
            ])
            .run();
          return;
        }
        editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
      },
      newline: () => {
        // What Enter does in an ordinary editor: a new list item, a new line in code, out of
        // an empty list item or quote line, or a new paragraph.
        if (editor.commands.splitListItem('listItem')) return;
        if (leaveCode(editor)) return;
        if (editor.commands.newlineInCode()) return;
        if (editor.commands.createParagraphNear()) return;
        if (editor.commands.liftEmptyBlock()) return;
        editor.commands.splitBlock();
      },
      element: () => (editor.view.dom as HTMLElement | undefined) ?? null,
    }),
    [editor],
  );

  // Focus straight away rather than through TipTap's `autofocus`, which waits for a timer:
  // keys typed before it fires (the browser runs input first) would have the caret moved under them.
  useLayoutEffect(() => {
    if (!props.autoFocus) return;
    editor.view.dispatch(editor.state.tr.setSelection(Selection.atEnd(editor.state.doc)));
    editor.view.focus();
    // On mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  return <EditorContent editor={editor} className={props.wrapClassName} />;
});

export default RichInput;
