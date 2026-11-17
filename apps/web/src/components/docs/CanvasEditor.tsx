import type { FileObject } from '@app/shared';
import { Extension } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import Placeholder from '@tiptap/extension-placeholder';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, yDocToProsemirrorJSON, ySyncPluginKey } from '@tiptap/y-tiptap';
import {
  AtSign,
  Bold,
  CheckSquare,
  Code,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  MessageSquarePlus,
  Minus,
  Pilcrow,
  Quote,
  Redo2,
  Smile,
  Strikethrough,
  Table as TableIcon,
  Undo2,
  WifiOff,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { attempt, errorText, go, setPanel as setSidePanel, toast } from '../../lib/actions';
import { asset, call, uploadFile } from '../../lib/api';
import { personColor, useDocs } from '../../lib/docs';
import { nativeEmoji } from '../../lib/emoji';
import { displayName, get, useStore } from '../../lib/store';
import { relative } from '../../lib/time';
import { T } from './text';
import { promptDialog } from '../dialogs/confirm';
import { Avatar, Button, IconButton, Modal, Popover, Spinner } from '../ui';
import { editorKit } from './editorKit';
import { formatDateTime } from '../../lib/time';

const EmojiPicker = lazy(() => import('../EmojiPicker'));

export type CanvasPanel = 'comments' | 'versions' | null;

interface Session {
  doc: Y.Doc;
  provider: WebsocketProvider;
}

interface Anchor {
  from: unknown;
  to: unknown;
}

interface Comment {
  id: string;
  root_id: string | null;
  user: string;
  text: string;
  quote: string;
  anchor: Anchor | null;
  created: number;
  resolved: boolean;
  resolved_by: string | null;
}

// ── Comment highlights ──────────────────────────────────────────────────────

const commentsKey = new PluginKey<DecorationSet>('canvasComments');

/** Where a comment's anchor is now, after everything people typed since. */
function anchorRange(state: EditorState, anchor: Anchor | null): { from: number; to: number } | null {
  if (!anchor) return null;
  const sync = ySyncPluginKey.getState(state);
  const binding = sync?.binding;
  if (!binding) return null;
  try {
    const from = relativePositionToAbsolutePosition(binding.doc, binding.type, Y.createRelativePositionFromJSON(anchor.from), binding.mapping);
    const to = relativePositionToAbsolutePosition(binding.doc, binding.type, Y.createRelativePositionFromJSON(anchor.to), binding.mapping);
    if (from === null || to === null || to <= from) return null;
    return { from, to };
  } catch {
    return null;
  }
}

/** Underline the text open comments are about; clicking it opens the thread. */
function commentHighlights(read: () => Comment[], onOpen: (id: string) => void): Extension {
  return Extension.create({
    name: 'canvasComments',
    addProseMirrorPlugins() {
      const build = (state: EditorState): DecorationSet => {
        const decorations: Decoration[] = [];
        for (const comment of read()) {
          if (comment.root_id || comment.resolved) continue;
          const range = anchorRange(state, comment.anchor);
          if (range) decorations.push(Decoration.inline(range.from, range.to, { class: 'comment-mark', 'data-comment': comment.id }, { comment: comment.id }));
        }
        return DecorationSet.create(state.doc, decorations);
      };
      return [
        new Plugin<DecorationSet>({
          key: commentsKey,
          state: {
            init: (_, state) => build(state),
            apply: (tr, value, _old, state) => (tr.docChanged || tr.getMeta(commentsKey) ? build(state) : value.map(tr.mapping, tr.doc)),
          },
          props: {
            decorations: (state) => commentsKey.getState(state),
            handleClick: (view, pos) => {
              const found = commentsKey.getState(view.state)?.find(pos, pos)[0];
              const id = (found?.spec as { comment?: string } | undefined)?.comment;
              if (id) onOpen(id);
              return false;
            },
          },
        }),
      ];
    },
  });
}

// ── Connection ──────────────────────────────────────────────────────────────

function useSession(id: string): Session | null {
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    const doc = new Y.Doc();
    const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/canvas`;
    const provider = new WebsocketProvider(url, id, doc, { maxBackoffTime: 4000, disableBc: true });
    setSession({ doc, provider });
    return () => {
      provider.destroy();
      doc.destroy();
      setSession(null);
    };
  }, [id]);
  return session;
}

function useConnection(session: Session): { synced: boolean; online: boolean } {
  const [synced, setSynced] = useState(session.provider.synced);
  const [online, setOnline] = useState(session.provider.wsconnected);
  useEffect(() => {
    const onSync = (value: boolean): void => {
      if (value) setSynced(true);
    };
    const onStatus = ({ status }: { status: string }): void => setOnline(status === 'connected');
    session.provider.on('sync', onSync);
    session.provider.on('status', onStatus);
    return () => {
      session.provider.off('sync', onSync);
      session.provider.off('status', onStatus);
    };
  }, [session]);
  return { synced, online };
}

interface Present {
  id: string;
  name: string;
  color: string;
}

function usePresence(session: Session): Present[] {
  const [people, setPeople] = useState<Present[]>([]);
  useEffect(() => {
    const awareness = session.provider.awareness;
    const update = (): void => {
      const seen = new Map<string, Present>();
      awareness.getStates().forEach((state, clientId) => {
        const user = state.user as Present | undefined;
        if (!user?.id || clientId === awareness.clientID) return;
        seen.set(user.id, user);
      });
      setPeople([...seen.values()]);
    };
    update();
    awareness.on('change', update);
    return () => awareness.off('change', update);
  }, [session]);
  return people;
}

// ── Toolbar ─────────────────────────────────────────────────────────────────

function Tool({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className={`tool ${active ? 'is-on' : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Toolbar({ editor, onImage, onComment }: { editor: Editor; onImage: () => void; onComment: () => void }) {
  const t = T.toolbar;
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      p: e.isActive('paragraph'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      quote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      table: e.isActive('table'),
    }),
  });
  const [emoji, setEmoji] = useState(false);
  const emojiButton = useRef<HTMLSpanElement>(null);
  const chain = () => editor.chain().focus();
  const link = async (): Promise<void> => {
    if (state.link) {
      chain().unsetLink().run();
      return;
    }
    const href = await promptDialog({ title: t.link, label: t.linkPrompt, initial: 'https://' });
    if (!href?.trim()) return;
    const url = /^[a-z]+:/i.test(href.trim()) ? href.trim() : `https://${href.trim()}`;
    if (editor.state.selection.empty) chain().insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).run();
    else chain().setLink({ href: url }).run();
  };
  return (
    <div className="canvas-toolbar" role="toolbar" aria-label={T.canvas}>
      <Tool label={t.undo} onClick={() => chain().undo().run()}>
        <Undo2 size={16} />
      </Tool>
      <Tool label={t.redo} onClick={() => chain().redo().run()}>
        <Redo2 size={16} />
      </Tool>
      <span className="tool-sep" />
      <Tool label={t.paragraph} active={state.p} onClick={() => chain().setParagraph().run()}>
        <Pilcrow size={16} />
      </Tool>
      <Tool label={t.h1} active={state.h1} onClick={() => chain().toggleHeading({ level: 1 }).run()}>
        <Heading1 size={16} />
      </Tool>
      <Tool label={t.h2} active={state.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()}>
        <Heading2 size={16} />
      </Tool>
      <Tool label={t.h3} active={state.h3} onClick={() => chain().toggleHeading({ level: 3 }).run()}>
        <Heading3 size={16} />
      </Tool>
      <span className="tool-sep" />
      <Tool label={t.bold} active={state.bold} onClick={() => chain().toggleBold().run()}>
        <Bold size={16} />
      </Tool>
      <Tool label={t.italic} active={state.italic} onClick={() => chain().toggleItalic().run()}>
        <Italic size={16} />
      </Tool>
      <Tool label={t.strike} active={state.strike} onClick={() => chain().toggleStrike().run()}>
        <Strikethrough size={16} />
      </Tool>
      <Tool label={t.code} active={state.code} onClick={() => chain().toggleCode().run()}>
        <Code size={16} />
      </Tool>
      <Tool label={t.link} active={state.link} onClick={() => void link()}>
        <Link2 size={16} />
      </Tool>
      <span className="tool-sep" />
      <Tool label={t.bullet} active={state.bullet} onClick={() => chain().toggleBulletList().run()}>
        <List size={16} />
      </Tool>
      <Tool label={t.ordered} active={state.ordered} onClick={() => chain().toggleOrderedList().run()}>
        <ListOrdered size={16} />
      </Tool>
      <Tool label={t.checklist} active={state.task} onClick={() => chain().toggleTaskList().run()}>
        <CheckSquare size={16} />
      </Tool>
      <Tool label={t.quote} active={state.quote} onClick={() => chain().toggleBlockquote().run()}>
        <Quote size={16} />
      </Tool>
      <Tool label={t.codeBlock} active={state.codeBlock} onClick={() => chain().toggleCodeBlock().run()}>
        <Code2 size={16} />
      </Tool>
      <Tool label={t.divider} onClick={() => chain().setHorizontalRule().run()}>
        <Minus size={16} />
      </Tool>
      <Tool label={t.table} active={state.table} onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
        <TableIcon size={16} />
      </Tool>
      <Tool label={t.image} onClick={onImage}>
        <ImagePlus size={16} />
      </Tool>
      <span ref={emojiButton}>
        <Tool label={t.emoji} onClick={() => setEmoji(true)}>
          <Smile size={16} />
        </Tool>
      </span>
      <Tool label={t.mention} onClick={() => chain().insertContent(' @').run()}>
        <AtSign size={16} />
      </Tool>
      <span className="tool-sep" />
      <Tool label={t.comment} onClick={onComment}>
        <MessageSquarePlus size={16} />
      </Tool>
      {state.table ? (
        <span className="table-tools">
          <Button size="sm" variant="ghost" onClick={() => chain().addRowAfter().run()}>
            {t.addRow}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => chain().addColumnAfter().run()}>
            {t.addColumn}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => chain().deleteRow().run()}>
            {t.deleteRow}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => chain().deleteColumn().run()}>
            {t.deleteColumn}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => chain().deleteTable().run()}>
            {t.deleteTable}
          </Button>
        </span>
      ) : null}
      {emoji ? (
        <Popover anchor={emojiButton.current} onClose={() => setEmoji(false)} className="emoji-popover">
          <Suspense fallback={<Spinner />}>
            <EmojiPicker
              onPick={(name) => {
                setEmoji(false);
                chain()
                  .insertContent(nativeEmoji(name) ?? `:${name}:`)
                  .run();
              }}
            />
          </Suspense>
        </Popover>
      ) : null}
    </div>
  );
}

// ── Comments ────────────────────────────────────────────────────────────────

function CommentBox({ placeholder, onSend, autoFocus }: { placeholder: string; onSend: (text: string) => Promise<unknown>; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (): Promise<void> => {
    if (!text.trim()) return;
    setBusy(true);
    const ok = await attempt(() => onSend(text.trim()));
    setBusy(false);
    if (ok !== undefined) setText('');
  };
  return (
    <form
      className="comment-box"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <textarea
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        rows={2}
        autoFocus={autoFocus}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <Button type="submit" size="sm" variant="primary" busy={busy} disabled={!text.trim()}>
        {T.reply}
      </Button>
    </form>
  );
}

function CommentThread({
  root,
  replies,
  focused,
  canDelete,
  onSelect,
  onReply,
  onResolve,
  onDelete,
}: {
  root: Comment;
  replies: Comment[];
  focused: boolean;
  canDelete: (comment: Comment) => boolean;
  onSelect: () => void;
  onReply: (text: string) => Promise<unknown>;
  onResolve: (resolved: boolean) => void;
  onDelete: (comment: Comment) => void;
}) {
  const users = useStore((state) => state.users);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [focused]);
  return (
    <article ref={ref} className={`comment-thread ${root.resolved ? 'is-resolved' : ''} ${focused ? 'is-focused' : ''}`} data-thread={root.id}>
      {root.quote ? (
        <button type="button" className="comment-quote" onClick={onSelect}>
          {root.quote}
        </button>
      ) : null}
      {[root, ...replies].map((comment) => (
        <div key={comment.id} className="comment" data-comment-id={comment.id}>
          <Avatar user={users[comment.user]} size={24} />
          <div className="comment-body">
            <div className="comment-meta">
              <strong>{displayName(users[comment.user])}</strong>
              <time>{relative(String(comment.created))}</time>
              {canDelete(comment) ? (
                <button type="button" className="link-btn comment-delete" onClick={() => onDelete(comment)}>
                  {T.deleteComment}
                </button>
              ) : null}
            </div>
            <p>{comment.text}</p>
          </div>
        </div>
      ))}
      <div className="comment-actions">
        {root.resolved ? (
          <span className="tag">
            {T.resolved}
            {root.resolved_by ? ` · ${displayName(users[root.resolved_by])}` : ''}
          </span>
        ) : null}
        <span className="composer-spacer" />
        <Button size="sm" variant="ghost" onClick={() => onResolve(!root.resolved)}>
          {root.resolved ? T.reopen : T.resolve}
        </Button>
      </div>
      {!root.resolved ? <CommentBox placeholder={T.replyPlaceholder} onSend={onReply} /> : null}
    </article>
  );
}

function CommentsPanel({
  id,
  editor,
  comments,
  draft,
  focus,
  canWrite,
  isOwner,
  onDraftDone,
  onClose,
}: {
  id: string;
  editor: Editor;
  comments: Comment[];
  draft: { quote: string; anchor: Anchor } | null;
  focus: string | null;
  canWrite: boolean;
  isOwner: boolean;
  onDraftDone: () => void;
  onClose: () => void;
}) {
  const self = useStore((state) => state.self?.id ?? '');
  const [showResolved, setShowResolved] = useState(false);
  const roots = comments.filter((comment) => !comment.root_id && (showResolved || !comment.resolved));
  const select = (comment: Comment): void => {
    const range = anchorRange(editor.state, comment.anchor);
    if (range) editor.chain().focus().setTextSelection(range).scrollIntoView().run();
  };
  return (
    <aside className="canvas-side" aria-label={T.comments}>
      <header className="canvas-side-head">
        <h2>{T.comments}</h2>
        <label className="toggle-label">
          <input type="checkbox" checked={showResolved} onChange={(event) => setShowResolved(event.target.checked)} />
          {T.showResolved}
        </label>
        <IconButton label={T.close} onClick={onClose}>
          ×
        </IconButton>
      </header>
      <div className="canvas-side-scroll">
        {draft ? (
          <article className="comment-thread is-draft">
            <p className="comment-quote">{draft.quote}</p>
            <CommentBox
              autoFocus
              placeholder={T.commentPlaceholder}
              onSend={async (text) => {
                await call('client.canvases.comments.add', { canvas_id: id, text, quote: draft.quote, anchor: draft.anchor });
                onDraftDone();
              }}
            />
          </article>
        ) : null}
        {roots.length === 0 && !draft ? <p className="view-empty">{T.noComments}</p> : null}
        {roots.map((root) => (
          <CommentThread
            key={root.id}
            root={root}
            focused={focus === root.id}
            replies={comments.filter((comment) => comment.root_id === root.id)}
            canDelete={(comment) => comment.user === self || isOwner}
            onSelect={() => select(root)}
            onReply={(text) => call('client.canvases.comments.add', { canvas_id: id, text, root_id: root.id })}
            onResolve={(resolved) => void attempt(() => call('client.canvases.comments.resolve', { canvas_id: id, comment_id: root.id, resolved }))}
            onDelete={(comment) => void attempt(() => call('client.canvases.comments.delete', { canvas_id: id, comment_id: comment.id }))}
          />
        ))}
      </div>
    </aside>
  );
}

// ── Versions ────────────────────────────────────────────────────────────────

interface Version {
  id: string;
  title: string;
  created: number;
  created_by: string;
  label: string;
}

function VersionPreview({ id, version, canWrite, onClose }: { id: string; version: Version; canWrite: boolean; onClose: () => void }) {
  const self = useStore((state) => state.self?.id ?? '');
  const [content, setContent] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    call('client.canvases.versions.get', { canvas_id: id, version_id: version.id })
      .then((result) => {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, Uint8Array.from(atob(String(result.version.state)), (char) => char.charCodeAt(0)));
        const json = yDocToProsemirrorJSON(doc, 'default');
        doc.destroy();
        if (live) setContent(json);
      })
      .catch((error: unknown) => toast(errorText(error), 'error'));
    return () => {
      live = false;
    };
  }, [id, version.id]);
  const preview = useEditor({ editable: false, extensions: editorKit({ live: false, selfId: self }), content: content ?? undefined }, [content]);
  return (
    <Modal
      title={`${T.preview} · ${version.label || relative(String(version.created))}`}
      onClose={onClose}
      width={820}
      className="version-modal"
      footer={
        <>
          <Button onClick={onClose}>{T.close}</Button>
          {canWrite ? (
            <Button
              variant="primary"
              busy={busy}
              onClick={() => {
                setBusy(true);
                void attempt(() => call('client.canvases.versions.restore', { canvas_id: id, version_id: version.id })).then((ok) => {
                  setBusy(false);
                  if (ok === undefined) return;
                  toast(T.restored);
                  onClose();
                });
              }}
            >
              {T.restore}
            </Button>
          ) : null}
        </>
      }
    >
      {content ? <EditorContent editor={preview} className="canvas-content is-preview" /> : <Spinner />}
    </Modal>
  );
}

function VersionsPanel({ id, canWrite, onClose }: { id: string; canWrite: boolean; onClose: () => void }) {
  const users = useStore((state) => state.users);
  const version = useDocs((state) => state.version[id] ?? 0);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [open, setOpen] = useState<Version | null>(null);
  const load = (): void => {
    call('client.canvases.versions.list', { canvas_id: id })
      .then((result) => setVersions(result.versions as Version[]))
      .catch(() => setVersions([]));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [id, version]);
  return (
    <aside className="canvas-side" aria-label={T.versions}>
      <header className="canvas-side-head">
        <h2>{T.versions}</h2>
        <IconButton label={T.close} onClick={onClose}>
          ×
        </IconButton>
      </header>
      <div className="canvas-side-scroll">
        {canWrite ? (
          <Button
            size="sm"
            onClick={() =>
              void promptDialog({ title: T.saveVersion, label: T.versionLabel, initial: '', confirmLabel: T.saveVersion }).then((label) => {
                if (label === null) return;
                void attempt(() => call('client.canvases.versions.save', { canvas_id: id, label: label.trim() })).then((ok) => {
                  if (ok === undefined) return;
                  toast(T.versionSaved);
                  load();
                });
              })
            }
          >
            {T.saveVersion}
          </Button>
        ) : null}
        {versions === null ? <Spinner /> : null}
        {versions?.length === 0 ? <p className="view-empty">{T.noVersions}</p> : null}
        <ol className="version-list">
          {versions?.map((entry) => (
            <li key={entry.id}>
              <button type="button" className="version-item" data-version={entry.id} onClick={() => setOpen(entry)}>
                <strong>{entry.label === 'Before restore' ? T.beforeRestore : entry.label || relative(String(entry.created))}</strong>
                <span>
                  {displayName(users[entry.created_by])} · {formatDateTime(entry.created)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      {open ? <VersionPreview id={id} version={open} canWrite={canWrite} onClose={() => setOpen(null)} /> : null}
    </aside>
  );
}

// ── The editor ──────────────────────────────────────────────────────────────

function LiveEditor({
  id,
  session,
  canWrite,
  canComment,
  isOwner,
  panel,
  onPanel,
}: {
  id: string;
  session: Session;
  canWrite: boolean;
  canComment: boolean;
  isOwner: boolean;
  panel: CanvasPanel;
  onPanel: (panel: CanvasPanel) => void;
}) {
  const self = useStore((state) => state.self);
  const version = useDocs((state) => state.version[id] ?? 0);
  const lastChange = useDocs((state) => state.lastChange[id]);
  const { synced, online } = useConnection(session);
  const people = usePresence(session);
  const [comments, setComments] = useState<Comment[]>([]);
  const commentsRef = useRef<Comment[]>([]);
  const [draft, setDraft] = useState<{ quote: string; anchor: Anchor } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pickImage = useRef<() => void>(() => fileInput.current?.click());

  const user = useMemo(() => ({ id: self?.id ?? '', name: displayName(self ?? undefined), color: personColor(self?.id ?? '') }), [self]);
  const editor = useEditor(
    {
      editable: canWrite,
      extensions: [
        ...editorKit({ live: canWrite, selfId: user.id, onImage: () => pickImage.current() }),
        Placeholder.configure({ placeholder: ({ node }) => (node.type.name === 'heading' ? T.headingPlaceholder : T.placeholder) }),
        Collaboration.configure({ document: session.doc, field: 'default' }),
        CollaborationCaret.configure({ provider: session.provider, user }),
        commentHighlights(
          () => commentsRef.current,
          (commentId) => {
            if (!canComment) return;
            setFocus(commentId);
            onPanel('comments');
          },
        ),
      ],
      editorProps: { attributes: { class: 'canvas-content', 'aria-label': T.canvas } },
    },
    [session, canWrite],
  );

  // Comments: load now and whenever someone adds or resolves one.
  const loadComments = (): void => {
    call('client.canvases.comments.list', { canvas_id: id })
      .then((result) => {
        commentsRef.current = result.comments as Comment[];
        setComments(commentsRef.current);
        if (editor) editor.view.dispatch(editor.state.tr.setMeta(commentsKey, true));
      })
      .catch(() => undefined);
  };
  useEffect(() => {
    if (lastChange === undefined || lastChange === 'comments') loadComments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, version, editor]);

  const upload = async (file: File): Promise<void> => {
    if (!editor) return;
    setUploading(true);
    try {
      const fileId = await uploadFile(file);
      const result = await call('files.completeUploadExternal', { files: [{ id: fileId, title: file.name }] });
      const uploaded = (result.files as FileObject[])[0]!;
      const src = asset(uploaded.thumb_720 ?? uploaded.thumb_360 ?? uploaded.url_private);
      editor.chain().focus().setImage({ src, alt: uploaded.title || file.name }).run();
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setUploading(false);
    }
  };

  const startComment = (): void => {
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    const binding = ySyncPluginKey.getState(editor.state)?.binding;
    if (empty || !binding) {
      toast(T.selectToComment);
      return;
    }
    const anchor = {
      from: Y.relativePositionToJSON(absolutePositionToRelativePosition(from, binding.type, binding.mapping)),
      to: Y.relativePositionToJSON(absolutePositionToRelativePosition(to, binding.type, binding.mapping)),
    };
    setDraft({ quote: editor.state.doc.textBetween(from, to, ' ').slice(0, 500), anchor });
    onPanel('comments');
  };

  // Mentions and channel names in the text open the profile or the channel.
  const onClick = (event: React.MouseEvent): void => {
    const target = (event.target as HTMLElement).closest('.mention') as HTMLElement | null;
    if (!target) return;
    const mentionId = target.dataset.id ?? '';
    if (/^[UW]/.test(mentionId)) setSidePanel({ kind: 'profile', user: mentionId });
    else if (/^[CG]/.test(mentionId) && (get().channels[mentionId] || get().others[mentionId])) go({ name: 'conversation', id: mentionId });
  };

  if (!editor) return null;
  return (
    <div className={`canvas-layout ${panel ? 'has-side' : ''}`}>
      <div className="canvas-main">
        <div className="canvas-bar">
          {canWrite ? <Toolbar editor={editor} onImage={() => fileInput.current?.click()} onComment={startComment} /> : <span className="tag">{T.readOnly}</span>}
          {!canWrite && canComment ? (
            <Button size="sm" variant="ghost" onClick={startComment}>
              <MessageSquarePlus size={15} /> {T.addComment}
            </Button>
          ) : null}
          <span className="composer-spacer" />
          <div className="canvas-presence" role="group" aria-label={T.here(people.map((person) => person.name).join(', '))}>
            {people.map((person) => (
              <span key={person.id} className="presence-chip" style={{ borderColor: person.color }} title={person.name} data-present={person.id}>
                <Avatar user={get().users[person.id]} size={22} />
              </span>
            ))}
          </div>
        </div>
        {!synced ? (
          <div className="canvas-status">
            <Spinner /> {T.connecting}
          </div>
        ) : !online ? (
          <div className="canvas-status is-offline" role="status">
            <WifiOff size={14} /> {T.offline}
          </div>
        ) : null}
        {uploading ? (
          <div className="canvas-status">
            <Spinner /> {T.uploading}
          </div>
        ) : null}
        <div className="canvas-scroll" onClick={onClick}>
          <EditorContent editor={editor} className="canvas-page" />
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void upload(file);
          }}
        />
      </div>
      {panel === 'comments' ? (
        <CommentsPanel
          id={id}
          editor={editor}
          comments={comments}
          draft={draft}
          focus={focus}
          canWrite={canWrite}
          isOwner={isOwner}
          onDraftDone={() => {
            setDraft(null);
            loadComments();
          }}
          onClose={() => {
            setDraft(null);
            onPanel(null);
          }}
        />
      ) : null}
      {panel === 'versions' ? <VersionsPanel id={id} canWrite={canWrite} onClose={() => onPanel(null)} /> : null}
    </div>
  );
}

export default function CanvasEditor({
  id,
  canWrite,
  canComment = true,
  isOwner,
  panel,
  onPanel,
}: {
  id: string;
  canWrite: boolean;
  /** False for a canvas shown read-only, without comments (a code channel's `read` view). */
  canComment?: boolean;
  isOwner: boolean;
  panel: CanvasPanel;
  onPanel: (panel: CanvasPanel) => void;
}) {
  const session = useSession(id);
  if (!session) {
    return (
      <div className="list-loading">
        <Spinner />
      </div>
    );
  }
  return <LiveEditor key={`${id}:${canWrite}`} id={id} session={session} canWrite={canWrite} canComment={canComment} isOwner={isOwner} panel={panel} onPanel={onPanel} />;
}
