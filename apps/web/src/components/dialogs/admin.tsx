import type { User } from '@app/shared';
import { ArrowLeft, Bot, Trash2 } from 'lucide-react';
import { AppPlatformSettings, RateLimitSetting } from '../AppViews';
import { useEffect, useRef, useState } from 'react';
import { attempt, closeModal, errorText, openModal, toast } from '../../lib/actions';
import { ApiError, asset, call, isUnsupported, uploadFile, type Json } from '../../lib/api';
import { customEmojiUrl } from '../../lib/emoji';
import { displayName, useStore, type AdminTab } from '../../lib/store';
import { S } from '../../strings';
import { Avatar, Button, CopyField, Field, IconButton, Modal, Spinner } from '../ui';
import { confirmDialog } from './confirm';
import { ResponsesAdmin } from '../workflows/ResponsesAdmin';
import { AppStepsSetting } from '../workflows/AppSteps';
import { ConfigTokenSetting, ManifestCreate, ManifestEditor } from '../AppManifest';
import { GuestControls, InviteRequests, WorkspaceSettings } from '../accounts/Admin';

// ── Members ─────────────────────────────────────────────────────────────────

function MembersAdmin() {
  const users = useStore((state) => state.users);
  const self = useStore((state) => state.self);
  if (!self?.is_admin) return <p className="muted">{S.admin.membersOnly}</p>;
  const people = Object.values(users)
    .filter((user) => !user.is_bot)
    .sort((a, b) => Number(a.deleted) - Number(b.deleted) || displayName(a).localeCompare(displayName(b)));
  const roleOf = (user: User): string =>
    user.is_primary_owner ? 'primary_owner' : user.is_owner ? 'owner' : user.is_admin ? 'admin' : user.is_ultra_restricted ? 'single' : user.is_restricted ? 'multi' : 'member';
  // Guests are an account type rather than a role; one list covers both.
  const roles = [...(self.is_owner ? ['owner', 'admin', 'member'] : ['admin', 'member']), 'multi', 'single'];
  const roleLabel = (role: string): string => S.admin.role[role] ?? (role === 'multi' ? S.accounts.guestMulti : S.accounts.guestSingle);

  // The server's answer is applied at once; the same change also arrives as an event for everyone else.
  const apply = (result: Json | undefined): void => {
    const changed = result?.user as User | undefined;
    if (changed) useStore.setState((state) => ({ users: { ...state.users, [changed.id]: changed } }));
  };
  const setRole = async (user: User, role: string): Promise<void> => {
    if (role === 'multi' || role === 'single') {
      apply(await attempt(() => call('client.admin.setAccountType', { user: user.id, type: role })));
      return;
    }
    if (user.is_restricted) {
      const result = await attempt(() => call('client.admin.setAccountType', { user: user.id, type: 'member' }));
      apply(result);
      if (!result || role === 'member') return;
    }
    apply(await attempt(() => call('client.admin.setRole', { user: user.id, role })));
  };
  const deactivate = async (user: User): Promise<void> => {
    if (!user.deleted && !(await confirmDialog(S.admin.confirmDeactivate(displayName(user)), S.admin.deactivate))) return;
    apply(await attempt(() => call('client.admin.setActive', { user: user.id, active: user.deleted })));
  };

  return (
    <>
    <InviteRequests />
    <ul className="admin-list">
      {people.map((user) => {
        const role = roleOf(user);
        const locked = user.is_primary_owner || user.id === self.id || (user.is_owner && !self.is_owner);
        return (
          <li key={user.id} className={user.deleted ? 'is-off' : ''}>
            <Avatar user={user} size={34} />
            <span className="admin-meta">
              <span className="admin-name">
                {user.real_name || displayName(user)}
                {user.id === self.id ? <span className="conv-you">{S.sidebar.you}</span> : null}
              </span>
              <span className="muted">{user.profile.email ?? `@${user.name}`}</span>
            </span>
            <GuestControls user={user} editable={!locked} />
            {user.deleted ? (
              <span className="tag">{S.admin.deactivated}</span>
            ) : locked ? (
              <span className="admin-role">{roleLabel(role)}</span>
            ) : (
              <select
                value={role}
                aria-label={roleLabel(role)}
                onChange={(event) => void setRole(user, event.target.value)}
              >
                {roles.map((option) => (
                  <option key={option} value={option}>
                    {roleLabel(option)}
                  </option>
                ))}
              </select>
            )}
            {!locked ? (
              <Button size="sm" variant="ghost" onClick={() => void deactivate(user)}>
                {user.deleted ? S.admin.reactivate : S.admin.deactivate}
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
    </>
  );
}

// ── Custom emoji ────────────────────────────────────────────────────────────

function EmojiAdmin() {
  const emoji = useStore((state) => state.emoji);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const add = async (): Promise<void> => {
    if (!file || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const id = await uploadFile(file);
      await call('admin.emoji.add', { name: name.trim(), file_id: id });
      setName('');
      setFile(null);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const names = Object.keys(emoji).sort();
  return (
    <div className="emoji-admin">
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <Field label={S.admin.emojiName} error={error} hint={S.admin.emojiHint}>
          <input value={name} placeholder={S.admin.emojiNamePlaceholder} onChange={(event) => setName(event.target.value.toLowerCase().replace(/[\s:]/g, '-'))} />
        </Field>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        <Button onClick={() => input.current?.click()}>{file ? file.name : S.admin.emojiChoose}</Button>
        <Button variant="primary" busy={busy} disabled={!file || !name.trim()} onClick={() => void add()}>
          {S.admin.emojiAdd}
        </Button>
      </form>
      {names.length === 0 ? (
        <p className="muted">{S.admin.emojiNone}</p>
      ) : (
        <ul className="admin-list">
          {names.map((item) => {
            const url = customEmojiUrl(item, emoji);
            return (
              <li key={item}>
                {url ? <img className="emoji-admin-image" src={asset(url)} alt="" /> : <span className="emoji-admin-image" />}
                <span className="admin-meta">
                  <span className="admin-name">:{item}:</span>
                  {emoji[item]?.startsWith('alias:') ? <span className="muted">{emoji[item]}</span> : null}
                </span>
                <IconButton label={S.remove} onClick={() => void attempt(() => call('admin.emoji.remove', { name: item }))}>
                  <Trash2 size={15} />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Apps ────────────────────────────────────────────────────────────────────

interface AppInfo {
  id: string;
  name: string;
  description: string;
  bot_user_id: string;
  bot_id: string;
  socket_mode: boolean;
  events_url: string | null;
  interactivity_url: string | null;
  bot_events: string[];
  connected: boolean;
  token_hints?: { bot?: string | null; app?: string | null } | null;
}

interface Secrets {
  bot_token?: string;
  app_token?: string;
  signing_secret?: string;
}

function boltSnippet(): string {
  return [
    "import { App } from '@slack/bolt';",
    '',
    'const app = new App({',
    '  token: process.env.SLACK_BOT_TOKEN, // xoxb-…',
    '  appToken: process.env.SLACK_APP_TOKEN, // xapp-…',
    '  socketMode: true,',
    `  clientOptions: { slackApiUrl: '${window.location.origin}/api/' },`,
    '});',
    '',
    "app.message('hello', async ({ say }) => say('Hello from this server'));",
    '',
    'await app.start();',
  ].join('\n');
}

function SecretsView({ secrets }: { secrets: Secrets }) {
  return (
    <div className="secrets">
      <h3>{S.apps.tokensTitle}</h3>
      <p className="muted">{S.apps.tokensBody}</p>
      {secrets.bot_token ? <CopyField label={S.apps.botToken} value={secrets.bot_token} /> : null}
      {secrets.app_token ? <CopyField label={S.apps.appToken} value={secrets.app_token} /> : null}
      {secrets.signing_secret ? <CopyField label={S.apps.signingSecret} value={secrets.signing_secret} /> : null}
      <h3>{S.apps.snippetTitle}</h3>
      <pre className="code-block">
        <code>{boltSnippet()}</code>
      </pre>
    </div>
  );
}

interface AppDetailProps {
  app: AppInfo;
  /** Credentials from creating the app in this dialog; null once the detail view has been left. */
  secrets: Secrets | null;
  onBack: () => void;
  onChanged: () => void;
  /** A token was replaced, so the one shown at creation is no longer valid. */
  onRotated: (kind: 'bot' | 'app') => void;
}

function AppDetail({ app, secrets, onBack, onChanged, onRotated }: AppDetailProps) {
  const bot = useStore((state) => state.users[app.bot_user_id]);
  const connected = useStore((state) => state.appConnections[app.id] ?? app.connected);
  const [signingSecret, setSigningSecret] = useState<string | null>(null);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [hints, setHints] = useState(app.token_hints ?? null);
  const channels = useStore((state) => state.channels);
  const allCommands = useStore((state) => state.commands);
  const [socketMode, setSocketMode] = useState(app.socket_mode);
  const [eventsUrl, setEventsUrl] = useState(app.events_url ?? '');
  const [interactivityUrl, setInteractivityUrl] = useState(app.interactivity_url ?? '');
  const [botEvents, setBotEvents] = useState((app.bot_events ?? []).join(', '));
  const [rotated, setRotated] = useState<string | null>(null);
  const [webhooks, setWebhooks] = useState<{ id: string; url: string; channel: string; channel_name?: string }[]>([]);
  const [webhookChannel, setWebhookChannel] = useState('');
  const [command, setCommand] = useState('');
  const [commandDescription, setCommandDescription] = useState('');
  const [commandHint, setCommandHint] = useState('');
  const [commandUrl, setCommandUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const loadWebhooks = (): void => {
    call('client.apps.webhooks.list', { app: app.id })
      .then((result) => setWebhooks(result.webhooks ?? []))
      .catch(() => setWebhooks([]));
  };
  useEffect(loadWebhooks, [app.id]);
  useEffect(() => {
    call('client.apps.info', { app: app.id })
      .then((result) => {
        setSigningSecret(typeof result.signing_secret === 'string' ? result.signing_secret : null);
        setEventTypes(Array.isArray(result.subscribable_events) ? result.subscribable_events : []);
        setHints(result.app?.token_hints ?? null);
      })
      .catch(() => undefined);
  }, [app.id]);

  const reloadCommands = (): void => {
    call('client.commands.list')
      .then((result) => useStore.setState({ commands: result.commands ?? [] }))
      .catch(() => undefined);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await call('client.apps.update', {
        app: app.id,
        socket_mode: socketMode,
        events_url: eventsUrl.trim(),
        interactivity_url: interactivityUrl.trim(),
        bot_events: botEvents.split(',').map((item) => item.trim()).filter(Boolean),
      });
      toast(S.saved);
      onChanged();
    } catch (error) {
      // A request URL is verified before it is saved; say what the server heard back.
      const detail = error instanceof ApiError && typeof error.data.detail === 'string' ? ` ${error.data.detail}` : '';
      toast(`${errorText(error)}${detail}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (kind: 'bot' | 'app'): Promise<void> => {
    const result = await attempt(() => call('client.apps.rotateToken', { app: app.id, kind }));
    if (!result) return;
    const token = String(result.token);
    setRotated(token);
    onRotated(kind);
    setHints((current) => ({ ...current, [kind]: `${token.slice(0, 9)}…${token.slice(-4)}` }));
  };

  const remove = async (): Promise<void> => {
    if (!(await confirmDialog(S.apps.confirmDelete(app.name), S.apps.delete))) return;
    const result = await attempt(() => call('client.apps.delete', { app: app.id }));
    if (result) {
      onChanged();
      onBack();
    }
  };

  const commands = allCommands.filter((item) => item.app_id === app.id);
  const memberChannels = Object.values(channels).filter((channel) => channel.is_channel);

  return (
    <div className="app-detail">
      <button type="button" className="link-btn back-link" onClick={onBack}>
        <ArrowLeft size={15} /> {S.apps.back}
      </button>
      <div className="app-head">
        <Avatar user={bot} size={44} />
        <div>
          <h3>{app.name}</h3>
          <p className="muted">
            {bot ? S.apps.botUser(bot.name) : app.bot_id} · {connected ? S.apps.connected : S.apps.notConnected}
          </p>
        </div>
      </div>
      {secrets ? <SecretsView secrets={secrets} /> : null}
      {!secrets && signingSecret ? <CopyField label={S.apps.signingSecret} value={signingSecret} /> : null}

      <label className="check-row">
        <input type="checkbox" checked={socketMode} onChange={(event) => setSocketMode(event.target.checked)} />
        <span>
          <strong>{S.apps.socketMode}</strong>
          <span className="field-hint">{S.apps.socketModeHint}</span>
        </span>
      </label>
      <Field label={S.apps.eventsUrl}>
        <input type="url" value={eventsUrl} placeholder="https://" onChange={(event) => setEventsUrl(event.target.value)} />
      </Field>
      <Field label={S.apps.interactivityUrl}>
        <input type="url" value={interactivityUrl} placeholder="https://" onChange={(event) => setInteractivityUrl(event.target.value)} />
      </Field>
      <Field label={S.apps.botEvents} hint={S.apps.botEventsHint}>
        <input value={botEvents} placeholder="message.channels, app_mention" onChange={(event) => setBotEvents(event.target.value)} />
      </Field>
      {eventTypes.length > 0 ? (
        <details className="event-types">
          <summary>{S.apps.eventsAvailable}</summary>
          <p>{eventTypes.join(', ')}</p>
        </details>
      ) : null}
      <div className="row-buttons">
        <Button variant="primary" busy={busy} onClick={() => void save()}>
          {S.save}
        </Button>
      </div>
      <ul className="admin-list token-list">
        <li>
          <span className="admin-meta">
            <span className="admin-name">{S.apps.botToken}</span>
            <span className="muted token-hint">{hints?.bot ?? S.apps.noToken}</span>
          </span>
          <Button size="sm" onClick={() => void rotate('bot')}>
            {hints?.bot ? S.apps.rotateBot : S.apps.issueBot}
          </Button>
        </li>
        <li>
          <span className="admin-meta">
            <span className="admin-name">{S.apps.appToken}</span>
            <span className="muted token-hint">{hints?.app ?? S.apps.noToken}</span>
          </span>
          <Button size="sm" onClick={() => void rotate('app')}>
            {hints?.app ? S.apps.rotateApp : S.apps.issueApp}
          </Button>
        </li>
      </ul>
      {rotated ? <CopyField label={S.apps.rotated} value={rotated} /> : null}

      <h3 className="dialog-sub">{S.apps.webhooks}</h3>
      <p className="muted">{S.apps.webhooksHint}</p>
      {webhooks.length === 0 ? <p className="muted">{S.apps.webhookNone}</p> : null}
      {webhooks.map((hook) => (
        <div key={hook.id} className="hook-row">
          <CopyField label={`#${hook.channel_name ?? channels[hook.channel]?.name ?? hook.channel}`} value={hook.url} />
          <IconButton
            label={S.remove}
            onClick={() => void attempt(() => call('client.apps.webhooks.delete', { app: app.id, id: hook.id })).then(loadWebhooks)}
          >
            <Trash2 size={15} />
          </IconButton>
        </div>
      ))}
      <div className="inline-form">
        <Field label={S.apps.webhookChannel}>
          <select value={webhookChannel} onChange={(event) => setWebhookChannel(event.target.value)}>
            <option value="" disabled>
              {S.apps.webhookChannel}
            </option>
            {memberChannels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                #{channel.name}
              </option>
            ))}
          </select>
        </Field>
        <Button
          disabled={!webhookChannel}
          onClick={() => void attempt(() => call('client.apps.webhooks.create', { app: app.id, channel: webhookChannel })).then(loadWebhooks)}
        >
          {S.apps.webhookAdd}
        </Button>
      </div>

      <h3 className="dialog-sub">{S.apps.commands}</h3>
      {commands.length === 0 ? <p className="muted">{S.apps.commandsNone}</p> : null}
      <ul className="admin-list">
        {commands.map((item) => (
          <li key={item.command}>
            <span className="admin-meta">
              <span className="admin-name">
                {item.command} <span className="muted">{item.usage_hint}</span>
              </span>
              <span className="muted">{item.description}</span>
            </span>
            <IconButton
              label={S.remove}
              onClick={() => void attempt(() => call('client.apps.commands.delete', { app: app.id, command: item.command })).then(reloadCommands)}
            >
              <Trash2 size={15} />
            </IconButton>
          </li>
        ))}
      </ul>
      <div className="command-form">
        <Field label={S.apps.command}>
          <input value={command} placeholder={S.apps.commandPlaceholder} onChange={(event) => setCommand(event.target.value.replace(/\s/g, ''))} />
        </Field>
        <Field label={S.apps.commandDescription}>
          <input value={commandDescription} onChange={(event) => setCommandDescription(event.target.value)} />
        </Field>
        <Field label={S.apps.commandHint}>
          <input value={commandHint} placeholder="[environment]" onChange={(event) => setCommandHint(event.target.value)} />
        </Field>
        <Field label={S.apps.commandUrl}>
          <input type="url" value={commandUrl} placeholder="https://" onChange={(event) => setCommandUrl(event.target.value)} />
        </Field>
        <Button
          disabled={!/^\/?[a-z0-9_-]+$/i.test(command)}
          onClick={() =>
            void attempt(() =>
              call('client.apps.commands.set', {
                app: app.id,
                command: command.startsWith('/') ? command.toLowerCase() : `/${command.toLowerCase()}`,
                description: commandDescription,
                usage_hint: commandHint,
                url: commandUrl.trim() || undefined,
              }),
            ).then((result) => {
              if (!result) return;
              setCommand('');
              setCommandDescription('');
              setCommandHint('');
              setCommandUrl('');
              reloadCommands();
            })
          }
        >
          {S.apps.commandAdd}
        </Button>
      </div>

      <AppPlatformSettings app={app} onChanged={onChanged} />
      <AppStepsSetting app={app} onChanged={onChanged} />
      <ManifestEditor appId={app.id} onChanged={onChanged} />

      <div className="danger-zone">
        <Button variant="danger" onClick={() => void remove()}>
          {S.apps.delete}
        </Button>
      </div>
    </div>
  );
}

function AppsAdmin() {
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<Record<string, Secrets>>({});
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const users = useStore((state) => state.users);
  const isAdmin = useStore((state) => state.self?.is_admin ?? false);
  const live = useStore((state) => state.appConnections);

  const load = (): void => {
    call('client.apps.list')
      .then((result) => setApps(result.apps as AppInfo[]))
      .catch((error: unknown) => {
        setApps([]);
        if (isUnsupported(error)) setUnsupported(true);
      });
  };
  useEffect(load, []);

  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      const result: Json = await call('client.apps.create', { name: name.trim(), description: description.trim() });
      const app = result.app as AppInfo;
      setSecrets((current) => ({
        ...current,
        [app.id]: { bot_token: result.bot_token, app_token: result.app_token, signing_secret: result.signing_secret },
      }));
      setApps((current) => [...(current ?? []), app]);
      setSelected(app.id);
      setName('');
      setDescription('');
    } catch (error) {
      toast(isUnsupported(error) ? S.apps.unsupported : errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (apps === null) return <Spinner />;
  const current = apps.find((app) => app.id === selected);
  const isConnected = (app: AppInfo): boolean => live[app.id] ?? app.connected;
  if (current && isAdmin) {
    const forget = (kind?: 'bot' | 'app'): void => {
      setSecrets((all) => {
        const next = { ...all };
        const mine = next[current.id];
        if (!mine) return all;
        if (kind === 'bot') next[current.id] = { ...mine, bot_token: undefined };
        else if (kind === 'app') next[current.id] = { ...mine, app_token: undefined };
        else delete next[current.id];
        return next;
      });
    };
    return (
      <AppDetail
        key={current.id}
        app={current}
        secrets={secrets[current.id] ?? null}
        onBack={() => {
          // Credentials are shown once: leaving this view forgets them.
          forget();
          setSelected(null);
        }}
        onChanged={load}
        onRotated={forget}
      />
    );
  }

  return (
    <div className="apps-admin">
      <p className="dialog-lead">{S.apps.intro}</p>
      {unsupported ? <p className="notice">{S.apps.unsupported}</p> : null}
      {apps.length === 0 && !unsupported ? <p className="muted">{S.apps.none}</p> : null}
      <ul className="admin-list">
        {apps.map((app) => (
          <li key={app.id}>
            <button type="button" className="app-row" disabled={!isAdmin} onClick={() => setSelected(app.id)}>
              {users[app.bot_user_id] ? <Avatar user={users[app.bot_user_id]} size={34} /> : <span className="app-glyph"><Bot size={18} /></span>}
              <span className="admin-meta">
                <span className="admin-name">{app.name}</span>
                <span className="muted">{app.description || (users[app.bot_user_id] ? S.apps.botUser(users[app.bot_user_id]!.name) : '')}</span>
              </span>
              <span className={`app-state ${isConnected(app) ? 'is-on' : ''}`}>{isConnected(app) ? S.apps.connected : S.apps.notConnected}</span>
            </button>
          </li>
        ))}
      </ul>
      {!unsupported && !isAdmin ? <p className="muted">{S.apps.adminOnly}</p> : null}
      {!unsupported ? <RateLimitSetting /> : null}
      {!unsupported && isAdmin ? (
        <form
          className="new-app"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) void create();
          }}
        >
          <h3 className="dialog-sub">{S.apps.create}</h3>
          <Field label={S.apps.name}>
            <input value={name} maxLength={80} placeholder={S.apps.namePlaceholder} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label={`${S.apps.description} (${S.optional})`}>
            <input value={description} maxLength={200} onChange={(event) => setDescription(event.target.value)} />
          </Field>
          <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={() => void create()}>
            {S.apps.createGo}
          </Button>
        </form>
      ) : null}
      {!unsupported && isAdmin ? (
        <ManifestCreate
          onCreated={(appId, made) => {
            setSecrets((current) => ({ ...current, [appId]: made }));
            load();
            setSelected(appId);
          }}
        />
      ) : null}
      {!unsupported && isAdmin ? <ConfigTokenSetting /> : null}
    </div>
  );
}

// ── Workspace ───────────────────────────────────────────────────────────────

function MessagePolicyAdminGuard() {
  const isAdmin = useStore((state) => Boolean(state.self?.is_admin));
  return isAdmin ? <MessagePolicyAdmin /> : null;
}

/** How long people may edit their messages, and who may delete them. */
function MessagePolicyAdmin() {
  const policy = useStore((state) => state.att.messagePolicy);
  const save = async (patch: Record<string, unknown>): Promise<void> => {
    const result = await attempt(() => call('client.admin.setMessagePolicy', patch));
    if (result) toast(S.saved);
  };
  const windows = [-1, 0, 5, 15, 60, 1440, 10080];
  return (
    <fieldset className="pref-group message-policy">
      <legend>{S.att.policy.title}</legend>
      <Field label={S.att.policy.editWindow}>
        <select value={policy.msg_edit_window_mins} onChange={(event) => void save({ msg_edit_window_mins: Number(event.target.value) })}>
          {windows.map((value) => (
            <option key={value} value={value}>
              {value === -1 ? S.att.policy.always : value === 0 ? S.att.policy.never : S.att.policy.minutes(value)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={S.att.policy.deletion}>
        <select value={policy.allow_message_deletion} onChange={(event) => void save({ allow_message_deletion: event.target.value })}>
          <option value="everyone">{S.att.policy.deletionEveryone}</option>
          <option value="admins">{S.att.policy.deletionAdmins}</option>
        </select>
      </Field>
    </fieldset>
  );
}

export function AdminDialog({ tab }: { tab: AdminTab }) {
  const tabs: { id: AdminTab; label: string }[] = [
    { id: 'members', label: S.admin.members },
    { id: 'emoji', label: S.admin.emoji },
    { id: 'apps', label: S.admin.apps },
    { id: 'workspace', label: S.admin.workspace },
  ];
  return (
    <Modal title={S.admin.title} onClose={closeModal} width={720} className="admin-modal">
      <div className="tabs" role="tablist">
        {tabs.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'is-active' : ''} onClick={() => openModal({ kind: 'admin', tab: item.id })}>
            {item.label}
          </button>
        ))}
      </div>
      <div className="admin-body">
        {tab === 'members' ? <MembersAdmin /> : null}
        {tab === 'emoji' ? <EmojiAdmin /> : null}
        {tab === 'apps' ? <AppsAdmin /> : null}
        {tab === 'workspace' ? (
          <>
            <WorkspaceSettings />
            <MessagePolicyAdminGuard />
            <ResponsesAdmin />
          </>
        ) : null}
      </div>
    </Modal>
  );
}
