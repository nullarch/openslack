import type { Conversation, FileObject } from '@app/shared';
import { Hash, History, Lock, Search as SearchIcon, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { go, openDirect } from '../lib/actions';
import { call, isUnsupported } from '../lib/api';
import { clearRecentSearches, recentSearches } from '../lib/attention';
import { conversationName, displayName, get, useStore } from '../lib/store';
import { relative } from '../lib/time';
import { S } from '../strings';
import { Files } from './files';
import { Avatar, Spinner } from './ui';
import { PlaceLabel } from './views/common';

export type SearchTab = 'messages' | 'files' | 'channels' | 'people' | 'docs';

/** Free text with the modifiers taken out, for the tabs that are not message search. */
function plainTerms(query: string): string {
  return query
    .replace(/\b(in|from|before|after|on|during|has|is):\S+/gi, ' ')
    .replace(/["']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function FileResults({ query }: { query: string }) {
  const [files, setFiles] = useState<FileObject[] | null>(null);
  useEffect(() => {
    let live = true;
    setFiles(null);
    const terms = plainTerms(query);
    // `search.files` when the server has it; otherwise filter the file list by name.
    call('search.files', { query, count: 50 })
      .then((result) => live && setFiles((result.files?.matches ?? []) as FileObject[]))
      .catch(async (error: unknown) => {
        if (!isUnsupported(error)) {
          if (live) setFiles([]);
          return;
        }
        try {
          const result = await call('files.list', { count: 200 });
          const all = result.files as FileObject[];
          if (live) setFiles(all.filter((file) => !terms || `${file.title} ${file.name}`.toLowerCase().includes(terms)));
        } catch {
          if (live) setFiles([]);
        }
      });
    return () => {
      live = false;
    };
  }, [query]);
  if (files === null) {
    return (
      <div className="list-loading">
        <Spinner />
      </div>
    );
  }
  if (files.length === 0) return <p className="search-empty">{S.att.search.noFiles}</p>;
  return (
    <>
      {files.map((file) => (
        <FileHit key={file.id} file={file} />
      ))}
    </>
  );
}

function FileHit({ file }: { file: FileObject }) {
  const owner = useStore((state) => state.users[file.user]);
  const place = file.channels[0] ?? file.groups[0] ?? file.ims[0];
  return (
    <div className="result file-row">
      <div className="result-place">
        <Avatar user={owner} size={20} />
        <span>{S.att.files.sharedBy(displayName(owner), relative(String(file.created)))}</span>
        {place ? <PlaceLabel channel={place} /> : null}
      </div>
      <Files files={[file]} />
    </div>
  );
}

export function ChannelResults({ query }: { query: string }) {
  const [channels, setChannels] = useState<Conversation[] | null>(null);
  useEffect(() => {
    let live = true;
    call('client.channels.browse', { query: plainTerms(query) })
      .then((result) => live && setChannels(result.channels as Conversation[]))
      .catch(() => live && setChannels([]));
    return () => {
      live = false;
    };
  }, [query]);
  if (channels === null) {
    return (
      <div className="list-loading">
        <Spinner />
      </div>
    );
  }
  if (channels.length === 0) return <p className="search-empty">{S.att.search.noChannels}</p>;
  return (
    <ul className="browse-list">
      {channels.map((conv) => (
        <li key={conv.id}>
          <button type="button" className="browse-row" onClick={() => go({ name: 'conversation', id: conv.id })}>
            <span className="browse-main">
              <span className="browse-name">
                {conv.is_private ? <Lock size={14} /> : <Hash size={14} />}
                {conv.name}
              </span>
              <span className="browse-sub">
                {S.header.members(conv.num_members ?? 0)}
                {conv.purpose?.value ? ` · ${conv.purpose.value}` : ''}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function PeopleResults({ query }: { query: string }) {
  const users = useStore((state) => state.users);
  const terms = plainTerms(query);
  const people = useMemo(
    () =>
      Object.values(users)
        .filter((user) => !user.deleted && (!terms || `${displayName(user)} ${user.real_name} ${user.name} ${user.profile.title}`.toLowerCase().includes(terms)))
        .sort((a, b) => displayName(a).localeCompare(displayName(b))),
    [users, terms],
  );
  if (people.length === 0) return <p className="search-empty">{S.att.search.noPeople}</p>;
  return (
    <ul className="people-list search-people">
      {people.map((user) => (
        <li key={user.id}>
          <button type="button" className="member-row" onClick={() => void openDirect([user.id])}>
            <Avatar user={user} size={36} presence />
            <span className="member-meta">
              <span className="member-name">
                {displayName(user)}
                {user.is_bot ? <span className="tag">{S.sidebar.app}</span> : null}
              </span>
              <span className="member-title">{[user.real_name !== displayName(user) ? user.real_name : '', user.profile.title].filter(Boolean).join(' · ')}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Below the search box: recent searches and quick filters for what is being typed. */
export function SearchSuggestions({ input, onPick }: { input: string; onPick: (query: string) => void }) {
  const [recent, setRecent] = useState(recentSearches);
  const needle = input.trim().toLowerCase();
  const state = get();
  const items: { key: string; label: string; query: string; icon: 'recent' | 'channel' | 'person' }[] = [];
  for (const item of recent) {
    if (!needle || item.toLowerCase().includes(needle)) items.push({ key: `r:${item}`, label: item, query: item, icon: 'recent' });
  }
  if (needle && !needle.includes(':')) {
    for (const conv of Object.values(state.channels)) {
      if (conv.is_channel && conv.name?.includes(needle)) items.push({ key: `c:${conv.id}`, label: `in:#${conv.name}`, query: `in:#${conv.name} `, icon: 'channel' });
    }
    for (const user of Object.values(state.users)) {
      if (!user.deleted && `${displayName(user)} ${user.name}`.toLowerCase().includes(needle)) {
        items.push({ key: `u:${user.id}`, label: `from:@${user.name} (${displayName(user)})`, query: `from:@${user.name} `, icon: 'person' });
      }
    }
  }
  if (items.length === 0) return null;
  return (
    <div className="search-suggest" role="listbox">
      {recent.length > 0 && !needle ? (
        <div className="suggest-head">
          {S.att.search.recent}
          <button
            type="button"
            className="link-btn"
            onMouseDown={(event) => {
              event.preventDefault();
              clearRecentSearches();
              setRecent([]);
            }}
          >
            {S.att.search.clearRecent}
          </button>
        </div>
      ) : null}
      {items.slice(0, 10).map((item) => (
        <button
          key={item.key}
          type="button"
          role="option"
          className="suggest-item"
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(item.query);
          }}
        >
          <span className="suggest-icon">{item.icon === 'recent' ? <History size={16} /> : item.icon === 'channel' ? <Hash size={16} /> : <SearchIcon size={16} />}</span>
          <span className="suggest-label">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

export function placeName(id: string): string {
  const state = get();
  const conv = state.channels[id] ?? state.others[id];
  return conv ? conversationName(state, conv) : '';
}

export function ClearButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="icon-btn" aria-label={S.close} onClick={onClick}>
      <X size={15} />
    </button>
  );
}
