import type { Kernel } from '../app.ts';
import { getMember, resolveConv, type ConvRow } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { nowSeconds } from '../core/ids.ts';
import { getMessage } from '../core/messages.ts';
import { getUser } from '../core/users.ts';
import type { Ctx } from '../ctx.ts';
import { getApp, parseList, type AppRow } from './apps.ts';
import { sendToApp, type Delivery } from './dispatch.ts';

/**
 * Agent sessions (`agents.sessions.*`): what an agent working in a thread
 * reports — active, processing, waiting on the person (suspended) or closed —
 * and the session's title. People in the conversation see it on the thread,
 * can stop a processing agent (`agent_session_stopped` to the app, which
 * must stop and say so) and rename the session (`agent_session_title_changed`).
 * Several agents can work in one thread; the thread shows the most pressing
 * state: suspended, then processing, then active, then closed.
 *
 * Thread sessions only: Slack's code channels (`agents.conversations.*`) are
 * not here yet.
 */

const STATUSES = ['active', 'processing', 'suspended', 'closed'] as const;
type SessionStatus = (typeof STATUSES)[number];
const PRECEDENCE: SessionStatus[] = ['suspended', 'processing', 'active', 'closed'];
/** A processing session nobody refreshes goes back to active after an hour, as on Slack. */
const PROCESSING_MS = 3_600_000;

interface SessionRow {
  app_id: string;
  conversation_id: string;
  thread_ts: string;
  title: string;
  session_status: string;
  status_set: number | null;
  initiator: string | null;
}

function effective(row: SessionRow): SessionStatus {
  const status = (STATUSES as readonly string[]).includes(row.session_status) ? (row.session_status as SessionStatus) : 'active';
  if (status === 'processing' && row.status_set !== null && Date.now() - row.status_set * 1000 > PROCESSING_MS) return 'active';
  return status;
}

function sessionsIn(ctx: Ctx, conversationId: string, threadTs: string): SessionRow[] {
  return ctx.db.all<SessionRow>("SELECT * FROM agent_threads WHERE conversation_id = ? AND thread_ts = ? AND session_status != ''", conversationId, threadTs);
}

/** The thread's state across its agents. */
function overall(rows: SessionRow[]): SessionStatus {
  const states = rows.map(effective);
  return PRECEDENCE.find((status) => states.includes(status)) ?? 'active';
}

function sessionToApi(ctx: Ctx, rows: SessionRow[]): Record<string, unknown> {
  const first = rows[0]!;
  const title = rows.find((row) => row.title)?.title ?? '';
  return {
    channel: first.conversation_id,
    thread_ts: first.thread_ts,
    status: overall(rows),
    title,
    agents: rows.map((row) => {
      const app = getApp(ctx, row.app_id);
      return { app_id: row.app_id, bot_user_id: app?.bot_user_id ?? null, name: app?.name ?? '', status: effective(row) };
    }),
  };
}

export function installAgentSessions(kernel: Kernel, delivery: Delivery): void {
  const { ctx, registry } = kernel;

  const emit = (conv: ConvRow, threadTs: string): void => {
    const rows = sessionsIn(ctx, conv.id, threadTs);
    if (!rows.length) return;
    ctx.bus.emit({ event: { type: 'agent_session', session: sessionToApi(ctx, rows), event_ts: ctx.clock.eventTs() }, audience: { conversation: conv.id }, clientOnly: true });
  };

  const record = (app: AppRow, conv: ConvRow, threadTs: string, fields: { status?: SessionStatus; title?: string; initiator?: string | null }): void => {
    ctx.db.run(
      `INSERT INTO agent_threads (app_id, conversation_id, thread_ts, title, status, streaming, last_activity, session_status, status_set, initiator)
       VALUES (?, ?, ?, ?, '', 0, ?, ?, ?, ?)
       ON CONFLICT (app_id, conversation_id, thread_ts) DO UPDATE SET
         title = coalesce(?, title), session_status = coalesce(?, session_status), status_set = coalesce(?, status_set),
         initiator = coalesce(initiator, ?), last_activity = excluded.last_activity`,
      app.id,
      conv.id,
      threadTs,
      fields.title ?? '',
      nowSeconds(),
      fields.status ?? 'active',
      nowSeconds(),
      fields.initiator ?? null,
      fields.title ?? null,
      fields.status ?? null,
      fields.status ? nowSeconds() : null,
      fields.initiator ?? null,
    );
  };

  /** The calling agent, the conversation and the thread of a session call. */
  const target = (actor: { isBot: boolean; appId: string | null; userId: string }, channel: string | undefined, threadTs: string | undefined): { app: AppRow; conv: ConvRow; threadTs: string } => {
    if (!actor.isBot || !actor.appId) fail('not_allowed_token_type');
    const app = getApp(ctx, actor.appId) ?? fail('invalid_auth');
    if (!channel) fail('channel_not_found');
    const conv = resolveConv(ctx, actor as never, channel);
    if (!getMember(ctx, conv.id, actor.userId)) fail('not_authorized');
    // Without Slack's code channels, every session lives in a thread.
    if (!threadTs) fail('thread_ts_required');
    if (!/^\d{10}\.\d{6}$/.test(threadTs) || !getMessage(ctx, conv.id, threadTs)) fail('session_not_found');
    return { app, conv, threadTs };
  };

  // A streamed reply is work in progress, as on Slack: chat.startStream makes the session processing,
  // and when the stream ends it is active again.
  const unsubscribe = ctx.bus.subscribe(({ event }) => {
    if (event.type !== 'message' || typeof event.channel !== 'string') return;
    const message = (event.subtype === 'message_changed' ? event.message : event) as { app_id?: string; streaming?: boolean; ts?: string; thread_ts?: string } | undefined;
    if (!message?.app_id || !message.ts) return;
    const starting = event.subtype !== 'message_changed' && message.streaming === true;
    const ending = event.subtype === 'message_changed' && !message.streaming && (event.previous_message as { streaming?: boolean } | undefined)?.streaming === true;
    if (!starting && !ending) return;
    const app = getApp(ctx, message.app_id);
    const conv = app ? ctx.db.get<ConvRow>('SELECT * FROM conversations WHERE id = ?', event.channel) : undefined;
    if (!app || !conv) return;
    const threadTs = message.thread_ts ?? message.ts;
    try {
      record(app, conv, threadTs, { status: starting ? 'processing' : 'active' });
      emit(conv, threadTs);
    } catch (error) {
      console.error('[agents] session not recorded', error);
    }
  });
  kernel.onClose.push(unsubscribe);

  registry.add('agents.sessions.setStatus', { scopes: ['chat:write'] }, ({ actor, args }) => {
    const status = args.req('status', 'invalid_status') as SessionStatus;
    if (!STATUSES.includes(status)) fail('invalid_status');
    const { app, conv, threadTs } = target(actor, args.str('channel_id'), args.str('thread_ts'));
    const initiator = args.str('initiator_user_id');
    if (initiator && !getMember(ctx, conv.id, initiator)) fail('user_not_found');
    const exists = ctx.db.get<SessionRow>("SELECT * FROM agent_threads WHERE app_id = ? AND conversation_id = ? AND thread_ts = ? AND session_status != ''", app.id, conv.id, threadTs);
    const title = args.str('title');
    record(app, conv, threadTs, { status, title: exists ? undefined : title?.slice(0, 200), initiator: exists ? undefined : (initiator ?? null) });
    emit(conv, threadTs);
    const rows = sessionsIn(ctx, conv.id, threadTs);
    const mine = rows.find((row) => row.app_id === app.id)!;
    const wanted = parseList(app.bot_events);
    return {
      status: overall(rows),
      agent_status: effective(mine),
      title: rows.find((row) => row.title)?.title ?? '',
      ...(wanted.length && !wanted.includes('agent_session_stopped') ? { warning: 'missing_agent_session_stopped_event_subscription' } : {}),
    };
  });

  registry.add('agents.sessions.rename', { scopes: ['chat:write'] }, ({ actor, args }) => {
    const title = args.req('title', 'invalid_name').trim();
    if (!title || title.length > 200) fail('invalid_name');
    const { app, conv, threadTs } = target(actor, args.str('channel_id'), args.str('thread_ts'));
    record(app, conv, threadTs, { title });
    emit(conv, threadTs);
    return { title };
  });

  // ── What people do ──────────────────────────────────────────────────────

  registry.add('client.agents.sessions', { auth: 'session' }, ({ actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const threads = ctx.db.all<{ thread_ts: string }>("SELECT DISTINCT thread_ts FROM agent_threads WHERE conversation_id = ? AND session_status != '' ORDER BY last_activity DESC LIMIT 200", conv.id);
    return { sessions: threads.map(({ thread_ts }) => sessionToApi(ctx, sessionsIn(ctx, conv.id, thread_ts))) };
  });

  /** Stop: the agents still processing in the thread are told; each must stop and update its status. */
  registry.add('client.agents.stop', { auth: 'session' }, ({ actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const threadTs = args.reqTs('thread_ts');
    let told = 0;
    for (const row of sessionsIn(ctx, conv.id, threadTs)) {
      if (effective(row) !== 'processing') continue;
      const app = getApp(ctx, row.app_id);
      if (!app) continue;
      const streaming = ctx.db
        .all<{ ts: string }>('SELECT ts FROM messages WHERE conversation_id = ? AND (thread_ts = ? OR ts = ?) AND streaming = 1 AND app_id = ?', conv.id, threadTs, threadTs, app.id)
        .map((message) => message.ts);
      sendToApp(delivery, app, 'agent_session_stopped', {
        type: 'agent_session_stopped',
        channel: conv.id,
        thread_ts: threadTs,
        user: actor.userId,
        streaming_message_ts: streaming,
        event_ts: ctx.clock.eventTs(),
      });
      told += 1;
    }
    return { stopped: told };
  });

  registry.add('client.agents.rename', { auth: 'session' }, ({ actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const threadTs = args.reqTs('thread_ts');
    const title = args.req('title', 'invalid_name').trim().slice(0, 200);
    if (!title) fail('invalid_name');
    const rows = sessionsIn(ctx, conv.id, threadTs);
    if (!rows.length) fail('session_not_found');
    const previous = rows.find((row) => row.title)?.title ?? '';
    ctx.db.run("UPDATE agent_threads SET title = ? WHERE conversation_id = ? AND thread_ts = ? AND session_status != ''", title, conv.id, threadTs);
    const team = ctx.requireTeam();
    for (const row of rows) {
      const app = getApp(ctx, row.app_id);
      if (!app) continue;
      sendToApp(delivery, app, 'agent_session_title_changed', {
        type: 'agent_session_title_changed',
        channel: conv.id,
        thread_ts: threadTs,
        title,
        ...(previous ? { previous_title: previous } : {}),
        user: actor.userId,
        team_id: team.id,
        event_ts: ctx.clock.eventTs(),
      });
    }
    emit(conv, threadTs);
    return { title, user: getUser(ctx, actor.userId)?.id };
  });
}
