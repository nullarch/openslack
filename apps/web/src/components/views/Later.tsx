import { describeRecurrence, type FileObject, type Message } from '@app/shared';
import { AlarmClock, Archive, Check, Clock, Forward, MessageSquareText, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { attempt, errorText, go, openMessage, openModal, openThread } from '../../lib/actions';
import { call } from '../../lib/api';
import { remindAbout, removeSaved, saveDraft, setSavedState, whenText } from '../../lib/attention';
import { displayName, useStore } from '../../lib/store';
import { relative } from '../../lib/time';
import { S } from '../../strings';
import { Files } from '../files';
import { Mrkdwn } from '../text';
import { Avatar, Button, IconButton, MenuItem, Popover, Spinner } from '../ui';
import { promptDialog } from '../dialogs/confirm';
import { EmptyNote, MessagePreview, PlaceLabel, Tabs, useRefreshOn, ViewFrame } from './common';

// ── Remind-me menu (shared with the message toolbar) ────────────────────────

function nextMonday9(): number {
  const date = new Date();
  date.setDate(date.getDate() + (((8 - date.getDay()) % 7) || 7));
  date.setHours(9, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

function tomorrow9(): number {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

export function RemindMenu({ anchor, onClose, onPick }: { anchor: HTMLElement | null; onClose: () => void; onPick: (time: string) => void }) {
  const now = (): number => Math.floor(Date.now() / 1000);
  const pick = (time: string | number): void => {
    onClose();
    onPick(String(time));
  };
  return (
    <Popover anchor={anchor} onClose={onClose} align="end" className="menu">
      <div className="menu-heading">{S.att.later.remindMe}</div>
      <MenuItem icon={<Clock size={16} />} label={S.att.later.remindIn20} onSelect={() => pick(now() + 20 * 60)} />
      <MenuItem icon={<Clock size={16} />} label={S.att.later.remindIn1h} onSelect={() => pick(now() + 3600)} />
      <MenuItem icon={<Clock size={16} />} label={S.att.later.remindIn3h} onSelect={() => pick(now() + 3 * 3600)} />
      <MenuItem icon={<Clock size={16} />} label={S.att.later.remindTomorrow} onSelect={() => pick(tomorrow9())} />
      <MenuItem icon={<Clock size={16} />} label={S.att.later.remindNextWeek} onSelect={() => pick(nextMonday9())} />
      <MenuItem
        icon={<AlarmClock size={16} />}
        label={S.att.later.remindCustom}
        onSelect={() => {
          onClose();
          void promptDialog({ title: S.att.later.remindMe, label: S.att.later.remindPrompt, placeholder: 'in 2 hours', confirmLabel: S.done }).then((value) => {
            if (value?.trim()) onPick(value.trim());
          });
        }}
      />
    </Popover>
  );
}

// ── Later ───────────────────────────────────────────────────────────────────

type LaterTab = 'in_progress' | 'archived' | 'completed' | 'reminders';

interface SavedItem {
  channel: string;
  ts: string;
  state: 'in_progress' | 'archived' | 'completed';
  date_saved: number;
  message?: Message;
}

interface Reminder {
  id: string;
  creator: string;
  user: string;
  text: string;
  recurring: boolean;
  time?: number;
  next_time?: number;
  complete_ts?: number;
  recurrence?: { frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'; weekdays?: string[] };
  channel?: string;
  message_ts?: string;
}

function SavedRow({ item }: { item: SavedItem }) {
  const remindButton = useRef<HTMLButtonElement>(null);
  const [reminding, setReminding] = useState(false);
  const open = (): void => {
    if (item.message) openMessage(item.channel, item.message);
    else go({ name: 'conversation', id: item.channel });
  };
  return (
    <div className="result later-item" role="button" tabIndex={0} onClick={open} onKeyDown={(event) => event.key === 'Enter' && open()}>
      <div className="result-place">
        <PlaceLabel channel={item.channel} />
        <time>{relative(String(item.date_saved))}</time>
        <span className="composer-spacer" />
        <span className="row-actions" onClick={(event) => event.stopPropagation()}>
          {item.state !== 'completed' ? (
            <IconButton label={S.att.later.complete} onClick={() => void setSavedState(item.channel, item.ts, 'completed')}>
              <Check size={16} />
            </IconButton>
          ) : null}
          {item.state === 'in_progress' ? (
            <IconButton label={S.att.later.archive} onClick={() => void setSavedState(item.channel, item.ts, 'archived')}>
              <Archive size={16} />
            </IconButton>
          ) : (
            <IconButton label={S.att.later.restore} onClick={() => void setSavedState(item.channel, item.ts, 'in_progress')}>
              <RotateCcw size={16} />
            </IconButton>
          )}
          <IconButton ref={remindButton} label={S.att.later.remindMe} onClick={() => setReminding(true)}>
            <AlarmClock size={16} />
          </IconButton>
          <IconButton label={S.att.later.remove} onClick={() => void removeSaved(item.channel, item.ts)}>
            <Trash2 size={16} />
          </IconButton>
        </span>
      </div>
      {item.message ? <MessagePreview channel={item.channel} message={item.message} /> : <p className="view-empty is-inline">{S.att.activity.gone}</p>}
      {reminding ? <RemindMenu anchor={remindButton.current} onClose={() => setReminding(false)} onPick={(time) => void remindAbout(item.channel, item.ts, time)} /> : null}
    </div>
  );
}

function ReminderRow({ reminder, onChange }: { reminder: Reminder; onChange: () => void }) {
  const selfId = useStore((state) => state.self?.id);
  const other = useStore((state) => (reminder.user !== selfId ? displayName(state.users[reminder.user]) : reminder.creator !== selfId ? displayName(state.users[reminder.creator]) : null));
  const snoozeButton = useRef<HTMLButtonElement>(null);
  const [snoozing, setSnoozing] = useState(false);
  const time = reminder.time ?? reminder.next_time ?? 0;
  const done = Boolean(reminder.complete_ts);
  const overdue = !done && !reminder.recurring && time * 1000 < Date.now();
  const rule = reminder.recurrence
    ? describeRecurrence({
        frequency: reminder.recurrence.frequency,
        weekdays: reminder.recurrence.weekdays as never,
        hour: new Date(time * 1000).getHours(),
        minute: new Date(time * 1000).getMinutes(),
      })
    : null;
  const act = async (method: string): Promise<void> => {
    const ok = await attempt(() => call(method, { reminder: reminder.id }));
    if (ok) onChange();
  };
  return (
    <div className={`result reminder-item ${done ? 'is-done' : ''} ${overdue ? 'is-overdue' : ''}`}>
      <div className="reminder-main">
        <AlarmClock size={18} className="reminder-glyph" />
        <div className="reminder-text">
          <Mrkdwn text={reminder.text} />
          <div className="reminder-when">
            {done ? S.att.later.completedOn(relative(String(reminder.complete_ts))) : rule ?? S.att.later.due(whenText(time))}
            {overdue ? <span className="tag tag-overdue">{S.att.later.overdue}</span> : null}
            {other ? <span className="reminder-other">{reminder.user !== selfId ? S.att.later.forOther(other) : S.att.later.from(other)}</span> : null}
          </div>
        </div>
        <span className="row-actions">
          {reminder.channel && reminder.message_ts ? (
            <IconButton label={S.messages.viewThread} onClick={() => go({ name: 'conversation', id: reminder.channel!, ts: reminder.message_ts })}>
              <MessageSquareText size={16} />
            </IconButton>
          ) : null}
          {!done && !reminder.recurring ? (
            <IconButton label={S.att.later.complete} onClick={() => void act('reminders.complete')}>
              <Check size={16} />
            </IconButton>
          ) : null}
          {!reminder.recurring ? (
            <IconButton ref={snoozeButton} label={S.att.later.remindMe} onClick={() => setSnoozing(true)}>
              <Clock size={16} />
            </IconButton>
          ) : null}
          <IconButton label={S.att.later.remove} onClick={() => void act('reminders.delete')}>
            <Trash2 size={16} />
          </IconButton>
        </span>
      </div>
      {snoozing ? (
        <RemindMenu
          anchor={snoozeButton.current}
          onClose={() => setSnoozing(false)}
          onPick={(value) => void attempt(() => call('client.reminders.reschedule', { reminder: reminder.id, time: value })).then((ok) => ok && onChange())}
        />
      ) : null}
    </div>
  );
}

export function LaterView() {
  const [tab, setTab] = useState<LaterTab>('in_progress');
  const [saved, setSaved] = useState<SavedItem[] | null>(null);
  const [reminders, setReminders] = useState<Reminder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const counts = useStore((state) => {
    const values = Object.values(state.att.saved);
    return values.filter((value) => value === 'in_progress').length;
  });

  const loadSaved = (state: LaterTab): void => {
    if (state === 'reminders') return;
    call('client.saved.list', { state })
      .then((result) => {
        setSaved(result.items as SavedItem[]);
        setError(null);
      })
      .catch((failure: unknown) => setError(errorText(failure)));
  };
  const loadReminders = (): void => {
    call('reminders.list')
      .then((result) => {
        const list = (result.reminders as Reminder[]).slice().sort((a, b) => {
          const doneA = a.complete_ts ? 1 : 0;
          const doneB = b.complete_ts ? 1 : 0;
          return doneA - doneB || (a.time ?? a.next_time ?? 0) - (b.time ?? b.next_time ?? 0);
        });
        setReminders(list);
      })
      .catch((failure: unknown) => setError(errorText(failure)));
  };

  useEffect(() => {
    setSaved(null);
    if (tab === 'reminders') loadReminders();
    else loadSaved(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  useRefreshOn('saved', () => loadSaved(tab));
  useRefreshOn('reminders', () => loadReminders());

  return (
    <ViewFrame
      title={S.att.later.title}
      className="later-view"
      tabs={
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            { id: 'in_progress', label: S.att.later.inProgress, count: counts },
            { id: 'archived', label: S.att.later.archived },
            { id: 'completed', label: S.att.later.completed },
            { id: 'reminders', label: S.att.later.reminders },
          ]}
        />
      }
    >
      {error ? <EmptyNote>{error}</EmptyNote> : null}
      {tab === 'reminders' ? (
        reminders === null ? (
          <div className="list-loading">
            <Spinner />
          </div>
        ) : reminders.length === 0 ? (
          <EmptyNote>{S.att.later.emptyReminders}</EmptyNote>
        ) : (
          reminders.map((reminder) => <ReminderRow key={reminder.id} reminder={reminder} onChange={loadReminders} />)
        )
      ) : saved === null ? (
        <div className="list-loading">
          <Spinner />
        </div>
      ) : saved.length === 0 ? (
        <EmptyNote>{tab === 'in_progress' ? S.att.later.empty : S.att.later.emptyOther}</EmptyNote>
      ) : (
        saved.map((item) => <SavedRow key={`${item.channel}:${item.ts}`} item={item} />)
      )}
    </ViewFrame>
  );
}

// ── Drafts & sent ───────────────────────────────────────────────────────────

type DraftsTab = 'drafts' | 'scheduled' | 'sent';

interface Scheduled {
  id: string;
  channel_id: string;
  post_at: number;
  text: string;
  thread_ts?: string;
}

function DraftRow({ draftKey, text, updated }: { draftKey: string; text: string; updated: number }) {
  const [channel, thread] = draftKey.split(':') as [string, string | undefined];
  const open = (): void => {
    go({ name: 'conversation', id: channel });
    if (thread) openThread(channel, thread);
  };
  return (
    <div className="result draft-item" role="button" tabIndex={0} onClick={open} onKeyDown={(event) => event.key === 'Enter' && open()}>
      <div className="result-place">
        <PlaceLabel channel={channel} />
        {thread ? <span className="tag">{S.att.drafts.inThread}</span> : null}
        <time>{relative(String(updated))}</time>
        <span className="composer-spacer" />
        <IconButton
          label={S.att.drafts.discard}
          onClick={(event) => {
            event.stopPropagation();
            localStorage.removeItem(`draft:${channel}${thread ? `:${thread}` : ''}`);
            saveDraft(channel, thread, '');
          }}
        >
          <Trash2 size={16} />
        </IconButton>
      </div>
      <div className="draft-text">{text}</div>
    </div>
  );
}

function SentRow({ channel, message }: { channel: string; message: Message }) {
  return (
    <div className="result" role="button" tabIndex={0} onClick={() => openMessage(channel, message)} onKeyDown={(event) => event.key === 'Enter' && openMessage(channel, message)}>
      <div className="result-place">
        <PlaceLabel channel={channel} />
      </div>
      <MessagePreview channel={channel} message={message} />
    </div>
  );
}

export function DraftsView() {
  const [tab, setTab] = useState<DraftsTab>('drafts');
  const drafts = useStore((state) => state.att.drafts);
  const scheduledCount = useStore((state) => state.att.scheduledCount);
  const [scheduled, setScheduled] = useState<Scheduled[] | null>(null);
  const [sent, setSent] = useState<{ channel: string; message: Message }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadScheduled = (): void => {
    call('chat.scheduledMessages.list')
      .then((result) => setScheduled(result.scheduled_messages as Scheduled[]))
      .catch((failure: unknown) => setError(errorText(failure)));
  };
  useEffect(() => {
    if (tab === 'scheduled') loadScheduled();
    if (tab === 'sent') {
      call('client.messages.sent', { limit: 50 })
        .then((result) => setSent(result.messages))
        .catch((failure: unknown) => setError(errorText(failure)));
    }
  }, [tab]);
  useRefreshOn('scheduled', () => loadScheduled());

  const draftList = Object.entries(drafts).sort((a, b) => b[1].updated - a[1].updated);
  return (
    <ViewFrame
      title={S.att.drafts.title}
      className="drafts-view"
      tabs={
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            { id: 'drafts', label: S.att.drafts.drafts, count: draftList.length },
            { id: 'scheduled', label: S.att.drafts.scheduled, count: scheduledCount },
            { id: 'sent', label: S.att.drafts.sent },
          ]}
        />
      }
    >
      {error ? <EmptyNote>{error}</EmptyNote> : null}
      {tab === 'drafts' ? (
        draftList.length === 0 ? (
          <EmptyNote>{S.att.drafts.emptyDrafts}</EmptyNote>
        ) : (
          draftList.map(([key, draft]) => <DraftRow key={key} draftKey={key} text={draft.text} updated={draft.updated} />)
        )
      ) : null}
      {tab === 'scheduled' ? (
        scheduled === null ? (
          <div className="list-loading">
            <Spinner />
          </div>
        ) : scheduled.length === 0 ? (
          <EmptyNote>{S.att.drafts.emptyScheduled}</EmptyNote>
        ) : (
          scheduled.map((item) => (
            <div key={item.id} className="result scheduled-item">
              <div className="result-place">
                <PlaceLabel channel={item.channel_id} />
                {item.thread_ts ? <span className="tag">{S.att.drafts.inThread}</span> : null}
                <time>{S.att.drafts.sendsAt(whenText(item.post_at))}</time>
                <span className="composer-spacer" />
                <IconButton
                  label={S.att.drafts.cancelSchedule}
                  onClick={() =>
                    void attempt(() => call('chat.deleteScheduledMessage', { channel: item.channel_id, scheduled_message_id: item.id })).then((ok) => ok && loadScheduled())
                  }
                >
                  <Trash2 size={16} />
                </IconButton>
              </div>
              <div className="draft-text">
                <Mrkdwn text={item.text} />
              </div>
            </div>
          ))
        )
      ) : null}
      {tab === 'sent' ? (
        sent === null ? (
          <div className="list-loading">
            <Spinner />
          </div>
        ) : sent.length === 0 ? (
          <EmptyNote>{S.att.drafts.emptySent}</EmptyNote>
        ) : (
          sent.map((item) => <SentRow key={`${item.channel}:${item.message.ts}`} channel={item.channel} message={item.message} />)
        )
      ) : null}
    </ViewFrame>
  );
}

// ── Files ───────────────────────────────────────────────────────────────────

type FileType = 'all' | 'images' | 'pdfs' | 'videos';

function FileRow({ file }: { file: FileObject }) {
  const owner = useStore((state) => state.users[file.user]);
  const place = file.channels[0] ?? file.groups[0] ?? file.ims[0];
  return (
    <div className="result file-row" data-file={file.id}>
      <div className="result-place">
        <Avatar user={owner} size={20} />
        <span>{S.att.files.sharedBy(displayName(owner), relative(String(file.created)))}</span>
        {place ? <PlaceLabel channel={place} /> : null}
        <span className="composer-spacer" />
        <IconButton label={S.att.files.share} onClick={() => openModal({ kind: 'shareFile', file })}>
          <Forward size={16} />
        </IconButton>
      </div>
      <Files files={[file]} />
    </div>
  );
}

/** Files in the workspace, or in one conversation when `channel` is given. */
export function FileList({ channel }: { channel?: string }) {
  const selfId = useStore((state) => state.self?.id);
  const [type, setType] = useState<FileType>('all');
  const [mine, setMine] = useState(false);
  const [files, setFiles] = useState<FileObject[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setFiles(null);
    call('files.list', { channel, types: type, user: mine ? selfId : undefined, count: 100 })
      .then((result) => live && setFiles(result.files as FileObject[]))
      .catch((failure: unknown) => live && setError(errorText(failure)));
    return () => {
      live = false;
    };
  }, [channel, type, mine, selfId]);

  return (
    <div className="file-list">
      <div className="file-filters">
        <div className="segmented" role="radiogroup">
          {(
            [
              ['all', S.att.files.all],
              ['images', S.att.files.images],
              ['pdfs', S.att.files.pdfs],
              ['videos', S.att.files.videos],
            ] as [FileType, string][]
          ).map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={type === id} className={type === id ? 'is-active' : ''} onClick={() => setType(id)}>
              {label}
            </button>
          ))}
        </div>
        <label className="toggle-label">
          <input type="checkbox" checked={mine} onChange={(event) => setMine(event.target.checked)} />
          {S.att.files.mine}
        </label>
      </div>
      {error ? <EmptyNote>{error}</EmptyNote> : null}
      {files === null ? (
        <div className="list-loading">
          <Spinner />
        </div>
      ) : files.length === 0 ? (
        <EmptyNote>{S.att.files.empty}</EmptyNote>
      ) : (
        files.map((file) => <FileRow key={file.id} file={file} />)
      )}
    </div>
  );
}

export function FilesView() {
  return (
    <ViewFrame title={S.att.files.title} className="files-view">
      <FileList />
    </ViewFrame>
  );
}
