import { useEffect, useState } from 'react';
import { attempt, toast } from '../../lib/actions';
import { call } from '../../lib/api';
import { displayName, useStore } from '../../lib/store';
import { S } from '../../strings';
import { confirmDialog } from '../dialogs/confirm';
import { Button, Field, Spinner } from '../ui';

// ── Sensitive information ───────────────────────────────────────────────────

interface Detector {
  id: string;
  name: string;
  enabled: boolean;
}

interface Rule {
  name: string;
  pattern: string;
}

export function SensitiveInfoSetting() {
  const [detectors, setDetectors] = useState<Detector[] | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [draft, setDraft] = useState<Rule>({ name: '', pattern: '' });
  const [sample, setSample] = useState('');
  const [result, setResult] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call('client.admin.dlp.get')
      .then((policy) => {
        setDetectors(policy.detectors as Detector[]);
        setRules(policy.custom as Rule[]);
      })
      .catch(() => setDetectors([]));
  }, []);
  if (detectors === null) return <Spinner />;
  const policy = { detectors: detectors.filter((detector) => detector.enabled).map((detector) => detector.id), custom: rules };

  const save = async (next = policy): Promise<void> => {
    setBusy(true);
    const saved = await attempt(() => call('client.admin.dlp.set', { detectors: next.detectors, custom: next.custom }));
    setBusy(false);
    if (saved) toast(S.saved);
  };

  return (
    <section className="compliance-section">
      <h3 className="dialog-sub">{S.compliance.sensitiveTitle}</h3>
      <p className="field-hint">{S.compliance.sensitiveHint}</p>
      {detectors.map((detector) => (
        <label key={detector.id} className="check-row">
          <input
            type="checkbox"
            checked={detector.enabled}
            onChange={(event) => setDetectors(detectors.map((entry) => (entry.id === detector.id ? { ...entry, enabled: event.target.checked } : entry)))}
          />
          <span>{S.compliance.detectors[detector.id] ?? detector.name}</span>
        </label>
      ))}
      <h4 className="compliance-sub">{S.compliance.customTitle}</h4>
      {rules.length ? (
        <ul className="admin-list">
          {rules.map((rule) => (
            <li key={rule.name}>
              <span className="admin-meta">
                <span className="admin-name">{rule.name}</span>
                <code className="muted">{rule.pattern}</code>
              </span>
              <Button size="sm" onClick={() => setRules(rules.filter((entry) => entry !== rule))}>
                {S.remove}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="inline-form">
        <Field label={S.compliance.ruleName}>
          <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </Field>
        <Field label={S.compliance.rulePattern}>
          <input value={draft.pattern} placeholder="\\bproject-x\\b" spellCheck={false} onChange={(event) => setDraft({ ...draft, pattern: event.target.value })} />
        </Field>
        <Button
          disabled={!draft.name.trim() || !draft.pattern}
          onClick={() => {
            setRules([...rules, { name: draft.name.trim(), pattern: draft.pattern }]);
            setDraft({ name: '', pattern: '' });
          }}
        >
          {S.compliance.addRule}
        </Button>
      </div>
      <Field label={S.compliance.tryLabel}>
        <textarea rows={2} value={sample} onChange={(event) => setSample(event.target.value)} />
      </Field>
      <div className="row-actions">
        <Button
          disabled={!sample.trim()}
          onClick={() =>
            void attempt(() => call('client.admin.dlp.test', { text: sample, policy })).then((tested) => {
              if (tested) setResult(tested.matches as string[]);
            })
          }
        >
          {S.compliance.tryGo}
        </Button>
        <Button variant="primary" busy={busy} onClick={() => void save()}>
          {S.save}
        </Button>
      </div>
      {result ? <p className={result.length ? 'notice' : 'muted'}>{result.length ? S.compliance.wouldBlock(result.join(', ')) : S.compliance.wouldPass}</p> : null}
    </section>
  );
}

// ── Legal hold ──────────────────────────────────────────────────────────────

interface Hold {
  id: string;
  name: string;
  created: number;
  released: number | null;
  is_active: boolean;
  users: string[];
  conversations: string[];
}

const day = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export function LegalHolds() {
  const self = useStore((state) => state.self);
  const users = useStore((state) => state.users);
  const channels = useStore((state) => state.channels);
  const [holds, setHolds] = useState<Hold[] | null>(null);
  const [name, setName] = useState('');
  const [people, setPeople] = useState<string[]>([]);
  const [convs, setConvs] = useState<string[]>([]);
  const owner = Boolean(self?.is_owner);

  const load = (): void => {
    call('client.admin.holds.list')
      .then((result) => setHolds(result.holds as Hold[]))
      .catch(() => setHolds([]));
  };
  useEffect(() => {
    if (owner) load();
  }, [owner]);
  if (!owner) return <p className="muted">{S.compliance.ownersOnly}</p>;
  if (holds === null) return <Spinner />;

  const humans = Object.values(users).filter((user) => !user.is_bot && !user.deleted);
  const channelList = Object.values(channels).filter((channel) => channel.is_channel);
  const exportUrl = (hold: Hold): string => `/admin/discovery.zip?${new URLSearchParams({ users: hold.users.join(','), channels: hold.conversations.join(',') })}`;

  return (
    <section className="compliance-section">
      <h3 className="dialog-sub">{S.compliance.holdsTitle}</h3>
      <p className="field-hint">{S.compliance.holdsHint}</p>
      {holds.length ? (
        <ul className="admin-list">
          {holds.map((hold) => (
            <li key={hold.id}>
              <span className="admin-meta">
                <span className="admin-name">
                  {hold.name} {hold.is_active ? <span className="tag">{S.compliance.active}</span> : null}
                </span>
                <span className="muted">
                  {S.compliance.covers(hold.users.length, hold.conversations.length)} · {day.format(new Date(hold.created * 1000))}
                  {hold.released ? ` – ${day.format(new Date(hold.released * 1000))}` : ''}
                </span>
              </span>
              <a className="btn btn-sm" href={exportUrl(hold)} download>
                {S.compliance.export}
              </a>
              {hold.is_active ? (
                <Button
                  size="sm"
                  onClick={() =>
                    void confirmDialog(S.compliance.confirmRelease(hold.name), S.compliance.release).then(async (ok) => {
                      if (ok && (await attempt(() => call('client.admin.holds.release', { hold: hold.id })))) load();
                    })
                  }
                >
                  {S.compliance.release}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{S.compliance.noHolds}</p>
      )}
      <h4 className="compliance-sub">{S.compliance.newHold}</h4>
      <Field label={S.compliance.holdName}>
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label={S.compliance.holdPeople}>
        <select multiple size={Math.min(6, humans.length)} value={people} onChange={(event) => setPeople([...event.target.selectedOptions].map((option) => option.value))}>
          {humans.map((user) => (
            <option key={user.id} value={user.id}>
              {displayName(user)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={S.compliance.holdChannels}>
        <select multiple size={Math.min(6, channelList.length)} value={convs} onChange={(event) => setConvs([...event.target.selectedOptions].map((option) => option.value))}>
          {channelList.map((channel) => (
            <option key={channel.id} value={channel.id}>
              #{channel.name}
            </option>
          ))}
        </select>
      </Field>
      <Button
        variant="primary"
        disabled={!name.trim() || (people.length === 0 && convs.length === 0)}
        onClick={() =>
          void attempt(() => call('client.admin.holds.create', { name: name.trim(), users: people, channels: convs })).then((created) => {
            if (!created) return;
            setName('');
            setPeople([]);
            setConvs([]);
            toast(S.compliance.holdCreated);
            load();
          })
        }
      >
        {S.compliance.createHold}
      </Button>
    </section>
  );
}

// ── Sign-in length and signing everyone out ────────────────────────────────

export function SessionPolicy() {
  const self = useStore((state) => state.self);
  const [days, setDays] = useState(30);
  const owner = Boolean(self?.is_owner);
  useEffect(() => {
    call('client.admin.sessionSettings')
      .then((result) => setDays(Number(result.session_duration_days) || 30))
      .catch(() => undefined);
  }, []);
  return (
    <section className="compliance-section">
      <h3 className="dialog-sub">{S.compliance.sessionsTitle}</h3>
      <div className="inline-form">
        <Field label={S.compliance.sessionDays}>
          <input type="number" min={1} max={365} value={days} onChange={(event) => setDays(Number(event.target.value))} />
        </Field>
        <Button
          disabled={days < 1 || days > 365}
          onClick={() =>
            void attempt(() => call('client.admin.setSessionDuration', { days })).then((done) => {
              if (done) toast(S.saved);
            })
          }
        >
          {S.save}
        </Button>
      </div>
      {owner ? (
        <Button
          variant="danger"
          onClick={() =>
            void confirmDialog(S.compliance.confirmResetAll, S.compliance.resetAll).then(async (ok) => {
              if (!ok) return;
              const result = await attempt(() => call('client.admin.sessions.resetAll'));
              if (result) toast(S.compliance.resetDone(Number(result.revoked)));
            })
          }
        >
          {S.compliance.resetAll}
        </Button>
      ) : null}
    </section>
  );
}
