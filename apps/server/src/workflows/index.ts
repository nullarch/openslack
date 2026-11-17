import { timingSafeEqual } from 'node:crypto';
import { readBody, sendJson } from '../api/http.ts';
import type { Kernel } from '../app.ts';
import { Scheduler } from '../attention/scheduler.ts';
import { canSee, getConv } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { newHex, newId, nowSeconds } from '../core/ids.ts';
import { getMessage } from '../core/messages.ts';
import { getUser, isAdmin, uniqueHandle, type UserRow } from '../core/users.ts';
import type { Actor, Ctx } from '../ctx.ts';
import { appConfig, createAppRecord, getApp, isBuiltinApp, listApps, type AppRow } from '../platform/apps.ts';
import { registerLocalApp } from '../platform/local-apps.ts';
import { Engine, listsAvailable, newLinkToken, triggerOf, type LogEntry, type RunRow, type WorkflowRow } from './engine.ts';
import { allSteps, publishProblems, readSteps, readTrigger, type Step, type Trigger } from './model.ts';
import { installResponses } from './responses.ts';
import { nextFire, put, type Vars } from './vars.ts';

export { setListItemCreator } from './engine.ts';

/**
 * Workflows: a person builds a trigger and a list of steps, publishes it, and
 * the server runs it. The builder is a built-in app ("Workflows") so its forms
 * use the modal machinery and its shortcuts appear with app shortcuts.
 */
export function installWorkflows(kernel: Kernel): void {
  const { ctx, registry, router } = kernel;
  let identity: { appId: string; botUserId: string; botId: string } | null = null;

  /** The built-in app, created the first time it is needed. */
  const ensure = (create = true): { appId: string; botUserId: string; botId: string } | null => {
    if (identity && getApp(ctx, identity.appId)) return identity;
    let app = listApps(ctx).find((candidate) => appConfig(candidate).builtin === 'workflows');
    if (!app && !create) return null;
    if (!app) {
      const owner = ctx.db.get<UserRow>("SELECT * FROM users WHERE role = 'primary_owner' LIMIT 1");
      if (!owner) fail('team_not_set_up');
      const created = createAppRecord(ctx, {
        name: 'Workflows',
        description: 'Built-in workflow builder',
        createdBy: owner.id,
        socketMode: false,
        handle: uniqueHandle(ctx, 'workflows'),
      });
      ctx.db.run('UPDATE apps SET config = ? WHERE id = ?', JSON.stringify({ builtin: 'workflows' }), created.app.id);
      app = getApp(ctx, created.app.id)!;
    }
    identity = { appId: app.id, botUserId: app.bot_user_id, botId: app.bot_id };
    registerLocalApp(ctx, {
      appId: app.id,
      shortcuts: () =>
        ctx.db
          .all<WorkflowRow>("SELECT * FROM workflows WHERE status = 'published' AND json_extract(trigger, '$.type') = 'shortcut' ORDER BY name")
          .map((workflow) => ({ type: 'global' as const, name: workflow.name, callback_id: `workflow:${workflow.id}`, description: workflow.description })),
      runShortcut: (actor, callbackId, context) => {
        const workflow = published(callbackId.replace(/^workflow:/, ''), 'shortcut');
        startByPerson(workflow, actor, context.channel);
      },
      submitView: (userId, view) => {
        const runId = String(view.private_metadata ?? '');
        const values = ((view.state as { values?: Record<string, Record<string, unknown>> } | undefined)?.values ?? {}) as Record<string, Record<string, unknown>>;
        const errors = engine.submitForm(runId, userId, values);
        if (errors && Object.keys(errors).length) return { response_action: 'errors', errors };
        return undefined;
      },
      closeView: (userId, view) => engine.cancelForm(String(view.private_metadata ?? ''), userId),
    });
    return identity;
  };
  const engine = new Engine(ctx, () => ensure()!);
  // Pick up the built-in app if an earlier run created it; it is created only when someone builds a workflow.
  if (ctx.team()) ensure(false);

  // ── Starting runs ─────────────────────────────────────────────────────────

  const published = (id: string, type: Trigger['type']): WorkflowRow => {
    const workflow = ctx.db.get<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', id);
    if (!workflow || workflow.status !== 'published' || triggerOf(workflow).type !== type) fail('workflow_not_found');
    return workflow;
  };

  /** A person set the workflow off (shortcut or link); `channel` is where they were, if they can see it. */
  const startByPerson = (workflow: WorkflowRow, actor: Actor, channel: string | undefined): string => {
    ensure();
    const vars: Vars = {};
    put(vars, 'trigger.user', { value: actor.userId, kind: 'user' });
    const conv = channel ? getConv(ctx, channel) : undefined;
    if (conv && canSee(ctx, conv, actor.userId)) put(vars, 'trigger.channel', { value: conv.id, kind: conv.kind === 'im' || conv.kind === 'mpim' ? 'text' : 'channel' });
    return engine.start(workflow, actor.userId, vars);
  };

  const ofType = (type: Trigger['type']): WorkflowRow[] =>
    ctx.db.all<WorkflowRow>("SELECT * FROM workflows WHERE status = 'published' AND json_extract(trigger, '$.type') = ?", type);

  // Reactions and channel joins.
  const unsubscribe = ctx.bus.subscribe(({ event }) => {
    if (event.type === 'reaction_added') {
      const item = event.item as { channel?: string; ts?: string } | undefined;
      const user = typeof event.user === 'string' ? getUser(ctx, event.user) : undefined;
      if (!item?.channel || !item.ts || !user || user.is_bot === 1) return;
      const reaction = String(event.reaction ?? '').replace(/::skin-tone-[2-6]$/, '');
      for (const workflow of ofType('reaction')) {
        const trigger = triggerOf(workflow);
        if (trigger.channel !== item.channel || trigger.reaction !== reaction) continue;
        const vars: Vars = {};
        put(vars, 'trigger.user', { value: user.id, kind: 'user' });
        put(vars, 'trigger.channel', { value: item.channel, kind: 'channel' });
        put(vars, 'trigger.message_ts', { value: item.ts, kind: 'text' });
        put(vars, 'trigger.reaction', { value: reaction, kind: 'text' });
        const message = getMessage(ctx, item.channel, item.ts);
        put(vars, 'trigger.message_text', { value: message?.text ?? '', kind: 'text' });
        if (message?.user_id) put(vars, 'trigger.message_author', { value: message.user_id, kind: 'user' });
        setImmediate(() => engine.start(workflow, user.id, vars));
      }
    } else if (event.type === 'member_joined_channel') {
      const user = typeof event.user === 'string' ? getUser(ctx, event.user) : undefined;
      if (!user || user.is_bot === 1 || typeof event.channel !== 'string') return;
      for (const workflow of ofType('member_joined')) {
        if (triggerOf(workflow).channel !== event.channel) continue;
        const vars: Vars = {};
        put(vars, 'trigger.user', { value: user.id, kind: 'user' });
        put(vars, 'trigger.channel', { value: event.channel, kind: 'channel' });
        setImmediate(() => engine.start(workflow, user.id, vars));
      }
    }
  });

  // Schedules, and app steps that never completed.
  const scheduler = new Scheduler();
  scheduler.add({
    next: () => ctx.db.get<{ at: number | null }>("SELECT min(next_run) AS at FROM workflows WHERE status = 'published' AND next_run IS NOT NULL")?.at ?? null,
    run: (now) => {
      for (const workflow of ctx.db.all<WorkflowRow>("SELECT * FROM workflows WHERE status = 'published' AND next_run IS NOT NULL AND next_run <= ?", now)) {
        const trigger = triggerOf(workflow);
        // Move the schedule on first, so a crash mid-run never fires the same moment twice.
        const next = trigger.schedule ? nextFire(trigger.schedule, now) : null;
        const claimed = ctx.db.run('UPDATE workflows SET next_run = ? WHERE id = ? AND next_run = ?', next, workflow.id, workflow.next_run).changes;
        if (claimed && ctx.team()) engine.start(workflow, null, {});
      }
    },
  });
  scheduler.add({ next: () => engine.expire(nowSeconds()), run: (now) => void engine.expire(now) });
  if (ctx.team()) scheduler.arm();
  kernel.onClose.push(() => {
    scheduler.stop();
    unsubscribe();
  });

  // Webhook triggers: POST /hooks/workflows/<id>/<secret> with a JSON body.
  router.add('POST', /^\/hooks\/workflows\/([A-Za-z0-9]+)\/([0-9a-f]+)$/, async ({ req, res, params }) => {
    const workflow = ctx.db.get<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', params[0]!);
    const secret = workflow?.webhook_secret ?? '';
    const given = params[1]!;
    const valid =
      workflow && workflow.status === 'published' && triggerOf(workflow).type === 'webhook' && secret.length === given.length && timingSafeEqual(Buffer.from(secret), Buffer.from(given));
    if (!valid) {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      const raw = (await readBody(req, 64 * 1024)).toString('utf8');
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      else throw new Error('not an object');
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_json' });
      return;
    }
    const vars: Vars = {};
    for (const name of triggerOf(workflow).variables ?? []) {
      const value = body[name];
      put(vars, `webhook.${name}`, { value: value === undefined || value === null ? '' : typeof value === 'string' ? value.slice(0, 4000) : JSON.stringify(value).slice(0, 4000), kind: 'text' });
    }
    ensure();
    engine.start(workflow, null, vars);
    sendJson(res, 200, { ok: true });
  });

  // ── Methods: building ─────────────────────────────────────────────────────

  const canManageWorkflow = (workflow: WorkflowRow, actor: Actor): boolean => workflow.created_by === actor.userId || isAdmin(actor);
  const own = (id: string | undefined, actor: Actor): WorkflowRow => {
    const workflow = id ? ctx.db.get<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', id) : undefined;
    if (!workflow || !canManageWorkflow(workflow, actor)) fail('workflow_not_found');
    return workflow;
  };

  const toApi = (workflow: WorkflowRow, full: boolean): Record<string, unknown> => {
    const trigger = triggerOf(workflow);
    const creator = getUser(ctx, workflow.created_by);
    const summary: Record<string, unknown> = {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      status: workflow.status,
      trigger,
      created_by: workflow.created_by,
      created_by_name: creator ? creator.display_name || creator.real_name || creator.name : '',
      created: workflow.created,
      updated: workflow.updated,
      next_run: workflow.next_run,
    };
    const last = ctx.db.get<{ status: string; started: number }>('SELECT status, started FROM workflow_runs WHERE workflow_id = ? ORDER BY started DESC, rowid DESC LIMIT 1', workflow.id);
    if (last) summary.last_run = last;
    if (full) {
      summary.steps = JSON.parse(workflow.steps) as Step[];
      if (trigger.type === 'link' && workflow.link_token) summary.link_url = `${ctx.config.publicUrl}/workflow/${workflow.link_token}`;
      if (trigger.type === 'webhook' && workflow.webhook_secret) summary.webhook_url = `${ctx.config.publicUrl}/hooks/workflows/${workflow.id}/${workflow.webhook_secret}`;
      summary.problems = publishProblems(trigger, JSON.parse(workflow.steps) as Step[]);
    }
    return summary;
  };

  /** Checks that depend on who builds it: the channels and apps it names must be ones the creator can use. */
  const checkReferences = (creator: Actor, trigger: Trigger, steps: Step[]): void => {
    const visible = (id: string): boolean => {
      const conv = getConv(ctx, id);
      return conv !== undefined && canSee(ctx, conv, creator.userId);
    };
    if (trigger.channel && !visible(trigger.channel)) fail('channel_not_found', { channel: trigger.channel });
    for (const step of allSteps(steps)) {
      if (step.type === 'message' && step.destination.to === 'channel' && !visible(step.destination.channel)) fail('channel_not_found', { channel: step.destination.channel });
      if (step.type === 'form' && step.post_to && step.post_to !== 'trigger_channel' && !visible(step.post_to)) fail('channel_not_found', { channel: step.post_to });
      if (step.type === 'add_to_channel') {
        const conv = getConv(ctx, step.channel);
        if (!conv || conv.kind !== 'public') fail('invalid_workflow', { detail: `${step.id}: workflows add people to public channels only` });
      }
      if (step.type === 'app') {
        const app = getApp(ctx, step.app_id);
        if (!app || isBuiltinApp(app) || !appConfig(app).functions.some((entry) => entry.callback_id === step.callback_id)) {
          fail('invalid_workflow', { detail: `${step.id}: that app step does not exist` });
        }
      }
      if (step.type === 'list_item' && !listsAvailable(ctx)) fail('invalid_workflow', { detail: `${step.id}: lists are not available` });
    }
  };

  /** Turn triggers on or off for the current state of a workflow. */
  const arm = (id: string): void => {
    const workflow = ctx.db.get<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', id)!;
    const trigger = triggerOf(workflow);
    const next = workflow.status === 'published' && trigger.type === 'schedule' && trigger.schedule ? nextFire(trigger.schedule, nowSeconds()) : null;
    ctx.db.run(
      'UPDATE workflows SET next_run = ?, link_token = coalesce(link_token, ?), webhook_secret = coalesce(webhook_secret, ?) WHERE id = ?',
      next,
      trigger.type === 'link' ? newLinkToken() : null,
      trigger.type === 'webhook' ? newHex(20) : null,
      id,
    );
    scheduler.arm();
  };

  registry.add('client.workflows.list', { auth: 'session' }, ({ actor }) => {
    const rows = isAdmin(actor)
      ? ctx.db.all<WorkflowRow>('SELECT * FROM workflows ORDER BY updated DESC')
      : ctx.db.all<WorkflowRow>('SELECT * FROM workflows WHERE created_by = ? ORDER BY updated DESC', actor.userId);
    return { workflows: rows.map((row) => toApi(row, false)) };
  });

  registry.add('client.workflows.get', { auth: 'session' }, ({ actor, args }) => ({ workflow: toApi(own(args.str('workflow'), actor), true) }));

  registry.add('client.workflows.save', { auth: 'session' }, ({ actor, args }) => {
    ensure();
    const name = args.req('name').trim().slice(0, 80);
    if (!name) fail('invalid_name');
    const trigger = readTrigger(args.json('trigger'));
    const steps = readSteps(args.json('steps') ?? []);
    checkReferences(actor, trigger, steps);
    const now = nowSeconds();
    const existingId = args.str('workflow');
    let id: string;
    if (existingId) {
      const current = own(existingId, actor);
      if (current.status === 'published') {
        const problems = publishProblems(trigger, steps);
        if (problems.length) fail('cannot_publish', { problems });
      }
      ctx.db.run(
        'UPDATE workflows SET name = ?, description = ?, trigger = ?, steps = ?, updated = ? WHERE id = ?',
        name,
        (args.str('description') ?? '').slice(0, 300),
        JSON.stringify(trigger),
        JSON.stringify(steps),
        now,
        current.id,
      );
      id = current.id;
    } else {
      id = newId('Wf');
      ctx.db.run(
        'INSERT INTO workflows (id, name, description, created_by, trigger, steps, status, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        name,
        (args.str('description') ?? '').slice(0, 300),
        actor.userId,
        JSON.stringify(trigger),
        JSON.stringify(steps),
        'draft',
        now,
        now,
      );
    }
    arm(id);
    return { workflow: toApi(ctx.db.get<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', id)!, true) };
  });

  registry.add('client.workflows.publish', { auth: 'session' }, ({ actor, args }) => {
    const workflow = own(args.str('workflow'), actor);
    const publish = args.bool('published', true);
    if (publish) {
      const trigger = triggerOf(workflow);
      const steps = JSON.parse(workflow.steps) as Step[];
      const problems = publishProblems(trigger, steps);
      if (problems.length) fail('cannot_publish', { problems });
      checkReferences(actor.userId === workflow.created_by ? actor : { ...actor, userId: workflow.created_by }, trigger, steps);
      if (trigger.type === 'schedule' && trigger.schedule && nextFire(trigger.schedule, nowSeconds()) === null) fail('cannot_publish', { problems: ['The scheduled time has already passed.'] });
    }
    ctx.db.run('UPDATE workflows SET status = ?, updated = ? WHERE id = ?', publish ? 'published' : 'disabled', nowSeconds(), workflow.id);
    arm(workflow.id);
    return { workflow: toApi(ctx.db.get<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', workflow.id)!, true) };
  });

  registry.add('client.workflows.delete', { auth: 'session' }, ({ actor, args }) => {
    const workflow = own(args.str('workflow'), actor);
    ctx.db.run('DELETE FROM workflows WHERE id = ?', workflow.id);
    scheduler.arm();
  });

  registry.add('client.workflows.runs', { auth: 'session' }, ({ actor, args }) => {
    const workflow = own(args.str('workflow'), actor);
    const runs = ctx.db.all<RunRow>('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started DESC, rowid DESC LIMIT 50', workflow.id);
    return {
      runs: runs.map((run) => ({
        id: run.id,
        runner: run.runner,
        status: run.status,
        error: run.error,
        started: run.started,
        finished: run.finished,
        log: JSON.parse(run.log) as LogEntry[],
      })),
    };
  });

  /** What the builder can offer: steps from apps, and whether lists exist. */
  registry.add('client.workflows.stepTypes', { auth: 'session' }, () => ({
    apps: listApps(ctx)
      .filter((app: AppRow) => !isBuiltinApp(app) && appConfig(app).functions.length > 0)
      .map((app) => ({ app_id: app.id, app_name: app.name, functions: appConfig(app).functions })),
    lists_available: listsAvailable(ctx),
  }));

  // ── Methods: running ──────────────────────────────────────────────────────

  registry.add('client.workflows.linkInfo', { auth: 'session' }, ({ args }) => {
    const workflow = ctx.db.get<WorkflowRow>("SELECT * FROM workflows WHERE link_token = ? AND status = 'published'", args.req('token'));
    if (!workflow || triggerOf(workflow).type !== 'link') fail('workflow_not_found');
    return { workflow: { id: workflow.id, name: workflow.name, description: workflow.description } };
  });

  registry.add('client.workflows.startByLink', { auth: 'session' }, ({ actor, args }) => {
    const workflow = ctx.db.get<WorkflowRow>("SELECT * FROM workflows WHERE link_token = ? AND status = 'published'", args.req('token'));
    if (!workflow || triggerOf(workflow).type !== 'link') fail('workflow_not_found');
    return { run_id: startByPerson(workflow, actor, args.str('channel')) };
  });

  // ── Custom steps: the Slack API apps use to finish them ───────────────────

  registry.add('functions.completeSuccess', {}, ({ actor, args }) => {
    const outputs = args.json<Record<string, unknown>>('outputs') ?? {};
    if (typeof outputs !== 'object' || Array.isArray(outputs)) fail('invalid_arguments', { needed: 'outputs' });
    engine.completeFunction(args.req('function_execution_id'), actor.appId, outputs);
  });

  registry.add('functions.completeError', {}, ({ actor, args }) => {
    engine.failFunction(args.req('function_execution_id'), actor.appId, args.req('error'));
  });

  installResponses(kernel);
}
