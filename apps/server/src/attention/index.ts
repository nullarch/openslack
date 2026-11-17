import { registerDnd, dndSchedule, dndStatus, type DndStatus } from '../api/methods/dnd.ts';
import type { Kernel } from '../app.ts';
import { channelTypeWord, convToApi, getMember, resolveConv } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { registerActivity, unreadActivity } from './activity.ts';
import { registerBookmarks } from './bookmarks.ts';
import { draftsFor, registerDrafts } from './drafts.ts';
import { messagePolicy, registerPolicy } from './policy.ts';
import { installPosting } from './posting.ts';
import { installPreviews } from './previews.ts';
import { registerReminders, reminderSource } from './reminders.ts';
import { savedKeys, registerSaved } from './saved.ts';
import { pendingScheduledCount, registerScheduled, scheduledSource } from './scheduled.ts';
import { Scheduler } from './scheduler.ts';
import { registerShare } from './share.ts';
import { registerThreads, unreadThreads } from './threads.ts';
import { installWatch } from './watch.ts';

/**
 * Messaging and attention: what needs a person's attention and how they
 * control it — activity, followed threads, notification levels, Do Not Disturb,
 * keywords, scheduled messages, reminders, saved items, bookmarks, posting
 * permissions, forwarding, drafts, link previews and the message edit policy.
 */
export function installAttention(kernel: Kernel): void {
  const { ctx, registry, router } = kernel;
  const scheduler = new Scheduler(ctx.instances, 'attention');
  scheduler.add(scheduledSource(ctx));
  scheduler.add(reminderSource(ctx));

  registerActivity(registry);
  registerThreads(registry);
  registerDnd(registry);
  registerScheduled(registry, scheduler);
  registerReminders(registry, scheduler);
  registerSaved(registry, scheduler);
  registerBookmarks(registry);
  registerShare(registry);
  registerDrafts(registry);
  registerPolicy(registry);
  installPosting(registry);

  /** Which messages notify the person here: `default` (mentions), `all`, `mentions` or `nothing`. */
  registry.add('client.conversations.setNotify', { auth: 'session' }, ({ ctx: c, actor, args }) => {
    const conv = resolveConv(c, actor, args.req('channel', 'channel_not_found'));
    if (!getMember(c, conv.id, actor.userId)) fail('not_in_channel');
    const level = args.req('level');
    if (!['default', 'all', 'mentions', 'nothing'].includes(level)) fail('invalid_arguments', { needed: 'level' });
    c.db.run('UPDATE members SET notify_level = ? WHERE conversation_id = ? AND user_id = ?', level, conv.id, actor.userId);
    const channel = convToApi(c, conv, actor.userId, { readState: true, numMembers: channelTypeWord(conv) !== 'im' });
    c.bus.emit({ event: { type: 'channel_prefs_changed', channel }, audience: { users: [actor.userId] }, clientOnly: true });
    return { channel };
  });

  /** Everything the client needs after `client.boot` to draw the attention parts of the screen. */
  registry.add('client.attention.boot', { auth: 'session' }, ({ ctx: c, actor }) => {
    const now = Math.floor(Date.now() / 1000);
    const others: Record<string, DndStatus> = {};
    for (const row of c.db.all<{ user_id: string }>('SELECT user_id FROM dnd WHERE schedule_enabled = 1 OR snooze_until > ?', now)) {
      if (row.user_id !== actor.userId) others[row.user_id] = dndStatus(c, row.user_id, false, now);
    }
    return {
      activity_unread: unreadActivity(c, actor.userId),
      unread_threads: unreadThreads(c, actor.userId).map((item) => ({ channel: item.channel, thread_ts: item.thread_ts })),
      dnd: { self: dndStatus(c, actor.userId, true, now), schedule: dndSchedule(c, actor.userId), users: others },
      saved: savedKeys(c, actor.userId),
      drafts: draftsFor(c, actor.userId),
      scheduled_count: pendingScheduledCount(c, actor.userId),
      message_policy: messagePolicy(c),
    };
  });

  const stopWatch = installWatch(ctx);
  const stopPreviews = installPreviews(ctx, registry, router);
  scheduler.arm();
  kernel.onClose.push(() => {
    scheduler.stop();
    stopWatch();
    stopPreviews();
  });
}
