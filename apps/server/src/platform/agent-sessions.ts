import type { Kernel } from '../app.ts';
import { channelNameError } from '@app/shared';
import { getConv, getMember, renameConversation, resolveConv, type ConvRow } from '../core/conversations.ts';
import { ApiError, fail } from '../core/errors.ts';
import { nowSeconds } from '../core/ids.ts';
import { getMessage } from '../core/messages.ts';
import { getUser } from '../core/users.ts';
import type { Ctx } from '../ctx.ts';
import {
  announceChannel,
  CHANNEL_SESSION,
  channelSlug,
  effective,
  getAgentChannel,
  overall,
  sessionsIn,
  sessionTitle,
  STATUSES,
  type SessionRow,
  type SessionStatus,
} from './agent-state.ts';
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
 * In a code channel (`agents.conversations.create`) the session is the whole
 * channel: calls take `channel_id` without `thread_ts`, and renaming the
 * session renames the channel.
 */

function sessionToApi(ctx: Ctx, rows: SessionRow[]): Record<string, unknown> {
  const first = rows[0]!;
  return {
    channel: first.conversation_id,
    thread_ts: first.thread_ts === CHANNEL_SESSION ? null : first.thread_ts,
    status: overall(rows),
    title: sessionTitle(rows),
    agents: rows.map((row) => {
      const app = getApp(ctx, row.app_id);
      return { app_id: row.app_id, bot_user_id: app?.bot_user_id ?? null, name: app?.name ?? '', status: effective(row) };
    }),
  };
}

/** Record a session row for one agent; fields left out keep their value. */
export function recordSession(ctx: Ctx, app: AppRow, conversationId: string, threadTs: string, fields: { status?: SessionStatus; title?: string; initiator?: string | null }): void {
  ctx.db.run(
    `INSERT INTO agent_threads (app_id, conversation_id, thread_ts, title, status, streaming, last_activity, session_status, status_set, initiator)
     VALUES (?, ?, ?, ?, '', 0, ?, ?, ?, ?)
     ON CONFLICT (app_id, conversation_id, thread_ts) DO UPDATE SET
       title = coalesce(?, title), session_status = coalesce(?, session_status), status_set = coalesce(?, status_set),
       initiator = coalesce(initiator, ?), last_activity = excluded.last_activity`,
    app.id,
    conversationId,
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
}

/** The channel name a session title gives a code channel, or null when nothing is left of it. */
function slugFor(title: string): string | null {
  const slug = channelSlug(title);
  return slug && !channelNameError(slug) ? slug : null;
}

/** Tell the people in the conversation what the session looks like now. */
export function emitSession(ctx: Ctx, conversationId: string, threadTs: string): void {
  const rows = sessionsIn(ctx, conversationId, threadTs);
  if (!rows.length) return;
  ctx.bus.emit({ event: { type: 'agent_session', session: sessionToApi(ctx, rows), event_ts: ctx.clock.eventTs() }, audience: { conversation: conversationId }, clientOnly: true });
  // A code channel carries its session in its properties.
  if (threadTs === CHANNEL_SESSION) announceChannel(ctx, conversationId);
}

export function installAgentSessions(kernel: Kernel, delivery: Delivery): void {
  const { ctx, registry } = kernel;

  const emit = (conv: ConvRow, threadTs: string): void => emitSession(ctx, conv.id, threadTs);

  /**
   * The calling agent, the conversation and the session of a call: a thread
   * (`thread_ts`, required in ordinary conversations) or, in a code channel,
   * the channel itself (`thread_ts` not allowed).
   */
  const target = (actor: { isBot: boolean; appId: string | null; userId: string }, channel: string | undefined, threadTs: string | undefined): { app: AppRow; conv: ConvRow; threadTs: string } => {
    if (!actor.isBot || !actor.appId) fail('not_allowed_token_type');
    const app = getApp(ctx, actor.appId) ?? fail('invalid_auth');
    if (!channel) fail('channel_not_found');
    const conv = resolveConv(ctx, actor as never, channel);
    if (!getMember(ctx, conv.id, actor.userId)) fail('not_authorized');
    if (getAgentChannel(ctx, conv.id)) {
      if (threadTs) fail('thread_ts_not_allowed');
      return { app, conv, threadTs: CHANNEL_SESSION };
    }
    if (!threadTs) fail('thread_ts_required');
    if (!/^\d{10}\.\d{6}$/.test(threadTs) || !getMessage(ctx, conv.id, threadTs)) fail('session_not_found');
    return { app, conv, threadTs };
  };

  /** Rename a code channel after its session's new title. `strict` fails on a name that is taken or unusable. */
  const renameChannel = (conv: ConvRow, actorId: string, title: string, strict: boolean): void => {
    const slug = slugFor(title);
    if (!slug) {
      if (strict) fail('invalid_name');
      return;
    }
    if (slug === conv.name) return;
    if (conv.is_archived === 1) {
      if (strict) fail('is_archived');
      return;
    }
    try {
      renameConversation(ctx, conv, actorId, slug);
    } catch (error) {
      if (strict || !(error instanceof ApiError)) throw error;
    }
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
    const conv = app ? getConv(ctx, event.channel) : undefined;
    if (!app || !conv) return;
    const threadTs = getAgentChannel(ctx, conv.id) ? CHANNEL_SESSION : (message.thread_ts ?? message.ts);
    try {
      recordSession(ctx, app, conv.id, threadTs, { status: starting ? 'processing' : 'active' });
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
    recordSession(ctx, app, conv.id, threadTs, { status, title: exists ? undefined : title?.slice(0, 200), initiator: exists ? undefined : (initiator ?? null) });
    emit(conv, threadTs);
    const rows = sessionsIn(ctx, conv.id, threadTs);
    const mine = rows.find((row) => row.app_id === app.id)!;
    const wanted = parseList(app.bot_events);
    return {
      status: overall(rows),
      agent_status: effective(mine),
      title: sessionTitle(rows),
      ...(wanted.length && !wanted.includes('agent_session_stopped') ? { warning: 'missing_agent_session_stopped_event_subscription' } : {}),
    };
  });

  registry.add('agents.sessions.rename', { scopes: ['chat:write'] }, ({ actor, args }) => {
    const title = args.req('title', 'invalid_name').trim();
    if (!title || title.length > 200) fail('invalid_name');
    const { app, conv, threadTs } = target(actor, args.str('channel_id'), args.str('thread_ts'));
    if (threadTs === CHANNEL_SESSION) {
      // Only an agent of the channel renames it; the channel's name follows the title.
      if (!sessionsIn(ctx, conv.id, threadTs).some((row) => row.app_id === app.id)) fail('not_authorized');
      renameChannel(conv, actor.userId, title, true);
    }
    recordSession(ctx, app, conv.id, threadTs, { title });
    emit(conv, threadTs);
    return { title };
  });

  // ── What people do ──────────────────────────────────────────────────────

  /** The session people act on: a thread (`thread_ts`) or, in a code channel, the channel. */
  const personTarget = (actor: Parameters<typeof resolveConv>[1], channel: string, thread: string | undefined): { conv: ConvRow; threadTs: string } => {
    const conv = resolveConv(ctx, actor, channel);
    if (thread) return { conv, threadTs: thread };
    if (!getAgentChannel(ctx, conv.id)) fail('invalid_arguments', { needed: 'thread_ts' });
    return { conv, threadTs: CHANNEL_SESSION };
  };

  registry.add('client.agents.sessions', { auth: 'session' }, ({ actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const threads = ctx.db.all<{ thread_ts: string }>(
      "SELECT thread_ts FROM agent_threads WHERE conversation_id = ? AND session_status != '' GROUP BY thread_ts ORDER BY max(last_activity) DESC LIMIT 200",
      conv.id,
    );
    return { sessions: threads.map(({ thread_ts }) => sessionToApi(ctx, sessionsIn(ctx, conv.id, thread_ts))) };
  });

  /** Stop: the agents still processing in the thread (or code channel) are told; each must stop and update its status. */
  registry.add('client.agents.stop', { auth: 'session' }, ({ actor, args }) => {
    const { conv, threadTs } = personTarget(actor, args.req('channel', 'channel_not_found'), args.ts('thread_ts', 'message_not_found'));
    const channelWide = threadTs === CHANNEL_SESSION;
    let told = 0;
    for (const row of sessionsIn(ctx, conv.id, threadTs)) {
      if (effective(row) !== 'processing') continue;
      const app = getApp(ctx, row.app_id);
      if (!app) continue;
      const streaming = (
        channelWide
          ? ctx.db.all<{ ts: string }>('SELECT ts FROM messages WHERE conversation_id = ? AND streaming = 1 AND app_id = ?', conv.id, app.id)
          : ctx.db.all<{ ts: string }>('SELECT ts FROM messages WHERE conversation_id = ? AND (thread_ts = ? OR ts = ?) AND streaming = 1 AND app_id = ?', conv.id, threadTs, threadTs, app.id)
      ).map((message) => message.ts);
      // Without thread_ts the agent stops all its work in the channel.
      sendToApp(delivery, app, 'agent_session_stopped', {
        type: 'agent_session_stopped',
        channel: conv.id,
        ...(channelWide ? {} : { thread_ts: threadTs }),
        user: actor.userId,
        streaming_message_ts: streaming,
        event_ts: ctx.clock.eventTs(),
      });
      told += 1;
    }
    return { stopped: told };
  });

  registry.add('client.agents.rename', { auth: 'session' }, ({ actor, args }) => {
    const { conv, threadTs } = personTarget(actor, args.req('channel', 'channel_not_found'), args.ts('thread_ts', 'message_not_found'));
    const title = args.req('title', 'invalid_name').trim().slice(0, 200);
    if (!title) fail('invalid_name');
    const rows = sessionsIn(ctx, conv.id, threadTs);
    if (!rows.length) fail('session_not_found');
    if (threadTs === CHANNEL_SESSION && !getMember(ctx, conv.id, actor.userId)) fail('not_in_channel');
    const previous = sessionTitle(rows);
    ctx.db.run("UPDATE agent_threads SET title = ? WHERE conversation_id = ? AND thread_ts = ? AND session_status != ''", title, conv.id, threadTs);
    // A code channel takes the new title as its name when it can; a taken or unusable name keeps the old one.
    if (threadTs === CHANNEL_SESSION) renameChannel(conv, actor.userId, title, false);
    const team = ctx.requireTeam();
    for (const row of rows) {
      const app = getApp(ctx, row.app_id);
      if (!app) continue;
      sendToApp(delivery, app, 'agent_session_title_changed', {
        type: 'agent_session_title_changed',
        channel: conv.id,
        ...(threadTs === CHANNEL_SESSION ? {} : { thread_ts: threadTs }),
        title,
        ...(previous ? { previous_title: previous } : {}),
        user: actor.userId,
        team_id: team.id,
        event_ts: ctx.clock.eventTs(),
      });
    }
    emit(getConv(ctx, conv.id) ?? conv, threadTs);
    return { title, user: getUser(ctx, actor.userId)?.id };
  });
}
