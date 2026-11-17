import type { Conversation } from '@app/shared';
import { ArrowDown, Hash, Lock } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { loadLatest, loadNewer, loadOlder, MAX_LOADED, maybeMarkRead, trimLoaded } from '../lib/actions';
import { viewing } from '../lib/realtime';
import { conversation, conversationName, EMPTY_CONV, set, useStore, type LocalMessage } from '../lib/store';
import { dayKey, dayLabel } from '../lib/time';
import { S } from '../strings';
import { isSystem, MessageRow } from './Message';
import { Mrkdwn } from './text';
import { Avatar, Spinner } from './ui';

const GROUP_WINDOW_SECONDS = 300;
const NEAR_BOTTOM = 48;

function groupable(previous: LocalMessage, message: LocalMessage): boolean {
  if (isSystem(previous) || isSystem(message)) return false;
  if (previous.subtype === 'tombstone' || message.subtype === 'tombstone') return false;
  if (message.subtype === 'thread_broadcast' || message.is_ephemeral !== previous.is_ephemeral) return false;
  if (previous.user !== message.user || previous.bot_id !== message.bot_id || previous.username !== message.username) return false;
  return Number(message.ts) - Number(previous.ts) < GROUP_WINDOW_SECONDS;
}

function Intro({ conv }: { conv: Conversation }) {
  const name = useStore((state) => conversationName(state, conv));
  const other = useStore((state) => (conv.is_im ? state.users[conv.user ?? ''] : undefined));
  const isSelf = useStore((state) => conv.is_im && conv.user === state.self?.id);
  if (conv.is_im) {
    return (
      <div className="intro">
        <Avatar user={other} size={72} />
        <h2>{name}</h2>
        <p>{isSelf ? S.messages.beginningSelf : S.messages.beginningDm(name)}</p>
      </div>
    );
  }
  if (conv.is_mpim) {
    return (
      <div className="intro">
        <h2>{name}</h2>
        <p>{S.messages.beginningGroup}</p>
      </div>
    );
  }
  return (
    <div className="intro">
      <span className="intro-glyph">{conv.is_private ? <Lock size={26} /> : <Hash size={26} />}</span>
      <h2>{name}</h2>
      <p>{S.messages.beginningChannel(name)}</p>
      {conv.purpose?.value ? (
        <p className="intro-purpose">
          <Mrkdwn text={conv.purpose.value} inline />
        </p>
      ) : null}
    </div>
  );
}

export function MessageList({ channel }: { channel: string }) {
  const conv = useStore((state) => state.convs[channel]) ?? EMPTY_CONV;
  const info = useStore((state) => conversation(state, channel));
  const highlight = useStore((state) => state.highlight);
  const selfId = useStore((state) => state.self?.id);

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const bottomSentinel = useRef<HTMLDivElement>(null);
  /** Keep the newest message in view as content grows. */
  const stick = useRef(true);
  const lastHeight = useRef(0);
  const firstTs = useRef<string | null>(null);
  const lastKey = useRef<string | null>(null);
  const positionedFor = useRef<string | null>(null);
  const handledHighlight = useRef(0);
  /** The first message on screen and its distance from the top of the pane, to keep it still when rows come or go above it. */
  const anchor = useRef<{ ts: string; offset: number } | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  const isNearBottom = (): boolean => {
    const node = scroller.current;
    return !node || node.scrollHeight - node.scrollTop - node.clientHeight < NEAR_BOTTOM;
  };

  const captureAnchor = (): void => {
    const node = scroller.current;
    if (!node) return;
    const top = node.getBoundingClientRect().top;
    for (const row of node.querySelectorAll<HTMLElement>('.message-content > .msg[data-ts]')) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > top + 1) {
        anchor.current = { ts: row.dataset.ts!, offset: rect.top - top };
        return;
      }
    }
    anchor.current = null;
  };

  const restoreAnchor = (): boolean => {
    const node = scroller.current;
    const saved = anchor.current;
    if (!node || !saved) return false;
    const row = node.querySelector<HTMLElement>(`.message-content > .msg[data-ts="${saved.ts}"]`);
    if (!row) return false;
    node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top - saved.offset;
    return true;
  };

  const report = (): void => {
    captureAnchor();
    const node = scroller.current;
    // Content that grew since the last measurement (a video learning its size) is not the reader
    // scrolling away: keep the newest message in view rather than concluding they left the bottom.
    if (node && stick.current && node.scrollHeight !== lastHeight.current) {
      node.scrollTop = node.scrollHeight;
      lastHeight.current = node.scrollHeight;
    }
    const bottom = isNearBottom();
    stick.current = bottom;
    viewing.atBottom = bottom && !conv.hasNewer;
    setAtBottom((previous) => (previous === bottom ? previous : bottom));
    if (bottom && document.hasFocus()) maybeMarkRead(channel);
  };

  // Positioning: first paint, earlier messages prepended, new messages appended.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node || !conv.loaded) return;
    const first = conv.list[0]?.ts ?? null;
    const last = conv.list[conv.list.length - 1];
    const lastId = last ? (last.local_id ?? last.ts) : null;
    const ownSend = last?.pending && lastId !== lastKey.current;
    const pendingHighlight = highlight && highlight.channel === channel && highlight.at !== handledHighlight.current;

    if (positionedFor.current !== channel) {
      positionedFor.current = channel;
      if (!pendingHighlight) {
        const divider = node.querySelector<HTMLElement>('.divider-new');
        if (divider) node.scrollTop = Math.max(0, divider.offsetTop - 72);
        else node.scrollTop = node.scrollHeight;
      }
    } else if (firstTs.current && first && first !== firstTs.current && !(stick.current && first > firstTs.current)) {
      // Rows were added or dropped above what is on screen: keep the same message in the same place.
      if (!restoreAnchor() && first < firstTs.current) node.scrollTop += node.scrollHeight - lastHeight.current;
    } else if (stick.current || ownSend) {
      node.scrollTop = node.scrollHeight;
    }
    firstTs.current = first;
    lastKey.current = lastId;
    lastHeight.current = node.scrollHeight;
    report();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.list, conv.loaded, channel]);

  // Scroll to and flash a message opened from a link or search.
  useEffect(() => {
    if (!highlight || highlight.channel !== channel || !conv.loaded) return;
    if (highlight.at === handledHighlight.current) return;
    const node = scroller.current?.querySelector<HTMLElement>(`[data-ts="${highlight.ts}"]`);
    if (!node) return;
    handledHighlight.current = highlight.at;
    stick.current = false;
    node.scrollIntoView({ block: 'center' });
    const at = highlight.at;
    const timer = window.setTimeout(() => {
      set((state) => (state.highlight?.at === at ? { highlight: null } : {}));
    }, 2600);
    return () => window.clearTimeout(timer);
  }, [highlight, channel, conv.loaded, conv.list]);

  // Media that loads late makes the content taller, and a growing composer makes the pane
  // shorter; either way, stay pinned while at the bottom.
  useEffect(() => {
    const node = scroller.current;
    const inner = content.current;
    if (!node || !inner) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) node.scrollTop = node.scrollHeight;
      lastHeight.current = node.scrollHeight;
    });
    observer.observe(inner);
    observer.observe(node);
    return () => observer.disconnect();
  }, [channel]);

  // Keep the number of rows bounded: drop the end the reader is furthest from.
  useEffect(() => {
    const node = scroller.current;
    if (!node || conv.list.length <= MAX_LOADED) return;
    captureAnchor();
    if (stick.current) trimLoaded(channel, 'newest');
    else trimLoaded(channel, node.scrollTop < (node.scrollHeight - node.clientHeight) / 2 ? 'oldest' : 'newest');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.list.length, channel]);

  // Load more when the top or bottom edge scrolls into view.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (entry.target === topSentinel.current) void loadOlder(channel);
          else void loadNewer(channel);
        }
      },
      { root, rootMargin: '300px 0px' },
    );
    if (topSentinel.current) observer.observe(topSentinel.current);
    if (bottomSentinel.current) observer.observe(bottomSentinel.current);
    return () => observer.disconnect();
  }, [channel, conv.hasOlder, conv.hasNewer, conv.loaded, conv.list.length]);

  useEffect(() => {
    viewing.channel = channel;
    const onFocus = (): void => {
      if (isNearBottom()) maybeMarkRead(channel);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      if (viewing.channel === channel) viewing.channel = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  const jumpToLatest = (): void => {
    stick.current = true;
    if (conv.hasNewer) {
      positionedFor.current = null;
      void loadLatest(channel);
      return;
    }
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  };

  const rows: ReactNode[] = [];
  let previous: LocalMessage | undefined;
  let markerShown = false;
  for (const message of conv.list) {
    const newDay = !previous || dayKey(previous.ts) !== dayKey(message.ts);
    if (newDay) {
      rows.push(
        <div key={`day-${message.ts}`} className="divider-day" role="separator">
          <span>{dayLabel(message.ts)}</span>
        </div>,
      );
    }
    const firstNew = !markerShown && conv.marker !== null && message.ts > conv.marker && message.user !== selfId && !message.pending && !isSystem(message);
    if (firstNew) {
      markerShown = true;
      rows.push(
        <div key="new" className="divider-new" role="separator">
          <span>{S.messages.newDivider}</span>
        </div>,
      );
    }
    const compact = !newDay && !firstNew && previous !== undefined && groupable(previous, message);
    const flashing = highlight?.channel === channel && highlight.ts === message.ts;
    rows.push(
      <MessageRow
        key={message.local_id ?? message.client_msg_id ?? message.ts}
        channel={channel}
        message={message}
        compact={compact}
        highlighted={flashing}
      />,
    );
    previous = message;
  }

  return (
    <div className="message-pane">
      <div className="message-scroll" ref={scroller} onScroll={report}>
        <div className="message-content" ref={content}>
          {conv.loaded && conv.hasOlder ? (
            <div ref={topSentinel} className="list-edge">
              <Spinner label={S.messages.loadingOlder} />
            </div>
          ) : null}
          {conv.loaded && !conv.hasOlder && info ? <Intro conv={info} /> : null}
          {!conv.loaded ? (
            <div className="list-loading">
              <Spinner />
            </div>
          ) : null}
          {rows}
          {conv.hasNewer ? (
            <div ref={bottomSentinel} className="list-edge">
              <Spinner />
            </div>
          ) : null}
        </div>
      </div>
      {(!atBottom || conv.hasNewer) && conv.loaded ? (
        <button type="button" className="jump-latest" onClick={jumpToLatest}>
          <ArrowDown size={15} /> {S.messages.jumpToLatest}
        </button>
      ) : null}
    </div>
  );
}
