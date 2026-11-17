import { useEffect, useState } from 'react';
import { attempt, closeModal, go, toast } from '../../lib/actions';
import { call, type Json } from '../../lib/api';
import { useStore } from '../../lib/store';
import { S } from '../../strings';
import { confirmDialog } from '../dialogs/confirm';
import { Button, CopyField, Field, Spinner } from '../ui';
import { formatDateTime } from '../../lib/time';

const when = { format: (date: Date): string => formatDateTime(date) };

// ── Audit log ───────────────────────────────────────────────────────────────

interface AuditEntry {
  id: string;
  date_create: number;
  action: string;
  actor: { type: string; user?: { id: string | null; name: string | null }; app?: { id: string | null; name: string | null } };
  entity: { type: string; [key: string]: unknown } | null;
  context: { ip_address: string | null; ua: string | null };
}

function actorName(entry: AuditEntry): string {
  if (entry.actor.type === 'app') return entry.actor.app?.name ?? entry.actor.app?.id ?? '—';
  return entry.actor.user?.name ?? entry.actor.user?.id ?? '—';
}

function entityName(entry: AuditEntry): string {
  if (!entry.entity) return '';
  const inner = entry.entity[entry.entity.type] as { id?: string; name?: string | null } | undefined;
  return inner?.name ?? inner?.id ?? '';
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function AuditAdmin() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [cursor, setCursor] = useState('');
  const [action, setAction] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (from = '', filter = action): Promise<void> => {
    setBusy(true);
    const result = await attempt(() => call('client.admin.audit.list', { limit: 100, ...(from ? { cursor: from } : {}), ...(filter ? { action: filter } : {}) }));
    setBusy(false);
    if (!result) return;
    setEntries((current) => [...(from ? (current ?? []) : []), ...(result.entries as AuditEntry[])]);
    setCursor(String(result.response_metadata?.next_cursor ?? ''));
  };
  useEffect(() => {
    void load('', action);
  }, [action]);

  /** Every entry matching the filter, as CSV (paged through the API). */
  const exportCsv = async (): Promise<void> => {
    setBusy(true);
    const all: AuditEntry[] = [];
    let next = '';
    do {
      const result: Json | undefined = await attempt(() => call('client.admin.audit.list', { limit: 1000, ...(next ? { cursor: next } : {}), ...(action ? { action } : {}) }));
      if (!result) break;
      all.push(...(result.entries as AuditEntry[]));
      next = String(result.response_metadata?.next_cursor ?? '');
    } while (next && all.length < 100_000);
    setBusy(false);
    const rows = [['time', 'action', 'actor_type', 'actor', 'entity_type', 'entity', 'ip_address', 'user_agent']];
    for (const entry of all) {
      rows.push([new Date(entry.date_create * 1000).toISOString(), entry.action, entry.actor.type, actorName(entry), entry.entity?.type ?? '', entityName(entry), entry.context.ip_address ?? '', entry.context.ua ?? '']);
    }
    const blob = new Blob([rows.map((row) => row.map(csvCell).join(',')).join('\n')], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className="audit-admin">
      <p className="dialog-lead">{S.audit.intro}</p>
      <div className="audit-tools">
        <Field label={S.audit.filter}>
          <select value={action} onChange={(event) => setAction(event.target.value)}>
            <option value="">{S.audit.allActions}</option>
            {Object.entries(S.audit.actions).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Button busy={busy} onClick={() => void exportCsv()}>
          {S.audit.export}
        </Button>
      </div>
      {entries === null ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <p className="muted">{S.audit.none}</p>
      ) : (
        <table className="viz-table audit-table">
          <thead>
            <tr>
              <th>{S.audit.time}</th>
              <th>{S.audit.who}</th>
              <th>{S.audit.what}</th>
              <th>{S.audit.target}</th>
              <th>{S.audit.from}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{when.format(new Date(entry.date_create * 1000))}</td>
                <td>{actorName(entry)}</td>
                <td>{(S.audit.actions as Record<string, string>)[entry.action] ?? entry.action}</td>
                <td>{entityName(entry)}</td>
                <td title={entry.context.ua ?? ''}>{entry.context.ip_address ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cursor ? (
        <Button busy={busy} onClick={() => void load(cursor)}>
          {S.audit.more}
        </Button>
      ) : null}
    </div>
  );
}

// ── Reports ─────────────────────────────────────────────────────────────────

interface Report {
  id: string;
  channel: string;
  channel_name: string | null;
  ts: string;
  author: string | null;
  reason: string;
  excerpt: string;
  status: 'open' | 'dismissed' | 'removed';
  reports: number;
  created: number;
  message_exists: boolean;
}

export function ReportsAdmin() {
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const [reports, setReports] = useState<Report[] | null>(null);
  const users = useStore((state) => state.users);

  const load = (): void => {
    call('client.admin.reports.list', { status })
      .then((result) => setReports(result.reports as Report[]))
      .catch(() => setReports([]));
  };
  useEffect(load, [status]);

  const resolve = async (report: Report, action: 'dismiss' | 'remove'): Promise<void> => {
    if (action === 'remove' && !(await confirmDialog(S.reports.confirmRemove, S.reports.remove))) return;
    const result = await attempt(() => call('client.admin.reports.resolve', { report: report.id, action }));
    if (result) {
      toast(action === 'remove' ? S.reports.removed : S.reports.dismissed);
      load();
    }
  };

  return (
    <div className="reports-admin">
      <p className="dialog-lead">{S.reports.intro}</p>
      <div className="analytics-range" role="radiogroup" aria-label={S.reports.show}>
        {(['open', 'all'] as const).map((value) => (
          <button key={value} type="button" role="radio" aria-checked={status === value} className={status === value ? 'is-active' : ''} onClick={() => setStatus(value)}>
            {value === 'open' ? S.reports.open : S.reports.all}
          </button>
        ))}
      </div>
      {reports === null ? (
        <Spinner />
      ) : reports.length === 0 ? (
        <p className="muted">{status === 'open' ? S.reports.noneOpen : S.reports.none}</p>
      ) : (
        <ul className="report-list">
          {reports.map((report) => (
            <li key={report.id} className="report-item">
              <div className="report-head">
                <strong>{report.author ? (users[report.author]?.real_name ?? users[report.author]?.name ?? report.author) : '—'}</strong>
                <span className="muted">
                  {report.channel_name ? `#${report.channel_name}` : ''} · {when.format(new Date(report.created * 1000))} · {S.reports.count(report.reports)}
                </span>
              </div>
              <blockquote className="report-excerpt">{report.excerpt || S.reports.noText}</blockquote>
              <p className="muted">{S.reports.reason(report.reason)}</p>
              {report.status === 'open' ? (
                <div className="row-actions">
                  {report.message_exists ? (
                    <Button
                      onClick={() => {
                        closeModal();
                        go({ name: 'conversation', id: report.channel, ts: report.ts });
                      }}
                    >
                      {S.reports.view}
                    </Button>
                  ) : null}
                  <Button onClick={() => void resolve(report, 'dismiss')}>{S.reports.dismiss}</Button>
                  {report.message_exists ? (
                    <Button variant="danger" onClick={() => void resolve(report, 'remove')}>
                      {S.reports.remove}
                    </Button>
                  ) : null}
                </div>
              ) : (
                <p className="muted">{report.status === 'removed' ? S.reports.wasRemoved : S.reports.wasDismissed}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Retention ───────────────────────────────────────────────────────────────

interface Policy {
  messages_days: number;
  dm_days: number | null;
  files_days: number;
}

const CHOICES = [0, 3650, 1825, 1095, 730, 365, 180, 90, 30];

function DaysSelect({ label, value, onChange, followLabel }: { label: string; value: number | null; onChange: (value: number | null) => void; followLabel?: string }) {
  return (
    <Field label={label}>
      <select value={value === null ? 'follow' : String(value)} onChange={(event) => onChange(event.target.value === 'follow' ? null : Number(event.target.value))}>
        {followLabel ? <option value="follow">{followLabel}</option> : null}
        {[...new Set([...CHOICES, ...(value && !CHOICES.includes(value) ? [value] : [])])].map((days) => (
          <option key={days} value={days}>
            {S.retention.keep(days)}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function RetentionSetting() {
  const self = useStore((state) => state.self);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [busy, setBusy] = useState(false);
  const owner = Boolean(self?.is_owner);

  useEffect(() => {
    call('client.admin.retention')
      .then((result) => {
        setPolicy(result.retention as Policy);
        setDraft(result.retention as Policy);
      })
      .catch(() => undefined);
  }, []);
  if (!policy || !draft) return null;

  const save = async (): Promise<void> => {
    const preview = await attempt(() => call('client.admin.retention', { preview: draft }));
    if (!preview) return;
    const doomed = preview.would_delete as { messages: number; files: number };
    if ((doomed.messages || doomed.files) && !(await confirmDialog(S.retention.confirm(doomed.messages, doomed.files), S.retention.apply))) return;
    setBusy(true);
    const result = await attempt(() => call('client.admin.setRetention', { retention: draft }));
    setBusy(false);
    if (result) {
      setPolicy(result.retention as Policy);
      setDraft(result.retention as Policy);
      toast(S.saved);
    }
  };
  const changed = JSON.stringify(policy) !== JSON.stringify(draft);

  return (
    <fieldset className="retention-setting">
      <legend className="dialog-sub">{S.retention.title}</legend>
      <p className="field-hint">{S.retention.hint}</p>
      <DaysSelect label={S.retention.messages} value={draft.messages_days} onChange={(value) => setDraft({ ...draft, messages_days: value ?? 0 })} />
      <DaysSelect label={S.retention.dms} value={draft.dm_days} followLabel={S.retention.sameAsChannels} onChange={(value) => setDraft({ ...draft, dm_days: value })} />
      <DaysSelect label={S.retention.files} value={draft.files_days} onChange={(value) => setDraft({ ...draft, files_days: value ?? 0 })} />
      {owner ? (
        <Button variant="primary" busy={busy} disabled={!changed} onClick={() => void save()}>
          {S.retention.apply}
        </Button>
      ) : (
        <p className="muted">{S.retention.ownersOnly}</p>
      )}
    </fieldset>
  );
}

// ── Tokens for identity providers and log collectors ───────────────────────

export function ServiceTokens() {
  const [made, setMade] = useState<{ kind: 'scim' | 'audit'; token: string; base?: string } | null>(null);
  const make = async (kind: 'scim' | 'audit'): Promise<void> => {
    if (!(await confirmDialog(S.serviceTokens.confirm, S.serviceTokens.create))) return;
    const result = await attempt(() => call(kind === 'scim' ? 'client.admin.scimToken' : 'client.admin.auditToken'));
    if (result) setMade({ kind, token: String(result.token), base: result.base_url ? String(result.base_url) : undefined });
  };
  return (
    <fieldset className="service-tokens">
      <legend className="dialog-sub">{S.serviceTokens.title}</legend>
      <p className="field-hint">{S.serviceTokens.hint}</p>
      <div className="row-actions">
        <Button onClick={() => void make('scim')}>{S.serviceTokens.scim}</Button>
        <Button onClick={() => void make('audit')}>{S.serviceTokens.audit}</Button>
      </div>
      {made ? (
        <div className="service-token-made">
          {made.base ? <CopyField label={S.serviceTokens.scimUrl} value={made.base} /> : null}
          <CopyField label={made.kind === 'scim' ? S.serviceTokens.scim : S.serviceTokens.audit} value={made.token} />
          <p className="field-hint">{S.serviceTokens.once}</p>
        </div>
      ) : null}
    </fieldset>
  );
}
