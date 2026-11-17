import { AssistantMemoryPref } from '../ai/Assistant';
import { Smile } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { attempt, closeModal, openModal, setPrefs } from '../../lib/actions';
import { call, uploadFile } from '../../lib/api';
import { enableNotifications, notificationPermission } from '../../lib/notify';
import { useStore } from '../../lib/store';
import { fieldValues, ProfileFieldInputs } from '../accounts/Profile';
import { contrast, isHexColor, SIDEBAR_PRESETS, sidebarInk, themeChoice, type ThemeChoice } from '../../lib/theme';
import { INTL_LOCALE, languagePref, timeFormatPref } from '../../lib/locale';
import { markupComposer } from '../../lib/richInput';
import { useAccounts } from '../../lib/accounts';
import { S } from '../../strings';
import { PickerPopover } from '../Message';
import { Emoji } from '../text';
import { Avatar, Button, Field, IconButton, Modal } from '../ui';

/** A row of mutually exclusive choices that save straight away. */
function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" role="radio" aria-checked={value === option.id} className={value === option.id ? 'is-active' : ''} onClick={() => onChange(option.id)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="check-row">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function SidebarPref() {
  const prefs = useStore((state) => state.prefs);
  const theme = typeof prefs.sidebar_theme === 'string' && (prefs.sidebar_theme in SIDEBAR_PRESETS || prefs.sidebar_theme === 'custom') ? prefs.sidebar_theme : 'harbor';
  const custom = isHexColor(prefs.sidebar_color) ? prefs.sidebar_color : '#2c4a6b';
  const [draft, setDraft] = useState(custom);
  const swatch = (id: string): string => (id === 'custom' ? draft : (SIDEBAR_PRESETS[id] ?? '#0f2a33'));
  const ratio = contrast(sidebarInk(draft), draft).toFixed(1);
  return (
    <fieldset className="pref-group">
      <legend>{S.prefs.sidebar}</legend>
      <div className="sidebar-swatches" role="radiogroup" aria-label={S.prefs.sidebar}>
        {[...Object.keys(SIDEBAR_PRESETS), 'custom'].map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={theme === id}
            className={`sidebar-swatch ${theme === id ? 'is-active' : ''}`}
            onClick={() => void setPrefs(id === 'custom' ? { sidebar_theme: 'custom', sidebar_color: draft } : { sidebar_theme: id })}
          >
            <span className="sidebar-swatch-chip" style={{ background: swatch(id), color: sidebarInk(swatch(id)) }} aria-hidden="true">
              Aa
            </span>
            <span className="sidebar-swatch-name">{S.prefs.sidebarThemes[id] ?? id}</span>
          </button>
        ))}
      </div>
      {theme === 'custom' ? (
        <div className="sidebar-custom">
          <label className="sidebar-color-field">
            <span>{S.prefs.sidebarColor}</span>
            <input
              type="color"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => void setPrefs({ sidebar_theme: 'custom', sidebar_color: draft })}
            />
            <input
              className="sidebar-hex"
              value={draft}
              maxLength={7}
              aria-label={S.prefs.sidebarColor}
              onChange={(event) => {
                const value = event.target.value.trim();
                setDraft(value.startsWith('#') ? value : `#${value}`);
              }}
              onBlur={() => {
                if (isHexColor(draft)) void setPrefs({ sidebar_theme: 'custom', sidebar_color: draft });
              }}
            />
          </label>
          <p className="field-hint">{S.prefs.sidebarContrast(ratio)}</p>
        </div>
      ) : null}
    </fieldset>
  );
}

function NotificationPrefs() {
  const prefs = useStore((state) => state.prefs);
  const mail = useAccounts((state) => state.mailEnabled);
  const level = prefs.notify_level === 'all' || prefs.notify_level === 'nothing' ? prefs.notify_level : 'mentions';
  const email = prefs.email_notifications === '1h' || prefs.email_notifications === 'off' ? prefs.email_notifications : '15m';
  return (
    <>
      <fieldset className="pref-group">
        <legend>{S.prefs.notifyAbout}</legend>
        <div className="pref-stack" role="radiogroup" aria-label={S.prefs.notifyAbout}>
          {(
            [
              ['all', S.prefs.notifyAll],
              ['mentions', S.prefs.notifyMentions],
              ['nothing', S.prefs.notifyNothing],
            ] as const
          ).map(([id, label]) => (
            <label key={id} className="check-row">
              <input type="radio" name="notify-level" checked={level === id} onChange={() => void setPrefs({ notify_level: id })} />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <p className="field-hint">{S.prefs.notifyAboutHint}</p>
        <Toggle label={S.prefs.notifyThreads} checked={prefs.notify_thread_replies !== false} onChange={(checked) => void setPrefs({ notify_thread_replies: checked })} />
        <Toggle label={S.prefs.notifyPreview} checked={prefs.notify_preview !== false} onChange={(checked) => void setPrefs({ notify_preview: checked })} />
        <Toggle label={S.prefs.notifySound} checked={prefs.notify_sound !== false} onChange={(checked) => void setPrefs({ notify_sound: checked })} />
      </fieldset>
      {mail ? (
        <fieldset className="pref-group">
          <legend>{S.prefs.email}</legend>
          <label className="pref-select">
            <span>{S.prefs.emailLabel}</span>
            <select value={email} onChange={(event) => void setPrefs({ email_notifications: event.target.value })}>
              <option value="15m">{S.prefs.email15m}</option>
              <option value="1h">{S.prefs.email1h}</option>
              <option value="off">{S.prefs.emailOff}</option>
            </select>
          </label>
        </fieldset>
      ) : null}
    </>
  );
}

export function PreferencesDialog() {
  const theme = useStore((state) => themeChoice(state.prefs.theme));
  const language = useStore((state) => languagePref(state.prefs.language));
  const clockPref = useStore((state) => timeFormatPref(state.prefs.time_format));
  const markup = useStore((state) => markupComposer(state.prefs));
  const [permission, setPermission] = useState(notificationPermission());
  const options: { id: ThemeChoice; label: string }[] = [
    { id: 'system', label: S.prefs.themeSystem },
    { id: 'light', label: S.prefs.themeLight },
    { id: 'dark', label: S.prefs.themeDark },
  ];
  return (
    <Modal title={S.prefs.title} onClose={closeModal} width={520} className="prefs-modal">
      <fieldset className="pref-group">
        <legend>{S.prefs.theme}</legend>
        <Choice label={S.prefs.theme} value={theme} options={options} onChange={(id) => void setPrefs({ theme: id })} />
      </fieldset>
      <SidebarPref />
      <fieldset className="pref-group">
        <legend>{S.prefs.language}</legend>
        <Choice
          label={S.prefs.language}
          value={language}
          options={[
            { id: 'auto', label: S.prefs.languageAuto },
            { id: 'en', label: 'English' },
            { id: 'ko', label: '한국어' },
          ]}
          onChange={(id) => void setPrefs({ language: id })}
        />
      </fieldset>
      <fieldset className="pref-group">
        <legend>{S.prefs.timeFormat}</legend>
        <Choice
          label={S.prefs.timeFormat}
          value={clockPref}
          options={[
            { id: 'auto', label: S.prefs.timeAuto },
            { id: '12h', label: `${S.prefs.time12} (${sampleTime(true)})` },
            { id: '24h', label: `${S.prefs.time24} (${sampleTime(false)})` },
          ]}
          onChange={(id) => void setPrefs({ time_format: id })}
        />
        <p className="field-hint">{S.prefs.reloadHint}</p>
      </fieldset>
      <fieldset className="pref-group">
        <legend>{S.prefs.composing}</legend>
        <Toggle label={S.prefs.markup} checked={markup} onChange={(checked) => void setPrefs({ compose_markup: checked })} />
        <p className="field-hint">{S.prefs.markupHint}</p>
      </fieldset>
      <fieldset className="pref-group">
        <legend>{S.prefs.notifications}</legend>
        <p className="muted">{S.prefs.notificationsBody}</p>
        {permission === 'granted' ? (
          <p>{S.prefs.notificationsOn}</p>
        ) : permission === 'denied' ? (
          <p>{S.prefs.notificationsBlocked}</p>
        ) : permission === 'unsupported' ? (
          <p>{S.prefs.notificationsUnsupported}</p>
        ) : (
          <Button
            variant="primary"
            onClick={() => {
              void enableNotifications().then(() => setPermission(notificationPermission()));
            }}
          >
            {S.prefs.notificationsEnable}
          </Button>
        )}
        <button type="button" className="link-btn pref-link" onClick={() => openModal({ kind: 'dndSchedule' })}>
          {S.att.dnd.schedule}
        </button>
      </fieldset>
      <NotificationPrefs />
      <KeywordsPref />
      <AssistantMemoryPref />
    </Modal>
  );
}

/** 9:41 in the interface language, forced to a 12- or 24-hour clock, to show what each choice looks like. */
function sampleTime(hour12: boolean): string {
  return new Intl.DateTimeFormat(INTL_LOCALE, { hour: 'numeric', minute: '2-digit', hour12 }).format(new Date(2026, 0, 1, 21, 41));
}

/** Words that notify like a mention (Slack's `highlight_words` preference). */
function KeywordsPref() {
  const saved = useStore((state) => (typeof state.prefs.highlight_words === 'string' ? state.prefs.highlight_words : ''));
  const [value, setValue] = useState(saved);
  const normalized = value
    .split(',')
    .map((word) => word.trim())
    .filter(Boolean)
    .join(', ');
  return (
    <fieldset className="pref-group">
      <legend>{S.att.keywords.title}</legend>
      <p className="muted">{S.att.keywords.body}</p>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void setPrefs({ highlight_words: normalized });
        }}
      >
        <input value={value} placeholder={S.att.keywords.placeholder} aria-label={S.att.keywords.title} onChange={(event) => setValue(event.target.value)} />
        <Button type="submit" variant="primary" disabled={normalized === saved}>
          {S.save}
        </Button>
      </form>
    </fieldset>
  );
}

function timeZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
}

export function EditProfileDialog() {
  const self = useStore((state) => state.self);
  const [realName, setRealName] = useState(self?.real_name ?? '');
  const [display, setDisplay] = useState(self?.profile.display_name ?? '');
  const [title, setTitle] = useState(self?.profile.title ?? '');
  const [statusText, setStatusText] = useState(self?.profile.status_text ?? '');
  const [statusEmoji, setStatusEmoji] = useState((self?.profile.status_emoji ?? '').replace(/:/g, ''));
  const [tz, setTz] = useState(self?.tz ?? 'UTC');
  const [fields, setFields] = useState<Record<string, string>>(() => fieldValues(self));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [picking, setPicking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const emojiButton = useRef<HTMLButtonElement>(null);
  const zones = useMemo(() => {
    const all = timeZones();
    return all.includes(tz) ? all : [tz, ...all];
  }, [tz]);
  if (!self) return null;

  const save = async (): Promise<void> => {
    setBusy(true);
    const result = await attempt(() =>
      call('users.profile.set', {
        profile: {
          real_name: realName.trim(),
          display_name: display.trim(),
          title: title.trim(),
          status_text: statusText.trim(),
          status_emoji: statusEmoji ? `:${statusEmoji}:` : '',
          status_expiration: 0,
          tz,
          fields: Object.fromEntries(Object.entries(fields).map(([id, value]) => [id, { value: value.trim() }])),
        },
      }),
    );
    setBusy(false);
    if (result) closeModal();
  };

  const upload = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setUploading(true);
    await attempt(async () => {
      const id = await uploadFile(file);
      await call('users.setPhoto', { file_id: id });
    });
    setUploading(false);
  };

  return (
    <Modal
      title={S.profile.edit}
      onClose={closeModal}
      width={560}
      footer={
        <>
          <Button onClick={closeModal}>{S.cancel}</Button>
          <Button variant="primary" busy={busy} disabled={!realName.trim()} onClick={() => void save()}>
            {S.save}
          </Button>
        </>
      }
    >
      <div className="profile-edit">
        <div className="profile-edit-photo">
          <Avatar user={self} size={112} />
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(event) => void upload(event.target.files?.[0])} />
          <Button size="sm" busy={uploading} onClick={() => fileInput.current?.click()}>
            {S.profile.uploadPhoto}
          </Button>
          <button type="button" className="link-btn" onClick={() => void attempt(() => call('users.deletePhoto'))}>
            {S.profile.removePhoto}
          </button>
          <span className="field-hint">{S.profile.photoHint}</span>
        </div>
        <div className="profile-edit-fields">
          <Field label={S.profile.fullName}>
            <input value={realName} maxLength={80} onChange={(event) => setRealName(event.target.value)} data-autofocus />
          </Field>
          <Field label={S.profile.displayName} hint={S.profile.displayNameHint}>
            <input value={display} maxLength={80} onChange={(event) => setDisplay(event.target.value)} />
          </Field>
          <Field label={S.profile.jobTitle}>
            <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field label={S.profile.status}>
            <div className="status-row">
              <IconButton ref={emojiButton} label={S.profile.statusEmoji} className="status-emoji-btn" onClick={() => setPicking(true)}>
                {statusEmoji ? <Emoji name={statusEmoji} /> : <Smile size={18} />}
              </IconButton>
              <input value={statusText} maxLength={100} placeholder={S.profile.statusPlaceholder} onChange={(event) => setStatusText(event.target.value)} />
              {statusText || statusEmoji ? (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setStatusText('');
                    setStatusEmoji('');
                  }}
                >
                  {S.profile.clearStatus}
                </button>
              ) : null}
            </div>
          </Field>
          <ProfileFieldInputs values={fields} onChange={setFields} />
          <Field label={S.profile.timeZone}>
            <select value={tz} onChange={(event) => setTz(event.target.value)}>
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      {picking ? <PickerPopover anchor={emojiButton.current} onClose={() => setPicking(false)} onPick={setStatusEmoji} /> : null}
    </Modal>
  );
}
