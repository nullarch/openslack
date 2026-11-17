import type { Kernel } from '../app.ts';
import { fail } from '../core/errors.ts';
import { getUser } from '../core/users.ts';

/**
 * `dnd.info` and `dnd.teamInfo` answering "not in Do Not Disturb", so apps that
 * check before notifying keep working. They are registered only when nothing
 * else provides these methods: a real Do Not Disturb implementation, installed
 * earlier, takes precedence.
 */
export function installDndPlaceholder(kernel: Kernel): void {
  const { registry, ctx } = kernel;
  const off = { dnd_enabled: false, next_dnd_start_ts: 1, next_dnd_end_ts: 1 };

  if (!registry.get('dnd.info')) {
    registry.add('dnd.info', { scopes: ['dnd:read', 'users:read'] }, ({ actor, args }) => {
      const userId = args.str('user') || actor.userId;
      if (!getUser(ctx, userId)) fail('user_not_found');
      return userId === actor.userId ? { ...off, snooze_enabled: false } : off;
    });
  }

  if (!registry.get('dnd.teamInfo')) {
    registry.add('dnd.teamInfo', { scopes: ['dnd:read', 'users:read'] }, ({ args }) => {
      const ids = args.has('users') ? args.list('users') : ctx.db.all<{ id: string }>('SELECT id FROM users WHERE deleted = 0').map((row) => row.id);
      const users: Record<string, typeof off> = {};
      for (const id of ids) if (getUser(ctx, id)) users[id] = off;
      return { users };
    });
  }
}
