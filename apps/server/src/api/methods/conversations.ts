import { channelNameError, normalizeChannelName } from '@app/shared';
import type { Actor, Ctx } from '../../ctx.ts';
import { addMember, archiveConversation, canManage, canSee, convToApi, createChannel, getConv, getMember, markRead, memberIds, openDirect, removeMember, renameConversation, resolveConv, setDirectOpen, touchConv, type ConvRow, workspaceFromArg } from '../../core/conversations.ts';
import { viewerThreadFields } from '../../attention/threads.ts';
import { fail } from '../../core/errors.ts';
import { nowSeconds } from '../../core/ids.ts';
import { history, messageToApi, postSystemMessage, replies } from '../../core/messages.ts';
import { getUser } from '../../core/users.ts';
import { decodeCursor, encodeCursor, pageByOffset, type Registry } from '../registry.ts';

const READ = ['channels:read', 'groups:read', 'im:read', 'mpim:read'];
const HISTORY = ['channels:history', 'groups:history', 'im:history', 'mpim:history'];
const MANAGE = ['channels:manage', 'groups:write', 'im:write', 'mpim:write'];

function requireChannel(conv: ConvRow): void {
  if (conv.kind === 'im' || conv.kind === 'mpim') fail('method_not_supported_for_channel_type');
}

function requireMember(ctx: Ctx, conv: ConvRow, actor: Actor): void {
  if (!getMember(ctx, conv.id, actor.userId)) fail('not_in_channel');
}

function emitChannelUpdate(ctx: Ctx, conv: ConvRow): void {
  const fresh = getConv(ctx, conv.id)!;
  ctx.bus.emit({
    event: { type: 'channel_updated', channel: convToApi(ctx, fresh, null), event_ts: ctx.clock.eventTs() },
    audience: fresh.kind === 'public' ? { all: true } : { conversation: fresh.id },
    clientOnly: true,
  });
}

export function registerConversations(registry: Registry): void {
  registry.add('conversations.list', { scopes: READ }, ({ ctx, actor, args }) => {
    const types = new Set(args.has('types') ? args.list('types') : ['public_channel']);
    const excludeArchived = args.bool('exclude_archived');
    const rows = ctx.db.all<ConvRow>('SELECT * FROM conversations ORDER BY name IS NULL, name, created');
    const visible = rows.filter((conv) => {
      if (excludeArchived && conv.is_archived === 1) return false;
      if (conv.kind === 'public') return types.has('public_channel') && canSee(ctx, conv, actor.userId);
      const wanted =
        (conv.kind === 'private' && types.has('private_channel')) ||
        (conv.kind === 'im' && types.has('im')) ||
        (conv.kind === 'mpim' && types.has('mpim'));
      return wanted && getMember(ctx, conv.id, actor.userId) !== undefined;
    });
    const { page, response_metadata } = pageByOffset(visible, args.str('cursor'), args.int('limit', 100, { min: 1, max: 1000 }));
    return {
      channels: page.map((conv) => convToApi(ctx, conv, actor.userId, { numMembers: conv.kind !== 'im' })),
      response_metadata,
    };
  });

  registry.add('conversations.info', { scopes: READ }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    return {
      channel: convToApi(ctx, conv, actor.userId, {
        numMembers: args.bool('include_num_members') || actor.kind === 'session',
        readState: actor.kind === 'session',
      }),
    };
  });

  registry.add('conversations.members', { scopes: READ }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const { page, response_metadata } = pageByOffset(
      memberIds(ctx, conv.id),
      args.str('cursor'),
      args.int('limit', 100, { min: 1, max: 1000 }),
    );
    return { members: page, response_metadata };
  });

  registry.add('conversations.history', { scopes: HISTORY }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const limit = args.int('limit', 100, { min: 1, max: 999 });
    const cursor = decodeCursor(args.str('cursor'));
    let latest = args.ts('latest');
    let oldest = args.ts('oldest');
    let inclusive = args.bool('inclusive');
    if (cursor?.startsWith('before:')) {
      latest = cursor.slice('before:'.length);
      inclusive = false;
    } else if (cursor?.startsWith('after:')) {
      oldest = cursor.slice('after:'.length);
      latest = undefined;
      inclusive = false;
    }
    const page = history(ctx, conv, { latest, oldest, inclusive, limit });
    const forward = oldest !== undefined && latest === undefined;
    let next = '';
    if (page.hasMore && page.rows.length > 0) {
      next = forward
        ? encodeCursor(`after:${page.rows[0]!.ts}`)
        : encodeCursor(`before:${page.rows.at(-1)!.ts}`);
    }
    const pinCount = ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM pins WHERE conversation_id = ?', conv.id)?.n ?? 0;
    return {
      messages: page.rows.map((row) => messageToApi(ctx, row)),
      has_more: page.hasMore,
      pin_count: pinCount,
      channel_actions_ts: null,
      channel_actions_count: 0,
      response_metadata: { next_cursor: next },
    };
  });

  registry.add('conversations.replies', { scopes: HISTORY }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const threadTs = args.reqTs('ts', 'thread_not_found');
    const limit = args.int('limit', 1000, { min: 1, max: 1000 });
    const cursor = decodeCursor(args.str('cursor'));
    let oldest = args.ts('oldest');
    let inclusive = args.bool('inclusive');
    if (cursor?.startsWith('after:')) {
      oldest = cursor.slice('after:'.length);
      inclusive = false;
    }
    const page = replies(ctx, conv, threadTs, { latest: args.ts('latest'), oldest, inclusive, limit });
    const messages = page.rows.map((row) => messageToApi(ctx, row));
    // Slack tells the person asking whether they follow the thread and how far they have read.
    const parent = messages[0];
    if (parent && !actor.isBot && parent.thread_ts === parent.ts) Object.assign(parent, viewerThreadFields(ctx, conv.id, parent.ts, actor.userId));
    return {
      messages,
      has_more: page.hasMore,
      response_metadata: { next_cursor: page.hasMore ? encodeCursor(`after:${page.rows.at(-1)!.ts}`) : '' },
    };
  });

  registry.add('conversations.create', { scopes: MANAGE }, ({ ctx, actor, args }) => {
    const conv = createChannel(ctx, {
      name: args.req('name', 'invalid_name_required'),
      isPrivate: args.bool('is_private'),
      creator: actor.userId,
      // In a further workspace of the organisation (src/org checks the creator may).
      workspaceId: workspaceFromArg(ctx, args.str('team_id')),
    });
    return { channel: convToApi(ctx, conv, actor.userId, { numMembers: true }) };
  });

  registry.add('conversations.join', { scopes: ['channels:join', 'channels:manage'] }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    requireChannel(conv);
    if (conv.is_archived === 1) fail('is_archived');
    const joined = addMember(ctx, conv, actor.userId);
    const result: Record<string, unknown> = { channel: convToApi(ctx, conv, actor.userId, { numMembers: true }) };
    if (!joined) {
      result.warning = 'already_in_channel';
      result.response_metadata = { warnings: ['already_in_channel'] };
    }
    return result;
  });

  registry.add('conversations.leave', { scopes: MANAGE }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    requireChannel(conv);
    if (conv.is_general === 1) fail('cant_leave_general');
    const left = removeMember(ctx, conv, actor.userId);
    return left ? {} : { not_in_channel: true };
  });

  registry.add('conversations.invite', { scopes: MANAGE }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    requireChannel(conv);
    requireMember(ctx, conv, actor);
    if (conv.is_archived === 1) fail('is_archived');
    const users = args.list('users');
    if (users.length === 0) fail('no_user');
    const errors: Record<string, unknown>[] = [];
    for (const userId of users) {
      const user = getUser(ctx, userId);
      if (!user || user.deleted === 1) errors.push({ user: userId, ok: false, error: 'user_not_found' });
      else if (userId === actor.userId) errors.push({ user: userId, ok: false, error: 'cant_invite_self' });
      else if (!addMember(ctx, conv, userId, { inviter: actor.userId })) {
        errors.push({ user: userId, ok: false, error: 'already_in_channel' });
      }
    }
    if (errors.length === users.length) fail(String(errors[0]!.error), { errors });
    return { channel: convToApi(ctx, conv, actor.userId, { numMembers: true }), ...(errors.length ? { errors } : {}) };
  });

  registry.add('conversations.kick', { scopes: MANAGE }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    requireChannel(conv);
    const userId = args.req('user', 'user_not_found');
    if (userId === actor.userId) fail('cant_kick_self');
    if (conv.is_general === 1) fail('cant_kick_from_general');
    if (!canManage(conv, actor, ctx)) fail('restricted_action');
    if (!removeMember(ctx, conv, userId)) fail('not_in_channel');
  });

  registry.add('conversations.archive', { scopes: MANAGE }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    requireChannel(conv);
    if (conv.is_general === 1) fail('cant_archive_general');
    if (conv.is_archived === 1) fail('already_archived');
    if (!canManage(conv, actor, ctx)) fail('restricted_action');
    archiveConversation(ctx, conv, actor.userId);
  });

  registry.add('conversations.unarchive', { scopes: MANAGE }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    requireChannel(conv);
    if (conv.is_archived === 0) fail('not_archived');
    if (!canManage(conv, actor, ctx)) fail('restricted_action');
    ctx.db.run('UPDATE conversations SET is_archived = 0, updated = ? WHERE id = ?', nowSeconds(), conv.id);
    ctx.bus.emit({
      event: { type: 'channel_unarchive', channel: conv.id, user: actor.userId, event_ts: ctx.clock.eventTs() },
      audience: conv.kind === 'public' ? { all: true } : { conversation: conv.id },
    });
  });

  registry.add('conversations.rename', { scopes: MANAGE }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    requireChannel(conv);
    if (!canManage(conv, actor, ctx)) fail('not_authorized');
    const name = normalizeChannelName(args.req('name', 'invalid_name_required'));
    const error = channelNameError(name);
    if (error) fail(error);
    renameConversation(ctx, conv, actor.userId, name);
    return { channel: convToApi(ctx, getConv(ctx, conv.id)!, actor.userId) };
  });

  registry.add('conversations.setTopic', { scopes: MANAGE }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    requireMember(ctx, conv, actor);
    if (conv.is_archived === 1) fail('is_archived');
    const topic = (args.str('topic') ?? '').slice(0, 250);
    ctx.db.run(
      'UPDATE conversations SET topic = ?, topic_creator = ?, topic_set = ?, updated = ? WHERE id = ?',
      topic,
      actor.userId,
      nowSeconds(),
      nowSeconds(),
      conv.id,
    );
    if (conv.kind === 'public' || conv.kind === 'private') {
      postSystemMessage(
        ctx,
        conv,
        actor.userId,
        'channel_topic',
        topic ? `<@${actor.userId}> set the channel topic: ${topic}` : `<@${actor.userId}> cleared the channel topic`,
        { topic },
      );
    }
    emitChannelUpdate(ctx, conv);
    return { channel: convToApi(ctx, getConv(ctx, conv.id)!, actor.userId), topic };
  });

  registry.add('conversations.setPurpose', { scopes: MANAGE }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    requireMember(ctx, conv, actor);
    if (conv.is_archived === 1) fail('is_archived');
    const purpose = (args.str('purpose') ?? '').slice(0, 250);
    ctx.db.run(
      'UPDATE conversations SET purpose = ?, purpose_creator = ?, purpose_set = ?, updated = ? WHERE id = ?',
      purpose,
      actor.userId,
      nowSeconds(),
      nowSeconds(),
      conv.id,
    );
    if (conv.kind === 'public' || conv.kind === 'private') {
      postSystemMessage(
        ctx,
        conv,
        actor.userId,
        'channel_purpose',
        purpose ? `<@${actor.userId}> set the channel description: ${purpose}` : `<@${actor.userId}> cleared the channel description`,
        { purpose },
      );
    }
    emitChannelUpdate(ctx, conv);
    return { channel: convToApi(ctx, getConv(ctx, conv.id)!, actor.userId), purpose };
  });

  registry.add('conversations.open', { scopes: ['im:write', 'mpim:write', 'channels:manage'] }, ({ ctx, actor, args }) => {
    let conv: ConvRow;
    let alreadyOpen = false;
    if (args.has('channel')) {
      conv = resolveConv(ctx, actor, args.req('channel'));
      if (conv.kind !== 'im' && conv.kind !== 'mpim') fail('method_not_supported_for_channel_type');
      alreadyOpen = getMember(ctx, conv.id, actor.userId)?.is_open === 1;
      if (!alreadyOpen) setDirectOpen(ctx, conv, actor.userId, true);
    } else {
      const users = args.list('users');
      if (users.length === 0) fail('users_list_not_supplied');
      const opened = openDirect(ctx, actor.userId, users);
      conv = opened.conv;
      alreadyOpen = opened.alreadyOpen;
    }
    const full = args.bool('return_im') || actor.kind === 'session';
    const result: Record<string, unknown> = {
      channel: full ? convToApi(ctx, conv, actor.userId, { readState: true }) : { id: conv.id },
    };
    if (alreadyOpen) {
      result.no_op = true;
      result.already_open = true;
    }
    return result;
  });

  registry.add('conversations.close', { scopes: ['im:write', 'mpim:write', 'channels:manage'] }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    if (conv.kind !== 'im' && conv.kind !== 'mpim') fail('method_not_supported_for_channel_type');
    const member = getMember(ctx, conv.id, actor.userId);
    if (!member || member.is_open === 0) return { no_op: true, already_closed: true };
    setDirectOpen(ctx, conv, actor.userId, false);
    return {};
  });

  registry.add('conversations.mark', { scopes: MANAGE }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    requireMember(ctx, conv, actor);
    markRead(ctx, conv, actor.userId, args.reqTs('ts', 'invalid_timestamp'));
    touchConv(ctx, conv.id);
  });

  /**
   * ext: turn a group DM into a private channel with the same people and its
   * whole history (Slack offers this in its client; there is no public method).
   */
  registry.add('client.conversations.convertGroupDm', { auth: 'session' }, ({ ctx, actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    if (conv.kind !== 'mpim') fail('method_not_supported_for_channel_type');
    if (!getMember(ctx, conv.id, actor.userId)) fail('channel_not_found');
    const name = normalizeChannelName(args.req('name', 'invalid_name_required'));
    const error = channelNameError(name);
    if (error) fail(error);
    if (ctx.db.get("SELECT 1 FROM conversations WHERE name = ? AND kind IN ('public', 'private')", name)) fail('name_taken');
    const now = nowSeconds();
    ctx.db.tx(() => {
      ctx.db.run("UPDATE conversations SET kind = 'private', name = ?, im_key = NULL, creator = ?, updated = ? WHERE id = ?", name, actor.userId, now, conv.id);
      ctx.db.run('UPDATE members SET is_open = 1 WHERE conversation_id = ?', conv.id);
    });
    const converted = getConv(ctx, conv.id)!;
    for (const userId of memberIds(ctx, conv.id)) {
      ctx.bus.emit({
        event: { type: 'channel_joined', channel: convToApi(ctx, converted, userId, { readState: true, numMembers: true }) },
        audience: { users: [userId] },
        clientOnly: true,
      });
    }
    postSystemMessage(ctx, converted, actor.userId, 'channel_convert', `<@${actor.userId}> turned this conversation into the private channel #${name}`, { name });
    return { channel: convToApi(ctx, converted, actor.userId, { readState: true, numMembers: true }) };
  });

  /** ext: public channels the caller could join, with member counts, for the channel browser. */
  registry.add('client.channels.browse', { auth: 'session' }, ({ ctx, actor, args }) => {
    const query = (args.str('query') ?? '').trim().toLowerCase();
    const rows = ctx.db
      .all<ConvRow>("SELECT * FROM conversations WHERE kind IN ('public', 'private') ORDER BY name")
      .filter((conv) => canSee(ctx, conv, actor.userId))
      .filter((conv) => !query || (conv.name ?? '').includes(query) || conv.purpose.toLowerCase().includes(query));
    return { channels: rows.map((conv) => convToApi(ctx, conv, actor.userId, { numMembers: true })) };
  });
}
