import { Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { attempt, errorText } from '../../lib/actions';
import { closeAccountsModal, useAccounts, type UserGroup } from '../../lib/accounts';
import { call } from '../../lib/api';
import { displayName, useStore } from '../../lib/store';
import { S } from '../../strings';
import { Avatar, Button, Field, Modal } from '../ui';

/** A filterable list of checkboxes, used to pick people and channels. */
export function CheckList<T extends { id: string }>({
  items,
  selected,
  onChange,
  label,
  render,
  match,
}: {
  items: T[];
  selected: string[];
  onChange: (ids: string[]) => void;
  label: string;
  render: (item: T) => React.ReactNode;
  match: (item: T, query: string) => boolean;
}) {
  const [query, setQuery] = useState('');
  const shown = items.filter((item) => !query || match(item, query.toLowerCase()));
  return (
    <div className="check-list">
      <input className="check-filter" placeholder={label} value={query} onChange={(event) => setQuery(event.target.value)} aria-label={label} />
      <ul>
        {shown.map((item) => (
          <li key={item.id}>
            <label>
              <input
                type="checkbox"
                checked={selected.includes(item.id)}
                onChange={(event) => onChange(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))}
              />
              {render(item)}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GroupForm({ group, onDone }: { group: UserGroup | null; onDone: () => void }) {
  const users = useStore((state) => state.users);
  const channels = useStore((state) => state.channels);
  const others = useStore((state) => state.others);
  const [name, setName] = useState(group?.name ?? '');
  const [handle, setHandle] = useState(group?.handle ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [members, setMembers] = useState<string[]>(group?.users ?? []);
  const [defaults, setDefaults] = useState<string[]>(group?.prefs.channels ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const people = useMemo(
    () => Object.values(users).filter((user) => !user.deleted && !user.is_bot).sort((a, b) => displayName(a).localeCompare(displayName(b))),
    [users],
  );
  const channelList = useMemo(
    () => [...Object.values(channels), ...Object.values(others)].filter((conv) => conv.is_channel && !conv.is_archived).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
    [channels, others],
  );

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const fields = { name: name.trim(), handle: handle.trim(), description: description.trim(), channels: defaults.join(',') };
      const result = group ? await call('usergroups.update', { usergroup: group.id, ...fields }) : await call('usergroups.create', fields);
      await call('usergroups.users.update', { usergroup: result.usergroup.id, users: members.join(',') });
      onDone();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="group-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="form-row">
        <Field label={S.accounts.groupName}>
          <input value={name} required maxLength={80} autoFocus onChange={(event) => {
            setName(event.target.value);
            if (!group && (handle === '' || handle === slug(name))) setHandle(slug(event.target.value));
          }} />
        </Field>
        <Field label={S.accounts.groupHandle} hint={S.accounts.groupHandleHint}>
          <input value={handle} required maxLength={21} onChange={(event) => setHandle(event.target.value.toLowerCase().replace(/\s+/g, '-'))} />
        </Field>
      </div>
      <Field label={`${S.accounts.groupDescription} (${S.optional})`}>
        <input value={description} maxLength={250} onChange={(event) => setDescription(event.target.value)} />
      </Field>
      <div className="form-row">
        <div className="field">
          <span className="field-label">{S.accounts.groupMembers}</span>
          <CheckList
            items={people}
            selected={members}
            onChange={setMembers}
            label={S.accounts.groupMembers}
            match={(user, query) => displayName(user).toLowerCase().includes(query) || user.name.includes(query)}
            render={(user) => (
              <>
                <Avatar user={user} size={20} /> {displayName(user)}
              </>
            )}
          />
        </div>
        <div className="field">
          <span className="field-label">{S.accounts.groupChannels}</span>
          <CheckList items={channelList} selected={defaults} onChange={setDefaults} label={S.accounts.groupChannels} match={(conv, query) => (conv.name ?? '').includes(query)} render={(conv) => <>#{conv.name}</>} />
        </div>
      </div>
      {error ? <p className="auth-error" role="alert">{error}</p> : null}
      <div className="form-actions">
        <Button onClick={onDone}>{S.cancel}</Button>
        <Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || !handle.trim()}>
          {group ? S.accounts.groupSave : S.accounts.groupCreate}
        </Button>
      </div>
    </form>
  );
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 21);
}

export function GroupsDialog() {
  const groups = useAccounts((state) => state.usergroups);
  const canManage = useAccounts((state) => state.permissions.manage_usergroups);
  const users = useStore((state) => state.users);
  const [editing, setEditing] = useState<UserGroup | 'new' | null>(null);
  const list = Object.values(groups).sort((a, b) => a.handle.localeCompare(b.handle));
  return (
    <Modal title={S.accounts.groups} onClose={closeAccountsModal} width={680} className="groups-modal">
      {editing ? (
        <GroupForm group={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />
      ) : (
        <>
          <p className="dialog-lead">{S.accounts.groupsBody}</p>
          {!canManage ? <p className="muted">{S.accounts.groupsReadOnly}</p> : null}
          {list.length === 0 ? (
            <p className="muted">{S.accounts.groupsNone}</p>
          ) : (
            <ul className="admin-list group-list">
              {list.map((group) => (
                <li key={group.id}>
                  <span className="group-icon">
                    <Users size={18} />
                  </span>
                  <span className="admin-meta">
                    <span className="admin-name">
                      @{group.handle} <span className="muted">{group.name}</span>
                    </span>
                    <span className="muted">
                      {S.accounts.groupCount(group.users.length)}
                      {group.users.length ? ` · ${group.users.slice(0, 4).map((id) => displayName(users[id])).join(', ')}${group.users.length > 4 ? '…' : ''}` : ''}
                    </span>
                  </span>
                  {canManage ? (
                    <>
                      <Button size="sm" onClick={() => setEditing(group)}>
                        {S.details.edit}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void attempt(() => call('usergroups.disable', { usergroup: group.id }))}>
                        {S.accounts.groupDisable}
                      </Button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {canManage ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              {S.accounts.groupNew}
            </Button>
          ) : null}
        </>
      )}
    </Modal>
  );
}
