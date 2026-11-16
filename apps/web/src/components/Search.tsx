import type { Conversation, Message, User } from '@app/shared';
import { Hash, Lock, Menu, Search as SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { closeModal, errorText, go, openDirect, openMessage } from '../lib/actions';
import { call } from '../lib/api';
import { conversationName, displayName, get, set, useStore } from '../lib/store';
import { shortStamp } from '../lib/time';
import { S } from '../strings';
import { Blocks } from './blocks';
import { Files } from './files';
import { Mrkdwn } from './text';
import { Avatar, Button, IconButton, Modal, Spinner } from './ui';

// ── Search results ──────────────────────────────────────────────────────────

interface Match extends Message {
  channel_info: { id: string; name: string; is_im: boolean; is_mpim: boolean; is_private: boolean; user?: string };
  permalink: string;
}

function toMatch(raw: Record<string, unknown>): Match {
  const { channel, ...rest } = raw as { channel: Match['channel_info'] } & Record<string, unknown>;
  return { ...(rest as unknown as Message), channel_info: channel, permalink: String(raw.permalink ?? '') };
}

function ResultRow({ match }: { match: Match }) {
  const author = useStore((state) => state.users[match.user ?? '']);
  const place = useStore((state) => {
    const conv = state.channels[match.channel_info.id] ?? state.others[match.channel_info.id];
    if (conv) return conversationName(state, conv);
    if (match.channel_info.is_im) return displayName(state.users[match.channel_info.user ?? '']);
    return match.channel_info.name;
  });
  const direct = match.channel_info.is_im || match.channel_info.is_mpim;
  return (
    <div
      className="result"
      role="button"
      tabIndex={0}
      onClick={() => openMessage(match.channel_info.id, match)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') openMessage(match.channel_info.id, match);
      }}
    >
      <div className="result-place">
        {direct ? null : match.channel_info.is_private ? <Lock size={13} /> : <Hash size={13} />}
        <span>{place}</span>
        <time>{shortStamp(match.ts)}</time>
      </div>
      <div className="result-body">
        <Avatar user={author} size={36} />
        <div className="result-main">
          <div className="result-author">{match.username && !author ? match.username : displayName(author)}</div>
          <div className="result-text">
            {match.blocks?.length ? (
              <Blocks blocks={match.blocks} fallbackText={match.text} channel={match.channel_info.id} message={match} />
            ) : (
              <Mrkdwn text={match.text} />
            )}
            {match.files?.length ? <Files files={match.files} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SearchView({ query }: { query: string }) {
  const [input, setInput] = useState(query);
  const [matches, setMatches] = useState<Match[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const load = (text: string, nextPage: number): void => {
    if (!text.trim()) {
      setMatches([]);
      setTotal(0);
      return;
    }
    const id = (request.current += 1);
    setLoading(true);
    setError(null);
    call('search.messages', { query: text, count: 20, page: nextPage })
      .then((result) => {
        if (id !== request.current) return;
        const found = (result.messages.matches as Record<string, unknown>[]).map(toMatch);
        setMatches((current) => (nextPage === 1 ? found : [...current, ...found]));
        setTotal(result.messages.total);
        setPage(nextPage);
        setPages(result.messages.paging.pages);
      })
      .catch((failure: unknown) => {
        if (id === request.current) setError(errorText(failure));
      })
      .finally(() => {
        if (id === request.current) setLoading(false);
      });
  };

  useEffect(() => {
    setInput(query);
    load(query, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <section className="search-view">
      <header className="conv-head">
        <IconButton className="only-narrow" label={S.sidebar.openSidebar} onClick={() => set({ drawer: true })}>
          <Menu size={19} />
        </IconButton>
        <form
          className="search-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (input.trim()) go({ name: 'search', query: input.trim() });
          }}
        >
          <SearchIcon size={17} />
          <input type="search" value={input} placeholder={S.search.placeholder} onChange={(event) => setInput(event.target.value)} aria-label={S.search.placeholder} autoFocus />
        </form>
      </header>
      <div className="search-scroll">
        <div className="search-inner">
          {query ? (
            <div className="search-summary">
              <h2>{S.search.title(query)}</h2>
              {!loading || matches.length > 0 ? <span>{S.search.count(total)}</span> : null}
            </div>
          ) : (
            <p className="search-empty">{S.search.empty}</p>
          )}
          <p className="search-hint">{S.search.hint}</p>
          {error ? <p className="search-empty">{error}</p> : null}
          {matches.map((match) => (
            <ResultRow key={`${match.channel_info.id}-${match.ts}`} match={match} />
          ))}
          {loading ? (
            <div className="list-loading">
              <Spinner />
            </div>
          ) : null}
          {!loading && query && matches.length === 0 && !error ? (
            <div className="search-none">
              <strong>{S.search.none}</strong>
              <span>{S.search.noneHint}</span>
            </div>
          ) : null}
          {!loading && page < pages ? (
            <div className="search-more">
              <Button onClick={() => load(query, page + 1)}>{S.search.more}</Button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

// ── Quick switcher ──────────────────────────────────────────────────────────

/** Higher is better; 0 means no match. */
function score(candidate: string, query: string): number {
  const text = candidate.toLowerCase();
  if (!query) return 1;
  if (text === query) return 100;
  if (text.startsWith(query)) return 80;
  if (text.split(/[\s._-]+/).some((word) => word.startsWith(query))) return 60;
  if (text.includes(query)) return 40;
  let position = 0;
  for (const char of query) {
    position = text.indexOf(char, position);
    if (position === -1) return 0;
    position += 1;
  }
  return 10;
}

interface Entry {
  key: string;
  icon: ReactNode;
  label: string;
  sub?: string;
  badge?: number;
  rank: number;
  run: () => void;
}

export function QuickSwitcher() {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [browsable, setBrowsable] = useState<Conversation[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    call('client.channels.browse', {})
      .then((result) => setBrowsable(result.channels as Conversation[]))
      .catch(() => undefined);
  }, []);

  const entries = useMemo(() => {
    const state = get();
    const needle = query.trim().toLowerCase().replace(/^[#@]/, '');
    const out: Entry[] = [];
    const seenUsers = new Set<string>();
    for (const conv of Object.values(state.channels)) {
      const name = conversationName(state, conv);
      const rank = score(name, needle);
      if (rank === 0) continue;
      const other: User | undefined = conv.is_im ? state.users[conv.user ?? ''] : undefined;
      if (other) seenUsers.add(other.id);
      out.push({
        key: conv.id,
        icon: conv.is_im ? <Avatar user={other} size={22} presence /> : conv.is_private ? <Lock size={16} /> : <Hash size={16} />,
        label: name,
        sub: conv.is_im ? other?.profile.title : conv.purpose?.value,
        badge: conv.mention_count || undefined,
        rank: rank + ((conv.unread_count ?? 0) > 0 ? 5 : 0) + (needle ? 0 : Number(conv.latest_ts ?? 0) / 1e12),
        run: () => go({ name: 'conversation', id: conv.id }),
      });
    }
    if (needle) {
      for (const user of Object.values(state.users)) {
        if (user.deleted || seenUsers.has(user.id)) continue;
        const rank = Math.max(score(displayName(user), needle), score(user.real_name, needle), score(user.name, needle));
        if (rank === 0) continue;
        out.push({
          key: user.id,
          icon: <Avatar user={user} size={22} presence />,
          label: displayName(user),
          sub: user.profile.title || S.switcher.person,
          rank: rank - 1,
          run: () => void openDirect([user.id]),
        });
      }
      for (const conv of browsable) {
        if (state.channels[conv.id] || !conv.name) continue;
        const rank = score(conv.name, needle);
        if (rank === 0) continue;
        out.push({
          key: conv.id,
          icon: <Hash size={16} />,
          label: conv.name,
          sub: S.switcher.notJoined,
          rank: rank - 2,
          run: () => go({ name: 'conversation', id: conv.id }),
        });
      }
    }
    out.sort((a, b) => b.rank - a.rank || a.label.localeCompare(b.label));
    const limited = out.slice(0, 12);
    if (query.trim()) {
      limited.push({
        key: 'search',
        icon: <SearchIcon size={16} />,
        label: S.switcher.searchFor(query.trim()),
        rank: -1,
        run: () => go({ name: 'search', query: query.trim() }),
      });
    }
    return limited;
  }, [query, browsable]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const run = (entry: Entry | undefined): void => {
    if (!entry) return;
    closeModal();
    entry.run();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const count = entries.length || 1;
      setIndex((current) => (current + (event.key === 'ArrowDown' ? 1 : count - 1)) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(entries[index]);
    }
  };

  return (
    <Modal title={S.topbar.jump} onClose={closeModal} width={600} className="switcher">
      <div className="switcher-input">
        <SearchIcon size={18} />
        <input value={query} placeholder={S.switcher.placeholder} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} aria-label={S.switcher.placeholder} data-autofocus />
      </div>
      <div className="switcher-list" ref={listRef} role="listbox">
        {entries.length === 0 ? <p className="panel-empty">{S.switcher.none}</p> : null}
        {entries.map((entry, entryIndex) => (
          <button
            key={entry.key}
            type="button"
            role="option"
            aria-selected={entryIndex === index}
            className={`switcher-item ${entryIndex === index ? 'is-active' : ''}`}
            onMouseEnter={() => setIndex(entryIndex)}
            onClick={() => run(entry)}
          >
            <span className="suggest-icon">{entry.icon}</span>
            <span className="suggest-label">{entry.label}</span>
            {entry.sub ? <span className="suggest-sub">{entry.sub}</span> : null}
            {entry.badge ? <span className="badge">{entry.badge}</span> : null}
          </button>
        ))}
      </div>
    </Modal>
  );
}
