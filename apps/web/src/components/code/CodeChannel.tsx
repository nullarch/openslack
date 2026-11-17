import type { AgentSessionView, ContextBarItem, Conversation } from '@app/shared';
import {
  AppWindow,
  Code,
  ExternalLink,
  FileDiff,
  FileText,
  Folder,
  GitBranch,
  GitPullRequest,
  Globe,
  LayoutGrid,
  LifeBuoy,
  Link,
  Lock,
  Network,
  Play,
  Search,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { loadCommands, toast } from '../../lib/actions';
import { ApiError } from '../../lib/api';
import { loadView, runContextAction, setViewTab, useCodeChannels, viewBlockAction, viewSuggest, type ViewDetail } from '../../lib/codeChannels';
import { parseUnifiedDiff, viewDocument, type DiffFile } from '../../lib/codeViews';
import { loadChannelDocs, setDocTab, useDocs } from '../../lib/docs';
import { useTabList } from '../../lib/roving';
import { StateBag, type Surface } from '../../lib/surface';
import { S } from '../../strings';
import { AgentSessionBar } from '../ai/AgentSession';
import { Blocks } from '../blocks';
import { KindIcon } from '../docs';
import { Spinner } from '../ui';
import '../../styles/ai.css';
import '../../styles/code.css';

// The canvas editor is its own chunk, as everywhere else.
const DocPage = lazy(() => import('../docs/DocPage'));

const ITEM_ICONS: Record<NonNullable<ContextBarItem['icon']>, LucideIcon> = {
  branch: GitBranch,
  folder: Folder,
  hierarchy: Network,
  'life-ring': LifeBuoy,
  link: Link,
  globe: Globe,
  terminal: Terminal,
  code: Code,
  search: Search,
  lock: Lock,
};

const VIEW_ICONS: Record<AgentSessionView['type'], LucideIcon> = {
  html: AppWindow,
  diff: FileDiff,
  block_kit: LayoutGrid,
  canvas: FileText,
  pull_request: GitPullRequest,
};

const viewLabel = (view: AgentSessionView): string => (view.type === 'diff' ? S.code.diff : view.name);

function views(conv: Conversation): AgentSessionView[] {
  return conv.properties?.code_channel?.agent_session_views ?? [];
}

// ── Session and context bar ─────────────────────────────────────────────────

function ContextItem({ channel, item, canAct }: { channel: string; item: ContextBarItem; canAct: boolean }) {
  const Icon = item.icon ? ITEM_ICONS[item.icon] : null;
  const icon = Icon ? <Icon size={14} aria-hidden="true" /> : null;
  if (item.url) {
    return (
      <a className="code-chip is-link" href={item.url} target="_blank" rel="noopener noreferrer" data-context-item={item.key} aria-label={`${item.label} (${S.code.opensNewTab})`}>
        {icon}
        <span className="code-chip-label">{item.label}</span>
        <ExternalLink size={12} aria-hidden="true" />
      </a>
    );
  }
  if (item.item_type === 'action') {
    return (
      <button
        type="button"
        className="code-chip is-action"
        data-context-item={item.key}
        disabled={!canAct}
        onClick={() =>
          void runContextAction(channel, item.key).then((ok) => {
            if (ok) toast(S.code.actionSent);
          })
        }
      >
        {icon ?? <Play size={13} aria-hidden="true" />}
        <span className="code-chip-label">{item.label}</span>
      </button>
    );
  }
  return (
    <span className="code-chip" data-context-item={item.key}>
      {icon}
      <span className="code-chip-label">{item.label}</span>
    </span>
  );
}

/** Above a code channel's tabs: its session (title, state, Stop) and the agent's context bar. */
export function CodeChannelBar({ conv, isMember }: { conv: Conversation; isMember: boolean }) {
  const items = conv.properties?.code_channel?.context_bar_items ?? [];
  // A member who just joined, or an agent that just changed its commands: the composer's list follows.
  useEffect(() => {
    if (isMember) void loadCommands();
  }, [conv.id, isMember]);
  return (
    <div className="code-bar" data-code-channel={conv.id}>
      <AgentSessionBar channel={conv.id} threadTs="" />
      {items.length ? (
        <div className="code-context" role="group" aria-label={S.code.contextBar}>
          {items.map((item) => (
            <ContextItem key={item.key} channel={conv.id} item={item} canAct={isMember && !conv.is_archived} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────────

/** The view tab open in a code channel, while it still exists. */
export function useOpenViewTab(conv: Conversation | undefined): AgentSessionView | null {
  const channel = conv?.id ?? '';
  const id = useCodeChannels((state) => state.tab[channel]);
  // Coming back to the channel shows its messages.
  useEffect(() => () => setViewTab(channel, null), [channel]);
  return (conv && id && views(conv).find((view) => view.view_id === id)) || null;
}

/** "Messages", the agent's views, then the channel's other canvases and lists. */
export function CodeChannelTabs({ conv }: { conv: Conversation }) {
  const channel = conv.id;
  const tabList = useTabList();
  const list = views(conv);
  const docs = useDocs((state) => state.byChannel[channel]);
  const docTab = useDocs((state) => state.tab[channel]);
  const viewTab = useCodeChannels((state) => state.tab[channel]);
  useEffect(() => {
    if (docs === undefined) void loadChannelDocs(channel);
  }, [channel, docs]);
  const shown = new Set(list.map((view) => view.canvas_id).filter(Boolean));
  const others = (docs ?? []).filter((doc) => !shown.has(doc.id));
  const openView = viewTab && list.some((view) => view.view_id === viewTab) ? viewTab : null;
  const select = (view: string | null, doc: string | null): void => {
    setViewTab(channel, view);
    setDocTab(channel, doc);
  };
  return (
    <div className="doc-tabs code-tabs">
      <div ref={tabList} className="doc-tab-list" role="tablist" aria-label={S.code.tabs}>
        <button type="button" role="tab" aria-selected={!openView && !docTab} className={`doc-tab ${!openView && !docTab ? 'is-on' : ''}`} onClick={() => select(null, null)}>
          {S.docs.messages}
        </button>
        {list.map((view) => {
          const Icon = VIEW_ICONS[view.type] ?? AppWindow;
          const on = openView === view.view_id;
          return (
            <button key={view.view_id} type="button" role="tab" aria-selected={on} className={`doc-tab ${on ? 'is-on' : ''}`} data-view-tab={view.type} onClick={() => select(view.view_id, null)}>
              <Icon size={14} aria-hidden="true" />
              <span className="doc-tab-name">{viewLabel(view)}</span>
            </button>
          );
        })}
        {others.map((doc) => {
          const on = !openView && docTab === doc.id;
          return (
            <button key={doc.id} type="button" role="tab" aria-selected={on} className={`doc-tab ${on ? 'is-on' : ''}`} data-doc={doc.id} onClick={() => select(null, doc.id)}>
              <KindIcon kind={doc.kind} size={14} />
              <span className="doc-tab-name">{doc.title || (doc.kind === 'canvas' ? S.docs.untitled : S.docs.untitledList)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── View bodies ─────────────────────────────────────────────────────────────

function Loading() {
  return (
    <div className="list-loading">
      <Spinner />
    </div>
  );
}

/** The agent's HTML in a frame of its own: scripts run there, but with no access to this page, its cookies or the network. */
function HtmlView({ view }: { view: ViewDetail }) {
  const document = useMemo(() => viewDocument(view.content ?? '', view.csp?.resource_domains ?? []), [view.content, view.csp]);
  return (
    <iframe
      className="code-frame"
      title={S.code.frameTitle(view.name)}
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={document}
      data-view-frame={view.view_id}
    />
  );
}

function DiffFileView({ file }: { file: DiffFile }) {
  return (
    <section className="code-diff-file" aria-label={file.name || file.from}>
      <h3 className="code-diff-name">
        <span className="code-diff-path">{file.name || file.from}</span>
        {file.from && file.name && file.from !== file.name ? <span className="code-diff-meta">{S.code.renamed(file.from)}</span> : null}
        <span className="code-diff-counts" aria-label={S.code.lineCounts(file.added, file.removed)}>
          <span className="is-add" aria-hidden="true">+{file.added}</span>
          <span className="is-del" aria-hidden="true">−{file.removed}</span>
        </span>
      </h3>
      {file.binary ? (
        <p className="code-diff-note">{S.code.binary}</p>
      ) : (
        <pre className="code-block is-diff code-diff-lines" tabIndex={0} aria-label={file.name || file.from}>
          <code>
            {file.lines.map((line, index) => (
              <span key={index} className={`diff-line ${line.kind === 'context' ? '' : line.kind}`} data-diff-line={line.kind}>
                <span className="code-diff-num" aria-hidden="true">{line.old ?? ''}</span>
                <span className="code-diff-num" aria-hidden="true">{line.new ?? ''}</span>
                {line.text}
              </span>
            ))}
          </code>
        </pre>
      )}
    </section>
  );
}

/** A unified diff, file by file, with what was added and removed. */
function DiffView({ view }: { view: ViewDetail }) {
  const files = useMemo(() => parseUnifiedDiff(view.content ?? ''), [view.content]);
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  return (
    <div className="code-scroll">
      <div className="code-diff">
        <header className="code-diff-head">
          {view.base_branch || view.head_branch ? (
            <span className="code-diff-branches">
              <GitBranch size={14} aria-hidden="true" />
              <code>{view.base_branch ?? '…'}</code>
              <span aria-hidden="true">←</span>
              <code>{view.head_branch ?? '…'}</code>
            </span>
          ) : null}
          <span>{S.code.files(files.length)}</span>
          <span className="code-diff-counts" aria-label={S.code.lineCounts(added, removed)}>
            <span className="is-add" aria-hidden="true">+{added}</span>
            <span className="is-del" aria-hidden="true">−{removed}</span>
          </span>
        </header>
        {files.length ? files.map((file, index) => <DiffFileView key={`${file.name}:${index}`} file={file} />) : <p className="code-diff-note">{S.code.noChanges}</p>}
      </div>
    </div>
  );
}

/** Block Kit the agent drew: clicks and menus go to that agent. */
function BlockKitView({ channel, view }: { channel: string; view: ViewDetail }) {
  const surface = useMemo<Surface>(() => {
    const state = new StateBag();
    return {
      kind: 'tab',
      state,
      errors: {},
      act: (action) => viewBlockAction(channel, view.view_id, action, state.toState()),
      suggest: (actionId, blockId, value) => viewSuggest(channel, view.view_id, actionId, blockId, value),
    };
    // A new version of the view starts with a fresh state bag.
  }, [channel, view.view_id, view.content_version]);
  return (
    <div className="code-scroll">
      <div className="code-blocks">
        <Blocks blocks={view.blocks ?? []} fallbackText="" surface={surface} />
      </div>
    </div>
  );
}

function PullRequestView({ view }: { view: ViewDetail }) {
  return (
    <div className="code-scroll">
      <a className="code-pr" href={view.pr_url} target="_blank" rel="noopener noreferrer" aria-label={`${S.code.openPullRequest} (${S.code.opensNewTab})`}>
        <GitPullRequest size={22} aria-hidden="true" />
        <span className="code-pr-body">
          <strong>{view.name}</strong>
          <span className="code-pr-url">{view.pr_url}</span>
        </span>
        <ExternalLink size={16} aria-hidden="true" />
      </a>
    </div>
  );
}

/** The open view tab: fetched when it opens and whenever the agent changes it. */
export function CodeViewBody({ channel, view }: { channel: string; view: AgentSessionView }) {
  const [detail, setDetail] = useState<ViewDetail | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setFailed(null);
    loadView(channel, view.view_id)
      .then((next) => live && setDetail(next))
      .catch((error: unknown) => live && setFailed(error instanceof ApiError && error.code === 'view_not_found' ? S.code.gone : S.code.viewFailed));
    return () => {
      live = false;
    };
  }, [channel, view.view_id, view.content_version]);

  let body;
  if (failed) body = <p className="code-empty">{failed}</p>;
  else if (!detail || detail.view_id !== view.view_id) body = <Loading />;
  else if (detail.type === 'html') body = <HtmlView view={detail} />;
  else if (detail.type === 'diff') body = <DiffView view={detail} />;
  else if (detail.type === 'block_kit') body = <BlockKitView channel={channel} view={detail} />;
  else if (detail.type === 'pull_request') body = <PullRequestView view={detail} />;
  else if (detail.type === 'canvas' && detail.canvas_id) {
    body = (
      <Suspense fallback={<Loading />}>
        <DocPage key={detail.canvas_id} kind="canvas" id={detail.canvas_id} channel={channel} canComment={detail.access_level !== 'read'} />
      </Suspense>
    );
  } else body = <p className="code-empty">{S.code.viewFailed}</p>;
  return (
    <section className={`code-view is-${view.type}`} data-code-view={view.type} aria-label={viewLabel(view)}>
      {body}
    </section>
  );
}
