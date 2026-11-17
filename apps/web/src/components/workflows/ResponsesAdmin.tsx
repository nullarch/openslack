import { Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { errorText, toast } from '../../lib/actions';
import { ApiError, call, type Json } from '../../lib/api';
import { useStore } from '../../lib/store';
import { S } from '../../strings';
import { Button, Field, IconButton } from '../ui';
import '../../styles/workflows.css';

interface Rule {
  id: string;
  match_type: 'exact' | 'contains' | 'regex';
  pattern: string;
  reply: string;
  channels: string[];
  enabled: boolean;
}

/** Admin rules that answer matching messages with a canned reply. */
export function ResponsesAdmin() {
  const isAdmin = useStore((state) => Boolean(state.self?.is_admin));
  const channels = useStore((state) => state.channels);
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [matchType, setMatchType] = useState<Rule['match_type']>('contains');
  const [pattern, setPattern] = useState('');
  const [reply, setReply] = useState('');
  const [channel, setChannel] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const choices = useMemo(
    () =>
      Object.values(channels)
        .filter((conv) => (conv.is_channel || conv.is_group) && !conv.is_archived)
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
    [channels],
  );
  const name = (id: string): string => `#${channels[id]?.name ?? id}`;

  const load = (): void => {
    call('client.responses.list')
      .then((result: Json) => setRules(result.responses))
      .catch(() => setRules([]));
  };
  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin]);
  if (!isAdmin) return null;

  const save = async (rule: Partial<Rule> & { match_type: Rule['match_type']; pattern: string; reply: string; channels: string[] }): Promise<boolean> => {
    try {
      await call('client.responses.save', { ...rule });
      setProblem(null);
      load();
      return true;
    } catch (error) {
      const detail = error instanceof ApiError && typeof error.data.detail === 'string' ? error.data.detail : null;
      setProblem(detail ?? errorText(error));
      return false;
    }
  };

  return (
    <fieldset className="pref-group responses-admin">
      <legend>{S.wf.responses.title}</legend>
      <p className="muted">{S.wf.responses.hint}</p>
      {rules?.length === 0 ? <p className="muted">{S.wf.responses.none}</p> : null}
      <ul className="admin-list">
        {rules?.map((rule) => (
          <li key={rule.id} className="response-rule">
            <span className="admin-meta">
              <span className="admin-name">
                {S.wf.responses.matchTypes[rule.match_type]} <code>{rule.pattern}</code>
              </span>
              <span className="muted">
                → {rule.reply} · {rule.channels.length ? rule.channels.map(name).join(', ') : S.wf.responses.allPublic}
              </span>
            </span>
            <label className="check-row response-toggle">
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(event) => void save({ ...rule, enabled: event.target.checked })}
                aria-label={S.wf.responses.enabled}
              />
              {S.wf.responses.enabled}
            </label>
            <IconButton
              label={S.remove}
              onClick={() =>
                void call('client.responses.delete', { id: rule.id })
                  .then(load)
                  .catch((error) => toast(errorText(error), 'error'))
              }
            >
              <Trash2 size={15} />
            </IconButton>
          </li>
        ))}
      </ul>
      <div className="response-form">
        <Field label={S.wf.responses.match}>
          <select value={matchType} onChange={(event) => setMatchType(event.target.value as Rule['match_type'])}>
            {(['contains', 'exact', 'regex'] as const).map((type) => (
              <option key={type} value={type}>
                {S.wf.responses.matchTypes[type]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={S.wf.responses.pattern}>
          <input value={pattern} maxLength={200} onChange={(event) => setPattern(event.target.value)} />
        </Field>
        <Field label={S.wf.responses.reply}>
          <input value={reply} maxLength={2000} onChange={(event) => setReply(event.target.value)} />
        </Field>
        <Field label={S.wf.responses.channels}>
          <select value={channel} onChange={(event) => setChannel(event.target.value)}>
            <option value="">{S.wf.responses.allPublic}</option>
            {choices.map((conv) => (
              <option key={conv.id} value={conv.id}>
                {name(conv.id)}
              </option>
            ))}
          </select>
        </Field>
        {problem ? <p className="field-error">{problem}</p> : null}
        <Button
          disabled={!pattern.trim() || !reply.trim()}
          onClick={() =>
            void save({ match_type: matchType, pattern, reply, channels: channel ? [channel] : [] }).then((ok) => {
              if (!ok) return;
              setPattern('');
              setReply('');
            })
          }
        >
          {S.wf.responses.add}
        </Button>
      </div>
    </fieldset>
  );
}
