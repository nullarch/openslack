import { ArrowLeft, Trash2, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { attempt, toast } from '../lib/actions';
import { call, type Json } from '../lib/api';
import {
  closeView,
  loadHome,
  loadShortcuts,
  runShortcut,
  setAppTab,
  submitView,
  usePlatform,
  viewAction,
  viewSuggest,
  type AppShortcut,
  type AppView,
} from '../lib/platform';
import { useStore } from '../lib/store';
import { StateBag, textOf, type Surface } from '../lib/surface';
import { S } from '../strings';
import '../styles/platform.css';
import { Blocks } from './blocks';
import { Avatar, Button, Field, IconButton, MenuDivider, MenuItem, Modal, Popover, Spinner } from './ui';

// ── Surfaces for views ──────────────────────────────────────────────────────

/** One state bag per view id, seeded from what the server last stored for it. */
function useBags(): (view: AppView) => StateBag {
  const bags = useRef(new Map<string, StateBag>());
  return (view) => {
    let bag = bags.current.get(view.id);
    if (!bag) {
      bag = new StateBag(view.state?.values ?? {});
      bags.current.set(view.id, bag);
    }
    return bag;
  };
}

function viewSurface(view: AppView, kind: 'modal' | 'home', state: StateBag, errors: Record<string, string>, changed?: (blockId: string) => void): Surface {
  return {
    kind,
    state,
    errors,
    changed,
    act: (action) => viewAction(view, action, state.toState()),
    suggest: (actionId, blockId, value) => viewSuggest(view, actionId, blockId, value),
  };
}

/** Input blocks that are not optional and have nothing in them, as Slack checks before submitting. */
function missingInputs(view: AppView, state: StateBag): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const block of view.blocks ?? []) {
    if (block?.type !== 'input' || block.optional === true) continue;
    const value = state.get(String(block.block_id), String(block.element?.action_id ?? ''));
    const filled =
      value &&
      Object.entries(value).some(([key, entry]) => key !== 'type' && entry !== null && entry !== '' && !(Array.isArray(entry) && entry.length === 0));
    if (!filled) errors[String(block.block_id)] = S.platform.required;
  }
  return errors;
}

function omit(record: Record<string, string>, key: string): Record<string, string> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

// ── The modal ───────────────────────────────────────────────────────────────

/** The modal an app opened, if any: its top view, with Cancel and Submit. */
export function AppModalHost() {
  const stack = usePlatform((state) => state.stack);
  const serverErrors = usePlatform((state) => state.errors);
  const bagFor = useBags();
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const view = stack.at(-1);
  const bot = useStore((state) => (view ? Object.values(state.users).find((user) => user.profile.bot_id === view.bot_id) : undefined));

  useEffect(() => setLocalErrors({}), [view?.id]);
  const errors = { ...serverErrors, ...localErrors };
  /** Once the person changes a block, the error shown for it goes. */
  const changed = (blockId: string): void => {
    setLocalErrors((current) => (blockId in current ? omit(current, blockId) : current));
    const fromApp = usePlatform.getState().errors;
    if (blockId in fromApp) usePlatform.setState({ errors: omit(fromApp, blockId) });
  };
  const surface = useMemo(
    () => (view ? viewSurface(view, 'modal', bagFor(view), errors, changed) : null),
    // `changed` only uses setters and the store; the view and its errors are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view?.id, view?.hash, JSON.stringify(errors)],
  );
  if (!view || !surface) return null;

  const submit = async (): Promise<void> => {
    const missing = missingInputs(view, surface.state);
    setLocalErrors(missing);
    if (Object.keys(missing).length > 0) return;
    setBusy(true);
    try {
      await submitView(view, surface.state.toState());
    } finally {
      setBusy(false);
    }
  };

  const title = (
    <span className="app-modal-title">
      {stack.length > 1 ? (
        <IconButton label={textOf(view.close) || S.cancel} onClick={() => void closeView(view, false)}>
          <ArrowLeft size={17} />
        </IconButton>
      ) : bot ? (
        <Avatar user={bot} size={22} />
      ) : null}
      <span>{textOf(view.title)}</span>
    </span>
  );

  return (
    <Modal
      title={title}
      width={560}
      className="app-modal"
      onClose={() => void closeView(view, true)}
      footer={
        <>
          <Button onClick={() => void closeView(view, false)}>{textOf(view.close) || S.cancel}</Button>
          {view.submit ? (
            <Button variant="primary" busy={busy} disabled={view.submit_disabled === true} onClick={() => void submit()}>
              {textOf(view.submit) || S.platform.submit}
            </Button>
          ) : null}
        </>
      }
    >
      <form
        className="app-view"
        data-view-id={view.id}
        data-callback-id={view.callback_id}
        onSubmit={(event) => {
          event.preventDefault();
          if (view.submit) void submit();
        }}
      >
        <Blocks key={view.id} blocks={view.blocks ?? []} fallbackText="" surface={surface} />
      </form>
    </Modal>
  );
}

// ── App Home ────────────────────────────────────────────────────────────────

/** The app behind a direct message with a bot, if it is one. */
export function useAppOf(channel: string): string | null {
  return useStore((state) => {
    const conv = state.channels[channel] ?? state.others[channel];
    if (!conv?.is_im || !conv.user) return null;
    const user = state.users[conv.user];
    return user?.is_bot && user.profile.api_app_id ? user.profile.api_app_id : null;
  });
}

/** Which tab of an app's conversation shows: what the person chose, else Home when the app has one. */
export function useAppTab(appId: string | null): 'home' | 'messages' {
  const chosen = usePlatform((state) => (appId ? state.appTab[appId] : undefined));
  const home = usePlatform((state) => (appId ? state.homes[appId] : undefined));
  if (!appId) return 'messages';
  return chosen ?? (home ? 'home' : 'messages');
}

export function AppTabs({ appId }: { appId: string }) {
  const tab = useAppTab(appId);
  const known = usePlatform((state) => state.homes[appId] !== undefined);
  useEffect(() => {
    if (!known) void loadHome(appId);
  }, [appId, known]);
  // Opening the conversation counts as opening the app: it hears `app_home_opened`.
  const told = useRef(false);
  useEffect(() => {
    if (!known || told.current) return;
    told.current = true;
    setAppTab(appId, tab);
  }, [appId, known, tab]);
  return (
    <div className="app-tabs" role="tablist">
      {(['home', 'messages'] as const).map((entry) => (
        <button key={entry} type="button" role="tab" aria-selected={tab === entry} className={`app-tab ${tab === entry ? 'is-on' : ''}`} onClick={() => setAppTab(appId, entry)}>
          {entry === 'home' ? S.platform.tabHome : S.platform.tabMessages}
        </button>
      ))}
    </div>
  );
}

export function AppHomeView({ appId }: { appId: string }) {
  const view = usePlatform((state) => state.homes[appId]);
  const bot = useStore((state) => Object.values(state.users).find((user) => user.profile.api_app_id === appId));
  const bagFor = useBags();
  const surface = useMemo(() => (view ? viewSurface(view, 'home', bagFor(view), {}) : null), [view?.id, view?.hash]);
  if (view === undefined) {
    return (
      <div className="app-home">
        <Spinner />
      </div>
    );
  }
  if (!view || !surface) {
    return (
      <div className="app-home is-empty">
        <p className="muted">{S.platform.homeEmpty(bot?.real_name || bot?.name || '')}</p>
      </div>
    );
  }
  return (
    <div className="app-home" data-view-id={view.id}>
      <Blocks key={`${view.id}:${view.hash}`} blocks={view.blocks ?? []} fallbackText="" surface={surface} />
    </div>
  );
}

// ── Shortcuts ───────────────────────────────────────────────────────────────

function useShortcuts(type: 'global' | 'message'): AppShortcut[] | null {
  const all = usePlatform((state) => state.shortcuts);
  useEffect(() => {
    if (all === null) void loadShortcuts();
  }, [all]);
  return all === null ? null : all.filter((entry) => entry.type === type);
}

/** The composer's shortcut menu: global shortcuts of every app. */
export function ShortcutsButton() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const all = useShortcuts('global');
  return (
    <>
      <IconButton
        ref={anchor}
        label={S.platform.shortcuts}
        onClick={() => {
          void loadShortcuts();
          setOpen(true);
        }}
      >
        <Zap size={17} />
      </IconButton>
      {open ? (
        <Popover anchor={anchor.current} onClose={() => setOpen(false)} side="top" className="menu shortcuts-menu">
          <div className="menu-title">{S.platform.shortcutsTitle}</div>
          {all === null ? <Spinner /> : null}
          {all?.length === 0 ? <p className="muted menu-empty">{S.platform.shortcutsNone}</p> : null}
          {all?.map((shortcut) => (
            <MenuItem
              key={`${shortcut.app_id}:${shortcut.callback_id}`}
              icon={<Zap size={15} />}
              label={shortcut.name}
              hint={shortcut.app_name}
              onSelect={() => {
                setOpen(false);
                void runShortcut(shortcut);
              }}
            />
          ))}
        </Popover>
      ) : null}
    </>
  );
}

/** Message shortcuts, for a message's menu. */
export function MessageShortcutItems({ channel, ts, onDone }: { channel: string; ts: string; onDone: () => void }) {
  const all = useShortcuts('message');
  if (!all || all.length === 0) return null;
  return (
    <>
      <MenuDivider />
      {all.map((shortcut) => (
        <MenuItem
          key={`${shortcut.app_id}:${shortcut.callback_id}`}
          icon={<Zap size={16} />}
          label={shortcut.name}
          hint={shortcut.app_name}
          onSelect={() => {
            onDone();
            void runShortcut(shortcut, { channel, message_ts: ts });
          }}
        />
      ))}
    </>
  );
}

// ── App settings for admins ─────────────────────────────────────────────────

interface Configurable {
  id: string;
  shortcuts?: Omit<AppShortcut, 'app_id' | 'app_name'>[];
  unfurl_domains?: string[];
}

/** Shortcuts and unfurl domains of one app, in the app's admin screen. */
export function AppPlatformSettings({ app, onChanged }: { app: Configurable; onChanged: () => void }) {
  const [shortcuts, setShortcuts] = useState(app.shortcuts ?? []);
  const [domains, setDomains] = useState((app.unfurl_domains ?? []).join(', '));
  const [type, setType] = useState<'global' | 'message'>('global');
  const [name, setName] = useState('');
  const [callbackId, setCallbackId] = useState('');
  const [description, setDescription] = useState('');

  const saveShortcuts = async (next: typeof shortcuts): Promise<void> => {
    const result = await attempt(() => call('client.apps.update', { app: app.id, shortcuts: next }));
    if (!result) return;
    setShortcuts(result.app?.shortcuts ?? next);
    usePlatform.setState({ shortcuts: null });
    onChanged();
  };

  return (
    <div className="app-platform-settings">
      <h3 className="dialog-sub">{S.platform.settings.shortcuts}</h3>
      <p className="muted">{S.platform.settings.shortcutsHint}</p>
      {shortcuts.length === 0 ? <p className="muted">{S.platform.settings.shortcutsNone}</p> : null}
      <ul className="admin-list">
        {shortcuts.map((shortcut) => (
          <li key={shortcut.callback_id}>
            <span className="admin-meta">
              <span className="admin-name">
                {shortcut.name} <span className="muted">{shortcut.type === 'global' ? S.platform.settings.global : S.platform.settings.message}</span>
              </span>
              <span className="muted">
                <code>{shortcut.callback_id}</code> {shortcut.description}
              </span>
            </span>
            <IconButton label={S.remove} onClick={() => void saveShortcuts(shortcuts.filter((entry) => entry.callback_id !== shortcut.callback_id))}>
              <Trash2 size={15} />
            </IconButton>
          </li>
        ))}
      </ul>
      <div className="shortcut-form">
        <Field label={S.platform.settings.name}>
          <input value={name} maxLength={30} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={S.platform.settings.callbackId}>
          <input value={callbackId} placeholder="new_bug" onChange={(event) => setCallbackId(event.target.value.replace(/\s/g, ''))} />
        </Field>
        <Field label={`${S.platform.settings.description} (${S.optional})`}>
          <input value={description} maxLength={100} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <Field label={S.platform.shortcuts}>
          <select value={type} onChange={(event) => setType(event.target.value === 'message' ? 'message' : 'global')}>
            <option value="global">{S.platform.settings.global}</option>
            <option value="message">{S.platform.settings.message}</option>
          </select>
        </Field>
        <Button
          disabled={!name.trim() || !/^[A-Za-z0-9_.-]+$/.test(callbackId)}
          onClick={() => {
            void saveShortcuts([...shortcuts, { type, name: name.trim(), callback_id: callbackId, description: description.trim() }]).then(() => {
              setName('');
              setCallbackId('');
              setDescription('');
            });
          }}
        >
          {S.platform.settings.add}
        </Button>
      </div>

      <h3 className="dialog-sub">{S.platform.settings.unfurl}</h3>
      <p className="muted">{S.platform.settings.unfurlHint}</p>
      <div className="inline-form">
        <Field label={S.platform.settings.unfurlDomains}>
          <input value={domains} placeholder="example.com" onChange={(event) => setDomains(event.target.value)} />
        </Field>
        <Button
          onClick={() =>
            void attempt(() => call('client.apps.update', { app: app.id, unfurl_domains: domains.trim() })).then((result) => {
              if (!result) return;
              setDomains((result.app?.unfurl_domains ?? []).join(', '));
              toast(S.saved);
              onChanged();
            })
          }
        >
          {S.save}
        </Button>
      </div>
    </div>
  );
}

/** The per-token API rate limit, for admins, on the Apps screen. */
export function RateLimitSetting() {
  const isAdmin = useStore((state) => state.self?.is_admin ?? false);
  const [limits, setLimits] = useState<Json | null>(null);
  const [value, setValue] = useState('');
  useEffect(() => {
    call('client.apps.limits')
      .then((result) => {
        setLimits(result);
        setValue(result.api_rate_limit_per_minute ? String(result.api_rate_limit_per_minute) : '');
      })
      .catch(() => setLimits(null));
  }, []);
  if (!limits) return null;
  const current = Number(limits.api_rate_limit_per_minute ?? limits.default_per_minute);
  if (!isAdmin) return <p className="muted">{S.platform.settings.rateCurrent(current)}</p>;
  return (
    <div className="rate-limit">
      <h3 className="dialog-sub">{S.platform.settings.rate}</h3>
      <p className="muted">{S.platform.settings.rateHint(Number(limits.default_per_minute))}</p>
      <div className="inline-form">
        <Field label={S.platform.settings.ratePerMinute}>
          <input
            type="number"
            min={limits.min}
            max={limits.max}
            value={value}
            placeholder={String(limits.default_per_minute)}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
        <Button
          onClick={() =>
            void attempt(() => call('client.apps.setRateLimit', { per_minute: value.trim() ? Number(value) : 0 })).then((result) => {
              if (!result) return;
              setLimits({ ...limits, api_rate_limit_per_minute: result.api_rate_limit_per_minute });
              toast(S.saved);
            })
          }
        >
          {S.save}
        </Button>
      </div>
    </div>
  );
}
