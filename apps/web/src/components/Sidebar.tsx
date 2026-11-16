import type { Conversation } from '@app/shared';
import { BellOff, ChevronDown, Compass, Hash, Lock, LogOut, Moon, PenSquare, Plus, Search, Settings, ShieldCheck, Smile, Sun, UserPlus, UserRound, Users } from 'lucide-react';
import { memo, useRef, useState, type ReactNode } from 'react';
import { attempt, go, openModal, signOut } from '../lib/actions';
import { asset, call } from '../lib/api';
import { conversationName, currentId, useStore } from '../lib/store';
import { S } from '../strings';
import { Emoji } from './text';
import { Avatar, IconButton, MenuDivider, MenuItem, Popover } from './ui';

const SidebarItem = memo(function SidebarItem({ id }: { id: string }) {
  const conv = useStore((state) => state.channels[id]);
  const selected = useStore((state) => currentId(state) === id);
  const name = useStore((state) => conversationName(state, state.channels[id]));
  const other = useStore((state) => {
    const item = state.channels[id];
    return item?.is_im ? state.users[item.user ?? ''] : undefined;
  });
  const isSelf = useStore((state) => state.channels[id]?.is_im === true && state.channels[id]?.user === state.self?.id);
  if (!conv) return null;

  const unread = (conv.unread_count ?? 0) > 0 && !conv.is_muted;
  const mentions = conv.mention_count ?? 0;
  let icon: ReactNode;
  if (conv.is_im) icon = <Avatar user={other} size={20} presence />;
  else if (conv.is_mpim) icon = <span className="side-count">{Math.max(1, (conv.members?.length ?? 2) - 1)}</span>;
  else if (conv.is_private) icon = <Lock size={15} />;
  else icon = <Hash size={16} />;

  return (
    <a
      href={`/c/${id}`}
      className={`side-item ${selected ? 'is-selected' : ''} ${unread ? 'is-unread' : ''} ${conv.is_muted ? 'is-muted' : ''}`}
      aria-current={selected ? 'page' : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        go({ name: 'conversation', id });
      }}
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
      {conv.is_muted ? <BellOff size={13} className="side-muted" /> : null}
      {mentions > 0 ? <span className="badge">{mentions > 99 ? '99+' : mentions}</span> : null}
    </a>
  );
});

function byName(names: Map<string, string>) {
  return (a: Conversation, b: Conversation): number => (names.get(a.id) ?? '').localeCompare(names.get(b.id) ?? '');
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="side-section">
      <header className="side-section-head">
        <h3>{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

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
          <MenuDivider />
          <MenuItem icon={<LogOut size={16} />} label={S.sidebar.signOut} onSelect={pick(() => void signOut())} />
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
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!self) return null;
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const away = presence !== 'active';
  return (
    <>
      <button ref={anchor} type="button" className="me-strip" onClick={() => setOpen(true)} aria-haspopup="menu">
        <Avatar user={self} size={34} presence />
        <span className="me-meta">
          <span className="me-name">{self.profile.display_name || self.real_name}</span>
          <span className="me-status">
            {self.profile.status_emoji ? <Emoji name={self.profile.status_emoji.replace(/:/g, '')} /> : null}
            {self.profile.status_text || (away ? S.profile.away : S.profile.active)}
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
          <MenuItem icon={<Settings size={16} />} label={S.sidebar.preferences} onSelect={pick(() => openModal({ kind: 'preferences' }))} />
          <MenuDivider />
          <MenuItem icon={<LogOut size={16} />} label={S.sidebar.signOut} onSelect={pick(() => void signOut())} />
        </Popover>
      ) : null}
    </>
  );
}

export function Sidebar() {
  const channels = useStore((state) => state.channels);
  const users = useStore((state) => state.users);
  const selfId = useStore((state) => state.self?.id);
  const state = useStore.getState();

  const all = Object.values(channels);
  const names = new Map(all.map((conv) => [conv.id, conversationName({ ...state, channels, users }, conv)]));
  const starred = all.filter((conv) => conv.is_starred).sort(byName(names));
  const regular = all.filter((conv) => conv.is_channel && !conv.is_starred).sort(byName(names));
  const direct = all
    .filter((conv) => (conv.is_im || conv.is_mpim) && !conv.is_starred)
    .sort((a, b) => {
      // The viewer's own space first, then most recently active.
      const selfA = a.is_im && a.user === selfId ? 1 : 0;
      const selfB = b.is_im && b.user === selfId ? 1 : 0;
      if (selfA !== selfB) return selfB - selfA;
      return (b.latest_ts ?? '') < (a.latest_ts ?? '') ? -1 : 1;
    });

  return (
    <nav className="sidebar" aria-label={S.sidebar.channels}>
      <header className="side-head">
        <TeamMenu />
        <IconButton className="compose-btn" label={S.sidebar.newMessage} onClick={() => openModal({ kind: 'newDm' })}>
          <PenSquare size={17} />
        </IconButton>
      </header>
      <button type="button" className="side-search" onClick={() => openModal({ kind: 'switcher' })}>
        <Search size={15} />
        <span>{S.topbar.searchShort}</span>
      </button>
      <div className="side-scroll">
        {starred.length > 0 ? (
          <Section title={S.sidebar.starred}>
            {starred.map((conv) => (
              <SidebarItem key={conv.id} id={conv.id} />
            ))}
          </Section>
        ) : null}
        <Section title={S.sidebar.channels} action={<AddChannelButton />}>
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
