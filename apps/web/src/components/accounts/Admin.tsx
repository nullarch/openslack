import type { User } from '@app/shared';
import { Download, Lock, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { attempt, errorText, toast } from '../../lib/actions';
import { refreshPendingRequests, useAccounts } from '../../lib/accounts';
import { asset, call, uploadFile, type Json } from '../../lib/api';
import { displayName, useStore } from '../../lib/store';
import { S } from '../../strings';
import { Button, Field, IconButton, Spinner } from '../ui';
import { confirmDialog } from '../dialogs/confirm';
import { CheckList } from './Groups';

// ── Invite requests (top of the Members tab) ────────────────────────────────

interface InviteRequest {
  id: string;
  email: string;
  reason: string;
  requested_by: string;
}

export function InviteRequests() {
  const users = useStore((state) => state.users);
  const pending = useAccounts((state) => state.pendingRequests);
  const [requests, setRequests] = useState<InviteRequest[] | null>(null);
  const refresh = (): void => {
    call('client.inviteRequests.list')
      .then((result) => setRequests(result.requests as InviteRequest[]))
      .catch(() => setRequests([]));
  };
  useEffect(refresh, [pending]);
  if (!requests || requests.length === 0) return null;
  const decide = async (request: InviteRequest, approve: boolean): Promise<void> => {
    const result: Json = await attempt(() => call(approve ? 'client.inviteRequests.approve' : 'client.inviteRequests.deny', { id: request.id }));
    if (result && approve) toast(result.email_sent ? S.accounts.inviteSent(request.email) : S.saved);
    refresh();
    void refreshPendingRequests();
  };
  return (
    <section className="admin-section">
      <h3 className="dialog-sub">{S.accounts.requests}</h3>
      <ul className="admin-list">
        {requests.map((request) => (
          <li key={request.id}>
            <span className="admin-meta">
              <span className="admin-name">{request.email}</span>
              <span className="muted">
                {S.accounts.requestedBy(displayName(users[request.requested_by]))}
                {request.reason ? ` · ${request.reason}` : ''}
              </span>
            </span>
            <Button size="sm" variant="primary" onClick={() => void decide(request, true)}>
              {S.accounts.approve}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void decide(request, false)}>
              {S.accounts.deny}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** When a guest's access ends, in a member row. */
export function GuestControls({ user }: { user: User; editable?: boolean }) {
  if (!user.is_restricted || !user.profile.guest_expiration_ts) return null;
  return <span className="tag">{S.accounts.guestUntil(new Date(user.profile.guest_expiration_ts * 1000).toLocaleDateString())}</span>;
}

// ── Workspace settings ──────────────────────────────────────────────────────

interface Settings {
  default_channels: string[];
  signup_domains: string[];
  require_2fa: boolean;
  public_invite_code: string | null;
  [permission: string]: unknown;
}

const PERMISSIONS = ['who_can_create_channels', 'who_can_invite', 'who_can_manage_emoji', 'who_can_at_channel', 'who_can_manage_usergroups'];

interface FieldDraft {
  id?: string;
  label: string;
  type: string;
  hint: string;
  options: string;
}

function ProfileFieldsEditor() {
  const [fields, setFields] = useState<FieldDraft[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call('team.profile.get')
      .then((result) =>
        setFields(
          (result.profile.fields as Json[]).map((field) => ({
            id: field.id,
            label: field.label,
            type: field.type,
            hint: field.hint ?? '',
            options: (field.possible_values ?? []).join(', '),
          })),
        ),
      )
      .catch(() => setFields([]));
  }, []);
  if (!fields) return <Spinner />;
  const update = (index: number, patch: Partial<FieldDraft>): void => setFields(fields.map((field, at) => (at === index ? { ...field, ...patch } : field)));
  const save = async (): Promise<void> => {
    setBusy(true);
    const payload = fields
      .filter((field) => field.label.trim())
      .map((field) => ({
        id: field.id,
        label: field.label.trim(),
        type: field.type,
        hint: field.hint.trim(),
        possible_values: field.type === 'options_list' ? field.options.split(',').map((item) => item.trim()).filter(Boolean) : undefined,
      }));
    const result = await attempt(() => call('client.admin.setProfileFields', { fields: payload }));
    setBusy(false);
    if (result) toast(S.saved);
  };
  return (
    <div className="profile-fields-editor">
      {fields.map((field, index) => (
        <div className="profile-field-row" key={field.id ?? `new-${index}`}>
          <input value={field.label} placeholder={S.accounts.fieldLabel} aria-label={S.accounts.fieldLabel} maxLength={50} onChange={(event) => update(index, { label: event.target.value })} />
          <select value={field.type} aria-label={S.accounts.fieldType} onChange={(event) => update(index, { type: event.target.value })}>
            {Object.entries(S.accounts.fieldTypes).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {field.type === 'options_list' ? (
            <input value={field.options} placeholder={S.accounts.fieldOptions} aria-label={S.accounts.fieldOptions} onChange={(event) => update(index, { options: event.target.value })} />
          ) : (
            <span />
          )}
          <IconButton label={S.remove} onClick={() => setFields(fields.filter((_, at) => at !== index))}>
            <Trash2 size={15} />
          </IconButton>
        </div>
      ))}
      <div className="pref-row">
        <Button size="sm" onClick={() => setFields([...fields, { label: '', type: 'text', hint: '', options: '' }])}>
          <Plus size={14} /> {S.accounts.fieldAdd}
        </Button>
        <Button size="sm" variant="primary" busy={busy} onClick={() => void save()}>
          {S.save}
        </Button>
      </div>
    </div>
  );
}

export function WorkspaceSettings() {
  const team = useStore((state) => state.team);
  const self = useStore((state) => state.self);
  const channels = useStore((state) => state.channels);
  const others = useStore((state) => state.others);
  const [name, setName] = useState(team?.name ?? '');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [domains, setDomains] = useState('');
  const [invites, setInvites] = useState<Json[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iconInput = useRef<HTMLInputElement>(null);
  const channelList = useMemo(
    () => [...Object.values(channels), ...Object.values(others)].filter((conv) => conv.is_channel && !conv.is_archived && !conv.is_general).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
    [channels, others],
  );

  const load = (): void => {
    call('client.admin.settings')
      .then((result) => {
        setSettings(result.settings as Settings);
        setDomains((result.settings.signup_domains as string[]).join(', '));
      })
      .catch((failure: unknown) => setError(errorText(failure)));
    call('client.invites.list')
      .then((result) => setInvites((result.invites as Json[]).filter((invite) => !invite.email && !invite.guest)))
      .catch(() => setInvites([]));
  };
  useEffect(load, []);
  if (!self?.is_admin) return <p className="muted">{S.admin.membersOnly}</p>;
  if (!settings) return error ? <p className="auth-error">{error}</p> : <Spinner />;

  const update = async (patch: Record<string, unknown>): Promise<boolean> => {
    setError(null);
    try {
      const result = await call('client.admin.updateSettings', patch);
      setSettings(result.settings as Settings);
      setDomains((result.settings.signup_domains as string[]).join(', '));
      return true;
    } catch (failure) {
      setError(errorText(failure));
      return false;
    }
  };
  const saveName = async (): Promise<void> => {
    setBusy(true);
    const result = await attempt(() => call('client.admin.updateTeam', { name: name.trim() }));
    setBusy(false);
    if (result) toast(S.saved);
  };
  const setIcon = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    await attempt(async () => {
      const id = await uploadFile(file);
      await call('client.admin.setTeamIcon', { file_id: id });
    });
  };
  const createJoinLink = async (): Promise<void> => {
    const result: Json = await attempt(() => call('client.invites.create', { expires_in_days: 365 }));
    if (!result) return;
    setInvites([...invites, result.invite]);
    await update({ public_invite_code: result.invite.code });
  };

  return (
    <div className="workspace-settings">
      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="admin-section">
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveName();
          }}
        >
          <Field label={S.admin.workspaceName}>
            <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Button variant="primary" busy={busy} disabled={!name.trim() || name.trim() === team?.name} onClick={() => void saveName()}>
            {S.save}
          </Button>
        </form>
        <div className="icon-row">
          <span className="field-label">{S.accounts.workspaceIcon}</span>
          {team ? <img className="team-icon-preview" src={asset(team.icon.image_132)} alt="" width={44} height={44} /> : null}
          <input ref={iconInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(event) => void setIcon(event.target.files?.[0])} />
          <Button size="sm" onClick={() => iconInput.current?.click()}>
            {S.accounts.workspaceIconUpload}
          </Button>
          {team && !team.icon.image_default ? (
            <button type="button" className="link-btn" onClick={() => void attempt(() => call('client.admin.setTeamIcon'))}>
              {S.accounts.workspaceIconRemove}
            </button>
          ) : null}
        </div>
      </section>

      <section className="admin-section">
        <h3 className="dialog-sub">{S.accounts.permissions}</h3>
        <div className="permission-grid">
          {PERMISSIONS.map((permission) => (
            <label key={permission} className="permission-row">
              <span>{S.accounts.permission[permission]}</span>
              <select value={String(settings[permission] ?? 'everyone')} onChange={(event) => void update({ [permission]: event.target.value })}>
                <option value="everyone">{S.accounts.everyone}</option>
                <option value="admins">{S.accounts.adminsOnly}</option>
              </select>
            </label>
          ))}
        </div>
        <label className="check-row">
          <input type="checkbox" checked={settings.require_2fa} onChange={(event) => void update({ require_2fa: event.target.checked })} />
          <span>
            {S.accounts.require2fa}
            <span className="field-hint">{S.accounts.require2faHint}</span>
          </span>
        </label>
      </section>

      <section className="admin-section">
        <Field label={S.accounts.domains} hint={S.accounts.domainsHint}>
          <div className="inline-form">
            <input value={domains} placeholder="example.com" onChange={(event) => setDomains(event.target.value)} />
            <Button size="sm" onClick={() => void update({ signup_domains: domains }).then((ok) => ok && toast(S.saved))}>
              {S.save}
            </Button>
          </div>
        </Field>
        <div className="field">
          <span className="field-label">{S.accounts.defaultChannels}</span>
          <span className="field-hint">{S.accounts.defaultChannelsHint}</span>
          <CheckList
            items={channelList}
            selected={settings.default_channels}
            onChange={(ids) => void update({ default_channels: ids })}
            label={S.accounts.defaultChannels}
            match={(conv, query) => (conv.name ?? '').includes(query)}
            render={(conv) => <>#{conv.name}</>}
          />
        </div>
        <Field label={S.accounts.joinLink}>
          <div className="inline-form">
            <select value={settings.public_invite_code ?? ''} onChange={(event) => void update({ public_invite_code: event.target.value })}>
              <option value="">{S.accounts.joinLinkNone}</option>
              {invites.map((invite) => (
                <option key={invite.code} value={invite.code}>
                  {`/join/${invite.code}`}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={() => void createJoinLink()}>
              {S.accounts.joinLinkCreate}
            </Button>
          </div>
        </Field>
      </section>

      <section className="admin-section">
        <h3 className="dialog-sub">{S.accounts.profileFields}</h3>
        <p className="muted">{S.accounts.profileFieldsHint}</p>
        <ProfileFieldsEditor />
      </section>

      <section className="admin-section">
        <h3 className="dialog-sub">{S.accounts.exportTitle}</h3>
        <p className="muted">{S.accounts.exportBody}</p>
        {self.is_owner ? (
          <a className="btn btn-default btn-md" href="/admin/export.zip" download>
            <span className="btn-label">
              <Download size={15} /> {S.accounts.exportGo}
            </span>
          </a>
        ) : (
          <p className="muted">{S.accounts.exportOwners}</p>
        )}
      </section>
    </div>
  );
}

// ── Channel administration (details panel) ──────────────────────────────────

export function ChannelWebSettings({ channel }: { channel: string }) {
  const self = useStore((state) => state.self);
  const conv = useStore((state) => state.channels[channel] ?? state.others[channel]);
  const web = useAccounts((state) => state.web[channel] ?? false);
  const [files, setFiles] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!web) return;
    call('client.webChannels')
      .then((result) => {
        const entry = (result.channels as Json[]).find((item) => item.id === channel);
        setFiles(Boolean(entry?.web_files));
        setUrl(entry?.url ? new URL(entry.url).pathname : null);
      })
      .catch(() => undefined);
  }, [web, channel]);
  if (!conv?.is_channel || conv.is_private) return null;
  const admin = Boolean(self?.is_admin);
  if (!admin && !web) return null;
  const makePrivate = async (): Promise<void> => {
    if (!(await confirmDialog(S.accounts.makePrivateConfirm, S.accounts.makePrivate))) return;
    await attempt(() => call('admin.conversations.convertToPrivate', { channel_id: channel }));
  };
  const apply = async (webPublic: boolean, webFiles: boolean): Promise<void> => {
    const result: Json = await attempt(() => call('client.admin.setChannelWeb', { channel, web_public: webPublic, web_files: webFiles }));
    if (!result) return;
    setFiles(Boolean(result.web_files));
    setUrl(result.url ? new URL(result.url).pathname : null);
    useAccounts.setState((state) => ({ web: { ...state.web, [channel]: Boolean(result.web_public) } }));
  };
  return (
    <section className="about-item web-settings">
      <div className="about-head">
        <h4>{S.accounts.webTitle}</h4>
      </div>
      <p className="muted">{S.accounts.webBody}</p>
      {admin ? (
        <>
          <label className="check-row">
            <input type="checkbox" checked={web} onChange={(event) => void apply(event.target.checked, files)} />
            <span>{S.accounts.webOn}</span>
          </label>
          {web ? (
            <label className="check-row">
              <input type="checkbox" checked={files} onChange={(event) => void apply(true, event.target.checked)} />
              <span>{S.accounts.webFiles}</span>
            </label>
          ) : null}
        </>
      ) : null}
      {web && url ? (
        <a className="link-btn" href={url} target="_blank" rel="noopener">
          {S.accounts.webOpen}
        </a>
      ) : null}
      {admin && !conv.is_general ? (
        <button type="button" className="row-action is-danger make-private" onClick={() => void makePrivate()}>
          <Lock size={16} /> {S.accounts.makePrivate}
        </button>
      ) : null}
    </section>
  );
}
