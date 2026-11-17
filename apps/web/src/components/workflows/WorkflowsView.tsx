import { ArrowLeft, Menu, Play, Workflow as WorkflowIcon } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { defaultConversation, errorText, go, toast } from '../../lib/actions';
import { ApiError, call, type Json } from '../../lib/api';
import { displayName, set, useStore } from '../../lib/store';
import {
  localZone,
  PERSON_TRIGGERS,
  triggerVariables,
  type Run,
  type ScheduleSpec,
  type Step,
  type StepTypes,
  type Trigger,
  type TriggerType,
  type Workflow,
} from '../../lib/workflows';
import { S } from '../../strings';
import { confirmDialog } from '../dialogs/confirm';
import { Button, CopyField, Field, IconButton, Spinner } from '../ui';
import { ChannelSelect, StepList, type BuilderContext } from './StepEditor';
import '../../styles/workflows.css';

const REFRESH_MS = 3000;

function when(seconds: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(seconds * 1000));
}

function problemText(error: unknown): string {
  if (error instanceof ApiError) {
    if (Array.isArray(error.data.problems) && error.data.problems.length) return (error.data.problems as string[]).join(' ');
    if (typeof error.data.detail === 'string') return `${errorText(error)} (${error.data.detail})`;
  }
  return errorText(error);
}

function ViewHead({ title, back }: { title: ReactNode; back?: () => void }) {
  return (
    <header className="conv-head">
      <IconButton className="only-narrow" label={S.sidebar.openSidebar} onClick={() => set({ drawer: true })}>
        <Menu size={19} />
      </IconButton>
      {back ? (
        <IconButton label={S.wf.back} onClick={back}>
          <ArrowLeft size={18} />
        </IconButton>
      ) : null}
      <span className="conv-title">
        <WorkflowIcon size={18} />
        <span className="conv-name">{title}</span>
      </span>
    </header>
  );
}

function StatusBadge({ status }: { status: Workflow['status'] }) {
  return <span className={`wf-badge is-${status}`}>{S.wf.status[status]}</span>;
}

// ── The list ────────────────────────────────────────────────────────────────

function WorkflowList() {
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  useEffect(() => {
    call('client.workflows.list')
      .then((result: Json) => setWorkflows(result.workflows))
      .catch(() => setWorkflows([]));
  }, []);
  return (
    <section className="conversation wf-view">
      <ViewHead title={S.wf.title} />
      <div className="wf-scroll">
        <div className="wf-intro">
          <p>{S.wf.intro}</p>
          <Button variant="primary" onClick={() => go({ name: 'workflows', id: 'new' })}>
            {S.wf.newWorkflow}
          </Button>
        </div>
        {workflows === null ? <Spinner /> : null}
        {workflows?.length === 0 ? <p className="muted">{S.wf.none}</p> : null}
        <ul className="wf-list">
          {workflows?.map((workflow) => (
            <li key={workflow.id}>
              <button type="button" className="wf-card" onClick={() => go({ name: 'workflows', id: workflow.id })}>
                <span className="wf-card-head">
                  <strong>{workflow.name}</strong>
                  <StatusBadge status={workflow.status} />
                </span>
                <span className="wf-card-trigger">{S.wf.triggers[workflow.trigger.type]}</span>
                <span className="muted">
                  {S.wf.by(workflow.created_by_name)}
                  {workflow.last_run ? ` · ${S.wf.lastRun(S.wf.runStatus[workflow.last_run.status] ?? '', when(workflow.last_run.started))}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ── The trigger ─────────────────────────────────────────────────────────────

function defaultTrigger(type: TriggerType, channel: string | undefined): Trigger {
  switch (type) {
    case 'reaction':
      return { type, channel: channel ?? '', reaction: 'eyes' };
    case 'member_joined':
      return { type, channel: channel ?? '' };
    case 'schedule':
      return { type, schedule: { frequency: 'daily', time: '09:00', tz: localZone() } };
    case 'webhook':
      return { type, variables: [] };
    default:
      return { type };
  }
}

function ScheduleEditor({ spec, onChange }: { spec: ScheduleSpec; onChange: (next: ScheduleSpec) => void }) {
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [spec.tz];
    } catch {
      return [spec.tz];
    }
  }, [spec.tz]);
  const setFrequency = (frequency: ScheduleSpec['frequency']): void => {
    const next: ScheduleSpec = { frequency, time: spec.time, tz: spec.tz };
    if (frequency === 'once') next.date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    if (frequency === 'weekly') next.weekdays = [1];
    if (frequency === 'monthly') next.day = 1;
    onChange(next);
  };
  return (
    <div className="wf-row wf-schedule">
      <Field label={S.wf.frequency}>
        <select value={spec.frequency} onChange={(event) => setFrequency(event.target.value as ScheduleSpec['frequency'])}>
          {(['once', 'daily', 'weekly', 'monthly'] as const).map((frequency) => (
            <option key={frequency} value={frequency}>
              {S.wf.frequencies[frequency]}
            </option>
          ))}
        </select>
      </Field>
      {spec.frequency === 'once' ? (
        <Field label={S.wf.date}>
          <input type="date" value={spec.date ?? ''} onChange={(event) => onChange({ ...spec, date: event.target.value })} />
        </Field>
      ) : null}
      {spec.frequency === 'monthly' ? (
        <Field label={S.wf.dayOfMonth}>
          <input type="number" min={1} max={31} value={spec.day ?? 1} onChange={(event) => onChange({ ...spec, day: Number(event.target.value) })} />
        </Field>
      ) : null}
      <Field label={S.wf.time}>
        <input type="time" value={spec.time} onChange={(event) => onChange({ ...spec, time: event.target.value })} />
      </Field>
      <Field label={S.wf.zone}>
        <select value={spec.tz} onChange={(event) => onChange({ ...spec, tz: event.target.value })}>
          {[...new Set([spec.tz, ...zones])].map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </Field>
      {spec.frequency === 'weekly' ? (
        <fieldset className="wf-weekdays">
          <legend className="field-label">{S.wf.weekdays}</legend>
          {S.wf.weekdayNames.map((name, day) => (
            <label key={name} className={spec.weekdays?.includes(day) ? 'is-on' : ''}>
              <input
                type="checkbox"
                checked={spec.weekdays?.includes(day) ?? false}
                onChange={(event) => {
                  const days = new Set(spec.weekdays ?? []);
                  if (event.target.checked) days.add(day);
                  else days.delete(day);
                  onChange({ ...spec, weekdays: [...days].sort() });
                }}
              />
              {name}
            </label>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}

function TriggerEditor({ trigger, onChange, ctx, saved }: { trigger: Trigger; onChange: (next: Trigger) => void; ctx: BuilderContext; saved: Workflow | null }) {
  const firstChannel = ctx.channels.find((conv) => conv.is_channel || conv.is_group)?.id;
  const savedSame = saved && saved.trigger.type === trigger.type;
  return (
    <div className="wf-trigger">
      <Field label={S.wf.event} hint={S.wf.triggerHint[trigger.type]}>
        <select aria-label={S.wf.trigger} value={trigger.type} onChange={(event) => onChange(defaultTrigger(event.target.value as TriggerType, firstChannel))}>
          {(['shortcut', 'link', 'reaction', 'member_joined', 'schedule', 'webhook'] as const).map((type) => (
            <option key={type} value={type}>
              {S.wf.triggers[type]}
            </option>
          ))}
        </select>
      </Field>
      {trigger.type === 'reaction' || trigger.type === 'member_joined' ? (
        <div className="wf-row">
          <ChannelSelect
            label={S.wf.channel}
            value={trigger.channel ?? ''}
            channels={ctx.channels.filter((conv) => conv.is_channel || conv.is_group)}
            onChange={(channel) => onChange({ ...trigger, channel })}
          />
          {trigger.type === 'reaction' ? (
            <Field label={S.wf.emoji}>
              <input value={trigger.reaction ?? ''} placeholder="eyes" onChange={(event) => onChange({ ...trigger, reaction: event.target.value.replace(/[:\s]/g, '') })} />
            </Field>
          ) : null}
        </div>
      ) : null}
      {trigger.type === 'schedule' && trigger.schedule ? <ScheduleEditor spec={trigger.schedule} onChange={(schedule) => onChange({ ...trigger, schedule })} /> : null}
      {trigger.type === 'webhook' ? (
        <Field label={S.wf.webhookVars} hint={S.wf.webhookVarsHint}>
          <input
            defaultValue={(trigger.variables ?? []).join(', ')}
            onBlur={(event) =>
              onChange({
                ...trigger,
                variables: event.target.value
                  .split(',')
                  .map((name) => name.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
      ) : null}
      {trigger.type === 'link' ? savedSame && saved.link_url ? <CopyField label={S.wf.linkUrl} value={saved.link_url} /> : <p className="muted">{S.wf.saveForUrl}</p> : null}
      {trigger.type === 'webhook' ? savedSame && saved.webhook_url ? <CopyField label={S.wf.webhookUrl} value={saved.webhook_url} /> : <p className="muted">{S.wf.saveForUrl}</p> : null}
      {trigger.type === 'schedule' && saved?.next_run && saved.status === 'published' ? <p className="muted">{S.wf.nextRun(when(saved.next_run))}</p> : null}
    </div>
  );
}

// ── Run history ─────────────────────────────────────────────────────────────

function RunHistory({ runs }: { runs: Run[] | null }) {
  const users = useStore((state) => state.users);
  return (
    <section className="wf-runs" aria-label={S.wf.runs}>
      <h3>{S.wf.runs}</h3>
      {runs === null ? <Spinner /> : null}
      {runs?.length === 0 ? <p className="muted">{S.wf.noRuns}</p> : null}
      <ul>
        {runs?.map((run) => (
          <li key={run.id} className={`wf-run is-${run.status}`}>
            <details>
              <summary>
                <span className={`wf-run-status is-${run.status}`}>{S.wf.runStatus[run.status]}</span>
                <span className="wf-run-when">{when(run.started)}</span>
                <span className="muted">{run.runner ? S.wf.runBy(displayName(users[run.runner])) : S.wf.runBySystem}</span>
              </summary>
              {run.error ? <p className="wf-run-error">{run.error}</p> : null}
              <ol className="wf-run-log">
                {run.log.map((entry, index) => (
                  <li key={index} className={entry.ok ? '' : 'is-bad'}>
                    <code>{entry.step}</code> {S.wf.stepTypes[entry.type] ?? entry.type}
                    {entry.detail ? <span className="muted"> — {entry.detail}</span> : null}
                  </li>
                ))}
              </ol>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── The builder ─────────────────────────────────────────────────────────────

interface Draft {
  name: string;
  description: string;
  trigger: Trigger;
  steps: Step[];
}

function Builder({ id }: { id: string }) {
  const channelMap = useStore((state) => state.channels);
  const userMap = useStore((state) => state.users);
  const isNew = id === 'new';
  const [saved, setSaved] = useState<Workflow | null>(null);
  const [draft, setDraft] = useState<Draft | null>(isNew ? { name: '', description: '', trigger: { type: 'shortcut' }, steps: [] } : null);
  const [dirty, setDirty] = useState(isNew);
  const [types, setTypes] = useState<StepTypes | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(isNew ? [] : null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    call('client.workflows.stepTypes')
      .then((result: Json) => setTypes(result))
      .catch(() => setTypes({ apps: [], lists_available: false }));
    if (isNew) return;
    call('client.workflows.get', { workflow: id })
      .then((result: Json) => {
        const workflow = result.workflow as Workflow;
        setSaved(workflow);
        setDraft({ name: workflow.name, description: workflow.description, trigger: workflow.trigger, steps: workflow.steps ?? [] });
      })
      .catch((error) => {
        toast(errorText(error), 'error');
        go({ name: 'workflows' }, true);
      });
  }, [id, isNew]);

  // Run history, refreshed while the page is visible.
  useEffect(() => {
    if (isNew) return;
    let alive = true;
    const load = (): void => {
      call('client.workflows.runs', { workflow: id })
        .then((result: Json) => {
          if (alive) setRuns(result.runs);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [id, isNew]);

  const channels = useMemo(
    () =>
      Object.values(channelMap)
        .filter((conv) => (conv.is_channel || conv.is_group) && !conv.is_archived && !conv.is_im && !conv.is_mpim)
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
    [channelMap],
  );
  const people = useMemo(
    () =>
      Object.values(userMap)
        .filter((user) => !user.is_bot && !user.deleted && user.id !== 'USLACKBOT')
        .sort((a, b) => displayName(a).localeCompare(displayName(b))),
    [userMap],
  );

  if (!draft) {
    return (
      <section className="conversation wf-view">
        <ViewHead title={S.wf.title} back={() => go({ name: 'workflows' })} />
        <Spinner />
      </section>
    );
  }

  const change = (patch: Partial<Draft>): void => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
    setProblem(null);
  };
  const ctx: BuilderContext = { trigger: draft.trigger, root: draft.steps, types, channels, people };

  /** Save the draft; a new workflow moves to its own address unless `stay` (publishing moves it afterwards). */
  const save = async (stay = false): Promise<Workflow | null> => {
    try {
      const result = await call('client.workflows.save', {
        ...(saved ? { workflow: saved.id } : {}),
        name: draft.name.trim() || S.wf.untitled,
        description: draft.description,
        trigger: draft.trigger,
        steps: draft.steps,
      });
      const workflow = result.workflow as Workflow;
      setSaved(workflow);
      setDirty(false);
      setProblem(null);
      if (isNew && !stay) go({ name: 'workflows', id: workflow.id }, true);
      return workflow;
    } catch (error) {
      setProblem(problemText(error));
      return null;
    }
  };

  const publish = async (on: boolean): Promise<void> => {
    setBusy(true);
    try {
      const current = dirty || !saved ? await save(true) : saved;
      if (!current) return;
      const result = await call('client.workflows.publish', { workflow: current.id, published: on });
      setSaved(result.workflow);
      toast(on ? S.wf.publishedToast : S.wf.offToast);
      if (isNew) go({ name: 'workflows', id: current.id }, true);
    } catch (error) {
      setProblem(problemText(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!saved || !(await confirmDialog(S.wf.removeConfirm(saved.name), S.wf.deleteLabel))) return;
    try {
      await call('client.workflows.delete', { workflow: saved.id });
      go({ name: 'workflows' }, true);
    } catch (error) {
      toast(errorText(error), 'error');
    }
  };

  const status = saved?.status ?? 'draft';
  const formWithoutPerson = !PERSON_TRIGGERS.includes(draft.trigger.type) && JSON.stringify(draft.steps).includes('"type":"form"');

  return (
    <section className="conversation wf-view">
      <ViewHead title={draft.name || S.wf.untitled} back={() => go({ name: 'workflows' })} />
      <div className="wf-scroll">
        <div className="wf-builder">
          <div className="wf-meta">
            <div className="wf-row">
              <Field label={S.wf.name}>
                <input value={draft.name} maxLength={80} placeholder={S.wf.untitled} onChange={(event) => change({ name: event.target.value })} />
              </Field>
              <span className="wf-meta-status">
                <StatusBadge status={status} />
              </span>
            </div>
            <Field label={`${S.wf.description} (${S.optional})`}>
              <input value={draft.description} maxLength={300} onChange={(event) => change({ description: event.target.value })} />
            </Field>
          </div>

          <section className="wf-section">
            <h3>{S.wf.trigger}</h3>
            <TriggerEditor trigger={draft.trigger} saved={dirty ? null : saved} ctx={ctx} onChange={(trigger) => change({ trigger })} />
          </section>

          <section className="wf-section">
            <h3>{S.wf.steps}</h3>
            <StepList steps={draft.steps} before={triggerVariables(draft.trigger, S.wf.variables)} ctx={ctx} onChange={(steps) => change({ steps })} />
          </section>

          {problem || formWithoutPerson ? (
            <div className="wf-problems" role="alert">
              <strong>{S.wf.problems}</strong>
              <p>{problem ?? S.errors.cannot_publish}</p>
            </div>
          ) : null}

          <div className="wf-actions">
            {saved ? (
              <Button variant="danger" onClick={() => void remove()}>
                {S.wf.remove}
              </Button>
            ) : null}
            <span className="spacer" />
            <Button disabled={!dirty || busy} onClick={() => void save().then((workflow) => workflow && toast(S.wf.saved))}>
              {saved ? S.wf.saveChanges : S.wf.save}
            </Button>
            {status === 'published' ? (
              <Button busy={busy} onClick={() => void publish(false)}>
                {S.wf.turnOff}
              </Button>
            ) : null}
            {status !== 'published' || dirty ? (
              <Button variant="primary" busy={busy} onClick={() => void publish(true)}>
                {status === 'disabled' && !dirty ? S.wf.turnOn : S.wf.publish}
              </Button>
            ) : null}
          </div>
        </div>
        {saved ? <RunHistory runs={runs} /> : null}
      </div>
    </section>
  );
}

export function WorkflowsView({ id }: { id?: string }) {
  return id ? <Builder id={id} /> : <WorkflowList />;
}

// ── Starting from a link ────────────────────────────────────────────────────

export function WorkflowLinkView({ token }: { token: string }) {
  const [info, setInfo] = useState<{ id: string; name: string; description: string } | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call('client.workflows.linkInfo', { link: token })
      .then((result: Json) => setInfo(result.workflow))
      .catch(() => setInfo(null));
  }, [token]);
  const start = async (): Promise<void> => {
    setBusy(true);
    const channel = defaultConversation();
    try {
      await call('client.workflows.startByLink', { link: token, ...(channel ? { channel } : {}) });
      toast(S.wf.linkStarted);
      if (channel) go({ name: 'conversation', id: channel }, true);
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="conversation wf-view">
      <ViewHead title={S.wf.linkTitle} />
      <div className="wf-scroll">
        {info === undefined ? <Spinner /> : null}
        {info === null ? <p className="muted">{S.wf.linkMissing}</p> : null}
        {info ? (
          <div className="wf-link-card">
            <WorkflowIcon size={28} />
            <h2>{info.name}</h2>
            {info.description ? <p>{info.description}</p> : null}
            <Button variant="primary" busy={busy} onClick={() => void start()}>
              <Play size={15} /> {S.wf.linkStart}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
