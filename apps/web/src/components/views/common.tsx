import type { Message } from '@app/shared';
import { Hash, Lock, Menu } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { attentionEvents, type AttentionTopic } from '../../lib/attention';
import { conversation, conversationName, displayName, set, useStore } from '../../lib/store';
import { shortStamp } from '../../lib/time';
import { S } from '../../strings';
import { Blocks } from '../blocks';
import { Files } from '../files';
import { Mrkdwn } from '../text';
import { Avatar, IconButton } from '../ui';
import { useTabList } from '../../lib/roving';

/** The frame every workspace-wide view shares: a header, optional tabs, a scrolling column. */
export function ViewFrame({ title, actions, tabs, children, className = '' }: { title: string; actions?: ReactNode; tabs?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`search-view view ${className}`}>
      <header className="conv-head">
        <IconButton className="only-narrow" label={S.sidebar.openSidebar} onClick={() => set({ drawer: true })}>
          <Menu size={19} />
        </IconButton>
        <h1 className="view-title">{title}</h1>
        <span className="composer-spacer" />
        {actions}
      </header>
      {tabs}
      <div className="search-scroll">
        <div className="search-inner">{children}</div>
      </div>
    </section>
  );
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string; count?: number }[]; onChange: (value: T) => void }) {
  const tabList = useTabList();
  return (
    <div ref={tabList} className="tabs" role="tablist">
      {options.map((option) => (
        <button key={option.id} type="button" role="tab" aria-selected={value === option.id} className={value === option.id ? 'is-active' : ''} onClick={() => onChange(option.id)}>
          {option.label}
          {option.count ? <span className="tab-count">{option.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="view-empty">{children}</p>;
}

/** Refetch when the server says something in this area changed. */
export function useRefreshOn(topic: AttentionTopic, refresh: () => void): void {
  useEffect(() => {
    const handler = (): void => refresh();
    attentionEvents.addEventListener(topic, handler);
    return () => attentionEvents.removeEventListener(topic, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic]);
}

/** "#general", "Mina", or the members of a group, for a conversation id. */
export function usePlace(channel: string): { name: string; isChannel: boolean; isPrivate: boolean } {
  return useStore(
    useShallow((state) => {
      const conv = conversation(state, channel);
      return { name: conversationName(state, conv) || '…', isChannel: Boolean(conv?.is_channel), isPrivate: Boolean(conv?.is_private) };
    }),
  );
}

export function PlaceLabel({ channel }: { channel: string }) {
  const place = usePlace(channel);
  return (
    <span className="place-label">
      {place.isChannel ? place.isPrivate ? <Lock size={13} /> : <Hash size={13} /> : null}
      <span>{place.name}</span>
    </span>
  );
}

/** A message shown compactly inside a list: avatar, author and body, without the hover actions. */
export function MessagePreview({ channel, message }: { channel: string; message: Message }) {
  const author = useStore((state) => state.users[message.user ?? '']);
  const collapsed = useStore((state) => Boolean(state.att.collapsed[channel]));
  return (
    <div className="result-body">
      <Avatar user={author} size={32} />
      <div className="result-main">
        <div className="result-author">
          {message.username && !author ? message.username : displayName(author)}
          <time className="preview-time">{shortStamp(message.ts)}</time>
        </div>
        <div className="result-text">
          {message.subtype === 'tombstone' ? (
            <span className="msg-deleted">{S.messages.deleted}</span>
          ) : message.blocks?.length ? (
            <Blocks blocks={message.blocks} fallbackText={message.text} channel={channel} message={message} />
          ) : (
            <Mrkdwn text={message.text} />
          )}
          {message.files?.length ? <Files files={message.files} collapsed={collapsed} /> : null}
        </div>
      </div>
    </div>
  );
}
