import { Copy, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from '../../lib/actions';
import { aiErrorText, closeAiModal, closeSheet, loadAiStatus, useAi, type AiFeature } from '../../lib/ai';
import { call, type Json } from '../../lib/api';
import { useStore } from '../../lib/store';
import { S } from '../../strings';
import { Button, Field, IconButton, Modal, Spinner } from '../ui';
import { AiText, CitationList } from './AiControls';
import { formatDateTime } from '../../lib/time';

const FEATURES: AiFeature[] = ['summaries', 'recaps', 'search_answers', 'translate', 'writing'];

/** The floating sheet a summary streams into. Only this viewer sees it. */
function ResultSheet() {
  const sheet = useAi((state) => state.sheet);
  if (!sheet) return null;
  return (
    <section className="ai-sheet" role="dialog" aria-label={sheet.title}>
      <header>
        <Sparkles size={16} />
        <div className="ai-sheet-title">
          <strong>{sheet.title}</strong>
          <span className="ai-private">{S.ai.onlyYou}</span>
        </div>
        {sheet.done && sheet.text ? (
          <IconButton
            label={S.ai.copySummary}
            onClick={() => void navigator.clipboard.writeText(sheet.text).then(() => toast(S.copied))}
          >
            <Copy size={16} />
          </IconButton>
        ) : null}
        <IconButton label={S.close} onClick={closeSheet}>
          <X size={17} />
        </IconButton>
      </header>
      <div className="ai-sheet-body">
        {sheet.error ? <p className="ai-error">{aiErrorText(sheet.error)}</p> : null}
        {!sheet.text && !sheet.done ? <Spinner label={S.ai.working} /> : null}
        {sheet.text ? <AiText result={sheet} /> : null}
        {sheet.done && sheet.citations.length > 0 ? (
          <>
            <h3 className="ai-sources-title">{S.ai.sources}</h3>
            <CitationList result={sheet} />
          </>
        ) : null}
        {sheet.done && sheet.messages ? <p className="ai-note">{S.ai.basedOn(sheet.messages, sheet.leftOut ?? 0)}</p> : null}
      </div>
    </section>
  );
}

// ── Settings (admins) ───────────────────────────────────────────────────────

function SettingsModal() {
  const [loaded, setLoaded] = useState<Json | null>(null);
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<'save' | 'test' | 'off' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const fill = (settings: Json): void => {
    setLoaded(settings);
    setProvider(settings.provider);
    setModel(settings.model ?? '');
    setBaseUrl(settings.base_url ?? '');
    setApiKey('');
    setClearKey(false);
    setFeatures(settings.features ?? {});
  };

  useEffect(() => {
    call('client.ai.settings.get')
      .then((result: Json) => fill(result.settings))
      .catch((caught: Json) => setError(caught?.code === 'not_allowed' ? S.ai.settings.adminOnly : aiErrorText(caught?.code)));
  }, []);

  const save = async (): Promise<void> => {
    setBusy('save');
    setError(null);
    setTestResult(null);
    try {
      const args: Json = { provider, model: model.trim(), base_url: baseUrl.trim(), features };
      if (apiKey.trim()) args.api_key = apiKey.trim();
      if (clearKey) args.clear_key = true;
      const result = await call('client.ai.settings.set', args);
      fill(result.settings);
      await loadAiStatus(true);
      toast(S.ai.settings.saved);
    } catch (caught) {
      setError(aiErrorText((caught as Json)?.code));
    } finally {
      setBusy(null);
    }
  };

  const test = async (): Promise<void> => {
    setBusy('test');
    setError(null);
    setTestResult(null);
    try {
      const result = await call('client.ai.settings.test');
      setTestResult(S.ai.settings.testOk(result.reply, result.latency_ms));
    } catch (caught) {
      const code = (caught as Json)?.code === 'ai_provider_error' ? (caught as Json).data?.detail : (caught as Json)?.code;
      setError(aiErrorText(code));
    } finally {
      setBusy(null);
    }
  };

  const turnOff = async (): Promise<void> => {
    setBusy('off');
    try {
      const result = await call('client.ai.settings.disconnect');
      fill(result.settings);
      await loadAiStatus(true);
      toast(S.ai.settings.disconnected);
    } finally {
      setBusy(null);
    }
  };

  const footer = loaded ? (
    <>
      {loaded.configured ? (
        <Button variant="ghost" busy={busy === 'off'} onClick={() => void turnOff()}>
          {S.ai.settings.disconnect}
        </Button>
      ) : null}
      <span className="spacer" />
      {loaded.configured ? (
        <Button busy={busy === 'test'} onClick={() => void test()}>
          {S.ai.settings.test}
        </Button>
      ) : null}
      <Button variant="primary" busy={busy === 'save'} onClick={() => void save()}>
        {loaded.configured ? S.ai.settings.save : S.ai.settings.connect}
      </Button>
    </>
  ) : null;

  return (
    <Modal title={S.ai.settings.title} onClose={closeAiModal} width={560} footer={footer} className="ai-settings">
      {!loaded && !error ? <Spinner /> : null}
      {loaded ? (
        <>
          <p className="ai-intro">{S.ai.settings.intro}</p>
          <fieldset className="pref-group">
            <legend>{S.ai.settings.provider}</legend>
            <div className="segmented" role="radiogroup">
              {(['anthropic', 'openai_compatible'] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={provider === id}
                  className={provider === id ? 'is-active' : ''}
                  onClick={() => {
                    setProvider(id);
                    if (id !== loaded.provider) setModel(id === 'anthropic' ? 'claude-opus-5-5' : '');
                  }}
                >
                  {id === 'anthropic' ? S.ai.settings.anthropic : S.ai.settings.openai}
                </button>
              ))}
            </div>
            {provider === 'openai_compatible' ? <p className="field-hint">{S.ai.settings.openaiHint}</p> : null}
          </fieldset>
          <Field label={S.ai.settings.model}>
            <input value={model} onChange={(event) => setModel(event.target.value)} placeholder={provider === 'anthropic' ? 'claude-opus-5-5' : 'llama3.1'} />
          </Field>
          <Field
            label={S.ai.settings.baseUrl}
            hint={provider === 'anthropic' ? S.ai.settings.baseUrlHintClaude : S.ai.settings.baseUrlHintOpenai}
          >
            <input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://" />
          </Field>
          <Field
            label={S.ai.settings.apiKey}
            hint={loaded.has_key && provider === loaded.provider ? S.ai.settings.apiKeySaved(loaded.key_hint) : S.ai.settings.apiKeyHint}
          >
            <input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
          </Field>
          {loaded.has_key && provider === loaded.provider ? (
            <label className="check-row">
              <input type="checkbox" checked={clearKey} onChange={(event) => setClearKey(event.target.checked)} />
              <span>{S.ai.settings.clearKey}</span>
            </label>
          ) : null}
          <fieldset className="pref-group">
            <legend>{S.ai.settings.features}</legend>
            {FEATURES.map((feature) => (
              <label key={feature} className="check-row">
                <input
                  type="checkbox"
                  checked={features[feature] !== false}
                  onChange={(event) => setFeatures({ ...features, [feature]: event.target.checked })}
                />
                <span>{S.ai.settings.feature[feature]}</span>
              </label>
            ))}
          </fieldset>
        </>
      ) : null}
      {testResult ? <p className="ai-ok" role="status">{testResult}</p> : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </Modal>
  );
}

// ── Daily recap ─────────────────────────────────────────────────────────────

function RecapModal() {
  const memberships = useStore((state) => state.channels);
  const channels = useMemo(
    () =>
      Object.values(memberships)
        .filter((channel) => channel.is_channel && !channel.is_archived)
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
    [memberships],
  );
  const tz = useStore((state) => state.self?.tz ?? 'UTC');
  const [loaded, setLoaded] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [time, setTime] = useState('09:00');
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [exists, setExists] = useState(false);
  const [busy, setBusy] = useState<'save' | 'send' | 'off' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call('client.ai.recaps.get')
      .then((result: Json) => {
        if (result.recap) {
          setPicked(result.recap.channels);
          setTime(result.recap.time);
          setNextAt(result.recap.next_at);
          setExists(true);
        }
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  const save = async (): Promise<void> => {
    if (picked.length === 0) {
      setError(S.ai.recap.pickOne);
      return;
    }
    setBusy('save');
    setError(null);
    try {
      const result = await call('client.ai.recaps.set', { channels: picked, time, tz });
      setNextAt(result.recap.next_at);
      setExists(true);
      toast(S.saved);
    } catch (caught) {
      setError(aiErrorText((caught as Json)?.code));
    } finally {
      setBusy(null);
    }
  };

  const sendNow = async (): Promise<void> => {
    setBusy('send');
    setError(null);
    try {
      const result = await call('client.ai.recaps.sendNow');
      toast(result.sent ? S.ai.recap.sent : S.ai.recap.nothing);
    } catch (caught) {
      const code = (caught as Json)?.code === 'ai_provider_error' ? (caught as Json).data?.detail : (caught as Json)?.code;
      setError(aiErrorText(code));
    } finally {
      setBusy(null);
    }
  };

  const turnOff = async (): Promise<void> => {
    setBusy('off');
    try {
      await call('client.ai.recaps.delete');
      setExists(false);
      setNextAt(null);
      toast(S.ai.recap.turnedOff);
    } finally {
      setBusy(null);
    }
  };

  const footer = (
    <>
      {exists ? (
        <Button variant="ghost" busy={busy === 'off'} onClick={() => void turnOff()}>
          {S.ai.recap.off}
        </Button>
      ) : null}
      <span className="spacer" />
      {exists ? (
        <Button busy={busy === 'send'} onClick={() => void sendNow()}>
          {S.ai.recap.sendNow}
        </Button>
      ) : null}
      <Button variant="primary" busy={busy === 'save'} onClick={() => void save()}>
        {S.ai.recap.save}
      </Button>
    </>
  );

  return (
    <Modal title={S.ai.recap.title} onClose={closeAiModal} width={480} footer={footer} className="ai-recap">
      <p className="ai-intro">{S.ai.recap.intro}</p>
      {!loaded ? <Spinner /> : null}
      {loaded ? (
        <>
          <Field label={S.ai.recap.time} hint={S.ai.recap.timeHint(tz)}>
            <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
          </Field>
          <fieldset className="pref-group ai-recap-channels">
            <legend>{S.ai.recap.channels}</legend>
            {channels.map((channel) => (
              <label key={channel.id} className="check-row">
                <input
                  type="checkbox"
                  checked={picked.includes(channel.id)}
                  onChange={(event) =>
                    setPicked(event.target.checked ? [...picked, channel.id] : picked.filter((id) => id !== channel.id))
                  }
                />
                <span>#{channel.name}</span>
              </label>
            ))}
          </fieldset>
          {nextAt ? <p className="field-hint">{S.ai.recap.next(formatDateTime(nextAt))}</p> : null}
        </>
      ) : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </Modal>
  );
}

/** Everything AI that floats above the app: the summary sheet and the AI dialogs. */
export function AiLayer() {
  const modal = useAi((state) => state.modal);

  useEffect(() => {
    void loadAiStatus();
  }, []);

  useEffect(() => {
    if (!modal) return;
    // Close our dialog first, before the app's own Escape handling sees the key.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeAiModal();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [modal]);

  return (
    <>
      <ResultSheet />
      {modal === 'settings' ? <SettingsModal /> : null}
      {modal === 'recap' ? <RecapModal /> : null}
    </>
  );
}
