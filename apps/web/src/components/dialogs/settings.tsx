import { Smile } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { attempt, closeModal, setPrefs } from '../../lib/actions';
import { call, uploadFile } from '../../lib/api';
import { enableNotifications, notificationPermission } from '../../lib/notify';
import { useStore } from '../../lib/store';
import { themeChoice, type ThemeChoice } from '../../lib/theme';
import { S } from '../../strings';
import { PickerPopover } from '../Message';
import { Emoji } from '../text';
import { Avatar, Button, Field, IconButton, Modal } from '../ui';

export function PreferencesDialog() {
  const theme = useStore((state) => themeChoice(state.prefs.theme));
  const [permission, setPermission] = useState(notificationPermission());
  const options: { id: ThemeChoice; label: string }[] = [
    { id: 'system', label: S.prefs.themeSystem },
    { id: 'light', label: S.prefs.themeLight },
    { id: 'dark', label: S.prefs.themeDark },
  ];
  return (
    <Modal title={S.prefs.title} onClose={closeModal} width={480}>
      <fieldset className="pref-group">
        <legend>{S.prefs.theme}</legend>
        <div className="segmented" role="radiogroup">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={theme === option.id}
              className={theme === option.id ? 'is-active' : ''}
              onClick={() => void setPrefs({ theme: option.id })}
            >
              {option.label}
            </button>
          ))}
        </div>
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
      </fieldset>
    </Modal>
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
