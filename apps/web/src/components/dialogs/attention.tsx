import type { FileObject } from '@app/shared';
import { Hash, Lock, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { closeModal, errorText, toast } from '../../lib/actions';
import { call, uploadFile } from '../../lib/api';
import { forwardMessage, saveBookmark, saveDndSchedule, scheduleMessage, shareFile } from '../../lib/attention';
import { conversation, conversationName, displayName, get, useStore, type Bookmark } from '../../lib/store';
import { S } from '../../strings';
import { MessagePreview } from '../views/common';
import { Avatar, Button, Field, Modal } from '../ui';

// ── Choosing where something goes ───────────────────────────────────────────

interface Destination {
  id: string;
  label: string;
  kind: 'channel' | 'private' | 'person' | 'group';
  userId?: string;
}

function useDestinations(): Destination[] {
  const channels = useStore((state) => state.channels);
  const users = useStore((state) => state.users);
  const selfId = useStore((state) => state.self?.id);
  return useMemo(() => {
    const state = get();
    const out: Destination[] = [];
    for (const conv of Object.values(channels)) {
      if (conv.is_archived) continue;
      if (conv.is_channel) out.push({ id: conv.id, label: conv.name ?? '', kind: conv.is_private ? 'private' : 'channel' });
      else if (conv.is_mpim) out.push({ id: conv.id, label: conversationName({ ...state, channels, users }, conv), kind: 'group' });
    }
    // People: a user id opens (or reuses) the direct message with them.
    for (const user of Object.values(users)) {
      if (user.deleted || user.is_bot) continue;
      out.push({ id: user.id, label: user.id === selfId ? `${displayName(user)} (${S.sidebar.you})` : displayName(user), kind: 'person', userId: user.id });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [channels, users, selfId]);
}

function DestinationPicker({ selected, onChange }: { selected: string[]; onChange: (ids: string[]) => void }) {
  const all = useDestinations();
  const users = useStore((state) => state.users);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase().replace(/^[#@]/, '');
  const shown = all.filter((item) => !selected.includes(item.id) && (!needle || item.label.toLowerCase().includes(needle))).slice(0, 30);
  const byId = new Map(all.map((item) => [item.id, item]));
  const icon = (item: Destination) =>
    item.kind === 'person' ? <Avatar user={users[item.userId!]} size={18} /> : item.kind === 'private' ? <Lock size={14} /> : item.kind === 'channel' ? <Hash size={14} /> : null;
  return (
    <div className="people-picker destination-picker">
      <div className="chip-input">
        {selected.map((id) => {
          const item = byId.get(id);
          return (
            <span key={id} className="chip">
              {item ? icon(item) : null}
              {item?.label ?? id}
              <button type="button" aria-label={S.remove} onClick={() => onChange(selected.filter((value) => value !== id))}>
                <X size={13} />
              </button>
            </span>
          );
        })}
        <input value={query} placeholder={selected.length === 0 ? S.att.forward.toPlaceholder : ''} onChange={(event) => setQuery(event.target.value)} aria-label={S.att.forward.to} data-autofocus />
      </div>
      {needle || selected.length === 0 ? (
        <ul className="people-list">
          {shown.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="member-row"
                onClick={() => {
                  if (selected.length < 10) onChange([...selected, item.id]);
                  setQuery('');
                }}
              >
                <span className="destination-icon">{icon(item)}</span>
                <span className="member-meta">
                  <span className="member-name">{item.label}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ── Forwarding ──────────────────────────────────────────────────────────────

export function ForwardDialog({ channel, ts }: { channel: string; ts: string }) {
  const message = useStore((state) => state.convs[channel]?.list.find((item) => item.ts === ts) ?? Object.values(state.threads).flatMap((thread) => [thread.parent, ...thread.replies]).find((item) => item?.ts === ts) ?? null);
  const fromPrivate = useStore((state) => {
    const conv = conversation(state, channel);
    return Boolean(conv && (conv.is_private || conv.is_im || conv.is_mpim));
  });
  const [to, setTo] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (): Promise<void> => {
    setBusy(true);
    const ok = await forwardMessage(channel, ts, to, text.trim());
    setBusy(false);
    if (ok) closeModal();
  };
  return (
    <Modal
      title={S.att.forward.title}
      onClose={closeModal}
      width={560}
      className="forward-modal"
      footer={
        <>
          <Button onClick={closeModal}>{S.cancel}</Button>
          <Button variant="primary" busy={busy} disabled={to.length === 0} onClick={() => void send()}>
            {S.att.forward.send}
          </Button>
        </>
      }
    >
      <DestinationPicker selected={to} onChange={setTo} />
      <Field label={S.att.forward.comment}>
        <textarea rows={2} value={text} onChange={(event) => setText(event.target.value)} />
      </Field>
      {fromPrivate ? <p className="notice">{S.att.forward.fromPrivate}</p> : null}
      {message ? (
        <div className="forward-quote">
          <MessagePreview channel={channel} message={message} />
        </div>
      ) : null}
    </Modal>
  );
}

export function ShareFileDialog({ file }: { file: FileObject }) {
  const [to, setTo] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (): Promise<void> => {
    setBusy(true);
    const ok = await shareFile(file, to, text.trim());
    setBusy(false);
    if (ok) closeModal();
  };
  return (
    <Modal
      title={S.att.forward.fileTitle}
      onClose={closeModal}
      width={560}
      footer={
        <>
          <Button onClick={closeModal}>{S.cancel}</Button>
          <Button variant="primary" busy={busy} disabled={to.length === 0} onClick={() => void send()}>
            {S.att.forward.share}
          </Button>
        </>
      }
    >
      <p className="dialog-lead">{file.title || file.name}</p>
      <DestinationPicker selected={to} onChange={setTo} />
      <Field label={S.att.forward.comment}>
        <textarea rows={2} value={text} onChange={(event) => setText(event.target.value)} />
      </Field>
    </Modal>
  );
}

// ── Scheduling ──────────────────────────────────────────────────────────────

function localInputValue(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ScheduleDialog({ channel, threadTs, text, broadcast }: { channel: string; threadTs?: string; text: string; broadcast?: boolean }) {
  const [value, setValue] = useState(() => {
    const date = new Date(Date.now() + 3600_000);
    date.setMinutes(0, 0, 0);
    return localInputValue(date);
  });
  const [busy, setBusy] = useState(false);
  const postAt = Math.floor(new Date(value).getTime() / 1000);
  const past = !Number.isFinite(postAt) || postAt * 1000 <= Date.now();
  const restore = (): void => {
    const key = `draft:${channel}${threadTs ? `:${threadTs}` : ''}`;
    if (!localStorage.getItem(key)) localStorage.setItem(key, text);
  };
  const confirm = async (): Promise<void> => {
    setBusy(true);
    const ok = await scheduleMessage(channel, text, postAt, threadTs, broadcast);
    setBusy(false);
    if (ok) closeModal();
  };
  return (
    <Modal
      title={S.att.schedule.title}
      onClose={() => {
        restore();
        closeModal();
      }}
      width={460}
      footer={
        <>
          <Button
            onClick={() => {
              restore();
              closeModal();
            }}
          >
            {S.cancel}
          </Button>
          <Button variant="primary" busy={busy} disabled={past} onClick={() => void confirm()}>
            {S.att.schedule.confirm}
          </Button>
        </>
      }
    >
      <Field label={S.att.schedule.when} error={past ? S.att.schedule.inPast : undefined}>
        <input type="datetime-local" value={value} min={localInputValue(new Date())} onChange={(event) => setValue(event.target.value)} data-autofocus />
      </Field>
      <div className="schedule-quote">{text}</div>
    </Modal>
  );
}

// ── Notification schedule ───────────────────────────────────────────────────

export function DndScheduleDialog() {
  const current = useStore((state) => state.att.dnd.schedule);
  const [enabled, setEnabled] = useState(current?.enabled ?? false);
  const [start, setStart] = useState(current?.start ?? '22:00');
  const [end, setEnd] = useState(current?.end ?? '08:00');
  const [days, setDays] = useState<number[]>(current?.days ?? [0, 1, 2, 3, 4, 5, 6]);
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    setBusy(true);
    const ok = await saveDndSchedule({ enabled, start, end, days });
    setBusy(false);
    if (ok) closeModal();
  };
  return (
    <Modal
      title={S.att.dnd.scheduleTitle}
      onClose={closeModal}
      width={480}
      footer={
        <>
          <Button onClick={closeModal}>{S.cancel}</Button>
          <Button variant="primary" busy={busy} disabled={enabled && (start === end || days.length === 0)} onClick={() => void save()}>
            {S.save}
          </Button>
        </>
      }
    >
      <p className="dialog-sub">{S.att.dnd.scheduleBody}</p>
      <label className="toggle-label">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        {S.att.dnd.scheduleOn}
      </label>
      <div className="dnd-times">
        <Field label={S.att.dnd.from}>
          <input type="time" value={start} disabled={!enabled} onChange={(event) => setStart(event.target.value)} />
        </Field>
        <Field label={S.att.dnd.to}>
          <input type="time" value={end} disabled={!enabled} onChange={(event) => setEnd(event.target.value)} />
        </Field>
      </div>
      <Field label={S.att.dnd.days}>
        <div className="day-picker">
          {S.att.dnd.dayNames.map((name, index) => {
            const on = days.includes(index);
            return (
              <button
                key={name}
                type="button"
                aria-pressed={on}
                disabled={!enabled}
                className={on ? 'is-on' : ''}
                onClick={() => setDays(on ? days.filter((day) => day !== index) : [...days, index].sort())}
              >
                {name}
              </button>
            );
          })}
        </div>
      </Field>
    </Modal>
  );
}

// ── Snippets ────────────────────────────────────────────────────────────────

/** Languages offered for a snippet; the highlighter loads only when a snippet is shown. */
const SNIPPET_TYPES = ['text', 'javascript', 'typescript', 'python', 'sql', 'bash', 'json', 'yaml', 'go', 'rust', 'java', 'kotlin', 'swift', 'cpp', 'csharp', 'ruby', 'php', 'css', 'xml', 'markdown', 'diff'];
const EXTENSIONS: Record<string, string> = { text: 'txt', javascript: 'js', typescript: 'ts', python: 'py', bash: 'sh', markdown: 'md', csharp: 'cs', kotlin: 'kt', ruby: 'rb', rust: 'rs', yaml: 'yaml' };

export function SnippetDialog({ channel, threadTs }: { channel: string; threadTs?: string }) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState('text');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      const name = `${(title.trim() || 'snippet').replace(/[\\/]/g, '-')}.${EXTENSIONS[type] ?? type}`;
      const file = new File([content], name, { type: 'text/plain' });
      // `snippet_type` marks it as a snippet; the upload itself is the ordinary two-step one.
      const fileId = await uploadFile(file, undefined, { snippetType: type });
      await call('files.completeUploadExternal', { files: [{ id: fileId, title: title.trim() || name }], channel_id: channel, thread_ts: threadTs });
      closeModal();
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={S.att.snippet.title}
      onClose={closeModal}
      width={680}
      footer={
        <>
          <Button onClick={closeModal}>{S.cancel}</Button>
          <Button variant="primary" busy={busy} disabled={!content.trim()} onClick={() => void create()}>
            {S.att.snippet.create}
          </Button>
        </>
      }
    >
      <div className="snippet-fields">
        <Field label={S.att.snippet.name}>
          <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} data-autofocus />
        </Field>
        <Field label={S.att.snippet.language}>
          <select value={type} onChange={(event) => setType(event.target.value)}>
            {SNIPPET_TYPES.map((item) => (
              <option key={item} value={item}>
                {item === 'text' ? S.att.snippet.plain : item}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label={S.att.snippet.content}>
        <textarea className="snippet-input" rows={12} spellCheck={false} value={content} onChange={(event) => setContent(event.target.value)} />
      </Field>
    </Modal>
  );
}

// ── Bookmarks ───────────────────────────────────────────────────────────────

export function BookmarkDialog({ channel, bookmark }: { channel: string; bookmark?: Bookmark }) {
  const [link, setLink] = useState(bookmark?.link ?? 'https://');
  const [title, setTitle] = useState(bookmark?.title ?? '');
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    setBusy(true);
    let name = title.trim();
    if (!name) {
      try {
        name = new URL(link.trim()).hostname;
      } catch {
        name = link.trim();
      }
    }
    const ok = await saveBookmark(channel, { link: link.trim(), title: name }, bookmark?.id);
    setBusy(false);
    if (ok) closeModal();
  };
  return (
    <Modal
      title={bookmark ? S.att.bookmarks.editTitle : S.att.bookmarks.title}
      onClose={closeModal}
      width={480}
      footer={
        <>
          <Button onClick={closeModal}>{S.cancel}</Button>
          <Button variant="primary" busy={busy} disabled={!/^https?:\/\/\S+\.\S+/.test(link.trim()) && !/^mailto:/.test(link.trim())} onClick={() => void save()}>
            {bookmark ? S.save : S.att.bookmarks.add}
          </Button>
        </>
      }
    >
      <Field label={S.att.bookmarks.link}>
        <input type="url" value={link} onChange={(event) => setLink(event.target.value)} data-autofocus />
      </Field>
      <Field label={S.att.bookmarks.name}>
        <input value={title} maxLength={250} onChange={(event) => setTitle(event.target.value)} />
      </Field>
    </Modal>
  );
}
