import { channelNameError, type ContextBarItem } from '@app/shared';
import type { Kernel } from '../app.ts';
import { canonicalTs } from '../core/clock.ts';
import { addMember, archiveConversation, canSee, createChannel, getConv, getMember, type ConvRow } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { getFile } from '../core/files.ts';
import { nowSeconds } from '../core/ids.ts';
import { getMessage, postMessage, type MsgRow } from '../core/messages.ts';
import { getUser } from '../core/users.ts';
import type { Ctx } from '../ctx.ts';
import type { CanvasHub } from '../docs/hub.ts';
import { emitSession, recordSession } from './agent-sessions.ts';
import {
  agentCommandUrl,
  announceChannel,
  callingAgent,
  channelSlug,
  codeChannel,
  installAgentChannelProperties,
  isChannelAgent,
  parseJson,
  STATUSES,
  type AgentChannelRow,
  type SessionStatus,
} from './agent-state.ts';
import { getApp } from './apps.ts';
import { installCodeViews } from './code-views.ts';
import { sendToApp } from './dispatch.ts';
import { platformServices } from './local-apps.ts';

/**
 * Code channels (Slack's `agents.conversations.*`): a channel an agent creates
 * for one piece of work, usually from the message that asked for it. The
 * channel is the session (`agents.sessions.*` without `thread_ts`); the agent
 * shows what it is doing in a context bar (`setProperties`), in view tabs
 * (`setView`, see `code-views.ts`) and offers its own slash commands there
 * (`setCommands`). When the work is done it archives the channel, optionally
 * sharing a summary back in the thread it started from.
 */

const SCOPES = ['code_channels:manage'];
const ICONS = new Set(['branch', 'folder', 'hierarchy', 'life-ring', 'link', 'globe', 'terminal', 'code', 'search', 'lock']);
const MAX_CONTEXT_ITEMS = 5;
const MAX_COMMANDS = 10;
/** Commands Slack itself answers; an agent may not take their names. */
const BUILTIN_COMMANDS = new Set([
  'active', 'apps', 'archive', 'away', 'call', 'canvas', 'collapse', 'dm', 'dnd', 'expand', 'feed', 'feedback', 'giphy', 'help', 'huddle',
  'invite', 'join', 'keys', 'kick', 'leave', 'list', 'me', 'msg', 'mute', 'open', 'prefs', 'purpose', 'remind', 'remove', 'rename',
  'search', 'shortcuts', 'shrug', 'star', 'status', 'topic', 'who', 'workflows',
]);

type Json = Record<string, unknown>;

/** A readable title from the message that started the work: its first line, people and links by name. */
function titleFrom(ctx: Ctx, message: MsgRow, botUserId: string): string {
  const source = message.text || message.plain || '';
  const text = source
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => {
      if (id === botUserId) return '';
      const user = getUser(ctx, id);
      return user ? user.display_name || user.real_name || user.name : '';
    })
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => label || getConv(ctx, id)?.name || '')
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
    .replace(/<![^>]*>/g, '')
    .replace(/[*_~`]/g, '');
  const first = text.split('\n').map((part) => part.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  // The first sentence, without a closing full stop.
  const line = (/^(.+?[.?!])(?:\s|$)/.exec(first)?.[1] ?? first).replace(/\.$/, '').trim();
  if (line.length <= 80) return line;
  const cut = line.slice(0, 80);
  return (cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut).trim();
}

/** A free channel name for a title: its slug, or the slug with -2, -3, … */
function freeName(ctx: Ctx, title: string): string {
  let base = channelSlug(title);
  if (!base || channelNameError(base)) base = 'agent-session';
  const taken = (name: string): boolean => ctx.db.get("SELECT 1 FROM conversations WHERE name = ? AND kind IN ('public', 'private')", name) !== undefined;
  if (!taken(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 80 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  fail('channel_creation_failed');
}

function readObject(value: unknown, name: string): Json | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_arguments', { needed: name });
  return value as Json;
}

function text(value: unknown, max: number, name: string, required = false): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) fail('invalid_arguments', { needed: name });
    return undefined;
  }
  if (typeof value !== 'string' || value.length > max) fail('invalid_arguments', { needed: name });
  return value;
}

function httpUrl(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return value;
  } catch {
    // Not a URL.
  }
  fail('invalid_arguments', { needed: name });
}

export function installCodeChannels(kernel: Kernel, hub: CanvasHub): void {
  const { ctx, registry } = kernel;
  installAgentChannelProperties();
  const services = (): ReturnType<typeof platformServices> => platformServices(ctx);

  // ── agents.conversations.create ───────────────────────────────────────────

  registry.add('agents.conversations.create', { scopes: SCOPES }, ({ actor, args }) => {
    const app = callingAgent(ctx, actor);
    const team = ctx.requireTeam();
    if (args.has('team_id') && args.str('team_id') !== team.id) fail('team_not_found');

    const sessionId = args.str('session_id')?.trim().slice(0, 255) || null;
    if (sessionId) {
      const existing = ctx.db.get<AgentChannelRow>('SELECT * FROM agent_channels WHERE app_id = ? AND session_id = ?', app.id, sessionId);
      const conv = existing ? getConv(ctx, existing.conversation_id) : undefined;
      if (conv) {
        if (!canSee(ctx, conv, actor.userId)) fail('channel_not_viewable');
        return { channel_id: conv.id };
      }
    }

    // The origin link: both halves or neither, a message the agent can see, in a channel (not a DM or a file's comments).
    const originChannel = args.str('origin_channel_id') || undefined;
    const originTs = args.str('origin_message_ts') || undefined;
    if (Boolean(originChannel) !== Boolean(originTs)) fail('invalid_origin_link');
    let origin: { conv: ConvRow; message: MsgRow } | null = null;
    if (originChannel && originTs) {
      if (/^F[A-Z0-9]+$/.test(originChannel)) {
        const isDoc = ctx.db.get('SELECT 1 FROM docs WHERE id = ? AND deleted = 0', originChannel) !== undefined;
        fail(isDoc || getFile(ctx, originChannel) ? 'origin_channel_is_file_channel' : 'invalid_origin_link');
      }
      const conv = getConv(ctx, originChannel);
      if (!conv || !canSee(ctx, conv, actor.userId)) fail('invalid_origin_link');
      if (conv.kind === 'im' || conv.kind === 'mpim') fail('origin_channel_externally_shared');
      const ts = canonicalTs(originTs);
      const message = ts ? getMessage(ctx, conv.id, ts) : undefined;
      if (!message) fail('invalid_origin_link');
      origin = { conv, message };
    }

    const given = args.str('name')?.trim();
    if (!given && !origin) fail('name_or_origin_required');
    const title = (given || (origin ? titleFrom(ctx, origin.message, actor.userId) : '') || 'Agent session').slice(0, 200);
    const isPrivate = args.has('is_private') ? args.bool('is_private') : origin ? origin.conv.kind === 'private' : false;

    const conv = createChannel(ctx, { name: freeName(ctx, title), isPrivate, creator: actor.userId });
    const author = origin?.message.user_id ? getUser(ctx, origin.message.user_id) : undefined;
    const initiator = author && author.is_bot === 0 && author.deleted === 0 && author.id !== actor.userId ? author : undefined;
    ctx.db.tx(() => {
      ctx.db.run(
        'INSERT INTO agent_channels (conversation_id, app_id, session_id, origin_channel, origin_ts, created) VALUES (?, ?, ?, ?, ?, ?)',
        conv.id,
        app.id,
        sessionId,
        origin?.conv.id ?? null,
        origin?.message.ts ?? null,
        nowSeconds(),
      );
      // The channel is the session, active from the start.
      recordSession(ctx, app, conv.id, '', { status: 'active', title, initiator: initiator?.id ?? null });
    });
    // The person who asked is in the channel, which opens in their sidebar.
    if (initiator) addMember(ctx, conv, initiator.id, { inviter: actor.userId });
    if (origin) {
      // A card in the conversation the work started from points to the new channel.
      try {
        postMessage(ctx, {
          conv: origin.conv,
          userId: actor.userId,
          botId: actor.botId,
          appId: app.id,
          text: `<#${conv.id}>`,
          threadTs: origin.message.thread_ts ?? origin.message.ts,
        });
      } catch (error) {
        console.error('[agents] origin card not posted', error);
      }
    }
    announceChannel(ctx, conv.id);
    return { channel_id: conv.id };
  });

  // ── agents.conversations.archive ──────────────────────────────────────────

  registry.add('agents.conversations.archive', { scopes: SCOPES }, ({ actor, args }) => {
    const app = callingAgent(ctx, actor);
    const { conv, row } = codeChannel(ctx, actor, args.req('channel_id', 'channel_not_found'));
    if (!isChannelAgent(ctx, conv.id, app.id)) fail('not_authorized');
    if (conv.is_archived === 1) fail('already_archived');
    if (args.has('summary_message_ts')) {
      if (!row.origin_channel || !row.origin_ts) fail('no_origin_link');
      const ts = canonicalTs(args.req('summary_message_ts'));
      const summary = ts ? getMessage(ctx, conv.id, ts) : undefined;
      if (!summary) fail('summary_message_not_found');
      const originConv = getConv(ctx, row.origin_channel) ?? fail('origin_channel_not_found');
      const originMessage = getMessage(ctx, originConv.id, row.origin_ts) ?? fail('origin_message_not_found');
      ctx.db.run(
        'UPDATE agent_channels SET summary_message = ? WHERE conversation_id = ?',
        JSON.stringify({ message_ts: summary.ts, ...(summary.thread_ts && summary.thread_ts !== summary.ts ? { thread_ts: summary.thread_ts } : {}) }),
        conv.id,
      );
      // The summary goes back to where the work was asked for, as a reply on the origin message.
      postMessage(ctx, {
        conv: originConv,
        userId: actor.userId,
        botId: actor.botId,
        appId: app.id,
        text: summary.text,
        blocks: parseJson(summary.blocks, null),
        threadTs: originMessage.thread_ts ?? originMessage.ts,
      });
    }
    archiveConversation(ctx, conv, actor.userId);
    announceChannel(ctx, conv.id);
  });

  // ── agents.conversations.setProperties ────────────────────────────────────

  registry.add('agents.conversations.setProperties', { scopes: SCOPES }, ({ actor, args }) => {
    const app = callingAgent(ctx, actor);
    const { conv, row } = codeChannel(ctx, actor, args.req('channel_id', 'channel_not_found'));
    if (!isChannelAgent(ctx, conv.id, app.id)) fail('not_authorized');
    const code = readObject(args.json<unknown>('code_channel'), 'code_channel');
    const resource = readObject(args.json<unknown>('agent_resource'), 'agent_resource');
    const hasTitle = args.raw.title !== undefined;
    const hasStatus = args.raw.status !== undefined;
    if (!code && !resource && !hasTitle && !hasStatus) fail('no_properties_provided');
    const warnings: string[] = [];

    // Deprecated: the session's title and this agent's status, now agents.sessions.rename and setStatus.
    let title: string | undefined;
    if (hasTitle) {
      title = (args.str('title') ?? '').trim();
      if (!title || title.length > 200) fail('invalid_title');
    }
    let status: SessionStatus | undefined;
    if (hasStatus) {
      status = args.str('status') as SessionStatus;
      if (!STATUSES.includes(status)) fail('invalid_status');
    }

    let items: ContextBarItem[] | undefined;
    if (code?.context_bar_items !== undefined) {
      if (!Array.isArray(code.context_bar_items)) fail('invalid_arguments', { needed: 'code_channel.context_bar_items' });
      const given = code.context_bar_items as unknown[];
      if (given.length > MAX_CONTEXT_ITEMS) warnings.push('too_many_context_bar_items');
      const keys = new Set<string>();
      items = given.slice(0, MAX_CONTEXT_ITEMS).map((entry, index) => {
        const item = readObject(entry, `code_channel.context_bar_items[${index}]`) ?? {};
        const key = text(item.key, 64, 'key', true)!;
        if (keys.has(key)) fail('invalid_arguments', { needed: 'key', detail: `duplicate key ${key}` });
        keys.add(key);
        const label = text(item.label, 128, 'label', true)!;
        const icon = text(item.icon, 32, 'icon');
        if (icon !== undefined && !ICONS.has(icon)) fail('invalid_arguments', { needed: 'icon' });
        const url = httpUrl(text(item.url, 2048, 'url'), 'url');
        const kind = text(item.item_type, 16, 'item_type') ?? 'info';
        if (kind !== 'info' && kind !== 'action') fail('invalid_arguments', { needed: 'item_type' });
        let itemType: 'info' | 'action' = kind;
        if (url && itemType === 'action') {
          itemType = 'info';
          if (!warnings.includes('action_with_url_overridden_to_info')) warnings.push('action_with_url_overridden_to_info');
        }
        const out: ContextBarItem = { key, label, item_type: itemType, bot_user_id: actor.userId };
        if (icon) out.icon = icon as ContextBarItem['icon'];
        if (url) out.url = url;
        return out;
      });
    }

    let summary: { message_ts: string; thread_ts?: string } | undefined;
    if (code?.summary_message !== undefined) {
      const value = readObject(code.summary_message, 'code_channel.summary_message') ?? {};
      const messageTs = canonicalTs(String(value.message_ts ?? '')) ?? fail('invalid_arguments', { needed: 'message_ts' });
      const threadTs = value.thread_ts === undefined || value.thread_ts === '' ? undefined : (canonicalTs(String(value.thread_ts)) ?? fail('invalid_arguments', { needed: 'thread_ts' }));
      summary = { message_ts: messageTs, ...(threadTs ? { thread_ts: threadTs } : {}) };
    }

    let nextResource: Json | undefined;
    if (resource) {
      nextResource = { ...parseJson<Json>(row.agent_resource, {}) };
      const limits: Record<string, number> = { url: 2048, resource_type: 64, title: 255, provider: 64 };
      for (const [field, max] of Object.entries(limits)) {
        if (resource[field] === undefined) continue;
        const value = text(resource[field], max, field);
        if (field === 'url') httpUrl(value, 'url');
        if (value === undefined) delete nextResource[field];
        else nextResource[field] = value;
      }
    }

    ctx.db.tx(() => {
      if (items) ctx.db.run('UPDATE agent_channels SET context_bar = ? WHERE conversation_id = ?', JSON.stringify(items), conv.id);
      if (summary) ctx.db.run('UPDATE agent_channels SET summary_message = ? WHERE conversation_id = ?', JSON.stringify(summary), conv.id);
      if (nextResource) ctx.db.run('UPDATE agent_channels SET agent_resource = ? WHERE conversation_id = ?', Object.keys(nextResource).length ? JSON.stringify(nextResource) : null, conv.id);
      if (title !== undefined) ctx.db.run("UPDATE agent_threads SET title = ? WHERE conversation_id = ? AND thread_ts = '' AND session_status != ''", title, conv.id);
      if (status) recordSession(ctx, app, conv.id, '', { status });
    });
    if (title !== undefined || status) emitSession(ctx, conv.id, '');
    announceChannel(ctx, conv.id);
    const out: Json = { channel_id: conv.id };
    if (warnings.length) {
      out.warning = warnings.join(',');
      out.response_metadata = { warnings };
    }
    return out;
  });

  // ── agents.conversations.setCommands ──────────────────────────────────────

  registry.add('agents.conversations.setCommands', { scopes: SCOPES }, ({ actor, args }) => {
    const app = callingAgent(ctx, actor, 'agent_required');
    const { conv } = codeChannel(ctx, actor, args.req('channel_id', 'channel_not_found'));
    if (!isChannelAgent(ctx, conv.id, app.id)) fail('not_authorized');
    let given: unknown = args.raw.commands;
    if (typeof given === 'string') {
      try {
        given = JSON.parse(given);
      } catch {
        fail('invalid_commands');
      }
    }
    if (!Array.isArray(given)) fail('invalid_commands');
    const names = new Set<string>();
    const commands = given.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('invalid_commands');
      const item = entry as Json;
      const raw = typeof item.name === 'string' ? item.name.trim().toLowerCase() : '';
      if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(raw)) fail('invalid_commands', { detail: `invalid name ${String(item.name ?? '')}` });
      if (names.has(raw)) fail('duplicate_command', { detail: raw });
      names.add(raw);
      if (BUILTIN_COMMANDS.has(raw)) fail('colliding_with_builtin', { detail: raw });
      const description = item.description ?? '';
      const hint = item.argument_hint ?? '';
      if (typeof description !== 'string' || description.length > 2000) fail('invalid_commands', { detail: `description of ${raw}` });
      if (typeof hint !== 'string' || hint.length > 1000) fail('invalid_commands', { detail: `argument_hint of ${raw}` });
      return { name: raw, description, argumentHint: hint, shouldEscape: item.should_escape === true };
    });
    const others = ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM agent_commands WHERE conversation_id = ? AND app_id != ?', conv.id, app.id)?.n ?? 0;
    if (others + commands.length > MAX_COMMANDS) fail('too_many_commands');
    if (commands.length && app.socket_mode !== 1 && !agentCommandUrl(app)) fail('no_actions_url');
    const now = nowSeconds();
    ctx.db.tx(() => {
      ctx.db.run('DELETE FROM agent_commands WHERE conversation_id = ? AND app_id = ?', conv.id, app.id);
      commands.forEach((command, position) => {
        ctx.db.run(
          'INSERT INTO agent_commands (conversation_id, app_id, name, description, argument_hint, should_escape, position, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          conv.id,
          app.id,
          command.name,
          command.description,
          command.argumentHint,
          command.shouldEscape ? 1 : 0,
          position,
          now,
        );
      });
    });
    // Composers in the channel refresh their slash-command list.
    ctx.bus.emit({ event: { type: 'commands_changed', channel: conv.id }, audience: { conversation: conv.id }, clientOnly: true });
    return { channel_id: conv.id, command_count: commands.length };
  });

  // ── What people do ────────────────────────────────────────────────────────

  /** Someone clicked an action item of the context bar: the agent that put it there hears `code_channel_action`. */
  registry.add('client.codeChannels.action', { auth: 'session' }, ({ actor, args }) => {
    const { conv, row } = codeChannel(ctx, actor, args.req('channel', 'channel_not_found'));
    if (!getMember(ctx, conv.id, actor.userId)) fail('not_in_channel');
    if (conv.is_archived === 1) fail('is_archived');
    const key = args.req('key');
    const item = parseJson<ContextBarItem[]>(row.context_bar, []).find((entry) => entry.key === key && entry.item_type === 'action');
    if (!item) fail('item_not_found');
    const bot = getUser(ctx, item.bot_user_id);
    const app = bot?.app_id ? getApp(ctx, bot.app_id) : undefined;
    if (!app) fail('app_not_found');
    sendToApp(services().delivery, app, 'code_channel_action', {
      type: 'code_channel_action',
      channel: conv.id,
      user: actor.userId,
      key: item.key,
      team_id: ctx.requireTeam().id,
      action_ts: ctx.clock.eventTs(),
      event_ts: ctx.clock.eventTs(),
    });
    return {};
  });

  installCodeViews(kernel, hub);
}
