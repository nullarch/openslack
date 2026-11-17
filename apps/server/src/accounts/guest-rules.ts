import type { Kernel } from '../app.ts';
import type { Call, MethodDef } from '../api/registry.ts';
import { canSee, getConv, memberIds, type MemberRow } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { canSeeUser, isGuest, visibleUserIds } from '../core/guests.ts';
import { nowSeconds } from '../core/ids.ts';
import { emitUserChange, getUser, isAdmin, requireUser, userToApi } from '../core/users.ts';
import type { Ctx } from '../ctx.ts';

type Loose = Record<string, unknown>;

/** Replace a method, keeping its authorisation, with one that can run code before and after it. */
function around(kernel: Kernel, name: string, handler: (call: Call, original: MethodDef['handler']) => Promise<Loose | void>): void {
  const original = kernel.registry.get(name);
  if (!original) throw new Error(`cannot wrap missing method ${name}`);
  const auth = original.auth === 'none' ? 'any' : original.auth;
  kernel.registry.add(name, { auth, scopes: original.scopes }, (call) => handler(call, original.handler));
}

async function run(original: MethodDef['handler'], call: Call): Promise<Loose> {
  return ((await original(call)) ?? {}) as Loose;
}

/** Visibility rules for guests, applied on top of the ordinary methods. */
export function installGuestRules(kernel: Kernel): void {
  const { ctx } = kernel;
  const guest = (call: Call): boolean => isGuest(ctx, call.actor.userId);
  const mustSee = (call: Call, userId: string | undefined): void => {
    if (userId && !canSeeUser(ctx, call.actor.userId, userId)) fail('user_not_found');
  };

  around(kernel, 'users.list', async (call, original) => {
    const result = await run(original, call);
    if (!guest(call)) return result;
    const visible = visibleUserIds(ctx, call.actor.userId);
    return { ...result, members: (result.members as { id: string }[]).filter((user) => visible.has(user.id)) };
  });

  for (const name of ['users.info', 'users.profile.get', 'users.getPresence']) {
    around(kernel, name, async (call, original) => {
      if (guest(call)) mustSee(call, call.args.str('user'));
      return run(original, call);
    });
  }

  around(kernel, 'users.lookupByEmail', async (call, original) => {
    const result = await run(original, call);
    if (guest(call)) mustSee(call, (result.user as { id: string }).id);
    return result;
  });

  around(kernel, 'bots.info', async (call, original) => {
    const result = await run(original, call);
    if (guest(call)) {
      const userId = (result.bot as { user_id?: string } | undefined)?.user_id;
      if (userId && !canSeeUser(ctx, call.actor.userId, userId)) fail('bot_not_found');
    }
    return result;
  });

  around(kernel, 'users.conversations', async (call, original) => {
    const target = call.args.str('user');
    if (guest(call)) mustSee(call, target);
    const result = await run(original, call);
    if (!guest(call)) return result;
    const channels = (result.channels as { id: string }[]).filter((channel) => {
      const conv = getConv(ctx, channel.id);
      return conv !== undefined && canSee(ctx, conv, call.actor.userId);
    });
    return { ...result, channels };
  });

  // RTM's heavier start lists people; Do Not Disturb lists people too.
  if (kernel.registry.get('rtm.start')) {
    around(kernel, 'rtm.start', async (call, original) => {
      const result = await run(original, call);
      if (!guest(call)) return result;
      const visible = visibleUserIds(ctx, call.actor.userId);
      return { ...result, users: (result.users as { id: string }[]).filter((user) => visible.has(user.id)) };
    });
  }
  if (kernel.registry.get('dnd.teamInfo')) {
    around(kernel, 'dnd.teamInfo', async (call, original) => {
      const result = await run(original, call);
      if (!guest(call)) return result;
      const visible = visibleUserIds(ctx, call.actor.userId);
      return { ...result, users: Object.fromEntries(Object.entries(result.users as Record<string, unknown>).filter(([id]) => visible.has(id))) };
    });
  }
  if (kernel.registry.get('dnd.info')) {
    around(kernel, 'dnd.info', async (call, original) => {
      if (guest(call)) mustSee(call, call.args.str('user'));
      return run(original, call);
    });
  }

  // Guests are added to channels by admins only; a single-channel guest stays in one.
  around(kernel, 'conversations.invite', async (call, original) => {
    if (guest(call)) fail('restricted_action');
    const channel = call.args.str('channel');
    const conv = channel ? getConv(ctx, channel) : undefined;
    for (const userId of call.args.list('users')) {
      const user = getUser(ctx, userId);
      if (!user || user.guest === '') continue;
      if (!isAdmin(call.actor)) fail('restricted_action', { user: userId });
      if (user.guest === 'single') {
        const elsewhere = ctx.db.get<MemberRow>(
          `SELECT m.* FROM members m JOIN conversations c ON c.id = m.conversation_id
           WHERE m.user_id = ? AND c.kind IN ('public', 'private') AND m.conversation_id != ?`,
          userId,
          conv?.id ?? '',
        );
        if (elsewhere) fail('ura_max_channels', { user: userId });
      }
    }
    return run(original, call);
  });

  // Turning a group DM into a private channel adds its guests to a channel:
  // the same rules as inviting them, checked only for people already in it.
  around(kernel, 'client.conversations.convertGroupDm', async (call, original) => {
    const conv = getConv(ctx, call.args.str('channel') ?? '');
    const members = conv?.kind === 'mpim' ? memberIds(ctx, conv.id) : [];
    if (members.includes(call.actor.userId)) {
      for (const userId of members) {
        const user = getUser(ctx, userId);
        if (!user || user.guest === '') continue;
        if (!isAdmin(call.actor)) fail('restricted_action', { user: userId });
        if (
          user.guest === 'single' &&
          ctx.db.get("SELECT 1 FROM members m JOIN conversations c ON c.id = m.conversation_id WHERE m.user_id = ? AND c.kind IN ('public', 'private')", userId)
        ) {
          fail('ura_max_channels', { user: userId });
        }
      }
    }
    return run(original, call);
  });

  // Guests' tabs know only the people they can see.
  around(kernel, 'client.boot', async (call, original) => {
    const result = await run(original, call);
    if (!guest(call)) return result;
    const visible = visibleUserIds(ctx, call.actor.userId);
    const presence = Object.fromEntries(Object.entries(result.presence as Loose).filter(([id]) => visible.has(id)));
    return { ...result, users: (result.users as { id: string }[]).filter((user) => visible.has(user.id)), presence };
  });

  // Change an account between member and the two kinds of guest.
  kernel.registry.add('client.admin.setAccountType', { auth: 'admin' }, ({ actor, args }) => {
    const target = requireUser(ctx, args.req('user'));
    const type = args.req('type');
    if (!['member', 'multi', 'single'].includes(type)) fail('invalid_arguments', { needed: 'type' });
    if (target.is_bot === 1 || target.role !== 'member') fail('cannot_change_role');
    if (target.id === actor.userId) fail('cannot_change_self');
    const guestType = type === 'member' ? '' : type;
    if (guestType === 'single') {
      const channels =
        ctx.db.get<{ n: number }>(
          `SELECT count(*) AS n FROM members m JOIN conversations c ON c.id = m.conversation_id
           WHERE m.user_id = ? AND c.kind IN ('public', 'private')`,
          target.id,
        )?.n ?? 0;
      if (channels > 1) fail('ura_max_channels');
    }
    const days = args.int('expires_in_days', -1, { min: -1, max: 3650 });
    const expires = guestType === '' ? 0 : days > 0 ? nowSeconds() + days * 86_400 : days === 0 ? 0 : target.guest_expires;
    ctx.db.run('UPDATE users SET guest = ?, guest_expires = ?, updated = ? WHERE id = ?', guestType, expires, nowSeconds(), target.id);
    emitUserChange(ctx, target.id);
    return { user: userToApi(ctx, requireUser(ctx, target.id), actor) };
  });

}
