import { useEffect, useState } from 'react';
import { attempt, toast } from '../../lib/actions';
import { call } from '../../lib/api';
import { useStore } from '../../lib/store';
import { S } from '../../strings';
import { confirmDialog } from '../dialogs/confirm';
import { Button, Field, Spinner } from '../ui';

// ── IP allowlist ────────────────────────────────────────────────────────────

export function IpAllowlistSetting() {
  const self = useStore((state) => state.self);
  const [state, setState] = useState<{ cidrs: string[]; applies_to_tokens: boolean; your_address: string; disabled_by_server: boolean } | null>(null);
  const [text, setText] = useState('');
  const [tokens, setTokens] = useState(false);
  const owner = Boolean(self?.is_owner);
  useEffect(() => {
    call('client.admin.ipAllowlist')
      .then((result) => {
        setState(result as never);
        setText((result.cidrs as string[]).join('\n'));
        setTokens(Boolean(result.applies_to_tokens));
      })
      .catch(() => undefined);
  }, []);
  if (!state) return <Spinner />;
  const cidrs = text.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
  const save = async (): Promise<void> => {
    if (cidrs.length && !(await confirmDialog(S.network.confirm(cidrs.length), S.save))) return;
    const result = await attempt(() => call('client.admin.setIpAllowlist', { cidrs, applies_to_tokens: tokens }));
    if (result) {
      setState({ ...state, cidrs: result.cidrs as string[], applies_to_tokens: Boolean(result.applies_to_tokens) });
      toast(S.saved);
    }
  };
  return (
    <section className="compliance-section">
      <h3 className="dialog-sub">{S.network.title}</h3>
      <p className="field-hint">{S.network.hint}</p>
      {state.disabled_by_server ? <p className="notice">{S.network.disabled}</p> : null}
      <p className="muted">{S.network.yourAddress(state.your_address)}</p>
      <Field label={S.network.ranges} hint={S.network.rangesHint}>
        <textarea rows={4} spellCheck={false} value={text} placeholder={'203.0.113.0/24\n2001:db8::/32'} disabled={!owner} onChange={(event) => setText(event.target.value)} />
      </Field>
      <label className="check-row">
        <input type="checkbox" checked={tokens} disabled={!owner} onChange={(event) => setTokens(event.target.checked)} />
        <span>{S.network.tokens}</span>
      </label>
      {owner ? (
        <Button variant="primary" onClick={() => void save()}>
          {S.save}
        </Button>
      ) : (
        <p className="muted">{S.network.ownersOnly}</p>
      )}
    </section>
  );
}

// ── Information barriers ───────────────────────────────────────────────────

interface Barrier {
  id: string;
  primary_usergroup: { id: string; name: string };
  barriered_from_usergroups: { id: string; name: string }[];
  restricted_subjects: string[];
}

export function BarriersSetting() {
  const [barriers, setBarriers] = useState<Barrier[] | null>(null);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [primary, setPrimary] = useState('');
  const [others, setOthers] = useState<string[]>([]);
  const load = (): void => {
    call('admin.barriers.list')
      .then((result) => setBarriers(result.barriers as Barrier[]))
      .catch(() => setBarriers([]));
    call('usergroups.list')
      .then((result) => setGroups((result.usergroups as { id: string; name: string }[]).map(({ id, name }) => ({ id, name }))))
      .catch(() => setGroups([]));
  };
  useEffect(load, []);
  if (barriers === null) return <Spinner />;
  return (
    <section className="compliance-section">
      <h3 className="dialog-sub">{S.network.barriersTitle}</h3>
      <p className="field-hint">{S.network.barriersHint}</p>
      {barriers.length ? (
        <ul className="admin-list">
          {barriers.map((barrier) => (
            <li key={barrier.id}>
              <span className="admin-meta">
                <span className="admin-name">{S.network.apart(barrier.primary_usergroup.name, barrier.barriered_from_usergroups.map((group) => group.name).join(', '))}</span>
              </span>
              <Button
                size="sm"
                onClick={() =>
                  void attempt(() => call('admin.barriers.delete', { barrier_id: barrier.id })).then((done) => {
                    if (done) load();
                  })
                }
              >
                {S.remove}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {groups.length >= 2 ? (
        <div className="inline-form">
          <Field label={S.network.group}>
            <select value={primary} onChange={(event) => setPrimary(event.target.value)}>
              <option value="">—</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={S.network.from}>
            <select multiple size={Math.min(4, groups.length)} value={others} onChange={(event) => setOthers([...event.target.selectedOptions].map((option) => option.value))}>
              {groups
                .filter((group) => group.id !== primary)
                .map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
            </select>
          </Field>
          <Button
            disabled={!primary || others.length === 0}
            onClick={() =>
              void attempt(() => call('admin.barriers.create', { primary_usergroup_id: primary, barriered_from_usergroup_ids: others.join(','), restricted_subjects: 'im,mpim,call' })).then((done) => {
                if (!done) return;
                setPrimary('');
                setOthers([]);
                load();
              })
            }
          >
            {S.network.addBarrier}
          </Button>
        </div>
      ) : (
        <p className="muted">{S.network.needGroups}</p>
      )}
    </section>
  );
}

// ── Huddle transcripts ──────────────────────────────────────────────────────

export function HuddleTranscriptsSetting() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    call('client.huddles.info')
      .then((result) => setEnabled(result.transcripts !== false))
      .catch(() => setEnabled(null));
  }, []);
  if (enabled === null) return null;
  return (
    <section className="compliance-section">
      <h3 className="dialog-sub">{S.network.transcriptsTitle}</h3>
      <label className="check-row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            const next = event.target.checked;
            void attempt(() => call('client.admin.setHuddleTranscripts', { enabled: next })).then((result) => {
              if (result) {
                setEnabled(next);
                toast(S.saved);
              }
            });
          }}
        />
        <span>{S.network.transcripts}</span>
      </label>
      <p className="field-hint">{S.network.transcriptsHint}</p>
    </section>
  );
}
