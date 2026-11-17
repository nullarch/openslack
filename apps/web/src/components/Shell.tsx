import { BRAND } from '@app/shared';
import { AccountsModalHost } from './accounts/ModalHost';
import { Search, WifiOff } from 'lucide-react';
import { useEffect } from 'react';
import { closeModal, go, openModal, setPanel } from '../lib/actions';
import { enableNotifications } from '../lib/notify';
import { conversation, conversationName, currentId, get, set, useStore } from '../lib/store';
import { S } from '../strings';
import { AppModalHost } from './AppViews';
import { ConversationView } from './Conversation';
import { AdminDialog } from './dialogs/admin';
import { AddPeopleDialog, BrowseChannelsDialog, CreateChannelDialog, InviteDialog, NewDmDialog } from './dialogs/channels';
import { EditProfileDialog, PreferencesDialog } from './dialogs/settings';
import { ImageViewer } from './files';
import { DetailsPanel, ProfilePanel, ThreadPanel } from './panels';
import { QuickSwitcher, SearchView } from './Search';
import { Sidebar } from './Sidebar';
import { Button, Mark, Modal } from './ui';
import type { ViewName } from '../lib/router';
import { BookmarkDialog, DndScheduleDialog, ForwardDialog, ScheduleDialog, ShareFileDialog, SnippetDialog } from './dialogs/attention';
import { ActivityView, ThreadsView, UnreadsView } from './views/Activity';
import { DraftsView, FilesView, LaterView } from './views/Later';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

function TopBar() {
  const team = useStore((state) => state.team);
  const connection = useStore((state) => state.connection);
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <Mark size={22} />
      </div>
      <button type="button" className="topbar-search" onClick={() => openModal({ kind: 'switcher' })}>
        <Search size={15} />
        <span>{S.topbar.search(team?.name ?? '')}</span>
        <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <div className="topbar-status">
        {connection !== 'online' ? (
          <span className="conn-pill" role="status">
            <WifiOff size={14} /> {S.sidebar.reconnecting}
          </span>
        ) : null}
      </div>
    </header>
  );
}

function ModalHost() {
  const modal = useStore((state) => state.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case 'createChannel':
      return <CreateChannelDialog />;
    case 'browse':
      return <BrowseChannelsDialog />;
    case 'newDm':
      return <NewDmDialog />;
    case 'invite':
      return <InviteDialog />;
    case 'preferences':
      return <PreferencesDialog />;
    case 'editProfile':
      return <EditProfileDialog />;
    case 'admin':
      return <AdminDialog tab={modal.tab} />;
    case 'switcher':
      return <QuickSwitcher />;
    case 'addPeople':
      return <AddPeopleDialog channel={modal.channel} />;
    case 'image':
      return (
        <Modal title={modal.file.title || modal.file.name} onClose={closeModal} width={1100} className="image-modal">
          <ImageViewer file={modal.file} />
        </Modal>
      );
    case 'forward':
      return <ForwardDialog channel={modal.channel} ts={modal.ts} />;
    case 'shareFile':
      return <ShareFileDialog file={modal.file} />;
    case 'schedule':
      return <ScheduleDialog channel={modal.channel} threadTs={modal.threadTs} text={modal.text} broadcast={modal.broadcast} />;
    case 'dndSchedule':
      return <DndScheduleDialog />;
    case 'snippet':
      return <SnippetDialog channel={modal.channel} threadTs={modal.threadTs} />;
    case 'bookmark':
      return <BookmarkDialog channel={modal.channel} bookmark={modal.bookmark} />;
  }
}

function WorkspaceView({ view }: { view: ViewName }) {
  switch (view) {
    case 'activity':
      return <ActivityView />;
    case 'threads':
      return <ThreadsView />;
    case 'unreads':
      return <UnreadsView />;
    case 'later':
      return <LaterView />;
    case 'drafts':
      return <DraftsView />;
    case 'files':
      return <FilesView />;
  }
}

function NotifyPrompt() {
  const show = useStore((state) => state.notifyPrompt);
  if (!show) return null;
  return (
    <div className="notify-prompt" role="alert">
      <span>
        <strong>{S.prefs.promptTitle}</strong> {S.prefs.promptBody}
      </span>
      <Button size="sm" variant="primary" onClick={() => void enableNotifications()}>
        {S.prefs.notificationsEnable}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => set({ notifyPrompt: false })}>
        {S.prefs.promptDismiss}
      </Button>
    </div>
  );
}

/** Keep the tab title in step with where the viewer is and what is waiting for them. */
function useTitle(): void {
  const title = useStore((state) => {
    const mentions = Object.values(state.channels).reduce((sum, channel) => sum + (channel.is_muted ? 0 : (channel.mention_count ?? 0)), 0);
    const unread = Object.values(state.channels).some((channel) => !channel.is_muted && (channel.unread_count ?? 0) > 0);
    const conv = conversation(state, currentId(state));
    const place =
      state.route.name === 'search'
        ? S.search.placeholder
        : state.route.name === 'view'
          ? S.att.nav[state.route.view]
          : conv
            ? `${conv.is_channel ? '#' : ''}${conversationName(state, conv)}`
            : '';
    const prefix = mentions > 0 ? `(${mentions}) ` : unread ? '• ' : '';
    return `${prefix}${[place, state.team?.name, BRAND.name].filter(Boolean).join(' | ')}`;
  });
  useEffect(() => {
    document.title = title;
  }, [title]);
}

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const state = get();
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (state.modal?.kind === 'switcher') closeModal();
        else openModal({ kind: 'switcher' });
        return;
      }
      // Find in this conversation: a search scoped to it.
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'f' && state.route.name === 'conversation') {
        const conv = conversation(state, state.route.id);
        if (!conv) return;
        event.preventDefault();
        const scope = conv.is_channel ? `in:#${conv.name}` : conv.is_im ? `in:@${state.users[conv.user ?? '']?.name ?? ''}` : '';
        if (scope) go({ name: 'search', query: `${scope} ` });
        return;
      }
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (state.modal) closeModal();
      else if (state.drawer) set({ drawer: false });
      else if (state.editing) set({ editing: null });
      else if (state.panel) setPanel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function Shell() {
  const route = useStore((state) => state.route);
  const panel = useStore((state) => state.panel);
  const drawer = useStore((state) => state.drawer);
  useTitle();
  useShortcuts();

  return (
    <div className={`frame ${drawer ? 'is-drawer-open' : ''} ${panel ? 'has-panel' : ''}`}>
      <TopBar />
      <div className="frame-body">
        <Sidebar />
        <button type="button" className="drawer-scrim" aria-label={S.close} onClick={() => set({ drawer: false })} />
        <main className="sheet">
          <NotifyPrompt />
          <div className="sheet-row">
            {route.name === 'search' ? (
              <SearchView query={route.query} />
            ) : route.name === 'conversation' ? (
              <ConversationView channel={route.id} />
            ) : route.name === 'view' ? (
              <WorkspaceView view={route.view} />
            ) : (
              <section className="conversation" />
            )}
            {panel?.kind === 'thread' ? <ThreadPanel key={`${panel.channel}:${panel.ts}`} channel={panel.channel} ts={panel.ts} /> : null}
            {panel?.kind === 'profile' ? <ProfilePanel userId={panel.user} /> : null}
            {panel?.kind === 'details' ? <DetailsPanel channel={panel.channel} tab={panel.tab} /> : null}
          </div>
        </main>
      </div>
      <ModalHost />
      <AppModalHost />
      <AccountsModalHost />
    </div>
  );
}
