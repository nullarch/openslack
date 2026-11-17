import { Bell, BellOff, BellRing, Check, Link2, Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { attempt, openModal, setConversationPrefs, toast } from '../lib/actions';
import { call } from '../lib/api';
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

interface Featured {
  id: string;
  title: string;
  link: string | null;
}

/** Workflows featured in the channel (workflows.featured.*): one click starts one here. */
function useFeatured(channel: string): Featured[] {
  const [featured, setFeatured] = useState<Featured[]>([]);
  useEffect(() => {
    let live = true;
    const load = (): void => {
      call('client.workflows.featured', { channel })
        .then((result) => live && setFeatured(result.featured as Featured[]))
        .catch(() => live && setFeatured([]));
    };
    load();
    const changed = (event: Event): void => {
      if ((event as CustomEvent<{ channel: string }>).detail?.channel === channel) load();
    };
    window.addEventListener('featured-workflows', changed);
    return () => {
      live = false;
      window.removeEventListener('featured-workflows', changed);
    };
  }, [channel]);
  return featured;
}

/** Links pinned under the conversation header. */
export function BookmarksBar({ channel, canEdit }: { channel: string; canEdit: boolean }) {
  const bookmarks = useStore((state) => state.att.bookmarks[channel]);
  const featured = useFeatured(channel);
  useEffect(() => {
    void loadBookmarks(channel);
  }, [channel]);
  if (!bookmarks || (bookmarks.length === 0 && featured.length === 0 && !canEdit)) return null;
  const start = async (item: Featured): Promise<void> => {
    if (!item.link) return;
    if (await attempt(() => call('client.workflows.startByLink', { link: item.link, channel }))) toast(S.wf.linkStarted);
  };
  return (
    <div className={`bookmarks-bar ${bookmarks.length === 0 && featured.length === 0 ? 'is-empty' : ''}`}>
      {featured.map((item) => (
        <button key={item.id} type="button" className="bookmark bookmark-workflow" onClick={() => void start(item)} title={S.wf.startFeatured(item.title)} data-featured-workflow={item.id}>
          <Zap size={13} />
          <span>{item.title}</span>
        </button>
      ))}
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
