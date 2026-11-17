import { useState } from 'react';
import { attempt, errorText, toast } from '../lib/actions';
import { ApiError, call, type Json } from '../lib/api';
import { S } from '../strings';
import { Button, CopyField, Field } from './ui';

interface ManifestProblem {
  message: string;
  pointer: string;
}

function problemsOf(error: unknown): ManifestProblem[] {
  if (!(error instanceof ApiError) || !Array.isArray(error.data.errors)) return [];
  return error.data.errors as ManifestProblem[];
}

function Problems({ items }: { items: ManifestProblem[] }) {
  if (!items.length) return null;
  return (
    <div className="manifest-problems" role="alert">
      <p>{S.apps.manifestProblems}</p>
      <ul>
        {items.map((item) => (
          <li key={`${item.pointer}:${item.message}`}>
            <code>{item.pointer}</code> {item.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Paste a Slack app manifest to create an app from it (the web client calls `apps.manifest.create` with the admin's session). */
export function ManifestCreate({ onCreated }: { onCreated: (appId: string, secrets: { bot_token?: string; app_token?: string; signing_secret?: string }) => void }) {
  const [text, setText] = useState('');
  const [problems, setProblems] = useState<ManifestProblem[]>([]);
  const [busy, setBusy] = useState(false);
  const create = async (): Promise<void> => {
    setBusy(true);
    setProblems([]);
    try {
      const created = await call('apps.manifest.create', { manifest: text });
      const appId = String(created.app_id);
      // Installing on this workspace: hand the admin the tokens a running app needs, as creating an app here does.
      const bot = await call('client.apps.rotateToken', { app: appId, kind: 'bot' });
      let socket = false;
      try {
        socket = (JSON.parse(text) as Json).settings?.socket_mode_enabled === true;
      } catch {
        socket = false;
      }
      const app = socket ? await call('client.apps.rotateToken', { app: appId, kind: 'app' }) : null;
      onCreated(appId, { bot_token: bot.token, app_token: app?.token, signing_secret: created.credentials?.signing_secret });
      setText('');
    } catch (error) {
      const found = problemsOf(error);
      if (found.length) setProblems(found);
      else toast(errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="manifest-create">
      <summary>{S.apps.manifestCreate}</summary>
      <p className="field-hint">{S.apps.manifestHint}</p>
      <Field label={S.apps.manifestCreate}>
        <textarea className="manifest-text" rows={10} spellCheck={false} value={text} placeholder='{ "display_information": { "name": "…" } }' onChange={(event) => setText(event.target.value)} />
      </Field>
      <Problems items={problems} />
      <Button variant="primary" busy={busy} disabled={!text.trim()} onClick={() => void create()}>
        {S.apps.manifestCreateGo}
      </Button>
    </details>
  );
}

/** The app as a manifest, to copy or edit and apply (`apps.manifest.export` / `apps.manifest.update`). */
export function ManifestEditor({ appId, onChanged }: { appId: string; onChanged: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [problems, setProblems] = useState<ManifestProblem[]>([]);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = async (): Promise<void> => {
    const result = await attempt(() => call('apps.manifest.export', { app_id: appId }));
    if (result) setText(JSON.stringify(result.manifest, null, 2));
  };
  const apply = async (): Promise<void> => {
    if (text === null) return;
    setBusy(true);
    setProblems([]);
    try {
      await call('apps.manifest.update', { app_id: appId, manifest: text });
      const exported = await call('apps.manifest.export', { app_id: appId });
      const requested = (JSON.parse(text) as Json).settings?.event_subscriptions?.request_url;
      const apps = await call('client.apps.list');
      const live = (apps.apps as Json[]).find((app) => app.id === appId);
      setPending(Boolean(requested) && live?.events_url !== requested);
      setText(JSON.stringify(exported.manifest, null, 2));
      toast(S.apps.manifestApplied);
      onChanged();
    } catch (error) {
      const found = problemsOf(error);
      if (found.length) setProblems(found);
      else toast(errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="manifest-editor"
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open && text === null) void load();
      }}
    >
      <summary>{S.apps.manifestExport}</summary>
      <p className="field-hint">{S.apps.manifestExportHint}</p>
      {text !== null ? (
        <>
          <textarea className="manifest-text" rows={14} spellCheck={false} aria-label={S.apps.manifestExport} value={text} onChange={(event) => setText(event.target.value)} />
          <Problems items={problems} />
          {pending ? <p className="notice">{S.apps.manifestPending}</p> : null}
          <div className="row-actions">
            <Button busy={busy} onClick={() => void apply()}>
              {S.apps.manifestApply}
            </Button>
            <Button onClick={() => void navigator.clipboard.writeText(text).then(() => toast(S.copied))}>{S.copy}</Button>
          </div>
        </>
      ) : null}
    </details>
  );
}

/** Make an app configuration token for tools that use `apps.manifest.*` (shown once). */
export function ConfigTokenSetting() {
  const [made, setMade] = useState<{ token: string; refresh_token: string } | null>(null);
  return (
    <section className="config-token">
      <h3 className="dialog-sub">{S.apps.configToken}</h3>
      <p className="field-hint">{S.apps.configTokenHint}</p>
      {made ? (
        <>
          <CopyField label={S.apps.configToken} value={made.token} />
          <CopyField label={S.apps.refreshToken} value={made.refresh_token} />
        </>
      ) : (
        <Button
          onClick={() =>
            void attempt(() => call('client.apps.configToken')).then((result) => {
              if (result) setMade({ token: String(result.token), refresh_token: String(result.refresh_token) });
            })
          }
        >
          {S.apps.configTokenGo}
        </Button>
      )}
    </section>
  );
}
