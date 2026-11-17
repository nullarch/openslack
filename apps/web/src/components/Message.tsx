import type { Message, Reaction } from '@app/shared';
import { AlarmClock, BellOff, BellRing, Bookmark, Copy, EyeOff, Flag, Forward, Link2, MessageSquareText, MoreHorizontal, Pencil, Pin, PinOff, Share2, SmilePlus, Trash2 } from 'lucide-react';
import { canDeleteOwn, canEditMessage, remindAbout, setThreadFollow, toggleSaved } from '../lib/attention';
import { RemindMenu } from './views/Later';
import { lazy, memo, Suspense, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import {
  attempt,
  deleteMessage,
  discardFailed,
  editMessage,
  markUnreadFrom,
  openModal,
  openThread,
  retryMessage,
  setPanel,
  setPinned,
  toast,
  toggleReaction,
} from '../lib/actions';
import { call } from '../lib/api';
import { useShallow } from 'zustand/react/shallow';
import { composeGroups } from '../lib/accounts';
import { decodeMessage, encodeMessage } from '../lib/compose';
import { nativeEmoji } from '../lib/emoji';
import { conversation, displayName, get, set, useStore, type LocalMessage } from '../lib/store';
import { clock, fullDateTime, relative } from '../lib/time';
import { S } from '../strings';
import { HuddleCard } from './Huddle';
import { AiMessageItems, AiTranslation } from './ai/AiControls';
import { Attachments, Blocks } from './blocks';
import { confirmDialog, promptDialog } from './dialogs/confirm';
import { Files } from './files';
import { DocCards } from './docs';
import { Emoji, Mrkdwn } from './text';
import { MessageShortcutItems } from './AppViews';
import { Avatar, IconButton, MenuDivider, MenuItem, Popover, Spinner } from './ui';

const EmojiPicker = lazy(() => import('./EmojiPicker'));

const SYSTEM_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'channel_convert',
  'channel_convert_to_private',
  'pinned_item',
]);
const QUICK_REACTIONS = ['white_check_mark', 'eyes', 'raised_hands'];

/**
 * The server writes system lines in English; show them in the interface language by
 * their subtype. Anything not recognised is shown as sent.
 */
const SYSTEM_TEXT: [subtype: string, pattern: RegExp, render: (match: RegExpExecArray) => string][] = [
  ['channel_join', /^(<@[A-Z0-9]+>) has joined the channel$/, (m) => S.system.joined(m[1]!)],
  ['channel_leave', /^(<@[A-Z0-9]+>) has left the channel$/, (m) => S.system.left(m[1]!)],
  ['channel_archive', /^(<@[A-Z0-9]+>) archived the channel$/, (m) => S.system.archived(m[1]!)],
  ['channel_name', /^(<@[A-Z0-9]+>) has renamed the channel from "(.*)" to "(.*)"$/, (m) => S.system.renamed(m[1]!, m[2]!, m[3]!)],
  ['channel_topic', /^(<@[A-Z0-9]+>) set the channel topic: ([\s\S]*)$/, (m) => S.system.topicSet(m[1]!, m[2]!)],
  ['channel_topic', /^(<@[A-Z0-9]+>) cleared the channel topic$/, (m) => S.system.topicCleared(m[1]!)],
  ['channel_purpose', /^(<@[A-Z0-9]+>) set the channel description: ([\s\S]*)$/, (m) => S.system.purposeSet(m[1]!, m[2]!)],
  ['channel_purpose', /^(<@[A-Z0-9]+>) cleared the channel description$/, (m) => S.system.purposeCleared(m[1]!)],
  ['channel_convert', /^(<@[A-Z0-9]+>) turned this conversation into the private channel #(\S+)$/, (m) => S.system.convertedFromDm(m[1]!, m[2]!)],
  ['channel_convert_to_private', /^(<@[A-Z0-9]+>) made this channel private$/, (m) => S.system.madePrivate(m[1]!)],
];

export function systemText(message: Message): string {
  const text = message.text ?? '';
  for (const [subtype, pattern, render] of SYSTEM_TEXT) {
    if (message.subtype !== subtype) continue;
    const match = pattern.exec(text);
    if (match) return render(match);
  }
  return text;
}

export function isSystem(message: Message): boolean {
  return message.subtype !== undefined && SYSTEM_SUBTYPES.has(message.subtype);
}

export function composeLookup() {
  const state = get();
  return {
    users: Object.values(state.users)
      .filter((user) => !user.deleted)
      .map((user) => ({ id: user.id, names: [user.profile.display_name, user.real_name, user.name].filter(Boolean) })),
    channels: [...Object.values(state.channels), ...Object.values(state.others)]
      .filter((channel) => channel.is_channel && channel.name)
      .map((channel) => ({ id: channel.id, name: channel.name! })),
    groups: composeGroups(),
  };
}

export function permalink(channel: string, message: Message): string {
  const base = `${window.location.origin}/archives/${channel}/p${message.ts.replace('.', '')}`;
  return message.thread_ts && message.thread_ts !== message.ts ? `${base}?thread_ts=${message.thread_ts}&cid=${channel}` : base;
}

// ── Picker popover ──────────────────────────────────────────────────────────

export function PickerPopover({ anchor, onPick, onClose, side = 'bottom' }: { anchor: HTMLElement | null; onPick: (name: string) => void; onClose: () => void; side?: 'top' | 'bottom' }) {
  return (
    <Popover anchor={anchor} onClose={onClose} align="end" side={side} className="picker-popover">
      <Suspense
        fallback={
          <div className="picker-loading">
            <Spinner />
          </div>
        }
      >
        <EmojiPicker
          onPick={(name) => {
            onPick(name);
            onClose();
          }}
        />
      </Suspense>
    </Popover>
  );
}

// ── Reactions ───────────────────────────────────────────────────────────────

function ReactionPill({ channel, message, reaction }: { channel: string; message: Message; reaction: Reaction }) {
  const selfId = useStore((state) => state.self?.id);
  const names = useStore((state) => reaction.users.map((id) => (id === selfId ? S.sidebar.you : displayName(state.users[id]))).join(', '));
  const mine = selfId ? reaction.users.includes(selfId) : false;
  return (
    <button
      type="button"
      className={`reaction ${mine ? 'is-mine' : ''}`}
      title={`${names} — :${reaction.name}:`}
      aria-pressed={mine}
      onClick={() => void toggleReaction(channel, message, reaction.name)}
    >
      <Emoji name={reaction.name} />
      <span className="reaction-count">{reaction.count}</span>
    </button>
  );
}

function Reactions({ channel, message }: { channel: string; message: Message }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  if (!message.reactions?.length) return null;
  return (
    <div className="reactions">
      {message.reactions.map((reaction) => (
        <ReactionPill key={reaction.name} channel={channel} message={message} reaction={reaction} />
      ))}
      <button ref={anchor} type="button" className="reaction reaction-add" aria-label={S.messages.actions.react} title={S.messages.actions.react} onClick={() => setPicking(true)}>
        <SmilePlus size={15} />
      </button>
      {picking ? <PickerPopover anchor={anchor.current} onClose={() => setPicking(false)} onPick={(name) => void toggleReaction(channel, message, name)} /> : null}
    </div>
  );
}

// ── Thread summary ──────────────────────────────────────────────────────────

function ThreadSummary({ channel, message }: { channel: string; message: Message }) {
  const users = useStore(useShallow((state) => (message.reply_users ?? []).slice(0, 4).map((id) => state.users[id])));
  if (!message.reply_count) return null;
  return (
    <button type="button" className="thread-summary" onClick={() => openThread(channel, message.ts)}>
      <span className="thread-avatars">
        {users.map((user, index) => (
          <Avatar key={user?.id ?? index} user={user} size={22} />
        ))}
      </span>
      <span className="thread-count">{S.messages.replyCount(message.reply_count)}</span>
      {message.latest_reply ? <span className="thread-last">{S.messages.lastReply(relative(message.latest_reply))}</span> : null}
      <span className="thread-open">{S.messages.viewThread}</span>
    </button>
  );
}

// ── Inline editor ───────────────────────────────────────────────────────────

function EditBox({ channel, message }: { channel: string; message: Message }) {
  const [text, setText] = useState(() =>
    decodeMessage(message.text, {
      userName: (id) => {
        const user = get().users[id];
        return user ? displayName(user) : undefined;
      },
      channelName: (id) => conversation(get(), id)?.name,
    }),
  );
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 320)}px`;
  }, [text]);

  const cancel = (): void => set({ editing: null });
  const save = async (): Promise<void> => {
    const next = encodeMessage(text.trim(), composeLookup());
    if (!next) {
      if (await confirmDialog(S.messages.confirmDelete, S.messages.deleteConfirm)) {
        await deleteMessage(channel, message.ts);
        cancel();
      }
      return;
    }
    if (next === message.text) {
      cancel();
      return;
    }
    setSaving(true);
    const ok = await editMessage(channel, message.ts, next);
    setSaving(false);
    if (ok) cancel();
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      cancel();
    } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void save();
    }
  };

  return (
    <div className="edit-box">
      <textarea ref={ref} value={text} rows={1} onChange={(event) => setText(event.target.value)} onKeyDown={onKey} aria-label={S.messages.actions.edit} />
      <div className="edit-actions">
        <span className="edit-hint">{S.messages.editHint}</span>
        <button type="button" className="btn btn-default btn-sm" onClick={cancel}>
          {S.cancel}
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
          {S.messages.editSave}
        </button>
      </div>
    </div>
  );
}

// ── Hover toolbar ───────────────────────────────────────────────────────────

interface ToolbarProps {
  channel: string;
  message: LocalMessage;
  inThread: boolean;
  onOpenChange: (open: boolean) => void;
}

function Toolbar({ channel, message, inThread, onOpenChange }: ToolbarProps) {
  const self = useStore((state) => state.self);
  const saved = useStore((state) => state.att.saved[`${channel}:${message.ts}`] === 'in_progress');
  const reactRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<'react' | 'more' | 'remind' | null>(null);
  const [following, setFollowing] = useState<boolean | null>(null);
  const change = (next: 'react' | 'more' | 'remind' | null): void => {
    setOpen(next);
    onOpenChange(next !== null);
  };

  const own = self?.id === message.user;
  // Workspace rules (edit window, who may delete) apply to people; admins are not limited.
  useStore((state) => state.att.messagePolicy);
  const canDelete = (own && canDeleteOwn()) || (self?.is_admin ?? false);
  const isParent = Boolean(message.reply_count) && message.thread_ts === message.ts;
  const threadTs = message.thread_ts ?? message.ts;
  const isFollowing = following ?? (message as LocalMessage & { subscribed?: boolean }).subscribed ?? Boolean(message.reply_users?.includes(self?.id ?? '') || message.user === self?.id);
  const pinned = Boolean(message.pinned_to?.length);
  const copy = (text: string, done: string): void => {
    void navigator.clipboard.writeText(text).then(() => toast(done));
    change(null);
  };

  return (
    <div className="msg-toolbar" role="toolbar">
      {QUICK_REACTIONS.map((name) => (
        <IconButton key={name} label={S.a11y.reactWith(nativeEmoji(name) ?? `:${name}:`)} onClick={() => void toggleReaction(channel, message, name)}>
          <Emoji name={name} />
        </IconButton>
      ))}
      <IconButton ref={reactRef} label={S.messages.actions.react} onClick={() => change('react')}>
        <SmilePlus size={17} />
      </IconButton>
      {!inThread ? (
        <IconButton label={S.messages.actions.thread} onClick={() => openThread(channel, message.thread_ts ?? message.ts)}>
          <MessageSquareText size={17} />
        </IconButton>
      ) : null}
      <IconButton label={saved ? S.att.later.unsave : S.att.later.save} className={saved ? 'is-on' : ''} onClick={() => void toggleSaved(channel, message.ts)}>
        <Bookmark size={17} fill={saved ? 'currentColor' : 'none'} />
      </IconButton>
      <IconButton ref={moreRef} label={S.messages.actions.more} onClick={() => change('more')}>
        <MoreHorizontal size={17} />
      </IconButton>
      {open === 'react' ? (
        <PickerPopover anchor={reactRef.current} onClose={() => change(null)} onPick={(name) => void toggleReaction(channel, message, name)} />
      ) : null}
      {open === 'remind' ? <RemindMenu anchor={moreRef.current} onClose={() => change(null)} onPick={(time) => void remindAbout(channel, message.ts, time)} /> : null}
      {open === 'more' ? (
        <Popover anchor={moreRef.current} onClose={() => change(null)} align="end" className="menu">
          <MenuItem
            icon={<Forward size={16} />}
            label={S.att.forward.action}
            onSelect={() => {
              change(null);
              openModal({ kind: 'forward', channel, ts: message.ts });
            }}
          />
          {message.files?.length === 1 ? (
            <MenuItem
              icon={<Share2 size={16} />}
              label={S.att.files.share}
              onSelect={() => {
                change(null);
                openModal({ kind: 'shareFile', file: message.files![0]! });
              }}
            />
          ) : null}
          <MenuItem icon={<AlarmClock size={16} />} label={S.att.later.remindMe} onSelect={() => change('remind')} />
          {isParent || inThread ? (
            <MenuItem
              icon={isFollowing ? <BellOff size={16} /> : <BellRing size={16} />}
              label={isFollowing ? S.att.threads.unfollow : S.att.threads.follow}
              onSelect={() => {
                change(null);
                void setThreadFollow(channel, threadTs, !isFollowing).then(setFollowing);
              }}
            />
          ) : null}
          <MenuDivider />
          {own && !message.bot_id && canEditMessage(message) ? (
            <MenuItem
              icon={<Pencil size={16} />}
              label={S.messages.actions.edit}
              onSelect={() => {
                change(null);
                set({ editing: { channel, ts: message.ts } });
              }}
            />
          ) : null}
          <MenuItem
            icon={pinned ? <PinOff size={16} /> : <Pin size={16} />}
            label={pinned ? S.messages.actions.unpin : S.messages.actions.pin}
            onSelect={() => {
              change(null);
              void setPinned(channel, message.ts, !pinned);
            }}
          />
          <MenuItem icon={<Link2 size={16} />} label={S.messages.actions.copyLink} onSelect={() => copy(permalink(channel, message), S.messages.linkCopied)} />
          {message.text ? <MenuItem icon={<Copy size={16} />} label={S.messages.actions.copyText} onSelect={() => copy(message.text, S.messages.textCopied)} /> : null}
          {!inThread ? (
            <MenuItem
              icon={<EyeOff size={16} />}
              label={S.messages.actions.markUnread}
              onSelect={() => {
                change(null);
                void markUnreadFrom(channel, message);
              }}
            />
          ) : null}
          {!own && message.subtype !== 'tombstone' ? (
            <MenuItem
              icon={<Flag size={16} />}
              label={S.messages.actions.report}
              onSelect={() => {
                change(null);
                void promptDialog({ title: S.messages.reportTitle, label: S.messages.reportLabel, initial: '', multiline: true, confirmLabel: S.messages.reportSend }).then(async (note) => {
                  if (note === null) return;
                  const done = await attempt(() => call('client.messages.report', { channel, ts: message.ts, reason: 'other', note: note.trim() }));
                  if (done) toast(S.messages.reported);
                });
              }}
            />
          ) : null}
          <MessageShortcutItems channel={channel} ts={message.ts} onDone={() => change(null)} />
          <AiMessageItems channel={channel} message={message} inThread={inThread} onDone={() => change(null)} />
          {canDelete ? (
            <>
              <MenuDivider />
              <MenuItem
                icon={<Trash2 size={16} />}
                label={S.messages.actions.delete}
                danger
                onSelect={() => {
                  change(null);
                  void confirmDialog(S.messages.confirmDelete, S.messages.deleteConfirm).then((ok) => {
                    if (ok) void deleteMessage(channel, message.ts);
                  });
                }}
              />
            </>
          ) : null}
        </Popover>
      ) : null}
    </div>
  );
}

// ── Row ─────────────────────────────────────────────────────────────────────

interface RowProps {
  channel: string;
  message: LocalMessage;
  /** Continue the previous author's group: no avatar or name. */
  compact?: boolean;
  inThread?: boolean;
  highlighted?: boolean;
}

function Body({ channel, message, id }: { channel: string; message: LocalMessage; id?: string }) {
  let content: ReactNode = null;
  if (message.subtype === 'tombstone') content = <span className="msg-deleted">{S.messages.deleted}</span>;
  else if (message.subtype === 'huddle_thread') content = <HuddleCard channel={channel} message={message} />;
  else if (message.blocks?.length) content = <Blocks blocks={message.blocks} fallbackText={message.text} channel={channel} message={message} />;
  else if (message.text) content = <Mrkdwn text={message.text} />;
  return (
    <div id={id} className={`msg-body ${message.streaming ? 'is-streaming' : ''} ${message.subtype === 'me_message' ? 'is-me-message' : ''}`}>
      {content}
      {message.streaming && !content ? <span className="msg-streaming-empty">{S.messages.streaming}</span> : null}
      {message.edited && !message.bot_id ? <span className="msg-edited">{S.messages.edited}</span> : null}
      <AiTranslation channel={channel} ts={message.ts} />
    </div>
  );
}

export const MessageRow = memo(function MessageRow({ channel, message, compact = false, inThread = false, highlighted = false }: RowProps) {
  const author = useStore((state) => state.users[message.user ?? '']);
  const editing = useStore((state) => state.editing?.channel === channel && state.editing.ts === message.ts);
  const saved = useStore((state) => state.att.saved[`${channel}:${message.ts}`] === 'in_progress');
  const collapsed = useStore((state) => Boolean(state.att.collapsed[channel]));
  const [menuOpen, setMenuOpen] = useState(false);
  // People this viewer chose to hide: their messages fold to one line until asked for.
  const hiddenAuthor = useStore((state) => Boolean(message.user && Array.isArray(state.prefs.hidden_users) && (state.prefs.hidden_users as string[]).includes(message.user)));
  const [revealed, setRevealed] = useState(false);
  // A message is an article named by its author, time and text, so a screen reader reads all three on reaching it.
  const ids = useId();
  const authorId = `${ids}a`;
  const timeId = `${ids}t`;
  const bodyId = `${ids}b`;

  if (isSystem(message)) {
    return (
      <div className={`msg msg-system ${highlighted ? 'is-highlighted' : ''}`} data-ts={message.ts} role="article">
        <span className="msg-gutter" />
        <div className="msg-system-text">
          <Mrkdwn text={systemText(message)} inline />
          <time title={fullDateTime(message.ts)}>{clock(message.ts)}</time>
        </div>
      </div>
    );
  }

  if (hiddenAuthor && !revealed) {
    return (
      <div className={`msg msg-system is-hidden-author ${highlighted ? 'is-highlighted' : ''}`} data-ts={message.ts} role="article">
        <span className="msg-gutter" />
        <div className="msg-system-text">
          {S.messages.hiddenAuthor}{' '}
          <button type="button" className="link-btn" onClick={() => setRevealed(true)}>
            {S.messages.showHidden}
          </button>
        </div>
      </div>
    );
  }

  const name = message.username || (author ? displayName(author) : (message.bot_profile?.name ?? 'Unknown'));
  const isBot = Boolean(message.bot_id) || author?.is_bot;
  const transient = message.pending || message.failed;
  const showHeader = !compact;
  const classes = [
    'msg',
    compact ? 'is-compact' : '',
    highlighted ? 'is-highlighted' : '',
    menuOpen ? 'is-menu-open' : '',
    message.pending ? 'is-pending' : '',
    message.failed ? 'is-failed' : '',
    message.is_ephemeral ? 'is-ephemeral' : '',
    message.pinned_to?.length ? 'is-pinned' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const onTap = (event: MouseEvent<HTMLDivElement>): void => {
    if (!window.matchMedia('(hover: none)').matches) return;
    if ((event.target as HTMLElement).closest('button, a, input, textarea, select, video, audio, .msg-toolbar')) return;
    setMenuOpen((open) => !open);
  };

  return (
    <div
      className={classes}
      data-ts={message.ts}
      onClick={onTap}
      role="article"
      aria-labelledby={`${authorId} ${timeId} ${bodyId}`}
      aria-busy={message.streaming || message.pending ? true : undefined}
    >
      <div className="msg-gutter">
        {showHeader ? (
          <button type="button" className="msg-avatar" onClick={() => author && setPanel({ kind: 'profile', user: author.id })} tabIndex={-1} aria-hidden="true">
            {message.icons?.emoji ? (
              <span className="avatar avatar-emoji">
                <Emoji name={message.icons.emoji.replace(/:/g, '')} />
              </span>
            ) : message.icons?.image_64 ? (
              <span className="avatar" style={{ width: 36, height: 36, borderRadius: 9 }}>
                <img src={message.icons.image_64} alt="" width={36} height={36} style={{ borderRadius: 9 }} />
              </span>
            ) : (
              <Avatar user={author} size={36} />
            )}
          </button>
        ) : (
          <>
            <span className="sr-only" id={authorId}>
              {name}
            </span>
            <span className="sr-only" id={timeId}>
              {clock(message.ts)}
            </span>
            <time className="msg-gutter-time" title={fullDateTime(message.ts)} aria-hidden="true">
              {clock(message.ts).replace(/\s?[AP]M$/i, '')}
            </time>
          </>
        )}
      </div>
      <div className="msg-main">
        {message.pinned_to?.length ? (
          <div className="msg-flag">
            <Pin size={12} /> {S.messages.pinned}
          </div>
        ) : null}
        {saved ? (
          <div className="msg-flag is-saved">
            <Bookmark size={12} /> {S.att.later.saved}
          </div>
        ) : null}
        {message.subtype === 'thread_broadcast' && !inThread ? (
          <button type="button" className="msg-flag is-link" onClick={() => openThread(channel, message.thread_ts ?? message.ts)}>
            <MessageSquareText size={12} /> {S.messages.repliedToThread}
          </button>
        ) : null}
        {showHeader ? (
          <div className="msg-head">
            <button type="button" className="msg-author" id={authorId} onClick={() => author && setPanel({ kind: 'profile', user: author.id })}>
              {name}
            </button>
            {isBot ? <span className="tag">{S.messages.app}</span> : null}
            {author?.profile.status_emoji && !isBot ? (
              <span className="msg-status" title={author.profile.status_text}>
                <Emoji name={author.profile.status_emoji.replace(/:/g, '')} />
              </span>
            ) : null}
            <time className="msg-time" id={timeId} title={fullDateTime(message.ts)}>
              {clock(message.ts)}
            </time>
            {message.is_ephemeral ? <span className="msg-note">{S.messages.onlyYou}</span> : null}
          </div>
        ) : null}
        {editing ? <EditBox channel={channel} message={message} /> : <Body channel={channel} message={message} id={bodyId} />}
        {message.files?.length ? <Files files={message.files} collapsed={collapsed} /> : null}
        {message.attachments?.length ? <Attachments attachments={message.attachments} channel={channel} message={message} /> : null}
        {message.text && message.subtype !== 'tombstone' ? <DocCards text={message.text} /> : null}
        {message.failed ? (
          <div className="msg-failed">
            {S.messages.failed}{' '}
            <button type="button" className="link-btn" onClick={() => retryMessage(channel, message)}>
              {S.retry}
            </button>
            <button type="button" className="link-btn" onClick={() => discardFailed(channel, message)}>
              {S.messages.discard}
            </button>
          </div>
        ) : null}
        {!transient ? <Reactions channel={channel} message={message} /> : null}
        {!inThread && !transient ? <ThreadSummary channel={channel} message={message} /> : null}
      </div>
      {!transient && !editing && !message.is_ephemeral && message.subtype !== 'tombstone' ? (
        <Toolbar channel={channel} message={message} inThread={inThread} onOpenChange={setMenuOpen} />
      ) : null}
    </div>
  );
});
