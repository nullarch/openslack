import type { Conversation, Message } from '@app/shared';
import { AtSign, CheckCheck, Circle, Hash, KeyRound, MessageSquareText, SmilePlus, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { errorText, go, markRead, openMessage, openThread } from '../../lib/actions';
import { call } from '../../lib/api';
import { fetchActivity, fetchThreads, markActivity, markThreadSeen, type ActivityItem, type ThreadSummary } from '../../lib/attention';
import { conversationName, displayName, get, threadKey, useStore } from '../../lib/store';
import { relative } from '../../lib/time';
import { S } from '../../strings';
import { MessageRow } from '../Message';
import { Emoji } from '../text';
import { Button, IconButton, Spinner } from '../ui';
import { EmptyNote, MessagePreview, PlaceLabel, Tabs, useRefreshOn, ViewFrame } from './common';
import { DOC_ACTIVITY, DocActivityBody, docActivityHeadline, docActivityIcon, openDocActivity, type DocActivity } from '../docs';

// ── Activity ────────────────────────────────────────────────────────────────

type ActivityFilter = 'all' | 'mention' | 'thread_reply' | 'reaction' | 'invite' | 'keyword' | 'docs';

function activityIcon(item: ActivityItem): ReactNode {
  switch (item.type) {
    case 'mention':
      return <AtSign size={15} />;
    case 'thread_reply':
      return <MessageSquareText size={15} />;
    case 'reaction':
      return item.reaction ? <Emoji name={item.reaction} /> : <SmilePlus size={15} />;
    case 'invite':
      return <UserPlus size={15} />;
    case 'keyword':
      return <KeyRound size={15} />;
  }
}

function ActivityRow({ item, onRead }: { item: ActivityItem; onRead: (item: ActivityItem, read: boolean) => void }) {
  const actor = useStore((state) => (item.actor ? displayName(state.users[item.actor]) : ''));
  const doc = DOC_ACTIVITY.includes(item.type) ? (item as unknown as DocActivity) : null;
  let headline: string;
  if (doc) headline = docActivityHeadline(doc, actor);
  else if (item.type === 'mention') headline = item.broadcast ? S.att.activity.mentionedAll(actor) : S.att.activity.mentioned(actor);
  else if (item.type === 'thread_reply') headline = S.att.activity.replied(actor);
  else if (item.type === 'reaction') headline = S.att.activity.reacted(actor);
  else if (item.type === 'invite') headline = S.att.activity.invited(actor);
  else headline = S.att.activity.keyword(item.keyword ?? '');

  const open = (): void => {
    if (item.is_unread) onRead(item, true);
    if (doc) openDocActivity(doc);
    else if (item.type === 'invite' || !item.message) go({ name: 'conversation', id: item.channel });
    else if (item.type === 'thread_reply' && item.thread_ts) {
      go({ name: 'conversation', id: item.channel });
      openThread(item.channel, item.thread_ts);
    } else openMessage(item.channel, item.message);
  };

  return (
    <div
      className={`result activity-item ${item.is_unread ? 'is-unread' : ''}`}
      role="button"
      tabIndex={0}
      data-activity={item.type}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter') open();
      }}
    >
      <div className="result-place">
        <span className={`activity-icon is-${item.type}`}>{doc ? docActivityIcon(item.type) : activityIcon(item)}</span>
        <strong className="activity-headline">{headline}</strong>
        {doc ? null : (
          <>
            <span className="activity-in">{S.att.activity.inPlace('')}</span>
            <PlaceLabel channel={item.channel} />
          </>
        )}
        <time>{relative(String(item.created))}</time>
        <span className="composer-spacer" />
        <IconButton
          className="activity-toggle"
          label={item.is_unread ? S.att.activity.markRead : S.att.activity.markUnread}
          onClick={(event) => {
            event.stopPropagation();
            onRead(item, item.is_unread);
          }}
        >
          <Circle size={10} fill={item.is_unread ? 'currentColor' : 'none'} />
        </IconButton>
      </div>
      {doc ? <DocActivityBody item={doc} /> : item.message ? <MessagePreview channel={item.channel} message={item.message} /> : item.type !== 'invite' ? <p className="view-empty is-inline">{S.att.activity.gone}</p> : null}
    </div>
  );
}

export function ActivityView() {
  const unread = useStore((state) => state.att.activityUnread);
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [next, setNext] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const load = (cursor?: string): void => {
    const id = (request.current += 1);
    setLoading(true);
    fetchActivity({ types: filter === 'all' ? undefined : filter === 'docs' ? DOC_ACTIVITY.join(',') : filter, unread_only: unreadOnly || undefined, cursor })
      .then((result) => {
        if (id !== request.current) return;
        setItems((current) => (cursor ? [...current, ...result.items] : result.items));
        setNext(result.next);
        setError(null);
      })
      .catch((failure: unknown) => id === request.current && setError(errorText(failure)))
      .finally(() => id === request.current && setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(), [filter, unreadOnly]);
  useRefreshOn('activity', () => load());

  const setRead = (item: ActivityItem, read: boolean): void => {
    setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, is_unread: !read } : entry)));
    void markActivity({ ids: [item.id] }, read);
  };

  const filters: { id: ActivityFilter; label: string }[] = [
    { id: 'all', label: S.att.activity.all },
    { id: 'mention', label: S.att.activity.mentions },
    { id: 'thread_reply', label: S.att.activity.threads },
    { id: 'reaction', label: S.att.activity.reactions },
    { id: 'invite', label: S.att.activity.invites },
    { id: 'keyword', label: S.att.activity.keywords },
    { id: 'docs', label: S.docs.activityFilter },
  ];

  return (
    <ViewFrame
      title={S.att.activity.title}
      className="activity-view"
      actions={
        <>
          <label className="toggle-label">
            <input type="checkbox" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} />
            {S.att.activity.unreadOnly}
          </label>
          <Button size="sm" disabled={unread === 0} onClick={() => void markActivity({ all: true }).then(() => load())}>
            <CheckCheck size={15} /> {S.att.activity.markAllRead}
          </Button>
        </>
      }
      tabs={<Tabs value={filter} options={filters} onChange={setFilter} />}
    >
      {error ? <EmptyNote>{error}</EmptyNote> : null}
      {items.map((item) => (
        <ActivityRow key={item.id} item={item} onRead={setRead} />
      ))}
      {loading ? (
        <div className="list-loading">
          <Spinner />
        </div>
      ) : null}
      {!loading && items.length === 0 && !error ? <EmptyNote>{S.att.activity.empty}</EmptyNote> : null}
      {!loading && next ? (
        <div className="search-more">
          <Button onClick={() => load(next)}>{S.att.activity.loadMore}</Button>
        </div>
      ) : null}
    </ViewFrame>
  );
}

// ── Threads ─────────────────────────────────────────────────────────────────

function ThreadCard({ thread }: { thread: ThreadSummary }) {
  const unread = useStore((state) => Boolean(state.att.unreadThreads[threadKey(thread.channel, thread.thread_ts)]));
  const hidden = Math.max(0, (thread.root.reply_count ?? 0) - thread.latest_replies.length);
  const open = (): void => {
    go({ name: 'conversation', id: thread.channel });
    openThread(thread.channel, thread.thread_ts);
  };
  return (
    <article className={`thread-card ${unread ? 'is-unread' : ''}`} data-thread={thread.thread_ts}>
      <header className="thread-card-head">
        <button type="button" className="link-btn thread-card-place" onClick={() => go({ name: 'conversation', id: thread.channel })}>
          <PlaceLabel channel={thread.channel} />
        </button>
        {unread ? <span className="tag tag-unread">{S.att.threads.unread}</span> : null}
      </header>
      <div className="thread-card-body">
        <MessageRow channel={thread.channel} message={thread.root} inThread />
        {hidden > 0 ? (
          <button type="button" className="thread-more" onClick={open}>
            {S.att.threads.moreReplies(hidden)}
          </button>
        ) : null}
        {thread.latest_replies.map((reply) => (
          <MessageRow key={reply.ts} channel={thread.channel} message={reply} inThread />
        ))}
      </div>
      <footer className="thread-card-foot">
        <Button size="sm" onClick={open}>
          <MessageSquareText size={15} /> {S.att.threads.reply}
        </Button>
      </footer>
    </article>
  );
}

export function ThreadsView() {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [next, setNext] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = (cursor?: string): void => {
    setLoading(true);
    fetchThreads(cursor)
      .then((result) => {
        setThreads((current) => (cursor ? [...current, ...result.threads] : result.threads));
        setNext(result.next);
        setError(null);
      })
      .catch((failure: unknown) => setError(errorText(failure)))
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(), []);
  useRefreshOn('threads', () => load());

  // Looking at the list catches you up on what it shows.
  useEffect(() => {
    if (loading) return;
    const timer = window.setTimeout(() => {
      if (!document.hasFocus()) return;
      for (const thread of threads) {
        const last = thread.latest_replies.at(-1)?.ts;
        if (last) markThreadSeen(thread.channel, thread.thread_ts, last);
      }
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [threads, loading]);

  return (
    <ViewFrame title={S.att.threads.title} className="threads-view">
      {error ? <EmptyNote>{error}</EmptyNote> : null}
      {threads.map((thread) => (
        <ThreadCard key={`${thread.channel}:${thread.thread_ts}`} thread={thread} />
      ))}
      {loading ? (
        <div className="list-loading">
          <Spinner />
        </div>
      ) : null}
      {!loading && threads.length === 0 && !error ? <EmptyNote>{S.att.threads.empty}</EmptyNote> : null}
      {!loading && next ? (
        <div className="search-more">
          <Button onClick={() => load(next)}>{S.att.activity.loadMore}</Button>
        </div>
      ) : null}
    </ViewFrame>
  );
}

// ── All unreads ─────────────────────────────────────────────────────────────

const UNREAD_PAGE = 30;

function UnreadGroup({ conv }: { conv: Conversation }) {
  const name = useStore((state) => conversationName(state, conv));
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    let live = true;
    call('conversations.history', { channel: conv.id, oldest: conv.last_read ?? '0', limit: UNREAD_PAGE })
      .then((result) => {
        if (!live) return;
        setMessages((result.messages as Message[]).slice().reverse());
        setMore(Boolean(result.has_more));
      })
      .catch(() => live && setMessages([]));
    return () => {
      live = false;
    };
    // Load once per group; marking read removes the group.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.id]);

  const last = messages?.at(-1)?.ts ?? conv.latest_ts;
  return (
    <section className="unread-group" data-channel={conv.id}>
      <header className="unread-head">
        <button type="button" className="link-btn unread-name" onClick={() => go({ name: 'conversation', id: conv.id })}>
          {conv.is_channel ? <Hash size={15} /> : null}
          {name}
        </button>
        <span className="unread-count">{S.att.unreads.count(conv.unread_count ?? 0)}</span>
        <span className="composer-spacer" />
        <Button size="sm" onClick={() => last && markRead(conv.id, last)}>
          <CheckCheck size={15} /> {S.att.unreads.markRead}
        </Button>
      </header>
      {messages === null ? (
        <div className="list-loading">
          <Spinner />
        </div>
      ) : (
        <div className="unread-messages">
          {messages.map((message) => (
            <MessageRow key={message.ts} channel={conv.id} message={message} />
          ))}
          {more ? (
            <button type="button" className="thread-more" onClick={() => go({ name: 'conversation', id: conv.id })}>
              {S.att.unreads.more}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

export function UnreadsView() {
  const ids = useStore(
    useShallow((state) =>
      Object.values(state.channels)
        .filter((conv) => !conv.is_muted && (conv.unread_count ?? 0) > 0)
        .sort((a, b) => ((b.latest_ts ?? '') < (a.latest_ts ?? '') ? -1 : 1))
        .map((conv) => conv.id),
    ),
  );
  const markAll = (): void => {
    const state = get();
    for (const id of ids) {
      const conv = state.channels[id];
      if (conv?.latest_ts) markRead(id, conv.latest_ts);
    }
  };
  return (
    <ViewFrame
      title={S.att.unreads.title}
      className="unreads-view"
      actions={
        ids.length > 0 ? (
          <Button size="sm" onClick={markAll}>
            <CheckCheck size={15} /> {S.att.unreads.markAllRead}
          </Button>
        ) : null
      }
    >
      {ids.length === 0 ? <EmptyNote>{S.att.unreads.empty}</EmptyNote> : null}
      {ids.map((id) => (
        <UnreadGroupById key={id} id={id} />
      ))}
    </ViewFrame>
  );
}

function UnreadGroupById({ id }: { id: string }) {
  const conv = useStore((state) => state.channels[id]);
  return conv ? <UnreadGroup conv={conv} /> : null;
}
