import { CalendarClock, ClipboardList, FileText, ListChecks, Plus, UserCheck } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { attempt } from '../../lib/actions';
import type { ActivityItem } from '../../lib/attention';
import { createDoc, docLinks, loadCard, loadChannelDocs, openDoc, setDocTab, useDocs, type DocKind, type DocSummary } from '../../lib/docs';
import { call } from '../../lib/api';
import { displayName, useStore } from '../../lib/store';
import { relative } from '../../lib/time';
import { S } from '../../strings';
import { MenuItem, Popover, Spinner } from '../ui';
import '../../styles/docs-lite.css';

// The editor, list views and browser load on first use; see ./DocPage.
const DocPage = lazy(() => import('./DocPage'));
const DocsBrowser = lazy(() => import('./Browser'));
const TemplatePicker = lazy(() => import('./Browser').then((module) => ({ default: module.TemplatePicker })));

function Loading() {
  return (
    <section className="conversation doc-loading">
      <div className="list-loading">
        <Spinner />
      </div>
    </section>
  );
}

export function KindIcon({ kind, size = 15 }: { kind: DocKind; size?: number }) {
  return kind === 'canvas' ? <FileText size={size} /> : <ListChecks size={size} />;
}

/** A canvas or list on its own page (`/docs/…`, `/lists/…`). */
export function DocRouteView({ kind, id }: { kind: DocKind; id: string }) {
  return (
    <Suspense fallback={<Loading />}>
      <DocPage key={id} kind={kind} id={id} />
    </Suspense>
  );
}

/** The Canvases and Lists views from the sidebar. */
export function DocsView({ kind }: { kind: DocKind }) {
  return (
    <Suspense fallback={<Loading />}>
      <DocsBrowser key={kind} kind={kind} />
    </Suspense>
  );
}

/** The canvas or list open as a tab of a conversation, in place of its messages. */
export function useOpenDocTab(channel: string): DocSummary | null {
  const id = useDocs((state) => state.tab[channel]);
  // Coming back to a conversation shows its messages, not the tab last open there.
  useEffect(() => () => setDocTab(channel, null), [channel]);
  const docs = useDocs((state) => state.byChannel[channel]);
  return (id && docs?.find((doc) => doc.id === id)) || null;
}

export function ChannelDocBody({ channel, doc }: { channel: string; doc: DocSummary }) {
  return (
    <Suspense fallback={<Loading />}>
      <DocPage key={doc.id} kind={doc.kind} id={doc.id} channel={channel} />
    </Suspense>
  );
}

/** "Messages" plus the conversation's canvases and lists, and a button to add one. */
export function DocTabs({ channel, canAdd }: { channel: string; canAdd: boolean }) {
  const docs = useDocs((state) => state.byChannel[channel]);
  const open = useDocs((state) => state.tab[channel]);
  const [menu, setMenu] = useState(false);
  const [picker, setPicker] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (docs === undefined) void loadChannelDocs(channel);
  }, [channel, docs]);

  if (!docs?.length && !canAdd) return null;
  const add = (kind: DocKind): void => {
    setMenu(false);
    void attempt(() => createDoc(kind, { channel }));
  };
  return (
    <div className="doc-tabs" role="tablist" aria-label={S.docs.addTab}>
      <button type="button" role="tab" aria-selected={!open} className={`doc-tab ${!open ? 'is-on' : ''}`} onClick={() => setDocTab(channel, null)}>
        {S.docs.messages}
      </button>
      {(docs ?? []).map((doc) => (
        <button
          key={doc.id}
          type="button"
          role="tab"
          aria-selected={open === doc.id}
          className={`doc-tab ${open === doc.id ? 'is-on' : ''}`}
          data-doc={doc.id}
          onClick={() => setDocTab(channel, doc.id)}
        >
          <KindIcon kind={doc.kind} size={14} />
          <span className="doc-tab-name">{doc.title || (doc.kind === 'canvas' ? S.docs.untitled : S.docs.untitledList)}</span>
        </button>
      ))}
      {canAdd ? (
        <button ref={button} type="button" className="doc-tab doc-tab-add" aria-label={S.docs.addTab} title={S.docs.addTab} onClick={() => setMenu(true)}>
          <Plus size={15} />
        </button>
      ) : null}
      {menu ? (
        <Popover anchor={button.current} onClose={() => setMenu(false)} className="menu">
          <MenuItem icon={<FileText size={16} />} label={S.docs.newCanvas} onSelect={() => add('canvas')} />
          <MenuItem icon={<ListChecks size={16} />} label={S.docs.newList} onSelect={() => add('list')} />
          <MenuItem
            icon={<ClipboardList size={16} />}
            label={S.docs.fromTemplate}
            onSelect={() => {
              setMenu(false);
              setPicker(true);
            }}
          />
        </Popover>
      ) : null}
      {picker ? (
        <Suspense fallback={null}>
          <TemplatePicker channel={channel} onClose={() => setPicker(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}

// ── Link cards in messages ──────────────────────────────────────────────────

function DocCard({ kind, id }: { kind: DocKind; id: string }) {
  const card = useDocs((state) => state.cards[id]);
  const editor = useStore((state) => (card ? displayName(state.users[card.updated_by]) : ''));
  useEffect(() => {
    if (card === undefined) loadCard(id);
  }, [id, card]);
  // Someone who cannot open it sees nothing more than the link itself.
  if (!card) return null;
  return (
    <a
      className="doc-card"
      href={card.permalink}
      data-doc-card={id}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        openDoc(kind, id);
      }}
    >
      <span className={`doc-card-icon is-${card.kind}`}>
        <KindIcon kind={card.kind} size={18} />
      </span>
      <span className="doc-card-body">
        <strong>{card.title || S.docs.untitled}</strong>
        <span className="doc-card-meta">
          {card.kind === 'canvas' ? S.docs.canvas : `${S.docs.list} · ${S.docs.items(card.item_count ?? 0)}`} · {S.docs.updatedBy(editor, relative(String(card.updated)))}
        </span>
        {card.kind === 'canvas' && card.snippet ? <span className="doc-card-snippet">{card.snippet}</span> : null}
        {card.kind === 'list' && card.columns?.length ? <span className="doc-card-snippet">{card.columns.join(' · ')}</span> : null}
      </span>
    </a>
  );
}

/** Cards for the canvas and list links in a message's text. */
export function DocCards({ text }: { text: string }) {
  if (!text || !/\/(docs|lists)\//.test(text)) return null;
  const links = docLinks(text);
  if (!links.length) return null;
  return (
    <div className="doc-cards">
      {links.map((link) => (
        <DocCard key={link.id} kind={link.kind} id={link.id} />
      ))}
    </div>
  );
}

// ── Activity ────────────────────────────────────────────────────────────────

export const DOC_ACTIVITY = ['canvas_mention', 'list_assigned', 'list_due'];

export interface DocActivity extends Omit<ActivityItem, 'type'> {
  type: string;
  doc?: { id: string; kind: DocKind; title: string; permalink: string };
  item?: { id: string; title: string };
  due?: string;
}

export function docActivityIcon(type: string): ReactNode {
  if (type === 'list_assigned') return <UserCheck size={15} />;
  if (type === 'list_due') return <CalendarClock size={15} />;
  return <FileText size={15} />;
}

export function docActivityHeadline(item: DocActivity, actor: string): string {
  if (item.type === 'list_assigned') return S.docs.activityAssigned(actor);
  if (item.type === 'list_due') return S.docs.activityDue;
  return S.docs.activityMention(actor);
}

export function openDocActivity(item: DocActivity): void {
  if (item.doc) openDoc(item.doc.kind, item.doc.id);
}

export function DocActivityBody({ item }: { item: DocActivity }) {
  if (!item.doc) return <p className="view-empty is-inline">{S.docs.gone}</p>;
  return (
    <div className="doc-activity">
      <KindIcon kind={item.doc.kind} size={14} />
      <strong>{item.doc.title}</strong>
      {item.item?.title ? <span className="doc-activity-item">{item.item.title}</span> : null}
      {item.due ? <span className="tag">{item.due}</span> : null}
    </div>
  );
}

// ── Search ──────────────────────────────────────────────────────────────────

function plain(query: string): string {
  return query
    .replace(/\b(in|from|before|after|on|during|has|is):\S+/gi, ' ')
    .replace(/["']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function DocSearchResults({ query }: { query: string }) {
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const users = useStore((state) => state.users);
  useEffect(() => {
    let live = true;
    const terms = plain(query);
    setDocs(null);
    if (!terms) {
      setDocs([]);
      return;
    }
    call('client.docs.search', { query: terms, count: 50 })
      .then((result) => live && setDocs(result.docs as DocSummary[]))
      .catch(() => live && setDocs([]));
    return () => {
      live = false;
    };
  }, [query]);
  if (docs === null) {
    return (
      <div className="list-loading">
        <Spinner />
      </div>
    );
  }
  if (!docs.length) return <p className="search-empty">{S.att.search.noDocs}</p>;
  return (
    <>
      {docs.map((doc) => (
        <button key={doc.id} type="button" className="result doc-result" data-doc-result={doc.id} onClick={() => openDoc(doc.kind, doc.id)}>
          <div className="result-place">
            <KindIcon kind={doc.kind} />
            <strong>{doc.title || S.docs.untitled}</strong>
            <span>{S.docs.updatedBy(displayName(users[doc.updated_by]), relative(String(doc.updated)))}</span>
          </div>
          {doc.snippet ? <p className="doc-result-snippet">{doc.snippet}</p> : null}
        </button>
      ))}
    </>
  );
}
