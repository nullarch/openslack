import { Bell, BellOff, BellRing, Check, Link2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { openModal, setConversationPrefs } from '../lib/actions';
import { loadBookmarks, removeBookmark, setNotifyLevel, type NotifyLevel } from '../lib/attention';
import { useStore, type Bookmark } from '../lib/store';
import { S } from '../strings';
import { Emoji } from './text';
import { IconButton, MenuDivider, MenuItem, Popover } from './ui';

function BookmarkChip({ channel, bookmark }: { channel: string; bookmark: Bookmark }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [menu, setMenu] = useState(false);
  return (
    <>
      <a
        ref={ref}
        className="bookmark"
        href={bookmark.link}
        target="_blank"
        rel="noopener noreferrer"
        title={bookmark.link}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu(true);
        }}
      >
        {bookmark.emoji ? <Emoji name={bookmark.emoji.replace(/:/g, '')} /> : <Link2 size={13} />}
        <span>{bookmark.title}</span>
      </a>
      <button type="button" className="bookmark-more" aria-label={`${S.att.bookmarks.edit}: ${bookmark.title}`} onClick={() => setMenu(true)}>
        <Pencil size={11} />
      </button>
      {menu ? (
        <Popover anchor={ref.current} onClose={() => setMenu(false)} className="menu">
          <MenuItem
            icon={<Pencil size={16} />}
            label={S.att.bookmarks.edit}
            onSelect={() => {
              setMenu(false);
              openModal({ kind: 'bookmark', channel, bookmark });
            }}
          />
          <MenuItem
            icon={<Trash2 size={16} />}
            label={S.att.bookmarks.remove}
            danger
            onSelect={() => {
              setMenu(false);
              void removeBookmark(channel, bookmark.id);
            }}
          />
        </Popover>
      ) : null}
    </>
  );
}

/** Links pinned under the conversation header. */
export function BookmarksBar({ channel, canEdit }: { channel: string; canEdit: boolean }) {
  const bookmarks = useStore((state) => state.att.bookmarks[channel]);
  useEffect(() => {
    void loadBookmarks(channel);
  }, [channel]);
  if (!bookmarks || (bookmarks.length === 0 && !canEdit)) return null;
  return (
    <div className={`bookmarks-bar ${bookmarks.length === 0 ? 'is-empty' : ''}`}>
      {bookmarks.map((bookmark) => (
        <BookmarkChip key={bookmark.id} channel={channel} bookmark={bookmark} />
      ))}
      {canEdit ? (
        <button type="button" className="bookmark bookmark-add" onClick={() => openModal({ kind: 'bookmark', channel })}>
          <Plus size={13} />
          <span>{S.att.bookmarks.add}</span>
        </button>
      ) : null}
    </div>
  );
}

/** The bell in the conversation header: notification level and mute. */
export function NotifyButton({ channel }: { channel: string }) {
  const conv = useStore((state) => state.channels[channel]);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!conv) return null;
  const level = conv.notify_level ?? 'default';
  const levels: [NotifyLevel, string, string?][] = [
    ['default', S.att.notify.default, S.att.notify.defaultHint],
    ['all', S.att.notify.all],
    ['mentions', S.att.notify.mentions],
    ['nothing', S.att.notify.nothing],
  ];
  const icon = conv.is_muted || level === 'nothing' ? <BellOff size={17} /> : level === 'all' ? <BellRing size={17} /> : <Bell size={17} />;
  return (
    <>
      <IconButton ref={anchor} className={`notify-btn is-${conv.is_muted ? 'muted' : level}`} label={S.att.notify.menu} onClick={() => setOpen(true)}>
        {icon}
      </IconButton>
      {open ? (
        <Popover anchor={anchor.current} onClose={() => setOpen(false)} align="end" className="menu">
          <div className="menu-heading">{S.att.notify.menu}</div>
          {levels.map(([value, label, hint]) => (
            <MenuItem
              key={value}
              icon={level === value ? <Check size={16} /> : <span />}
              label={label}
              hint={hint}
              onSelect={() => {
                setOpen(false);
                void setNotifyLevel(channel, value);
              }}
            />
          ))}
          <MenuDivider />
          <MenuItem
            icon={conv.is_muted ? <Bell size={16} /> : <BellOff size={16} />}
            label={conv.is_muted ? S.att.notify.unmute : S.att.notify.mute}
            onSelect={() => {
              setOpen(false);
              void setConversationPrefs(channel, { muted: !conv.is_muted });
            }}
          />
        </Popover>
      ) : null}
    </>
  );
}
