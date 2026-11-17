import { normalizeChannelName, type Conversation, type User } from '@app/shared';
import { Check, Hash, Lock, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { attempt, closeModal, createChannel, errorText, go, joinChannel, openDirect, toast } from '../../lib/actions';
import { call, type Json } from '../../lib/api';
import { GuestInviteOptions, type GuestChoice } from '../accounts/Profile';
import { conversation, displayName, useStore } from '../../lib/store';
import { S } from '../../strings';
import { Avatar, Button, CopyField, Field, Modal, Spinner } from '../ui';
import { formatDate } from '../../lib/time';

// ── Create channel ──────────────────────────────────────────────────────────

export function CreateChannelDialog() {
  const [name, setName] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await createChannel(name, isPrivate);
      closeModal();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={S.dialogs.createChannelTitle}
      onClose={closeModal}
      width={480}
      footer={
        <>
          <Button onClick={closeModal}>{S.cancel}</Button>
          <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={() => void submit()}>
            {S.dialogs.create}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) void submit();
        }}
      >
        <Field label={S.dialogs.channelName} hint={S.dialogs.channelNameHint} error={error}>
          <div className="input-prefix">
            {isPrivate ? <Lock size={16} /> : <Hash size={16} />}
            <input
              value={name}
              maxLength={80}
              placeholder={S.dialogs.channelNamePlaceholder}
              onChange={(event) => setName(normalizeChannelName(event.target.value.replace(/\s/g, '-')))}
              data-autofocus
            />
          </div>
        </Field>
        <label className="check-row">
          <input type="checkbox" checked={isPrivate} onChange={(event) => setPrivate(event.target.checked)} />
          <span>
            <strong>{S.dialogs.makePrivate}</strong>
            <span className="field-hint">{S.dialogs.makePrivateHint}</span>
          </span>
        </label>
      </form>
    </Modal>
  );
}

// ── Browse channels ─────────────────────────────────────────────────────────

export function BrowseChannelsDialog() {
  const [query, setQuery] = useState('');
  const [channels, setChannels] = useState<Conversation[] | null>(null);
  const joined = useStore((state) => state.channels);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      call('client.channels.browse', { query })
        .then((result) => {
          if (live) setChannels(result.channels as Conversation[]);
        })
        .catch(() => {
          if (live) setChannels([]);
        });
    }, 120);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const open = (id: string): void => {
    closeModal();
    go({ name: 'conversation', id });
  };

  return (
    <Modal title={S.dialogs.browseTitle} onClose={closeModal} width={620}>
      <input type="search" className="wide-search" value={query} placeholder={S.dialogs.browseSearch} onChange={(event) => setQuery(event.target.value)} aria-label={S.dialogs.browseSearch} data-autofocus />
      <div className="browse-list">
        {channels === null ? (
          <div className="list-loading">
            <Spinner />
          </div>
        ) : channels.length === 0 ? (
          <p className="panel-empty">{S.dialogs.browseNone}</p>
        ) : (
          channels.map((channel) => {
            const member = joined[channel.id] !== undefined;
            return (
              <div key={channel.id} className="browse-row">
                <button type="button" className="browse-main" onClick={() => open(channel.id)}>
                  <span className="browse-name">
                    {channel.is_private ? <Lock size={15} /> : <Hash size={15} />}
                    {channel.name}
                    {channel.is_archived ? <span className="tag">{S.header.archived}</span> : null}
                  </span>
                  <span className="browse-sub">
                    {member ? (
                      <span className="browse-joined">
                        <Check size={13} /> {S.dialogs.joined}
                      </span>
                    ) : null}
                    <span>{S.header.members(channel.num_members ?? 0)}</span>
                    {channel.purpose?.value ? <span className="browse-purpose">{channel.purpose.value}</span> : null}
                  </span>
                </button>
                {member ? (
                  <Button size="sm" onClick={() => open(channel.id)}>
                    {S.dialogs.open}
                  </Button>
                ) : !channel.is_archived ? (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      void joinChannel(channel.id).then(() => open(channel.id));
                    }}
                  >
                    {S.dialogs.join}
                  </Button>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}

// ── People pickers ──────────────────────────────────────────────────────────

function PeoplePicker({
  exclude,
  max,
  selected,
  onChange,
  placeholder,
}: {
  exclude: Set<string>;
  max: number;
  selected: string[];
  onChange: (ids: string[]) => void;
  placeholder: string;
}) {
  const users = useStore((state) => state.users);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const candidates = Object.values(users)
    .filter((user) => !user.deleted && !exclude.has(user.id))
    .filter((user) => !needle || `${displayName(user)} ${user.real_name} ${user.name}`.toLowerCase().includes(needle))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const toggle = (user: User): void => {
    if (selected.includes(user.id)) onChange(selected.filter((id) => id !== user.id));
    else if (selected.length < max) onChange([...selected, user.id]);
    setQuery('');
  };
  return (
    <div className="people-picker">
      <div className="chip-input">
        {selected.map((id) => (
          <span key={id} className="chip">
            <Avatar user={users[id]} size={18} />
            {displayName(users[id])}
            <button type="button" aria-label={S.remove} onClick={() => onChange(selected.filter((item) => item !== id))}>
              <X size={13} />
            </button>
          </span>
        ))}
        <input value={query} placeholder={selected.length === 0 ? placeholder : ''} onChange={(event) => setQuery(event.target.value)} aria-label={placeholder} data-autofocus />
      </div>
      <ul className="people-list">
        {candidates.map((user) => {
          const on = selected.includes(user.id);
          return (
            <li key={user.id}>
              <button type="button" className={`member-row ${on ? 'is-on' : ''}`} onClick={() => toggle(user)} aria-pressed={on}>
                <Avatar user={user} size={30} presence />
                <span className="member-meta">
                  <span className="member-name">
                    {displayName(user)}
                    {user.is_bot ? <span className="tag">{S.sidebar.app}</span> : null}
                  </span>
                  {user.profile.title ? <span className="member-title">{user.profile.title}</span> : null}
                </span>
                {on ? <Check size={16} /> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function NewDmDialog() {
  const selfId = useStore((state) => state.self?.id ?? '');
  const [selected, setSelected] = useState<string[]>([]);
  const start = (): void => {
    closeModal();
    void openDirect(selected.length > 0 ? selected : [selfId]);
  };
  return (
    <Modal
      title={S.dialogs.newDmTitle}
      onClose={closeModal}
      width={520}
      footer={
        <>
          <span className="foot-hint">{S.dialogs.newDmHint}</span>
          <Button onClick={closeModal}>{S.cancel}</Button>
          <Button variant="primary" disabled={selected.length === 0} onClick={start}>
            {S.dialogs.newDmGo}
          </Button>
        </>
      }
    >
      <PeoplePicker exclude={new Set()} max={8} selected={selected} onChange={setSelected} placeholder={S.dialogs.newDmSearch} />
    </Modal>
  );
}

export function AddPeopleDialog({ channel }: { channel: string }) {
  const conv = useStore((state) => conversation(state, channel));
  const [members, setMembers] = useState<Set<string> | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call('conversations.members', { channel, limit: 1000 })
      .then((result) => setMembers(new Set(result.members as string[])))
      .catch(() => setMembers(new Set()));
  }, [channel]);

  const add = async (): Promise<void> => {
    setBusy(true);
    const result = await attempt(() => call('conversations.invite', { channel, users: selected.join(',') }));
    setBusy(false);
    if (result) closeModal();
  };

  return (
    <Modal
      title={S.dialogs.addPeopleTitle(conv?.name ?? '')}
      onClose={closeModal}
      width={520}
      footer={
        <>
          <Button onClick={closeModal}>{S.cancel}</Button>
          <Button variant="primary" busy={busy} disabled={selected.length === 0} onClick={() => void add()}>
            {S.dialogs.addPeopleGo}
          </Button>
        </>
      }
    >
      {members ? (
        <PeoplePicker exclude={members} max={50} selected={selected} onChange={setSelected} placeholder={S.dialogs.newDmSearch} />
      ) : (
        <div className="list-loading">
          <Spinner />
        </div>
      )}
    </Modal>
  );
}

// ── Invitations ─────────────────────────────────────────────────────────────

interface Invite {
  code: string;
  url: string;
  email: string | null;
  expires: number;
  max_uses: number;
  uses: number;
}

/** Invite links are built from the address this page was loaded from, so they work for whoever is sent them. */
function inviteUrl(invite: Invite): string {
  return `${window.location.origin}/join/${encodeURIComponent(invite.code)}`;
}

export function InviteDialog() {
  const team = useStore((state) => state.team);
  const [email, setEmail] = useState('');
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [fresh, setFresh] = useState<Invite | null>(null);
  const [busy, setBusy] = useState(false);
  const [guest, setGuest] = useState<GuestChoice>({ type: '', channels: [], days: 0 });
  const isAdmin = useStore((state) => Boolean(state.self?.is_admin));

  const refresh = (): void => {
    call('client.invites.list')
      .then((result) => setInvites(result.invites as Invite[]))
      .catch(() => setInvites([]));
  };
  useEffect(refresh, []);

  const create = async (): Promise<void> => {
    setBusy(true);
    const args: Record<string, unknown> = email.trim() ? { email: email.trim() } : {};
    if (guest.type) Object.assign(args, { guest: guest.type, channels: guest.channels, guest_expires_in_days: guest.days || 0 });
    const result: Json = await attempt(() => call('client.invites.create', args));
    setBusy(false);
    if (!result) return;
    setFresh(result.invite as Invite);
    if (result.email_sent) toast(S.accounts.inviteSent(String(result.invite.email)));
    setEmail('');
    refresh();
  };

  return (
    <Modal title={S.dialogs.inviteTitle(team?.name ?? '')} onClose={closeModal} width={540}>
      <p className="dialog-lead">{S.dialogs.inviteBody}</p>
      <form
        className="invite-form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <Field label={guest.type ? S.dialogs.inviteEmail : `${S.dialogs.inviteEmail} (${S.optional})`}>
          <input type="email" value={email} required={Boolean(guest.type)} placeholder={S.dialogs.inviteEmailPlaceholder} onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Button variant="primary" busy={busy} onClick={() => void create()}>
          {S.dialogs.inviteCreate}
        </Button>
      </form>
      {isAdmin ? <GuestInviteOptions value={guest} onChange={setGuest} /> : null}
      {fresh ? <CopyField value={inviteUrl(fresh)} /> : null}
      <h3 className="dialog-sub">{S.dialogs.inviteActive}</h3>
      {invites === null ? (
        <Spinner />
      ) : invites.length === 0 ? (
        <p className="muted">{S.dialogs.inviteNone}</p>
      ) : (
        <ul className="invite-list">
          {invites.map((invite) => (
            <li key={invite.code}>
              <span className="invite-meta">
                <span className="invite-who">{invite.email ?? S.dialogs.inviteAnyone}</span>
                <span className="muted">
                  {S.dialogs.inviteUses(invite.uses, invite.max_uses)} · {S.dialogs.inviteExpires(formatDate(invite.expires))}
                </span>
              </span>
              <Button size="sm" onClick={() => void navigator.clipboard.writeText(inviteUrl(invite))}>
                {S.copy}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void attempt(() => call('client.invites.revoke', { code: invite.code })).then(refresh);
                }}
              >
                {S.dialogs.inviteRevoke}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
