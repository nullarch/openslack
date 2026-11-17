import { ArrowUpRight, Hash, History, Link2, Lock, Menu, MessageSquare, MoreHorizontal, Save, Share2, Trash2, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { attempt, errorText, go, toast } from '../../lib/actions';
import { call, type Json } from '../../lib/api';
import { openDoc, setDocTab, useDocs, type DocKind, type DocSummary } from '../../lib/docs';
import { displayName, get, set, useStore } from '../../lib/store';
import { relative } from '../../lib/time';
import { S } from '../../strings';
import { T } from './text';
import { confirmDialog } from '../dialogs/confirm';
import { Avatar, Button, Field, IconButton, MenuDivider, MenuItem, Modal, Popover, Spinner } from '../ui';
import { KindIcon } from './index';
import type { CanvasPanel } from './CanvasEditor';
import ListView from './ListView';
import '../../styles/docs.css';

// The editor (TipTap and Yjs) is its own chunk: a list never loads it.
const CanvasEditor = lazy(() => import('./CanvasEditor'));

interface Access {
  principal: string;
  level: 'read' | 'write';
}

function principalLabel(principal: string): { label: string; isChannel: boolean; isPrivate: boolean } {
  const state = get();
  if (/^[UW]/.test(principal)) return { label: displayName(state.users[principal]), isChannel: false, isPrivate: false };
  const conv = state.channels[principal] ?? state.others[principal];
  return { label: conv?.name ? `#${conv.name}` : principal, isChannel: true, isPrivate: Boolean(conv?.is_private) };
}

function ShareDialog({ doc, onClose }: { doc: DocSummary; onClose: () => void }) {
  const users = useStore((state) => state.users);
  const channels = useStore((state) => state.channels);
  const owner = doc.access_level === 'owner';
  const version = useDocs((state) => state.version[doc.id] ?? 0);
  const [access, setAccess] = useState<Access[] | null>(null);
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<'read' | 'write'>('write');
  const method = doc.kind === 'canvas' ? 'canvases' : 'slackLists';
  const idArg = doc.kind === 'canvas' ? { canvas_id: doc.id } : { list_id: doc.id };

  useEffect(() => {
    let live = true;
    call(doc.kind === 'canvas' ? 'client.canvases.info' : 'client.lists.info', idArg)
      .then((result) => live && setAccess(((doc.kind === 'canvas' ? result.canvas : result.list).access ?? []) as Access[]))
      .catch(() => live && setAccess([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, version]);

  const q = query.trim().toLowerCase().replace(/^#/, '');
  const taken = new Set((access ?? []).map((entry) => entry.principal));
  const suggestions = q
    ? [
        ...Object.values(channels)
          .filter((conv) => conv.is_channel && !conv.is_archived && (conv.name ?? '').toLowerCase().includes(q) && !taken.has(conv.id))
          .slice(0, 4)
          .map((conv) => ({ id: conv.id, label: `#${conv.name}`, channel: true })),
        ...Object.values(users)
          .filter((user) => !user.deleted && !user.is_bot && user.id !== doc.owner && !taken.has(user.id) && `${user.name} ${user.real_name} ${user.profile.display_name}`.toLowerCase().includes(q))
          .slice(0, 6)
          .map((user) => ({ id: user.id, label: displayName(user), channel: false })),
      ]
    : [];

  const grant = async (principal: string, channel: boolean, value: 'read' | 'write'): Promise<void> => {
    const result = await attempt(() => call(`${method}.access.set`, { ...idArg, access_level: value, ...(channel ? { channel_ids: [principal] } : { user_ids: [principal] }) }));
    if (result === undefined) return;
    setQuery('');
    setAccess((current) => [...(current ?? []).filter((entry) => entry.principal !== principal), { principal, level: value }]);
  };
  const remove = async (principal: string): Promise<void> => {
    const result = await attempt(() => call(`${method}.access.delete`, { ...idArg, ...(/^[UW]/.test(principal) ? { user_ids: [principal] } : { channel_ids: [principal] }) }));
    if (result !== undefined) setAccess((current) => (current ?? []).filter((entry) => entry.principal !== principal));
  };

  return (
    <Modal title={T.shareTitle(doc.title || T.untitled)} onClose={onClose} className="share-dialog" footer={<Button onClick={onClose}>{S.done}</Button>}>
      {owner ? (
        <div className="share-add">
          <Field label={T.addPeople}>
            <div className="share-row">
              <input className="input" placeholder={T.searchPeople} aria-label={T.addPeople} value={query} onChange={(event) => setQuery(event.target.value)} />
              <select className="input share-level" aria-label={T.levelWrite} value={level} onChange={(event) => setLevel(event.target.value as 'read' | 'write')}>
                <option value="write">{T.levelWrite}</option>
                <option value="read">{T.levelRead}</option>
              </select>
            </div>
          </Field>
          {suggestions.length ? (
            <div className="share-suggestions" role="listbox">
              {suggestions.map((entry) => (
                <button key={entry.id} type="button" role="option" aria-selected={false} className="menu-item" data-principal={entry.id} onClick={() => void grant(entry.id, entry.channel, level)}>
                  {entry.channel ? <Hash size={15} /> : <Avatar user={users[entry.id]} size={20} />}
                  <span className="menu-label">{entry.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="view-empty is-inline">{T.onlyOwner}</p>
      )}
      <h3 className="share-heading">{T.sharedWith}</h3>
      <ul className="share-list">
        <li>
          <Avatar user={users[doc.owner]} size={24} />
          <span className="share-name">{displayName(users[doc.owner])}</span>
          <span className="tag">{T.owner}</span>
        </li>
        {access === null ? <Spinner /> : null}
        {(access ?? []).map((entry) => {
          const who = principalLabel(entry.principal);
          return (
            <li key={entry.principal} data-access={entry.principal}>
              {who.isChannel ? who.isPrivate ? <Lock size={18} /> : <Hash size={18} /> : <Avatar user={users[entry.principal]} size={24} />}
              <span className="share-name">{who.isChannel ? T.channelMembers(who.label.replace(/^#/, '')) : who.label}</span>
              {owner ? (
                <>
                  <select className="input share-level" aria-label={who.label} value={entry.level} onChange={(event) => void grant(entry.principal, who.isChannel, event.target.value as 'read' | 'write')}>
                    <option value="write">{T.levelWrite}</option>
                    <option value="read">{T.levelRead}</option>
                  </select>
                  <IconButton label={T.remove} onClick={() => void remove(entry.principal)}>
                    <X size={15} />
                  </IconButton>
                </>
              ) : (
                <span className="tag">{entry.level === 'write' ? T.levelWrite : T.levelRead}</span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="share-note">{T.publicNote}</p>
    </Modal>
  );
}

function SaveTemplateDialog({ doc, onClose }: { doc: DocSummary; onClose: () => void }) {
  const [title, setTitle] = useState(doc.title);
  const [includeItems, setIncludeItems] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={T.saveTemplate}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{S.cancel}</Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!title.trim()}
            onClick={() => {
              setBusy(true);
              void attempt(() => call('client.docs.templates.save', { doc_id: doc.id, title: title.trim(), include_items: includeItems })).then((ok) => {
                setBusy(false);
                if (ok === undefined) return;
                toast(T.templateSaved);
                onClose();
              });
            }}
          >
            {T.saveTemplate}
          </Button>
        </>
      }
    >
      <Field label={T.templateName}>
        <input className="input" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      {doc.kind === 'list' ? (
        <label className="toggle-label">
          <input type="checkbox" checked={includeItems} onChange={(event) => setIncludeItems(event.target.checked)} /> {T.includeItems}
        </label>
      ) : null}
    </Modal>
  );
}

function Title({ doc, editable }: { doc: DocSummary; editable: boolean }) {
  const [value, setValue] = useState(doc.title);
  useEffect(() => setValue(doc.title), [doc.title]);
  const commit = (): void => {
    const next = value.trim();
    if (!next || next === doc.title) {
      setValue(doc.title);
      return;
    }
    void attempt(() => (doc.kind === 'canvas' ? call('client.canvases.rename', { canvas_id: doc.id, title: next }) : call('slackLists.update', { id: doc.id, name: next })));
  };
  if (!editable) return <h1 className="doc-title">{doc.title || T.untitled}</h1>;
  return (
    <input
      className="doc-title is-editable"
      value={value}
      aria-label={T.rename}
      placeholder={doc.kind === 'canvas' ? T.untitled : T.untitledList}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        if (event.key === 'Escape') {
          setValue(doc.title);
          (event.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/**
 * A canvas or a list with its header: title, who can edit, comments, history, sharing and the rest.
 * `canComment: false` is a canvas an agent shows read-only in a code channel.
 */
export default function DocPage({ kind, id, channel, canComment = true }: { kind: DocKind; id: string; channel?: string; canComment?: boolean }) {
  const version = useDocs((state) => state.version[id] ?? 0);
  const lastChange = useDocs((state) => state.lastChange[id]);
  const updatedBy = useStore((state) => state.users);
  const [doc, setDoc] = useState<DocSummary | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [panel, setPanel] = useState<CanvasPanel>(null);
  const [menu, setMenu] = useState(false);
  const [share, setShare] = useState(false);
  const [template, setTemplate] = useState(false);
  const [openComments, setOpenComments] = useState(0);
  const menuButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (doc && lastChange && !['renamed', 'access', 'deleted', 'comments', 'content', 'items', 'meta', 'schema', 'created'].includes(lastChange)) return;
    let live = true;
    call('client.docs.card', { id })
      .then((result) => {
        if (!live) return;
        setDoc(result.card as DocSummary);
        setMissing(null);
      })
      .catch((error: unknown) => live && setMissing(errorText(error)));
    if (kind === 'canvas') {
      call('client.canvases.info', { canvas_id: id })
        .then((result: Json) => live && setOpenComments(Number(result.canvas?.open_comments ?? 0)))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, version]);

  if (missing) {
    return (
      <section className="conversation doc-page">
        <div className="doc-missing">
          <KindIcon kind={kind} size={28} />
          <p>{T.gone}</p>
          {channel ? <Button onClick={() => setDocTab(channel, null)}>{T.messages}</Button> : null}
        </div>
      </section>
    );
  }
  if (!doc) {
    return (
      <section className="conversation doc-page">
        <div className="list-loading">
          <Spinner />
        </div>
      </section>
    );
  }

  const canWrite = doc.access_level === 'write' || doc.access_level === 'owner';
  const isOwner = doc.access_level === 'owner';
  const togglePanel = (next: CanvasPanel): void => setPanel((current) => (current === next ? null : next));
  const remove = async (): Promise<void> => {
    const ok = await confirmDialog(kind === 'canvas' ? T.deleteCanvas : T.deleteList, T.delete);
    if (!ok) return;
    const result = await attempt(() => (kind === 'canvas' ? call('canvases.delete', { canvas_id: id }) : call('client.lists.delete', { list_id: id })));
    if (result === undefined) return;
    toast(T.deleted);
    if (channel) setDocTab(channel, null);
    else go({ name: 'view', view: kind === 'canvas' ? 'canvases' : 'lists' });
  };

  return (
    <section className={`conversation doc-page is-${kind} ${channel ? 'is-tab' : 'is-full'}`} data-doc-page={id}>
      <header className="conv-head doc-head">
        {!channel ? (
          <IconButton className="only-narrow" label={S.sidebar.openSidebar} onClick={() => set({ drawer: true })}>
            <Menu size={19} />
          </IconButton>
        ) : null}
        <span className={`doc-kind is-${kind}`}>
          <KindIcon kind={kind} size={16} />
        </span>
        <Title doc={doc} editable={canWrite} />
        {!canWrite ? <span className="tag">{T.readOnly}</span> : null}
        <span className="doc-updated">{T.updatedBy(displayName(updatedBy[doc.updated_by]), relative(String(doc.updated)))}</span>
        <span className="composer-spacer" />
        {kind === 'canvas' ? (
          <>
            {canComment || canWrite ? (
              <Button size="sm" variant={panel === 'comments' ? 'primary' : 'ghost'} aria-pressed={panel === 'comments'} onClick={() => togglePanel('comments')}>
                <MessageSquare size={15} /> {openComments ? T.commentsCount(openComments) : T.comments}
              </Button>
            ) : null}
            <IconButton label={T.versions} className={panel === 'versions' ? 'is-on' : ''} onClick={() => togglePanel('versions')}>
              <History size={17} />
            </IconButton>
          </>
        ) : null}
        <Button size="sm" onClick={() => setShare(true)}>
          <Share2 size={15} /> {T.share}
        </Button>
        <IconButton ref={menuButton} label={T.openFull} onClick={() => setMenu(true)}>
          <MoreHorizontal size={18} />
        </IconButton>
      </header>
      <div className="doc-body">
        {kind === 'canvas' ? (
          <Suspense
            fallback={
              <div className="list-loading">
                <Spinner />
              </div>
            }
          >
            <CanvasEditor id={id} canWrite={canWrite} canComment={canComment || canWrite} isOwner={isOwner} panel={panel} onPanel={setPanel} />
          </Suspense>
        ) : (
          <ListView id={id} />
        )}
      </div>
      {menu ? (
        <Popover anchor={menuButton.current} onClose={() => setMenu(false)} className="menu" align="end">
          <MenuItem
            icon={<Link2 size={16} />}
            label={T.copyLink}
            onSelect={() => {
              setMenu(false);
              void navigator.clipboard?.writeText(doc.permalink).then(() => toast(T.linkCopied));
            }}
          />
          {channel ? (
            <MenuItem
              icon={<ArrowUpRight size={16} />}
              label={T.openFull}
              onSelect={() => {
                setMenu(false);
                openDoc(kind, id);
              }}
            />
          ) : null}
          <MenuItem
            icon={<Save size={16} />}
            label={T.saveTemplate}
            onSelect={() => {
              setMenu(false);
              setTemplate(true);
            }}
          />
          {isOwner ? (
            <>
              <MenuDivider />
              <MenuItem
                icon={<Trash2 size={16} />}
                label={T.delete}
                danger
                onSelect={() => {
                  setMenu(false);
                  void remove();
                }}
              />
            </>
          ) : null}
        </Popover>
      ) : null}
      {share ? <ShareDialog doc={doc} onClose={() => setShare(false)} /> : null}
      {template ? <SaveTemplateDialog doc={doc} onClose={() => setTemplate(false)} /> : null}
    </section>
  );
}
