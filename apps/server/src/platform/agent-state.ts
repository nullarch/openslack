import type { AgentSessionView, ContextBarItem, Conversation } from '@app/shared';
import { conversationExtensions, convToApi, getConv, resolveConv, type ConvRow } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import type { Actor, Ctx } from '../ctx.ts';
import { appConfig, getApp, type AppRow } from './apps.ts';

/**
 * What agent sessions and code channels store, shared by `agent-sessions.ts`
 * (status and title, in threads and in code channels) and `code-channels.ts`
 * (Slack's `agents.conversations.*`).
 *
 * A session is a row of `agent_threads` per agent; a code channel's session is
 * the row with `thread_ts = ''`, so the whole channel is one session. A code
 * channel's agents are the apps with such a row: the one that created it, and
 * any other bot in the channel that reports a status there.
 */

export const STATUSES = ['active', 'processing', 'suspended', 'closed'] as const;
export type SessionStatus = (typeof STATUSES)[number];
const PRECEDENCE: SessionStatus[] = ['suspended', 'processing', 'active', 'closed'];
/** A processing session nobody refreshes goes back to active after an hour, as on Slack. */
const PROCESSING_MS = 3_600_000;

/** `thread_ts` of a code channel's session. */
export const CHANNEL_SESSION = '';

export interface SessionRow {
  app_id: string;
  conversation_id: string;
  thread_ts: string;
  title: string;
  session_status: string;
  status_set: number | null;
  initiator: string | null;
}

export function effective(row: SessionRow): SessionStatus {
  const status = (STATUSES as readonly string[]).includes(row.session_status) ? (row.session_status as SessionStatus) : 'active';
  if (status === 'processing' && row.status_set !== null && Date.now() - row.status_set * 1000 > PROCESSING_MS) return 'active';
  return status;
}

export function sessionsIn(ctx: Ctx, conversationId: string, threadTs: string): SessionRow[] {
  return ctx.db.all<SessionRow>("SELECT * FROM agent_threads WHERE conversation_id = ? AND thread_ts = ? AND session_status != '' ORDER BY app_id", conversationId, threadTs);
}

/** The state across a session's agents: the most pressing one. */
export function overall(rows: SessionRow[]): SessionStatus {
  const states = rows.map(effective);
  return PRECEDENCE.find((status) => states.includes(status)) ?? 'active';
}

export function sessionTitle(rows: SessionRow[]): string {
  return rows.find((row) => row.title)?.title ?? '';
}

// ── Code channels ───────────────────────────────────────────────────────────

export interface AgentChannelRow {
  conversation_id: string;
  app_id: string;
  session_id: string | null;
  origin_channel: string | null;
  origin_ts: string | null;
  context_bar: string;
  summary_message: string | null;
  agent_resource: string | null;
  created: number;
}

export interface ViewRow {
  id: string;
  conversation_id: string;
  app_id: string;
  type: AgentSessionView['type'];
  view_key: string;
  name: string;
  file_id: string;
  canvas_id: string | null;
  body: string;
  options: string;
  content_version: number;
  created: number;
  updated: number;
}

export function getAgentChannel(ctx: Ctx, conversationId: string): AgentChannelRow | undefined {
  return ctx.db.get<AgentChannelRow>('SELECT * FROM agent_channels WHERE conversation_id = ?', conversationId);
}

/** The calling agent: a bot token of an app. */
export function callingAgent(ctx: Ctx, actor: Actor, error = 'not_allowed_token_type'): AppRow {
  if (actor.kind !== 'bot' || !actor.appId) fail(error);
  return getApp(ctx, actor.appId) ?? fail('invalid_auth');
}

/** A code channel the caller can see; `not_agent_channel` for any other channel. */
export function codeChannel(ctx: Ctx, actor: Actor, channel: string | undefined): { conv: ConvRow; row: AgentChannelRow } {
  const conv = resolveConv(ctx, actor, channel);
  const row = getAgentChannel(ctx, conv.id) ?? fail('not_agent_channel');
  return { conv, row };
}

/** A code channel's session rows: the agent that created the channel first, then the others. */
function channelSessions(ctx: Ctx, row: AgentChannelRow): SessionRow[] {
  const rows = sessionsIn(ctx, row.conversation_id, CHANNEL_SESSION);
  return [...rows.filter((session) => session.app_id === row.app_id), ...rows.filter((session) => session.app_id !== row.app_id)];
}

export function isChannelAgent(ctx: Ctx, conversationId: string, appId: string): boolean {
  return ctx.db.get("SELECT 1 FROM agent_threads WHERE conversation_id = ? AND thread_ts = '' AND app_id = ? AND session_status != ''", conversationId, appId) !== undefined;
}

export function viewsOf(ctx: Ctx, conversationId: string): ViewRow[] {
  return ctx.db.all<ViewRow>('SELECT * FROM agent_views WHERE conversation_id = ? ORDER BY created, rowid', conversationId);
}

export function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * A channel name from free text, the way Slack names code channels after their
 * title: lowercase, anything but letters, digits, `_` and `-` becomes `-`.
 */
export function channelSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{Ll}\p{Lo}\p{N}_-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

/** Where a code channel's slash commands go when the app uses HTTP: its manifest's `features.code_channels.slash_command_url`, else its interactivity URL. */
export function agentCommandUrl(app: AppRow): string | null {
  const features = appConfig(app).manifest?.features as { code_channels?: { slash_command_url?: unknown } } | undefined;
  const url = features?.code_channels?.slash_command_url;
  return typeof url === 'string' && url ? url : app.interactivity_url;
}

export function viewToProperty(row: ViewRow): AgentSessionView {
  const out: AgentSessionView = {
    view_id: row.id,
    type: row.type,
    file_id: row.file_id,
    name: row.name,
    date_added: row.created,
    content_version: row.content_version,
  };
  if (row.type !== 'diff') out.view_key = row.view_key;
  if (row.canvas_id) out.canvas_id = row.canvas_id;
  return out;
}

/** `properties` of a code channel, as `conversations.info` returns them. */
export function codeChannelProperties(ctx: Ctx, row: AgentChannelRow): NonNullable<Conversation['properties']> {
  const sessions = channelSessions(ctx, row);
  const bots = sessions.map((session) => getApp(ctx, session.app_id)?.bot_user_id).filter((id): id is string => Boolean(id));
  const agentSession: NonNullable<Conversation['properties']>['agent_session'] = {
    status: overall(sessions),
    encoded_agent_bot_user_ids: bots,
    title: sessionTitle(sessions),
  };
  if (row.origin_channel && row.origin_ts) agentSession.origin_link = { channel_id: row.origin_channel, ts: row.origin_ts };
  const codeChannel: NonNullable<NonNullable<Conversation['properties']>['code_channel']> = {
    context_bar_items: parseJson<ContextBarItem[]>(row.context_bar, []),
    agent_session_views: viewsOf(ctx, row.conversation_id).map(viewToProperty),
  };
  const summary = parseJson<{ message_ts: string; thread_ts?: string } | null>(row.summary_message, null);
  if (summary) codeChannel.summary_message = summary;
  const out: NonNullable<Conversation['properties']> = {
    agent_session: agentSession,
    code_channel: codeChannel,
    record_channel: { record_id: `AC:${ctx.requireTeam().id}:${row.app_id}:${row.conversation_id}`, record_type: 'agent_channel' },
  };
  const resource = parseJson<Record<string, string> | null>(row.agent_resource, null);
  if (resource) out.agent_resource = resource;
  return out;
}

/** Tell everyone who sees the channel that its properties changed (clients patch the conversation). */
export function announceChannel(ctx: Ctx, conversationId: string): void {
  const conv = getConv(ctx, conversationId);
  if (!conv) return;
  ctx.bus.emit({
    event: { type: 'channel_updated', channel: convToApi(ctx, conv, null), event_ts: ctx.clock.eventTs() },
    audience: conv.kind === 'public' ? { all: true } : { conversation: conv.id },
    clientOnly: true,
  });
}

/** Code channel properties on every conversation object (`conversations.info`, `client.boot`, events). */
function extend(ctx: Ctx, conv: ConvRow, out: Conversation): void {
  if (conv.kind !== 'public' && conv.kind !== 'private') return;
  const row = getAgentChannel(ctx, conv.id);
  if (!row) return;
  out.properties = { ...out.properties, ...codeChannelProperties(ctx, row) };
}

/** Hook lists in core are process-wide: add the extension once; it reads the ctx it is called with. */
export function installAgentChannelProperties(): void {
  if (!conversationExtensions.includes(extend)) conversationExtensions.push(extend);
}
