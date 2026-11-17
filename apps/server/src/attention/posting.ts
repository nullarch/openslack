import { extractBlockMentions, extractMentions, type Conversation } from '@app/shared';
import type { Registry } from '../api/registry.ts';
import { canManage, conversationExtensions, convToApi, getConv, resolveConv, type ConvRow } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { messageGuards, type NewMessage } from '../core/messages.ts';
import { getUser } from '../core/users.ts';
import type { Ctx } from '../ctx.ts';
import { isChannelManager, isPrivileged } from './common.ts';

/**
 * Posting permissions: who may start messages, reply in threads and use
 * @channel/@here in a channel. "Admins" means workspace admins and the
 * channel's managers. Apps are not restricted.
 */

interface PolicyRow {
  post_policy: string;
  thread_policy: string;
  mention_policy: string;
}

const SYSTEM_SUBTYPES = new Set(['channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name', 'channel_archive', 'channel_unarchive']);

function policy(ctx: Ctx, conversationId: string): PolicyRow {
  return (
    ctx.db.get<PolicyRow>('SELECT post_policy, thread_policy, mention_policy FROM conversations WHERE id = ?', conversationId) ?? {
      post_policy: '',
      thread_policy: '',
      mention_policy: '',
    }
  );
}

export function managers(ctx: Ctx, conversationId: string): string[] {
  return ctx.db
    .all<{ user_id: string }>('SELECT user_id FROM channel_managers WHERE conversation_id = ? ORDER BY user_id', conversationId)
    .map((row) => row.user_id);
}

function hasBroadcast(input: Pick<NewMessage, 'text' | 'blocks'>): boolean {
  if (extractMentions(input.text ?? '').broadcast) return true;
  return input.blocks ? extractBlockMentions(input.blocks).broadcast : false;
}

/** Refuse a message the author may not post here. Shared by posting and scheduling. */
export function checkPosting(ctx: Ctx, conv: ConvRow, userId: string, message: { threadTs?: string | null; broadcast?: boolean; text?: string; blocks?: NewMessage['blocks'] }): void {
  if (conv.kind === 'im' || conv.kind === 'mpim') return;
  const rules = policy(ctx, conv.id);
  if (!rules.post_policy && !rules.thread_policy && !rules.mention_policy) return;
  const user = getUser(ctx, userId);
  if (!user || user.is_bot === 1) return;
  if (isPrivileged(ctx, conv, userId)) return;
  const reply = Boolean(message.threadTs);
  if ((!reply || message.broadcast) && rules.post_policy === 'admins') fail('restricted_action_read_only_channel');
  if (reply && rules.thread_policy === 'admins') fail('restricted_action_non_threadable_channel');
  if (rules.mention_policy === 'admins' && hasBroadcast(message)) fail('restricted_action_at_channel');
}

function guard(ctx: Ctx, input: NewMessage): void {
  if (!input.userId || input.botId) return;
  if (input.subtype && SYSTEM_SUBTYPES.has(input.subtype)) return;
  checkPosting(ctx, input.conv, input.userId, { threadTs: input.threadTs, broadcast: input.broadcast, text: input.text, blocks: input.blocks });
}

function extend(ctx: Ctx, conv: ConvRow, out: Conversation): void {
  if (conv.kind === 'im' || conv.kind === 'mpim') return;
  const rules = policy(ctx, conv.id);
  const properties: NonNullable<Conversation['properties']> = {};
  if (rules.post_policy === 'admins') properties.posting_restrictions = { type: ['admin', 'channel_manager'] };
  if (rules.thread_policy === 'admins') properties.threads_restrictions = { type: ['admin', 'channel_manager'] };
  if (rules.mention_policy === 'admins') {
    properties.at_channel_restricted = true;
    properties.at_here_restricted = true;
  }
  // Other modules add properties too (code channels): merge, never replace.
  if (Object.keys(properties).length > 0) out.properties = { ...out.properties, ...properties };
  const list = managers(ctx, conv.id);
  if (list.length > 0) out.managers = list;
}

function emitUpdate(ctx: Ctx, conv: ConvRow): void {
  const fresh = getConv(ctx, conv.id)!;
  ctx.bus.emit({
    event: { type: 'channel_updated', channel: convToApi(ctx, fresh, null), event_ts: ctx.clock.eventTs() },
    audience: fresh.kind === 'public' ? { all: true } : { conversation: fresh.id },
    clientOnly: true,
  });
}

function channelOnly(conv: ConvRow): void {
  if (conv.kind === 'im' || conv.kind === 'mpim') fail('method_not_supported_for_channel_type');
}

export function installPosting(registry: Registry): void {
  messageGuards.push(guard);
  conversationExtensions.push(extend);

  /** `post`, `threads`, `mentions`: `everyone` or `admins` (workspace admins and channel managers). */
  registry.add('client.conversations.setPostingPolicy', { auth: 'session' }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    channelOnly(conv);
    if (!canManage(conv, actor, ctx)) fail('restricted_action');
    const value = (name: string, current: string): string => {
      if (!args.has(name)) return current;
      const choice = args.req(name);
      if (choice !== 'everyone' && choice !== 'admins') fail('invalid_arguments', { needed: name });
      return choice === 'admins' ? 'admins' : '';
    };
    const rules = policy(ctx, conv.id);
    ctx.db.run(
      'UPDATE conversations SET post_policy = ?, thread_policy = ?, mention_policy = ? WHERE id = ?',
      value('post', rules.post_policy),
      value('threads', rules.thread_policy),
      value('mentions', rules.mention_policy),
      conv.id,
    );
    emitUpdate(ctx, conv);
    return { channel: convToApi(ctx, getConv(ctx, conv.id)!, actor.userId) };
  });

  /** Add or remove channel managers. Workspace admins and existing managers may. */
  registry.add('client.conversations.setManagers', { auth: 'session' }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    channelOnly(conv);
    if (!canManage(conv, actor, ctx) && !isChannelManager(ctx, conv.id, actor.userId)) fail('restricted_action');
    for (const userId of args.list('add')) {
      const user = getUser(ctx, userId);
      if (!user || user.deleted === 1 || user.is_bot === 1) fail('user_not_found');
      ctx.db.run('INSERT OR IGNORE INTO channel_managers (conversation_id, user_id) VALUES (?, ?)', conv.id, userId);
    }
    for (const userId of args.list('remove')) {
      ctx.db.run('DELETE FROM channel_managers WHERE conversation_id = ? AND user_id = ?', conv.id, userId);
    }
    emitUpdate(ctx, conv);
    return { managers: managers(ctx, conv.id) };
  });
}
