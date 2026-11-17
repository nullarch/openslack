import type { Conversation } from '@app/shared';
import {
  AtSign,
  Bell,
  BellOff,
  Bookmark as BookmarkIcon,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Compass,
  FileStack,
  FileText,
  ListChecks,
  FolderInput,
  FolderMinus,
  FolderPlus,
  Hash,
  Inbox,
  Lock,
  LogOut,
  Moon,
  MoreHorizontal,
  MessagesSquare,
  PenSquare,
  Pencil,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Smile,
  Star,
  Sun,
  Trash2,
  UserPlus,
  UserRound,
  Users,
  Workflow,
} from 'lucide-react';
import { memo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { attempt, go, markRead, openModal, setConversationPrefs, setPrefs, signOut } from '../lib/actions';
import { asset, call } from '../lib/api';
import { resumeNotifications, selfDndUntil, setNotifyLevel, snooze, userInDnd, whenText, type NotifyLevel } from '../lib/attention';
import type { ViewName } from '../lib/router';
import { conversationName, currentId, get, useStore } from '../lib/store';
import { S } from '../strings';
import { SidebarHuddleBadge } from './Huddle';
import { AiMenuItems } from './ai/AiControls';
import { confirmDialog, promptDialog } from './dialogs/confirm';
import { Emoji } from './text';
import { Avatar, IconButton, MenuDivider, MenuItem, Popover } from './ui';

// ── Sidebar preferences (kept in the person's preferences, so they follow them) ──

interface CustomSection {
  id: string;
  name: string;
  channel_ids: string[];
}

type SortOrder = 'alpha' | 'recent';

function sections(): CustomSection[] {
  const value = get().prefs.sidebar_sections;
  return Array.isArray(value) ? (value as CustomSection[]).filter((item) => item && typeof item.id === 'string') : [];
}

function sortOf(sectionId: string): SortOrder {
  const value = get().prefs.sidebar_sort as Record<string, SortOrder> | undefined;
  return value?.[sectionId] ?? (sectionId === 'direct' ? 'recent' : 'alpha');
}

function saveSections(next: CustomSection[]): void {
  void setPrefs({ sidebar_sections: next });
}

async function createSection(withChannel?: string): Promise<void> {
  const name = await promptDialog({ title: S.att.sections.newSection.replace('…', ''), label: S.att.sections.sectionName, confirmLabel: S.done });
  if (!name?.trim()) return;
  const id = `s${Date.now().toString(36)}`;
  const rest = sections().map((section) => ({ ...section, channel_ids: section.channel_ids.filter((channel) => channel !== withChannel) }));
  saveSections([...rest, { id, name: name.trim().slice(0, 60), channel_ids: withChannel ? [withChannel] : [] }]);
}

function moveToSection(channel: string, sectionId: string | null): void {
  saveSections(
    sections().map((section) => ({
      ...section,
      channel_ids: section.id === sectionId ? [...section.channel_ids.filter((id) => id !== channel), channel] : section.channel_ids.filter((id) => id !== channel),
    })),
  );
}

// ── Items ───────────────────────────────────────────────────────────────────

function ItemMenu({ id, anchor, onClose }: { id: string; anchor: HTMLElement | null; onClose: () => void }) {
  const conv = useStore((state) => state.channels[id]);
  const all = useStore((state) => state.prefs.sidebar_sections);
  const list = Array.isArray(all) ? (all as CustomSection[]) : [];
  if (!conv) return null;
  const current = list.find((section) => section.channel_ids.includes(id));
  const pick = (action: () => void) => () => {
    onClose();
    action();
  };
  const level = conv.notify_level ?? 'default';
  const levels: [NotifyLevel, string][] = [
    ['default', S.att.notify.default],
    ['all', S.att.notify.all],
    ['mentions', S.att.notify.mentions],
    ['nothing', S.att.notify.nothing],
  ];
  return (
    <Popover anchor={anchor} onClose={onClose} className="menu side-menu">
      {(conv.unread_count ?? 0) > 0 && conv.latest_ts ? <MenuItem icon={<CheckCheck size={16} />} label={S.att.unreads.markRead} onSelect={pick(() => markRead(id, conv.latest_ts!))} /> : null}
      <MenuItem
        icon={<Star size={16} />}
        label={conv.is_starred ? S.header.unstar : S.header.star}
        onSelect={pick(() => void setConversationPrefs(id, { starred: !conv.is_starred }))}
      />
      <MenuItem
        icon={conv.is_muted ? <Bell size={16} /> : <BellOff size={16} />}
        label={conv.is_muted ? S.att.notify.unmute : S.att.notify.mute}
        onSelect={pick(() => void setConversationPrefs(id, { muted: !conv.is_muted }))}
      />
      <MenuDivider />
      <div className="menu-heading">{S.att.notify.menu}</div>
      {levels.map(([value, label]) => (
        <MenuItem key={value} icon={level === value ? <CheckCheck size={16} /> : <span />} label={label} onSelect={pick(() => void setNotifyLevel(id, value))} />
      ))}
      <MenuDivider />
      <div className="menu-heading">{S.att.sections.moveTo}</div>
      {list
        .filter((section) => section.id !== current?.id)
        .map((section) => (
          <MenuItem key={section.id} icon={<FolderInput size={16} />} label={section.name} onSelect={pick(() => moveToSection(id, section.id))} />
        ))}
      <MenuItem icon={<FolderPlus size={16} />} label={S.att.sections.newSection} onSelect={pick(() => void createSection(id))} />
      {current ? <MenuItem icon={<FolderMinus size={16} />} label={S.att.sections.moveOut} onSelect={pick(() => moveToSection(id, null))} /> : null}
    </Popover>
  );
}

const SidebarItem = memo(function SidebarItem({ id }: { id: string }) {
  const conv = useStore((state) => state.channels[id]);
  const selected = useStore((state) => currentId(state) === id);
  const name = useStore((state) => conversationName(state, state.channels[id]));
  const other = useStore((state) => {
    const item = state.channels[id];
    return item?.is_im ? state.users[item.user ?? ''] : undefined;
  });
  const isSelf = useStore((state) => state.channels[id]?.is_im === true && state.channels[id]?.user === state.self?.id);
  const paused = useStore((state) => {
    void state.att.tick;
    const item = state.channels[id];
    return Boolean(item?.is_im && item.user && item.user !== state.self?.id && userInDnd(item.user));
  });
  const ref = useRef<HTMLAnchorElement>(null);
  const [menu, setMenu] = useState(false);
  if (!conv) return null;

  const unread = (conv.unread_count ?? 0) > 0 && !conv.is_muted;
  const mentions = conv.mention_count ?? 0;
  let icon: ReactNode;
  if (conv.is_im) icon = <Avatar user={other} size={20} presence />;
  else if (conv.is_mpim) icon = <span className="side-count">{Math.max(1, (conv.members?.length ?? 2) - 1)}</span>;
  else if (conv.is_private) icon = <Lock size={15} />;
  else icon = <Hash size={16} />;

  const openMenu = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    setMenu(true);
  };

  return (
    <>
      <a
        ref={ref}
        href={`/c/${id}`}
        className={`side-item ${selected ? 'is-selected' : ''} ${unread ? 'is-unread' : ''} ${conv.is_muted ? 'is-muted' : ''}`}
        aria-current={selected ? 'page' : undefined}
        data-channel={id}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey) return;
          event.preventDefault();
          go({ name: 'conversation', id });
        }}
        onContextMenu={openMenu}
      >
        <span className="side-icon">{icon}</span>
        <span className="side-name">{name}</span>
        {isSelf ? <span className="side-you">{S.sidebar.you}</span> : null}
        {other?.is_bot ? <span className="tag tag-side">{S.sidebar.app}</span> : null}
        {other?.profile.status_emoji ? (
          <span className="side-status">
            <Emoji name={other.profile.status_emoji.replace(/:/g, '')} />
          </span>
        ) : null}
        {paused ? <Moon size={13} className="side-dnd" aria-label={S.att.dnd.label} /> : null}
        {conv.is_muted ? <BellOff size={13} className="side-muted" /> : null}
        <SidebarHuddleBadge channel={id} />
        {mentions > 0 ? <span className="badge">{mentions > 99 ? '99+' : mentions}</span> : null}
        <button type="button" className="side-more" aria-label={S.att.sections.itemOptions} title={S.att.sections.itemOptions} onClick={openMenu}>
          <MoreHorizontal size={15} />
        </button>
      </a>
      {menu ? <ItemMenu id={id} anchor={ref.current} onClose={() => setMenu(false)} /> : null}
    </>
  );
});

// ── Navigation to workspace-wide views ──────────────────────────────────────

function NavItem({ view, icon, badge, bold }: { view: ViewName; icon: ReactNode; badge?: number; bold?: boolean }) {
  const selected = useStore((state) => state.route.name === 'view' && state.route.view === view);
  return (
    <a
      href={`/${view}`}
      className={`side-item side-nav ${selected ? 'is-selected' : ''} ${bold ? 'is-unread' : ''}`}
      aria-current={selected ? 'page' : undefined}
      data-view={view}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        go({ name: 'view', view });
      }}
    >
      <span className="side-icon">{icon}</span>
      <span className="side-name">{S.att.nav[view]}</span>
      {badge ? <span className={`badge ${view === 'activity' ? '' : 'is-soft'}`}>{badge > 99 ? '99+' : badge}</span> : null}
    </a>
  );
}

function SideNav() {
  const activity = useStore((state) => state.att.activityUnread);
  const threads = useStore((state) => Object.keys(state.att.unreadThreads).length);
  const unreads = useStore((state) => Object.values(state.channels).some((conv) => !conv.is_muted && (conv.unread_count ?? 0) > 0));
  const later = useStore((state) => Object.values(state.att.saved).filter((value) => value === 'in_progress').length);
  const drafts = useStore((state) => Object.keys(state.att.drafts).length + state.att.scheduledCount);
  return (
    <nav className="side-nav-list" aria-label={S.att.nav.activity}>
      <NavItem view="activity" icon={<AtSign size={16} />} badge={activity} bold={activity > 0} />
      <NavItem view="threads" icon={<MessagesSquare size={16} />} bold={threads > 0} badge={threads} />
      <NavItem view="unreads" icon={<Inbox size={16} />} bold={unreads} />
      <NavItem view="later" icon={<BookmarkIcon size={16} />} badge={later} />
      <NavItem view="drafts" icon={<Send size={16} />} badge={drafts} />
      <NavItem view="files" icon={<FileStack size={16} />} />
      <NavItem view="canvases" icon={<FileText size={16} />} />
      <NavItem view="lists" icon={<ListChecks size={16} />} />
    </nav>
  );
}

// ── Sections ────────────────────────────────────────────────────────────────

function byName(names: Map<string, string>) {
  return (a: Conversation, b: Conversation): number => (names.get(a.id) ?? '').localeCompare(names.get(b.id) ?? '');
}

function byRecent(a: Conversation, b: Conversation): number {
  return (b.latest_ts ?? '') < (a.latest_ts ?? '') ? -1 : (b.latest_ts ?? '') > (a.latest_ts ?? '') ? 1 : 0;
}

function SectionMenu({ id, custom, anchor, onClose }: { id: string; custom?: CustomSection; anchor: HTMLElement | null; onClose: () => void }) {
  const sort = useStore((state) => (state.prefs.sidebar_sort as Record<string, SortOrder> | undefined)?.[id] ?? (id === 'direct' ? 'recent' : 'alpha'));
  const pick = (action: () => void) => () => {
    onClose();
    action();
  };
  const setSort = (value: SortOrder): void => void setPrefs({ sidebar_sort: { ...((get().prefs.sidebar_sort as object) ?? {}), [id]: value } });
  return (
    <Popover anchor={anchor} onClose={onClose} className="menu">
      <MenuItem icon={sort === 'alpha' ? <CheckCheck size={16} /> : <span />} label={S.att.sections.sortAlpha} onSelect={pick(() => setSort('alpha'))} />
      <MenuItem icon={sort === 'recent' ? <CheckCheck size={16} /> : <span />} label={S.att.sections.sortRecent} onSelect={pick(() => setSort('recent'))} />
      {custom ? (
        <>
          <MenuDivider />
          <MenuItem
            icon={<Pencil size={16} />}
            label={S.att.sections.rename}
            onSelect={pick(() => {
              void promptDialog({ title: S.att.sections.rename, label: S.att.sections.sectionName, initial: custom.name, confirmLabel: S.done }).then((name) => {
                if (name?.trim()) saveSections(sections().map((section) => (section.id === custom.id ? { ...section, name: name.trim().slice(0, 60) } : section)));
              });
            })}
          />
          <MenuItem
            icon={<Trash2 size={16} />}
            label={S.att.sections.delete}
            danger
            onSelect={pick(() => {
              void confirmDialog(custom.name, S.att.sections.delete).then((ok) => {
                if (ok) saveSections(sections().filter((section) => section.id !== custom.id));
              });
            })}
          />
        </>
      ) : null}
    </Popover>
  );
}

function Section({ id, title, action, children, custom }: { id: string; title: string; action?: ReactNode; children: ReactNode; custom?: CustomSection }) {
  const collapsed = useStore((state) => Boolean((state.prefs.sidebar_collapsed as Record<string, boolean> | undefined)?.[id]));
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const toggle = (): void => void setPrefs({ sidebar_collapsed: { ...((get().prefs.sidebar_collapsed as object) ?? {}), [id]: !collapsed } });
  return (
    <section className={`side-section ${collapsed ? 'is-collapsed' : ''}`} data-section={id}>
      <header className="side-section-head">
        <button type="button" className="side-section-toggle" onClick={toggle} aria-expanded={!collapsed}>
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <h3>{title}</h3>
        </button>
        <span className="side-section-actions">
          <IconButton ref={menuAnchor} label={S.att.sections.sectionOptions} onClick={() => setMenu(true)}>
            <MoreHorizontal size={15} />
          </IconButton>
          {action}
        </span>
      </header>
      {menu ? <SectionMenu id={id} custom={custom} anchor={menuAnchor.current} onClose={() => setMenu(false)} /> : null}
      {children}
    </section>
  );
}

// ── Menus at the top and bottom ─────────────────────────────────────────────

function TeamMenu() {
  const team = useStore((state) => state.team);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <>
      <button ref={anchor} type="button" className="team-btn" onClick={() => setOpen(true)} aria-label={S.sidebar.menu} aria-haspopup="menu">
        {team ? <img className="team-icon" src={asset(team.icon.image_68)} alt="" width={26} height={26} /> : null}
        <span className="team-name">{team?.name}</span>
        <ChevronDown size={15} />
      </button>
      {open ? (
        <Popover anchor={anchor.current} onClose={() => setOpen(false)} className="menu">
          <MenuItem icon={<UserPlus size={16} />} label={S.sidebar.invitePeople} onSelect={pick(() => openModal({ kind: 'invite' }))} />
          <MenuItem icon={<Compass size={16} />} label={S.sidebar.browseChannels} onSelect={pick(() => openModal({ kind: 'browse' }))} />
          <MenuItem icon={<ShieldCheck size={16} />} label={S.sidebar.administration} onSelect={pick(() => openModal({ kind: 'admin', tab: 'members' }))} />
          <MenuItem icon={<Settings size={16} />} label={S.sidebar.preferences} onSelect={pick(() => openModal({ kind: 'preferences' }))} />
          <AiMenuItems pick={pick} />
          <MenuItem icon={<Workflow size={16} />} label={S.wf.menu} onSelect={pick(() => go({ name: 'workflows' }))} />
          <MenuDivider />
          <MenuItem icon={<LogOut size={16} />} label={S.sidebar.signOut} onSelect={pick(() => void signOut())} />
        </Popover>
      ) : null}
    </>
  );
}

function SidebarOptions() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const filter = useStore((state) => (state.prefs.sidebar_filter === 'unreads' ? 'unreads' : 'all'));
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <>
      <IconButton ref={anchor} className={`compose-btn ${filter === 'unreads' ? 'is-on' : ''}`} label={S.att.sections.options} onClick={() => setOpen(true)}>
        <SlidersHorizontal size={16} />
      </IconButton>
      {open ? (
        <Popover anchor={anchor.current} onClose={() => setOpen(false)} className="menu">
          <MenuItem icon={filter === 'all' ? <CheckCheck size={16} /> : <span />} label={S.att.sections.showAll} onSelect={pick(() => void setPrefs({ sidebar_filter: 'all' }))} />
          <MenuItem icon={filter === 'unreads' ? <CheckCheck size={16} /> : <span />} label={S.att.sections.showUnreads} onSelect={pick(() => void setPrefs({ sidebar_filter: 'unreads' }))} />
          <MenuDivider />
          <MenuItem icon={<FolderPlus size={16} />} label={S.att.sections.newSection} onSelect={pick(() => void createSection())} />
        </Popover>
      ) : null}
    </>
  );
}

function AddChannelButton() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton ref={anchor} label={S.sidebar.addChannel} onClick={() => setOpen(true)}>
        <Plus size={16} />
      </IconButton>
      {open ? (
        <Popover anchor={anchor.current} onClose={() => setOpen(false)} className="menu">
          <MenuItem
            icon={<Plus size={16} />}
            label={S.sidebar.createChannel}
            onSelect={() => {
              setOpen(false);
              openModal({ kind: 'createChannel' });
            }}
          />
          <MenuItem
            icon={<Compass size={16} />}
            label={S.sidebar.browseChannels}
            onSelect={() => {
              setOpen(false);
              openModal({ kind: 'browse' });
            }}
          />
        </Popover>
      ) : null}
    </>
  );
}

function MeStrip() {
  const self = useStore((state) => state.self);
  const presence = useStore((state) => (state.self ? state.presence[state.self.id] : undefined));
  const pausedUntil = useStore((state) => {
    void state.att.tick;
    void state.att.dnd.self;
    return selfDndUntil();
  });
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!self) return null;
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const away = presence !== 'active';
  const untilTomorrow = (): number => {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    date.setHours(9, 0, 0, 0);
    return Math.max(1, Math.round((date.getTime() - Date.now()) / 60_000));
  };
  return (
    <>
      <button ref={anchor} type="button" className={`me-strip ${pausedUntil ? 'is-paused' : ''}`} onClick={() => setOpen(true)} aria-haspopup="menu">
        <span className="me-avatar">
          <Avatar user={self} size={34} presence />
          {pausedUntil ? <Moon size={12} className="me-dnd" /> : null}
        </span>
        <span className="me-meta">
          <span className="me-name">{self.profile.display_name || self.real_name}</span>
          <span className="me-status">
            {pausedUntil ? (
              S.att.dnd.paused(whenText(pausedUntil).replace(/^at /, ''))
            ) : (
              <>
                {self.profile.status_emoji ? <Emoji name={self.profile.status_emoji.replace(/:/g, '')} /> : null}
                {self.profile.status_text || (away ? S.profile.away : S.profile.active)}
              </>
            )}
          </span>
        </span>
        <Settings size={16} className="me-gear" />
      </button>
      {open ? (
        <Popover anchor={anchor.current} onClose={() => setOpen(false)} side="top" className="menu">
          <MenuItem icon={<Smile size={16} />} label={S.sidebar.setStatus} onSelect={pick(() => openModal({ kind: 'editProfile' }))} />
          <MenuItem icon={<UserRound size={16} />} label={S.sidebar.editProfile} onSelect={pick(() => openModal({ kind: 'editProfile' }))} />
          <MenuItem
            icon={away ? <Sun size={16} /> : <Moon size={16} />}
            label={away ? S.sidebar.setActive : S.sidebar.setAway}
            onSelect={pick(() => void attempt(() => call('users.setPresence', { presence: away ? 'auto' : 'away' })))}
          />
          <MenuDivider />
          <div className="menu-heading">{pausedUntil ? S.att.dnd.paused(whenText(pausedUntil).replace(/^at /, '')) : S.att.dnd.pause}</div>
          {pausedUntil ? <MenuItem icon={<Bell size={16} />} label={S.att.dnd.resume} onSelect={pick(() => void resumeNotifications())} /> : null}
          <MenuItem icon={<BellOff size={16} />} label={S.att.dnd.for30} onSelect={pick(() => void snooze(30))} />
          <MenuItem icon={<BellOff size={16} />} label={S.att.dnd.for1h} onSelect={pick(() => void snooze(60))} />
          <MenuItem icon={<BellOff size={16} />} label={S.att.dnd.for2h} onSelect={pick(() => void snooze(120))} />
          <MenuItem icon={<BellOff size={16} />} label={S.att.dnd.untilTomorrow} onSelect={pick(() => void snooze(untilTomorrow()))} />
          <MenuItem icon={<Moon size={16} />} label={S.att.dnd.schedule} onSelect={pick(() => openModal({ kind: 'dndSchedule' }))} />
          <MenuDivider />
          <MenuItem icon={<Settings size={16} />} label={S.sidebar.preferences} onSelect={pick(() => openModal({ kind: 'preferences' }))} />
          <MenuDivider />
          <MenuItem icon={<LogOut size={16} />} label={S.sidebar.signOut} onSelect={pick(() => void signOut())} />
        </Popover>
      ) : null}
    </>
  );
}

// ── Sidebar ─────────────────────────────────────────────────────────────────

export function Sidebar() {
  const channels = useStore((state) => state.channels);
  const users = useStore((state) => state.users);
  const selfId = useStore((state) => state.self?.id);
  const prefs = useStore((state) => state.prefs);
  const current = useStore((state) => currentId(state));
  const state = useStore.getState();

  const custom = Array.isArray(prefs.sidebar_sections) ? (prefs.sidebar_sections as CustomSection[]) : [];
  const placed = new Set(custom.flatMap((section) => section.channel_ids));
  const onlyUnread = prefs.sidebar_filter === 'unreads';
  const all = Object.values(channels).filter(
    // With "only unread", keep what is unread, what has mentions, and the open conversation.
    (conv) => !onlyUnread || conv.id === current || ((conv.unread_count ?? 0) > 0 && !conv.is_muted) || (conv.mention_count ?? 0) > 0,
  );
  const names = new Map(all.map((conv) => [conv.id, conversationName({ ...state, channels, users }, conv)]));
  const order = (id: string, list: Conversation[]): Conversation[] => {
    const sort = sortOf(id);
    if (id === 'direct' && sort === 'recent') {
      // The viewer's own space first, then most recently active.
      return list.sort((a, b) => {
        const selfA = a.is_im && a.user === selfId ? 1 : 0;
        const selfB = b.is_im && b.user === selfId ? 1 : 0;
        if (selfA !== selfB) return selfB - selfA;
        return byRecent(a, b);
      });
    }
    return list.sort(sort === 'recent' ? byRecent : byName(names));
  };
  const starred = order('starred', all.filter((conv) => conv.is_starred && !placed.has(conv.id)));
  const regular = order('channels', all.filter((conv) => conv.is_channel && !conv.is_starred && !placed.has(conv.id)));
  const direct = order('direct', all.filter((conv) => (conv.is_im || conv.is_mpim) && !conv.is_starred && !placed.has(conv.id)));

  return (
    <nav className="sidebar" aria-label={S.sidebar.channels}>
      <header className="side-head">
        <TeamMenu />
        <SidebarOptions />
        <IconButton className="compose-btn" label={S.sidebar.newMessage} onClick={() => openModal({ kind: 'newDm' })}>
          <PenSquare size={17} />
        </IconButton>
      </header>
      <button type="button" className="side-search" onClick={() => openModal({ kind: 'switcher' })}>
        <Search size={15} />
        <span>{S.topbar.searchShort}</span>
      </button>
      <div className="side-scroll">
        <SideNav />
        {starred.length > 0 ? (
          <Section id="starred" title={S.sidebar.starred}>
            {starred.map((conv) => (
              <SidebarItem key={conv.id} id={conv.id} />
            ))}
          </Section>
        ) : null}
        {custom.map((section) => {
          const members = order(
            section.id,
            section.channel_ids.map((id) => all.find((conv) => conv.id === id)).filter((conv): conv is Conversation => conv !== undefined),
          );
          return (
            <Section key={section.id} id={section.id} title={section.name} custom={section}>
              {members.map((conv) => (
                <SidebarItem key={conv.id} id={conv.id} />
              ))}
            </Section>
          );
        })}
        <Section id="channels" title={S.sidebar.channels} action={<AddChannelButton />}>
          {regular.map((conv) => (
            <SidebarItem key={conv.id} id={conv.id} />
          ))}
          <button type="button" className="side-item side-add" onClick={() => openModal({ kind: 'browse' })}>
            <span className="side-icon">
              <Plus size={15} />
            </span>
            <span className="side-name">{S.sidebar.addChannel}</span>
          </button>
        </Section>
        <Section
          id="direct"
          title={S.sidebar.directMessages}
          action={
            <IconButton label={S.sidebar.newMessage} onClick={() => openModal({ kind: 'newDm' })}>
              <Plus size={16} />
            </IconButton>
          }
        >
          {direct.map((conv) => (
            <SidebarItem key={conv.id} id={conv.id} />
          ))}
          <button type="button" className="side-item side-add" onClick={() => openModal({ kind: 'invite' })}>
            <span className="side-icon">
              <Users size={15} />
            </span>
            <span className="side-name">{S.sidebar.invitePeople}</span>
          </button>
        </Section>
      </div>
      <MeStrip />
    </nav>
  );
}
