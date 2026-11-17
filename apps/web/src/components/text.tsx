import { parseMrkdwn, type MrkdwnNode } from '@app/shared';
import { memo, useEffect, useMemo, type MouseEvent, type ReactNode } from 'react';
import { ensureConversationInfo, go, setPanel } from '../lib/actions';
import { asset } from '../lib/api';
import { customEmojiUrl, nativeEmoji } from '../lib/emoji';
import { parseRoute } from '../lib/router';
import { conversation, displayName, useStore } from '../lib/store';
import { S } from '../strings';
import { formatDateTime } from '../lib/time';

// ── Emoji ───────────────────────────────────────────────────────────────────

export function Emoji({ name }: { name: string }) {
  const custom = useStore((state) => state.emoji);
  // Re-render once the standard emoji data has loaded.
  useStore((state) => state.emojiVersion);
  const base = name.split('::')[0] ?? name;
  const url = customEmojiUrl(base, custom);
  if (url) return <img className="emoji emoji-custom" src={asset(url)} alt={`:${name}:`} title={`:${name}:`} draggable={false} />;
  const native = nativeEmoji(name);
  if (native) {
    return (
      <span className="emoji" role="img" aria-label={base.replace(/_/g, ' ')} title={`:${name}:`}>
        {native}
      </span>
    );
  }
  return <>{`:${name}:`}</>;
}

/** Plain text in which `:shortcode:` is shown as emoji. */
export function PlainText({ text, emoji = true }: { text: string; emoji?: boolean }) {
  if (!emoji || !text.includes(':')) return <>{text}</>;
  const parts = text.split(/(:[a-z0-9_+'-]+(?:::skin-tone-[2-6])?:)/gi);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? <Emoji key={index} name={part.slice(1, -1).toLowerCase()} /> : <span key={index}>{part}</span>,
      )}
    </>
  );
}

// ── Inline entities ─────────────────────────────────────────────────────────

export function UserMention({ id, label }: { id: string; label?: string }) {
  const user = useStore((state) => state.users[id]);
  const isSelf = useStore((state) => state.self?.id === id);
  const name = user ? displayName(user) : (label ?? id);
  return (
    <button
      type="button"
      className={`mention ${isSelf ? 'is-me' : ''}`}
      onClick={(event) => {
        event.stopPropagation();
        if (user) setPanel({ kind: 'profile', user: id });
      }}
    >
      @{name}
    </button>
  );
}

export function ChannelLink({ id, label }: { id: string; label?: string }) {
  const conv = useStore((state) => conversation(state, id));
  useEffect(() => {
    if (!conv) ensureConversationInfo(id);
  }, [conv, id]);
  const hidden = useStore((state) => state.hiddenChannels[id] === true);
  const name = conv?.name ?? label;
  // Unknown and not labelled: still being looked up, or a private channel the viewer is not in.
  if (!name) return <span className="channel-link is-unknown">#{hidden ? S.messages.privateChannel : '…'}</span>;
  return (
    <a
      className="channel-link"
      href={`/c/${id}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        go({ name: 'conversation', id });
      }}
    >
      #{name}
    </a>
  );
}

export function Broadcast({ range }: { range: string }) {
  return <span className="mention is-broadcast">@{range}</span>;
}

/** A link. Links into this workspace navigate in place; everything else opens a new tab. */
export function Link({ url, children }: { url: string; children: ReactNode }) {
  let internal = false;
  let safe = url;
  try {
    const parsed = new URL(url, window.location.origin);
    if (!/^(https?|mailto|tel):$/.test(parsed.protocol)) safe = '#';
    internal = parsed.origin === window.location.origin && /^\/(archives|c)\//.test(parsed.pathname);
    if (internal) safe = parsed.pathname + parsed.search;
  } catch {
    safe = '#';
  }
  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.stopPropagation();
    if (!internal || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    const parsed = new URL(safe, window.location.origin);
    go(parseRoute(parsed));
  };
  return (
    <a href={safe} onClick={onClick} {...(internal ? {} : { target: '_blank', rel: 'noopener noreferrer' })}>
      {children}
    </a>
  );
}

export function DateToken({ timestamp, fallback }: { timestamp: number; fallback: string }) {
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return <>{fallback}</>;
  return <time dateTime={date.toISOString()}>{formatDateTime(date)}</time>;
}

// ── mrkdwn ──────────────────────────────────────────────────────────────────

function renderNodes(nodes: MrkdwnNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text':
        return <span key={index}>{node.text}</span>;
      case 'bold':
        return <strong key={index}>{renderNodes(node.children)}</strong>;
      case 'italic':
        return <em key={index}>{renderNodes(node.children)}</em>;
      case 'strike':
        return <s key={index}>{renderNodes(node.children)}</s>;
      case 'code':
        return (
          <code key={index} className="code-inline">
            {node.text}
          </code>
        );
      case 'pre':
        return (
          <pre key={index} className="code-block">
            <code>{node.text}</code>
          </pre>
        );
      case 'quote':
        return (
          <blockquote key={index} className="quote">
            {renderNodes(node.children)}
          </blockquote>
        );
      case 'link':
        return (
          <Link key={index} url={node.url}>
            {renderNodes(node.children)}
          </Link>
        );
      case 'user':
        return <UserMention key={index} id={node.id} label={node.label} />;
      case 'channel':
        return <ChannelLink key={index} id={node.id} label={node.label} />;
      case 'usergroup':
        return (
          <span key={index} className="mention">
            {node.label ?? `@${node.id}`}
          </span>
        );
      case 'broadcast':
        return <Broadcast key={index} range={node.range} />;
      case 'date':
        return <DateToken key={index} timestamp={node.timestamp} fallback={node.fallback} />;
      case 'emoji':
        return <Emoji key={index} name={node.name} />;
      case 'br':
        return <br key={index} />;
    }
  });
}

/** Up to three emoji and nothing else: show them large. */
function emojiOnly(nodes: MrkdwnNode[]): boolean {
  let count = 0;
  for (const node of nodes) {
    if (node.type === 'emoji') count += 1;
    else if (node.type === 'text' && node.text.trim() === '') continue;
    else return false;
  }
  return count > 0 && count <= 3;
}

export const Mrkdwn = memo(function Mrkdwn({ text, inline = false }: { text: string; inline?: boolean }) {
  const nodes = useMemo(() => parseMrkdwn(text), [text]);
  const className = `mrkdwn ${!inline && emojiOnly(nodes) ? 'is-jumbo' : ''}`;
  return inline ? <span className={className}>{renderNodes(nodes)}</span> : <div className={className}>{renderNodes(nodes)}</div>;
});
