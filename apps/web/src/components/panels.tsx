import { escapeText, type Conversation, type Message, type User } from '@app/shared';
import { BellOff, Bell, BellRing, LogOut, MessageSquare, Pencil, UserMinus, UserPlus, X, Archive, ArchiveRestore } from 'lucide-react';
import { markThreadSeen, setThreadFollow } from '../lib/attention';
import { PostingPermissions } from './Posting';
import { FileList } from './views/Later';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  attempt,
  closeDirect,
  go,
  leaveChannel,
  openDirect,
  openMessage,
  openModal,
  sendMessage,
  setConversationPrefs,
  setPanel,
} from '../lib/actions';
import { call } from '../lib/api';
import { conversation, conversationName, displayName, EMPTY_THREAD, threadKey, useStore, type LocalMessage } from '../lib/store';
import { localTime } from '../lib/time';
import { ChannelWebSettings } from './accounts/Admin';
import { ProfileFieldFacts } from './accounts/Profile';
import { S } from '../strings';
import { Composer } from './Composer';
import { editTopic } from './Conversation';
import { confirmDialog, promptDialog } from './dialogs/confirm';
import { MessageRow } from './Message';
import { Emoji, Mrkdwn } from './text';
import { Avatar, Button, IconButton, Spinner } from './ui';

function PanelFrame({ title, subtitle, children, dropLabel, actions }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode; dropLabel?: string; actions?: ReactNode }) {
  // A panel with a composer accepts dropped files anywhere on it.
  const drop = dropLabel ? { 'data-drop-scope': '', 'data-drop-label': dropLabel } : {};
  return (
    <aside className="panel" {...drop}>
      <header className="panel-head">
        <div className="panel-title">
          <h2>{title}</h2>
          {subtitle ? <span>{subtitle}</span> : null}
        </div>
        {actions}
        <IconButton label={S.close} onClick={() => setPanel(null)}>
          <X size={18} />
        </IconButton>
      </header>
      {children}
    </aside>
  );
}

// ── Thread ──────────────────────────────────────────────────────────────────

function sameAuthorRun(previous: LocalMessage | undefined, message: LocalMessage): boolean {
  if (!previous) return false;
  if (previous.user !== message.user || previous.bot_id !== message.bot_id) return false;
  return Number(message.ts) - Number(previous.ts) < 300;
}

export function ThreadPanel({ channel, ts }: { channel: string; ts: string }) {
  const thread = useStore((state) => state.threads[threadKey(channel, ts)]) ?? EMPTY_THREAD;
  const conv = useStore((state) => conversation(state, channel));
  const name = useStore((state) => conversationName(state, conv));
  const isMember = useStore((state) => state.channels[channel] !== undefined);
  const highlight = useStore((state) => state.highlight);
  const statusUser = useStore((state) => state.users[thread.statusUser ?? '']);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && stick.current) node.scrollTop = node.scrollHeight;
  }, [thread.replies, thread.status, thread.loaded]);

  useEffect(() => {
    if (!highlight || highlight.channel !== channel || !thread.loaded) return;
    const node = scroller.current?.querySelector<HTMLElement>(`[data-ts="${highlight.ts}"]`);
    if (node) {
      stick.current = false;
      node.scrollIntoView({ block: 'center' });
    }
  }, [highlight, channel, thread.loaded]);

  const label = conv?.is_channel ? `#${name}` : name;
  const [following, setFollowing] = useState<boolean | null>(null);
  const subscribed = following ?? Boolean((thread.parent as (LocalMessage & { subscribed?: boolean }) | null)?.subscribed);
  const lastReply = thread.replies.filter((reply) => !reply.pending && !reply.failed && !reply.is_ephemeral).at(-1)?.ts;

  // Seeing the end of a followed thread catches you up on it.
  useEffect(() => {
    if (!thread.loaded || !lastReply) return;
    const mark = (): void => {
      if (document.hasFocus() && stick.current) markThreadSeen(channel, ts, lastReply);
    };
    mark();
    window.addEventListener('focus', mark);
    return () => window.removeEventListener('focus', mark);
  }, [thread.loaded, lastReply, channel, ts]);

  const onScroll = (): void => {
    const node = scroller.current;
    if (node) stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  };

  const followButton =
    thread.parent && isMember ? (
      <Button size="sm" className={`follow-btn ${subscribed ? 'is-on' : ''}`} onClick={() => void setThreadFollow(channel, ts, !subscribed).then(setFollowing)}>
        {subscribed ? <BellRing size={14} /> : <Bell size={14} />}
        {subscribed ? S.att.threads.following : S.att.threads.follow}
      </Button>
    ) : null;

  return (
    <PanelFrame title={S.thread.title} subtitle={thread.title ?? label} dropLabel={S.composer.dropHere} actions={followButton}>
      <div className="panel-scroll thread-scroll" ref={scroller} onScroll={onScroll}>
        {!thread.loaded ? (
          <div className="list-loading">
            <Spinner />
          </div>
        ) : !thread.parent ? (
          <p className="panel-empty">{S.thread.notFound}</p>
        ) : (
          <>
            <MessageRow channel={channel} message={thread.parent} inThread highlighted={highlight?.ts === thread.parent.ts && highlight.channel === channel} />
            {thread.replies.length > 0 ? (
              <div className="divider-replies" role="separator">
                <span>{S.thread.replies(thread.replies.length)}</span>
              </div>
            ) : null}
            {thread.replies.map((reply, index) => (
              <MessageRow
                key={reply.local_id ?? reply.client_msg_id ?? reply.ts}
                channel={channel}
                message={reply}
                inThread
                compact={sameAuthorRun(thread.replies[index - 1], reply)}
                highlighted={highlight?.ts === reply.ts && highlight.channel === channel}
              />
            ))}
            {thread.status ? (
              <div className="assistant-status" role="status">
                <span className="dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                {statusUser ? `${displayName(statusUser)} ` : ''}
                {thread.status}
              </div>
            ) : null}
            {thread.prompts && isMember ? (
              <div className="prompts">
                {thread.prompts.title ? <div className="prompts-title">{thread.prompts.title}</div> : null}
                {thread.prompts.items.map((prompt, index) => (
                  <button key={index} type="button" className="prompt-chip" onClick={() => void sendMessage({ channel, text: escapeText(prompt.message), threadTs: ts })}>
                    {prompt.title}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
      {thread.parent && isMember && !conv?.is_archived ? (
        <Composer
          key={`${channel}:${ts}`}
          channel={channel}
          threadTs={ts}
          placeholder={S.composer.placeholderThread}
          broadcastLabel={S.composer.alsoSend(label)}
          autoFocus
        />
      ) : null}
    </PanelFrame>
  );
}

// ── Profile ─────────────────────────────────────────────────────────────────

function roleLabel(user: User): string | null {
  if (user.is_bot) return S.profile.bot;
  if (user.is_restricted) return S.accounts.guestTag;
  if (user.is_owner) return S.profile.owner;
  if (user.is_admin) return S.profile.admin;
  return null;
}

export function ProfilePanel({ userId }: { userId: string }) {
  const user = useStore((state) => state.users[userId]);
  const self = useStore((state) => state.self);
  const presence = useStore((state) => state.presence[userId]);
  if (!user) return <PanelFrame title={S.profile.title}>{null}</PanelFrame>;
  const isSelf = self?.id === user.id;
  const role = roleLabel(user);
  const email = isSelf ? self?.profile.email : user.profile.email;
  return (
    <PanelFrame title={S.profile.title}>
      <div className="panel-scroll profile">
        <Avatar user={user} size={200} />
        <h3 className="profile-name">
          {user.real_name || displayName(user)}
          {role ? <span className="tag">{role}</span> : null}
        </h3>
        {user.profile.display_name && user.profile.display_name !== user.real_name ? <p className="profile-handle">{user.profile.display_name}</p> : null}
        {user.profile.title ? <p className="profile-title">{user.profile.title}</p> : null}
        {user.profile.status_text || user.profile.status_emoji ? (
          <p className="profile-status">
            {user.profile.status_emoji ? <Emoji name={user.profile.status_emoji.replace(/:/g, '')} /> : null} {user.profile.status_text}
          </p>
        ) : null}
        <ProfileFieldFacts user={user} />
        <dl className="profile-facts">
          {user.deleted ? (
            <div>
              <dd>{S.profile.deactivated}</dd>
            </div>
          ) : !user.is_bot ? (
            <div>
              <dd>
                <span className={`presence inline ${presence === 'active' ? 'on' : 'off'}`} /> {presence === 'active' ? S.profile.active : S.profile.away}
              </dd>
            </div>
          ) : null}
          {!user.is_bot && user.tz ? (
            <div>
              <dd>{S.profile.localTime(localTime(user.tz))}</dd>
            </div>
          ) : null}
          {email ? (
            <div>
              <dt>{S.profile.email}</dt>
              <dd>
                <a href={`mailto:${email}`}>{email}</a>
              </dd>
            </div>
          ) : null}
        </dl>
        <div className="profile-actions">
          {!user.deleted ? (
            <Button variant="primary" onClick={() => void openDirect([user.id])}>
              <MessageSquare size={16} /> {S.profile.message}
            </Button>
          ) : null}
          {isSelf ? (
            <Button onClick={() => openModal({ kind: 'editProfile' })}>
              <Pencil size={16} /> {S.profile.edit}
            </Button>
          ) : null}
        </div>
      </div>
    </PanelFrame>
  );
}

// ── Conversation details ────────────────────────────────────────────────────

function useMembers(conv: Conversation | undefined): string[] | null {
  const [members, setMembers] = useState<string[] | null>(null);
  const id = conv?.id;
  const count = conv?.num_members;
  useEffect(() => {
    if (!id) return;
    let live = true;
    call('conversations.members', { channel: id, limit: 1000 })
      .then((result) => {
        if (live) setMembers(result.members as string[]);
      })
      .catch(() => {
        if (live) setMembers([]);
      });
    return () => {
      live = false;
    };
  }, [id, count]);
  return members;
}

function MembersTab({ conv, canManage }: { conv: Conversation; canManage: boolean }) {
  const members = useMembers(conv);
  const users = useStore((state) => state.users);
  const selfId = useStore((state) => state.self?.id);
  const [query, setQuery] = useState('');
  if (!members) {
    return (
      <div className="list-loading">
        <Spinner />
      </div>
    );
  }
  const needle = query.trim().toLowerCase();
  const rows = members
    .map((id) => users[id])
    .filter((user): user is User => user !== undefined)
    .filter((user) => !needle || `${displayName(user)} ${user.real_name} ${user.name}`.toLowerCase().includes(needle))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
  return (
    <div className="members-tab">
      <div className="members-tools">
        <input type="search" value={query} placeholder={S.details.findMembers} onChange={(event) => setQuery(event.target.value)} aria-label={S.details.findMembers} />
        {conv.is_channel && !conv.is_archived ? (
          <Button size="sm" onClick={() => openModal({ kind: 'addPeople', channel: conv.id })}>
            <UserPlus size={15} /> {S.details.addPeople}
          </Button>
        ) : null}
      </div>
      <ul className="member-list">
        {rows.map((user) => (
          <li key={user.id}>
            <button type="button" className="member-row" onClick={() => setPanel({ kind: 'profile', user: user.id })}>
              <Avatar user={user} size={32} presence />
              <span className="member-meta">
                <span className="member-name">
                  {displayName(user)}
                  {user.id === selfId ? <span className="conv-you">{S.sidebar.you}</span> : null}
                  {user.is_bot ? <span className="tag">{S.sidebar.app}</span> : null}
                </span>
                {user.profile.title ? <span className="member-title">{user.profile.title}</span> : null}
              </span>
            </button>
            {canManage && conv.is_channel && !conv.is_general && user.id !== selfId ? (
              <IconButton
                label={S.details.removeMember}
                onClick={() => void attempt(() => call('conversations.kick', { channel: conv.id, user: user.id }))}
              >
                <UserMinus size={15} />
              </IconButton>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PinsTab({ conv }: { conv: Conversation }) {
  const [items, setItems] = useState<{ message: Message; created_by: string }[] | null>(null);
  const pinnedTick = useStore((state) => state.convs[conv.id]?.list.filter((message) => message.pinned_to?.length).length ?? 0);
  useEffect(() => {
    let live = true;
    call('pins.list', { channel: conv.id })
      .then((result) => {
        if (live) setItems(result.items);
      })
      .catch(() => {
        if (live) setItems([]);
      });
    return () => {
      live = false;
    };
  }, [conv.id, pinnedTick]);
  if (!items) {
    return (
      <div className="list-loading">
        <Spinner />
      </div>
    );
  }
  if (items.length === 0) return <p className="panel-empty">{S.details.noPins}</p>;
  return (
    <div className="pins-tab">
      {items.map((item) => (
        <div
          key={item.message.ts}
          className="pin-card"
          role="button"
          tabIndex={0}
          onClick={() => openMessage(conv.id, item.message)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') openMessage(conv.id, item.message);
          }}
        >
          <MessageRow channel={conv.id} message={item.message} inThread />
        </div>
      ))}
    </div>
  );
}

function AboutTab({ conv, canManage, isMember }: { conv: Conversation; canManage: boolean; isMember: boolean }) {
  const creator = useStore((state) => state.users[conv.creator ?? '']);
  const created = new Date(conv.created * 1000).toLocaleDateString(undefined, { dateStyle: 'long' });

  const editPurpose = async (): Promise<void> => {
    const purpose = await promptDialog({ title: S.details.description, label: S.details.description, initial: conv.purpose?.value ?? '', multiline: true });
    if (purpose === null) return;
    await attempt(() => call('conversations.setPurpose', { channel: conv.id, purpose: purpose.trim() }));
  };
  const rename = async (): Promise<void> => {
    const name = await promptDialog({ title: S.details.rename, label: S.details.channelName, initial: conv.name ?? '' });
    if (!name?.trim()) return;
    await attempt(() => call('conversations.rename', { channel: conv.id, name: name.trim() }));
  };
  const archive = async (): Promise<void> => {
    if (conv.is_archived) {
      await attempt(() => call('conversations.unarchive', { channel: conv.id }));
    } else if (await confirmDialog(S.details.confirmArchive, S.details.archive)) {
      await attempt(() => call('conversations.archive', { channel: conv.id }));
    }
  };
  const leave = async (): Promise<void> => {
    if (await confirmDialog(S.details.confirmLeave, S.details.leave)) await leaveChannel(conv.id);
  };

  return (
    <div className="about-tab">
      {conv.is_channel ? (
        <>
          <section className="about-item">
            <div className="about-head">
              <h4>{S.details.topic}</h4>
              {isMember && !conv.is_archived ? (
                <button type="button" className="link-btn" onClick={() => void editTopic(conv)}>
                  {S.details.edit}
                </button>
              ) : null}
            </div>
            {conv.topic?.value ? <Mrkdwn text={conv.topic.value} /> : <p className="muted">{S.details.none}</p>}
          </section>
          <section className="about-item">
            <div className="about-head">
              <h4>{S.details.description}</h4>
              {isMember && !conv.is_archived ? (
                <button type="button" className="link-btn" onClick={() => void editPurpose()}>
                  {S.details.edit}
                </button>
              ) : null}
            </div>
            {conv.purpose?.value ? <Mrkdwn text={conv.purpose.value} /> : <p className="muted">{S.details.none}</p>}
          </section>
          <p className="about-created muted">{S.details.created(displayName(creator), created)}</p>
          <ChannelWebSettings channel={conv.id} />
          {isMember ? <PostingPermissions conv={conv} canManage={canManage} /> : null}
        </>
      ) : null}
      {isMember ? (
        <div className="about-actions">
          <button type="button" className="row-action" onClick={() => void setConversationPrefs(conv.id, { muted: !conv.is_muted })}>
            {conv.is_muted ? <Bell size={16} /> : <BellOff size={16} />} {conv.is_muted ? S.details.unmute : S.details.mute}
          </button>
          {conv.is_channel && canManage ? (
            <button type="button" className="row-action" onClick={() => void rename()}>
              <Pencil size={16} /> {S.details.rename}
            </button>
          ) : null}
          {conv.is_channel && !conv.is_general ? (
            <button type="button" className="row-action" onClick={() => void leave()}>
              <LogOut size={16} /> {S.details.leave}
            </button>
          ) : null}
          {conv.is_mpim ? (
            <button
              type="button"
              className="row-action"
              onClick={() => {
                void closeDirect(conv.id);
                go({ name: 'home' });
              }}
            >
              <X size={16} /> {S.details.closeDm}
            </button>
          ) : null}
          {conv.is_channel && canManage && !conv.is_general ? (
            <button type="button" className="row-action is-danger" onClick={() => void archive()}>
              {conv.is_archived ? <ArchiveRestore size={16} /> : <Archive size={16} />} {conv.is_archived ? S.details.unarchive : S.details.archive}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function DetailsPanel({ channel, tab }: { channel: string; tab: 'about' | 'members' | 'pins' | 'files' }) {
  const conv = useStore((state) => conversation(state, channel));
  const name = useStore((state) => conversationName(state, conv));
  const self = useStore((state) => state.self);
  const isMember = useStore((state) => state.channels[channel] !== undefined);
  if (!conv) return <PanelFrame title={S.header.details}>{null}</PanelFrame>;
  const canManage = Boolean(self && (self.is_admin || conv.creator === self.id || conv.managers?.includes(self.id)));
  const tabs: { id: 'about' | 'members' | 'pins' | 'files'; label: string }[] = [
    { id: 'about', label: S.details.about },
    { id: 'members', label: `${S.details.members}${conv.num_members !== undefined ? ` ${conv.num_members}` : ''}` },
    { id: 'pins', label: S.details.pins },
    { id: 'files', label: S.att.files.title },
  ];
  return (
    <PanelFrame title={conv.is_channel ? `#${name}` : name} subtitle={conv.is_private && conv.is_channel ? S.header.private : undefined}>
      <div className="tabs" role="tablist">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'is-active' : ''}
            onClick={() => setPanel({ kind: 'details', channel, tab: item.id })}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="panel-scroll">
        {tab === 'about' ? <AboutTab conv={conv} canManage={canManage} isMember={isMember} /> : null}
        {tab === 'members' ? <MembersTab conv={conv} canManage={canManage} /> : null}
        {tab === 'pins' ? <PinsTab conv={conv} /> : null}
        {tab === 'files' ? (
          <div className="panel-files">
            <FileList channel={conv.id} />
          </div>
        ) : null}
      </div>
    </PanelFrame>
  );
}
