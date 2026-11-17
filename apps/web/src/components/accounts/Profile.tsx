import type { User } from '@app/shared';
import { useMemo } from 'react';
import { useAccounts, type ProfileField } from '../../lib/accounts';
import { displayName, useStore } from '../../lib/store';
import { S } from '../../strings';
import { Field } from '../ui';
import { CheckList } from './Groups';

/** Current custom field values of a person, as plain strings by field id. */
export function fieldValues(user: User | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, entry] of Object.entries(user?.profile.fields ?? {})) out[id] = entry.value;
  return out;
}

function FieldValue({ field, value }: { field: ProfileField; value: string }) {
  const users = useStore((state) => state.users);
  if (field.type === 'link' && /^https?:\/\//i.test(value)) {
    return (
      <a href={value} target="_blank" rel="noopener noreferrer nofollow">
        {value.replace(/^https?:\/\//i, '')}
      </a>
    );
  }
  if (field.type === 'user') return <>{displayName(users[value])}</>;
  if (field.type === 'date') return <>{new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' })}</>;
  return <>{value}</>;
}

/** Filled-in custom fields, in the profile panel. */
export function ProfileFieldFacts({ user }: { user: User }) {
  const fields = useAccounts((state) => state.profileFields);
  const values = user.profile.fields ?? {};
  const shown = fields.filter((field) => values[field.id]?.value);
  if (shown.length === 0) return null;
  return (
    <dl className="profile-facts profile-custom">
      {shown.map((field) => (
        <div key={field.id}>
          <dt>{field.label}</dt>
          <dd>
            <FieldValue field={field} value={values[field.id]!.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Inputs for the custom fields, in the edit-profile dialog. */
export function ProfileFieldInputs({ values, onChange }: { values: Record<string, string>; onChange: (next: Record<string, string>) => void }) {
  const fields = useAccounts((state) => state.profileFields);
  const users = useStore((state) => state.users);
  const people = useMemo(() => Object.values(users).filter((user) => !user.deleted && !user.is_bot), [users]);
  if (fields.length === 0) return null;
  const set = (id: string, value: string): void => onChange({ ...values, [id]: value });
  return (
    <>
      {fields.map((field) => {
        const value = values[field.id] ?? '';
        let input;
        if (field.type === 'options_list') {
          input = (
            <select value={value} onChange={(event) => set(field.id, event.target.value)}>
              <option value="" />
              {(field.possible_values ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          );
        } else if (field.type === 'user') {
          input = (
            <select value={value} onChange={(event) => set(field.id, event.target.value)}>
              <option value="" />
              {people.map((user) => (
                <option key={user.id} value={user.id}>
                  {displayName(user)}
                </option>
              ))}
            </select>
          );
        } else if (field.type === 'long_text') {
          input = <textarea value={value} maxLength={256} rows={2} onChange={(event) => set(field.id, event.target.value)} />;
        } else {
          input = (
            <input
              type={field.type === 'date' ? 'date' : field.type === 'link' ? 'url' : 'text'}
              value={value}
              maxLength={256}
              placeholder={field.type === 'link' ? 'https://' : undefined}
              onChange={(event) => set(field.id, event.target.value)}
            />
          );
        }
        return (
          <Field key={field.id} label={field.label} hint={field.hint || undefined}>
            {input}
          </Field>
        );
      })}
    </>
  );
}

// ── Inviting guests ─────────────────────────────────────────────────────────

export interface GuestChoice {
  type: '' | 'multi' | 'single';
  channels: string[];
  days: number;
}

export function GuestInviteOptions({ value, onChange }: { value: GuestChoice; onChange: (next: GuestChoice) => void }) {
  const channels = useStore((state) => state.channels);
  const list = useMemo(
    () => Object.values(channels).filter((conv) => conv.is_channel && !conv.is_archived).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
    [channels],
  );
  return (
    <div className="guest-options">
      <label className="check-row">
        <input type="checkbox" checked={value.type !== ''} onChange={(event) => onChange({ ...value, type: event.target.checked ? 'multi' : '', channels: [] })} />
        <span>
          {S.accounts.inviteAsGuest}
          <span className="field-hint">{S.accounts.guestHint}</span>
        </span>
      </label>
      {value.type ? (
        <>
          <div className="segmented" role="radiogroup" aria-label={S.accounts.guestType}>
            {(['multi', 'single'] as const).map((type) => (
              <button
                key={type}
                type="button"
                role="radio"
                aria-checked={value.type === type}
                className={value.type === type ? 'is-active' : ''}
                onClick={() => onChange({ ...value, type, channels: type === 'single' ? value.channels.slice(0, 1) : value.channels })}
              >
                {type === 'multi' ? S.accounts.guestMulti : S.accounts.guestSingle}
              </button>
            ))}
          </div>
          <div className="field">
            <span className="field-label">{S.accounts.guestChannels}</span>
            <CheckList
              items={list}
              selected={value.channels}
              onChange={(ids) => onChange({ ...value, channels: value.type === 'single' ? ids.slice(-1) : ids })}
              label={S.accounts.guestChannels}
              match={(conv, query) => (conv.name ?? '').includes(query)}
              render={(conv) => <>#{conv.name}</>}
            />
          </div>
          <Field label={S.accounts.guestExpires}>
            <input type="number" min={0} max={3650} value={value.days || ''} onChange={(event) => onChange({ ...value, days: Number(event.target.value) || 0 })} />
          </Field>
        </>
      ) : null}
    </div>
  );
}
