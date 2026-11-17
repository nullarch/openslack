import type { Block } from '@app/shared';
import { createToken } from '../core/auth.ts';
import { addMember, getConv, getMember, openDirect, type ConvRow } from '../core/conversations.ts';
import { ApiError } from '../core/errors.ts';
import { isGuest } from '../core/guests.ts';
import { newHex, newId, nowSeconds, sha256 } from '../core/ids.ts';
import { getMessage, postMessage } from '../core/messages.ts';
import { getUser } from '../core/users.ts';
import { actorForUser } from '../core/auth.ts';
import type { Ctx } from '../ctx.ts';
import { appConfig, getApp, parseList, type AppFunction } from '../platform/apps.ts';
import { sendToApp } from '../platform/dispatch.ts';
import { platformServices } from '../platform/local-apps.ts';
import { allowPrivateTargets, OutboundError, post } from '../platform/net.ts';
import { compile, type FormField, type Instruction, type Step, type Trigger } from './model.ts';
import { lookup, put, renderMessage, renderPlain, type Vars } from './vars.ts';

export interface WorkflowRow {
  id: string;
  name: string;
  description: string;
  created_by: string;
  trigger: string;
  steps: string;
  status: 'draft' | 'published' | 'disabled';
  link_token: string | null;
  webhook_secret: string | null;
  next_run: number | null;
  created: number;
  updated: number;
}

export interface RunRow {
  id: string;
  workflow_id: string;
  runner: string | null;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  program: string;
  pc: number;
  vars: string;
  log: string;
  waiting: string | null;
  error: string | null;
  started: number;
  updated: number;
  finished: number | null;
}

export interface LogEntry {
  step: string;
  type: string;
  at: number;
  ok: boolean;
  detail?: string;
}

type Waiting =
  | { kind: 'form'; step: string; view_id: string; fields: FormField[]; post_to: string | null; title: string }
  | { kind: 'function'; step: string; execution_id: string; token_hash: string; app_id: string; outputs: string[]; expires: number };

/** Creates a list item; provided by the lists module when it is installed. */
export type CreateListItem = (ctx: Ctx, actor: ReturnType<typeof actorForUser>, listId: string, fields: Record<string, string>) => { id: string };
const listItemCreators = new WeakMap<Ctx, CreateListItem>();

/** The lists module calls this at start-up so workflows can add list items. */
export function setListItemCreator(ctx: Ctx, create: CreateListItem): void {
  listItemCreators.set(ctx, create);
}

export function listsAvailable(ctx: Ctx): boolean {
  return listItemCreators.has(ctx);
}

/** A step failed for a reason worth showing in the run history. */
class StepError extends Error {}

const FUNCTION_TIMEOUT_SECONDS = 15 * 60;

function parse<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Runs workflows. A run executes with the workflow creator's permissions,
 * intersected with the permissions of the person who set it off (see
 * docs/ARCHITECTURE.md, "Workflows"): it posts only where both could, and adds
 * people only to public channels.
 */
export class Engine {
  private readonly ctx: Ctx;
  private readonly identity: () => { appId: string; botUserId: string; botId: string };
  private readonly busy = new Set<string>();

  constructor(ctx: Ctx, identity: () => { appId: string; botUserId: string; botId: string }) {
    this.ctx = ctx;
    this.identity = identity;
  }

  getRun(id: string): RunRow | undefined {
    return this.ctx.db.get<RunRow>('SELECT * FROM workflow_runs WHERE id = ?', id);
  }

  /** Start a run and drive it until it ends or waits. Returns the run id. */
  start(workflow: WorkflowRow, runner: string | null, vars: Vars): string {
    const id = newId('Wx');
    const now = nowSeconds();
    const program = compile(parse<Step[]>(workflow.steps, []));
    put(vars, 'trigger.time', { value: new Date(now * 1000).toISOString(), kind: 'text' });
    this.ctx.db.run(
      `INSERT INTO workflow_runs (id, workflow_id, runner, status, program, pc, vars, log, started, updated)
       VALUES (?, ?, ?, 'running', ?, 0, ?, '[]', ?, ?)`,
      id,
      workflow.id,
      runner,
      JSON.stringify(program),
      JSON.stringify(vars),
      now,
      now,
    );
    void this.advance(id);
    return id;
  }

  /** Execute instructions until the run waits, fails or ends. */
  async advance(runId: string): Promise<void> {
    if (this.busy.has(runId)) return;
    this.busy.add(runId);
    try {
      for (;;) {
        const run = this.getRun(runId);
        if (!run || run.status !== 'running') return;
        const workflow = this.ctx.db.get<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', run.workflow_id);
        if (!workflow) return this.finish(run, 'cancelled', 'The workflow was deleted.');
        const program = parse<Instruction[]>(run.program, []);
        if (run.pc >= program.length) return this.finish(run, 'completed', null);
        const vars = parse<Vars>(run.vars, {});
        const instruction = program[run.pc]!;
        if (instruction.op === 'jump') {
          this.save(run.id, { pc: instruction.to });
          continue;
        }
        if (instruction.op === 'branch') {
          const passed = this.test(instruction.step, vars);
          this.log(run, { step: instruction.step.id, type: 'branch', at: nowSeconds(), ok: true, detail: passed ? 'then' : 'else' });
          this.save(run.id, { pc: passed ? run.pc + 1 : instruction.elseAt });
          continue;
        }
        const step = instruction.step;
        let waiting: Waiting | null = null;
        try {
          waiting = await this.execute(workflow, run, step, vars);
        } catch (error) {
          const detail = error instanceof StepError || error instanceof ApiError ? (error instanceof ApiError ? describeCode(error.code) : error.message) : 'Something went wrong.';
          if (!(error instanceof StepError || error instanceof ApiError)) console.error('[workflows] step failed', error);
          this.log(run, { step: step.id, type: step.type, at: nowSeconds(), ok: false, detail });
          return this.finish(this.getRun(run.id)!, 'failed', detail);
        }
        if (waiting) {
          this.log(run, { step: step.id, type: step.type, at: nowSeconds(), ok: true, detail: 'waiting' });
          this.save(run.id, { status: 'waiting', waiting: JSON.stringify(waiting), vars: JSON.stringify(vars) });
          return;
        }
        this.log(run, { step: step.id, type: step.type, at: nowSeconds(), ok: true });
        this.save(run.id, { pc: run.pc + 1, vars: JSON.stringify(vars) });
      }
    } finally {
      this.busy.delete(runId);
    }
  }

  private save(runId: string, fields: Partial<Pick<RunRow, 'pc' | 'vars' | 'status' | 'waiting' | 'error' | 'finished'>>): void {
    const names = Object.keys(fields) as (keyof typeof fields)[];
    if (names.length === 0) return;
    this.ctx.db.run(
      `UPDATE workflow_runs SET ${names.map((name) => `${name} = ?`).join(', ')}, updated = ? WHERE id = ?`,
      ...names.map((name) => fields[name] ?? null),
      nowSeconds(),
      runId,
    );
  }

  private log(run: RunRow, entry: LogEntry): void {
    const fresh = this.getRun(run.id) ?? run;
    const log = parse<LogEntry[]>(fresh.log, []);
    log.push(entry);
    this.ctx.db.run('UPDATE workflow_runs SET log = ? WHERE id = ?', JSON.stringify(log.slice(-100)), run.id);
  }

  private finish(run: RunRow, status: 'completed' | 'failed' | 'cancelled', error: string | null): void {
    const waiting = parse<Waiting | null>(run.waiting, null);
    if (waiting?.kind === 'function') this.ctx.db.run('DELETE FROM tokens WHERE token_hash = ?', waiting.token_hash);
    this.save(run.id, { status, error, waiting: null, finished: nowSeconds() });
  }

  private test(step: Extract<Step, { type: 'branch' }>, vars: Vars): boolean {
    const value = (lookup(vars, step.variable)?.value ?? '').trim();
    const wanted = step.value.trim();
    switch (step.operator) {
      case 'equals':
        return value.toLowerCase() === wanted.toLowerCase();
      case 'not_equals':
        return value.toLowerCase() !== wanted.toLowerCase();
      case 'contains':
        return value.toLowerCase().includes(wanted.toLowerCase());
      case 'is_empty':
        return value === '';
      case 'is_not_empty':
        return value !== '';
    }
  }

  // ── Permissions ───────────────────────────────────────────────────────────

  /**
   * Whether the run may post into `conv`: anyone may post into a public channel
   * (a person who is not in it could join it); anywhere else both the creator
   * and the person who set the run off must be members.
   */
  private reachable(conv: ConvRow | undefined, workflow: WorkflowRow, run: RunRow): ConvRow {
    if (!conv) throw new StepError('The conversation does not exist any more.');
    if (conv.is_archived === 1) throw new StepError('The channel is archived.');
    if (conv.kind === 'public') return conv;
    if (!getMember(this.ctx, conv.id, workflow.created_by)) throw new StepError('The workflow’s creator is not in that conversation.');
    if (run.runner && !getMember(this.ctx, conv.id, run.runner)) throw new StepError('The person who started the workflow is not in that conversation.');
    return conv;
  }

  private userFrom(reference: string, vars: Vars): string {
    const id = reference.startsWith('U') && !reference.includes('.') ? reference : lookup(vars, reference)?.value ?? '';
    const user = id ? getUser(this.ctx, id) : undefined;
    if (!user || user.deleted === 1 || user.is_bot === 1) throw new StepError('The person to send to is not an active member.');
    return user.id;
  }

  private post(workflow: WorkflowRow, conv: ConvRow, text: string, threadTs: string | null, blocks?: Block[]): { ts: string } {
    const me = this.identity();
    const row = postMessage(this.ctx, {
      conv: getConv(this.ctx, conv.id)!,
      userId: me.botUserId,
      botId: me.botId,
      appId: me.appId,
      text,
      blocks: blocks ?? null,
      threadTs,
      username: workflow.name,
    });
    return { ts: row.ts };
  }

  // ── Steps ─────────────────────────────────────────────────────────────────

  private async execute(workflow: WorkflowRow, run: RunRow, step: Exclude<Step, { type: 'branch' }>, vars: Vars): Promise<Waiting | null> {
    const creator = getUser(this.ctx, workflow.created_by);
    if (!creator || creator.deleted === 1) throw new StepError('The workflow’s creator is no longer active.');
    const out = (name: string, value: string, kind: 'text' | 'user' | 'channel' = 'text'): void => put(vars, `steps.${step.id}.${name}`, { value, kind });

    switch (step.type) {
      case 'message': {
        const text = renderMessage(step.text, vars);
        if (!text.trim()) throw new StepError('The message came out empty.');
        let conv: ConvRow;
        let threadTs: string | null = null;
        const destination = step.destination;
        if (destination.to === 'channel') {
          conv = this.reachable(getConv(this.ctx, destination.channel), workflow, run);
        } else if (destination.to === 'trigger_channel' || destination.to === 'thread') {
          const channel = lookup(vars, 'trigger.channel')?.value;
          if (!channel) throw new StepError('The workflow was not started from a channel.');
          conv = this.reachable(getConv(this.ctx, channel), workflow, run);
          if (destination.to === 'thread') {
            const ts = lookup(vars, 'trigger.message_ts')?.value;
            const message = ts ? getMessage(this.ctx, conv.id, ts) : undefined;
            if (!message) throw new StepError('The message to reply to is gone.');
            threadTs = message.thread_ts ?? message.ts;
          }
        } else {
          const user = this.userFrom(destination.user, vars);
          conv = openDirect(this.ctx, this.identity().botUserId, [user]).conv;
        }
        const posted = this.post(workflow, conv, text, threadTs);
        out('ts', posted.ts);
        out('channel', conv.id, conv.kind === 'im' ? 'text' : 'channel');
        return null;
      }

      case 'form': {
        if (!run.runner) throw new StepError('A form needs a person to fill it in.');
        const view = formView(workflow, run.id, step);
        const opened = platformServices(this.ctx).views.openFor(this.identity().appId, run.runner, view);
        return { kind: 'form', step: step.id, view_id: String(opened.id), fields: step.fields, post_to: step.post_to ?? null, title: step.title };
      }

      case 'add_to_channel': {
        const conv = getConv(this.ctx, step.channel);
        if (!conv || conv.kind !== 'public') throw new StepError('Workflows add people to public channels only.');
        if (conv.is_archived === 1) throw new StepError('The channel is archived.');
        const user = this.userFrom(step.user, vars);
        // Only admins add guests to channels, and a single-channel guest stays in one; a workflow never does.
        if (isGuest(this.ctx, user)) throw new StepError('Workflows do not add guests to channels.');
        addMember(this.ctx, conv, user, { inviter: workflow.created_by });
        return null;
      }

      case 'webhook': {
        const body: Record<string, string> = {};
        for (const [key, template] of Object.entries(step.body)) body[key] = renderPlain(template, vars);
        try {
          const response = await post(step.url, {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            timeoutMs: 10_000,
            allowPrivate: allowPrivateTargets(this.ctx),
          });
          out('status', String(response.status));
          if (response.status >= 400) throw new StepError(`The webhook answered ${response.status}.`);
        } catch (error) {
          if (error instanceof OutboundError) {
            throw new StepError(error.reason === 'blocked_address' ? 'The webhook address is on a private network, which this server does not call.' : `The webhook could not be reached (${error.reason}).`);
          }
          throw error;
        }
        return null;
      }

      case 'app': {
        const app = getApp(this.ctx, step.app_id);
        const declared: AppFunction | undefined = app ? appConfig(app).functions.find((entry) => entry.callback_id === step.callback_id) : undefined;
        if (!app || !declared) throw new StepError('The app or its step is no longer available.');
        const inputs: Record<string, unknown> = {};
        for (const parameter of declared.input_parameters) {
          const raw = renderPlain(step.inputs[parameter.name] ?? '', vars);
          if (parameter.required && raw === '') throw new StepError(`The app step needs “${parameter.title}”.`);
          if (raw === '') continue;
          inputs[parameter.name] = parameter.type === 'number' ? Number(raw) : parameter.type === 'boolean' ? raw === 'true' : raw;
        }
        const executionId = `Fx${newId('', 10)}`;
        // The app acts for this execution with a token of its own that ends when the step does.
        const token = createToken(this.ctx, { kind: 'bot', userId: app.bot_user_id, appId: app.id, scopes: parseList(app.bot_scopes) });
        const now = nowSeconds();
        const event = {
          type: 'function_executed',
          function: {
            id: `Fn${sha256(`${app.id}:${declared.callback_id}`).slice(0, 10).toUpperCase()}`,
            callback_id: declared.callback_id,
            title: declared.title,
            description: declared.description,
            type: 'app',
            input_parameters: declared.input_parameters.map(slackParameter),
            output_parameters: declared.output_parameters.map(slackParameter),
            app_id: app.id,
            date_created: now,
            date_updated: now,
            date_deleted: 0,
          },
          inputs,
          function_execution_id: executionId,
          workflow_execution_id: run.id,
          event_ts: this.ctx.clock.eventTs(),
          bot_access_token: token,
        };
        sendToApp(platformServices(this.ctx).delivery, app, 'function_executed', event);
        return {
          kind: 'function',
          step: step.id,
          execution_id: executionId,
          token_hash: sha256(token),
          app_id: app.id,
          outputs: declared.output_parameters.map((parameter) => parameter.name),
          expires: now + FUNCTION_TIMEOUT_SECONDS,
        };
      }

      case 'list_item': {
        const create = listItemCreators.get(this.ctx);
        if (!create) throw new StepError('Lists are not available on this server.');
        const fields: Record<string, string> = {};
        for (const [key, template] of Object.entries(step.fields)) fields[key] = renderPlain(template, vars);
        // The creator's identity, so the list's own permission checks apply to the creator.
        const item = create(this.ctx, actorForUser(creator, 'session', null), step.list_id, fields);
        out('item_id', item.id);
        return null;
      }
    }
  }

  // ── Resuming ──────────────────────────────────────────────────────────────

  /** A form was submitted: check it, store the answers, continue. Returns errors per field when something is missing. */
  submitForm(runId: string, userId: string, values: Record<string, Record<string, unknown>>): Record<string, string> | null {
    const run = this.getRun(runId);
    const waiting = parse<Waiting | null>(run?.waiting ?? null, null);
    if (!run || run.status !== 'waiting' || waiting?.kind !== 'form' || run.runner !== userId) return null;
    const workflow = this.ctx.db.get<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', run.workflow_id);
    const vars = parse<Vars>(run.vars, {});
    const errors: Record<string, string> = {};
    const answers: { field: FormField; value: string }[] = [];
    for (const field of waiting.fields) {
      const element = (values[field.key]?.value ?? {}) as Record<string, unknown>;
      let value = '';
      if (field.type === 'select') value = String((element.selected_option as { value?: string } | undefined)?.value ?? '');
      else if (field.type === 'user') value = String(element.selected_user ?? '');
      else if (field.type === 'channel') value = String(element.selected_conversation ?? element.selected_channel ?? '');
      else if (field.type === 'date') value = String(element.selected_date ?? '');
      else value = String(element.value ?? '').trim();
      if (field.required && !value) errors[field.key] = 'Please fill this in.';
      if (field.type === 'number' && value && !Number.isFinite(Number(value))) errors[field.key] = 'Enter a number.';
      answers.push({ field, value });
    }
    if (Object.keys(errors).length) return errors;
    for (const { field, value } of answers) {
      put(vars, `steps.${waiting.step}.${field.key}`, { value, kind: field.type === 'user' ? 'user' : field.type === 'channel' ? 'channel' : 'text' });
    }
    put(vars, `steps.${waiting.step}.user`, { value: userId, kind: 'user' });
    // Answers posted for the team to see, when the step asks for it.
    if (waiting.post_to && workflow) {
      try {
        const channel = waiting.post_to === 'trigger_channel' ? lookup(vars, 'trigger.channel')?.value : waiting.post_to;
        if (!channel) throw new StepError('The workflow was not started from a channel.');
        const conv = this.reachable(getConv(this.ctx, channel), workflow, run);
        const lines = answers.map(({ field, value }) => {
          const shown = !value ? '_—_' : field.type === 'user' ? `<@${value}>` : field.type === 'channel' ? `<#${value}>` : value.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!);
          return `*${field.label}*\n${shown}`;
        });
        this.post(workflow, conv, `*${waiting.title}* — submitted by <@${userId}>\n\n${lines.join('\n\n')}`, null);
      } catch (error) {
        const detail = error instanceof StepError ? error.message : 'The answers could not be posted.';
        this.log(run, { step: waiting.step, type: 'form', at: nowSeconds(), ok: false, detail });
        this.finish(run, 'failed', detail);
        return {};
      }
    }
    this.log(run, { step: waiting.step, type: 'form', at: nowSeconds(), ok: true, detail: 'submitted' });
    this.save(run.id, { status: 'running', waiting: null, pc: run.pc + 1, vars: JSON.stringify(vars) });
    void this.advance(run.id);
    return {};
  }

  /** The person closed the form without submitting. */
  cancelForm(runId: string, userId: string): void {
    const run = this.getRun(runId);
    const waiting = parse<Waiting | null>(run?.waiting ?? null, null);
    if (!run || run.status !== 'waiting' || waiting?.kind !== 'form' || run.runner !== userId) return;
    this.log(run, { step: waiting.step, type: 'form', at: nowSeconds(), ok: false, detail: 'closed without submitting' });
    this.finish(run, 'cancelled', 'The form was closed without submitting.');
  }

  /** The run waiting on an app's step, if `appId` owns that execution. */
  private functionRun(executionId: string, appId: string | null): { run: RunRow; waiting: Extract<Waiting, { kind: 'function' }> } {
    const runs = this.ctx.db.all<RunRow>("SELECT * FROM workflow_runs WHERE status = 'waiting'");
    for (const run of runs) {
      const waiting = parse<Waiting | null>(run.waiting, null);
      if (waiting?.kind === 'function' && waiting.execution_id === executionId) {
        if (waiting.app_id !== appId) break;
        return { run, waiting };
      }
    }
    throw new ApiError('function_execution_not_found');
  }

  completeFunction(executionId: string, appId: string | null, outputs: Record<string, unknown>): void {
    const { run, waiting } = this.functionRun(executionId, appId);
    const vars = parse<Vars>(run.vars, {});
    for (const name of waiting.outputs) {
      const value = outputs[name];
      if (value === undefined || value === null) continue;
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      put(vars, `steps.${waiting.step}.${name}`, { value: text, kind: /^U[A-Z0-9]+$/.test(text) ? 'user' : /^C[A-Z0-9]+$/.test(text) ? 'channel' : 'text' });
    }
    this.ctx.db.run('DELETE FROM tokens WHERE token_hash = ?', waiting.token_hash);
    this.log(run, { step: waiting.step, type: 'app', at: nowSeconds(), ok: true, detail: 'completed by the app' });
    this.save(run.id, { status: 'running', waiting: null, pc: run.pc + 1, vars: JSON.stringify(vars) });
    void this.advance(run.id);
  }

  failFunction(executionId: string, appId: string | null, error: string): void {
    const { run, waiting } = this.functionRun(executionId, appId);
    const detail = `The app reported: ${error.slice(0, 300) || 'an error'}`;
    this.log(run, { step: waiting.step, type: 'app', at: nowSeconds(), ok: false, detail });
    this.finish(run, 'failed', detail);
  }

  /** Fail app steps nobody completed in time. Returns the next expiry, or null. */
  expire(now: number): number | null {
    let next: number | null = null;
    for (const run of this.ctx.db.all<RunRow>("SELECT * FROM workflow_runs WHERE status = 'waiting'")) {
      const waiting = parse<Waiting | null>(run.waiting, null);
      if (waiting?.kind !== 'function') continue;
      if (waiting.expires <= now) {
        this.log(run, { step: waiting.step, type: 'app', at: now, ok: false, detail: 'the app did not complete the step in time' });
        this.finish(run, 'failed', 'The app did not complete its step within 15 minutes.');
      } else if (next === null || waiting.expires < next) {
        next = waiting.expires;
      }
    }
    return next;
  }
}

function slackParameter(parameter: { name: string; title: string; type: string; required: boolean }): Record<string, unknown> {
  return { type: `slack#/types/${parameter.type}`, name: parameter.name, title: parameter.title, description: '', is_required: parameter.required };
}

function describeCode(code: string): string {
  const known: Record<string, string> = {
    is_archived: 'The channel is archived.',
    channel_not_found: 'The conversation does not exist any more.',
    user_not_found: 'The person does not exist.',
    user_disabled: 'The person is deactivated.',
    msg_too_long: 'The message is too long.',
  };
  return known[code] ?? `Stopped: ${code}.`;
}

/** The modal a form step shows: one input block per field. */
function formView(workflow: WorkflowRow, runId: string, step: Extract<Step, { type: 'form' }>): Record<string, unknown> {
  const element = (field: FormField): Record<string, unknown> => {
    switch (field.type) {
      case 'long_text':
        return { type: 'plain_text_input', action_id: 'value', multiline: true };
      case 'number':
        return { type: 'number_input', action_id: 'value', is_decimal_allowed: true };
      case 'date':
        return { type: 'datepicker', action_id: 'value' };
      case 'select':
        return {
          type: 'static_select',
          action_id: 'value',
          options: (field.options ?? []).map((option) => ({ text: { type: 'plain_text', text: option }, value: option })),
        };
      case 'user':
        return { type: 'users_select', action_id: 'value' };
      case 'channel':
        return { type: 'conversations_select', action_id: 'value', filter: { include: ['public', 'private'], exclude_bot_users: true } };
      default:
        return { type: 'plain_text_input', action_id: 'value' };
    }
  };
  const blocks: Record<string, unknown>[] = [];
  if (workflow.description) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: workflow.description.slice(0, 300) }] });
  for (const field of step.fields) {
    blocks.push({ type: 'input', block_id: field.key, optional: !field.required, label: { type: 'plain_text', text: field.label }, element: element(field) });
  }
  return {
    type: 'modal',
    callback_id: `workflow_form:${runId}`,
    private_metadata: runId,
    title: { type: 'plain_text', text: step.title.slice(0, 24) },
    submit: { type: 'plain_text', text: step.submit.slice(0, 24) },
    close: { type: 'plain_text', text: 'Cancel' },
    notify_on_close: false,
    blocks,
  };
}

export function newLinkToken(): string {
  return newHex(12);
}

export function triggerOf(workflow: WorkflowRow): Trigger {
  return parse<Trigger>(workflow.trigger, { type: 'shortcut' });
}
