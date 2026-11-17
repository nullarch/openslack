import type { Kernel } from '../app.ts';
import { Args } from '../api/registry.ts';
import { canSee, convToApi, getConv } from '../core/conversations.ts';
import { nowSeconds } from '../core/ids.ts';
import { getMessage } from '../core/messages.ts';
import { getUser } from '../core/users.ts';
import { messageLink } from './context.ts';

/**
 * The Agents view (t160): which apps act as agents, the threads they worked
 * in recently, and what they are doing now. Activity is recorded from the
 * events the app platform already emits (assistant status and titles,
 * streamed messages), so the platform itself is unchanged.
 */

interface ThreadRow {
  app_id: string;
  conversation_id: string;
  thread_ts: string;
  title: string;
  status: string;
  streaming: number;
  last_activity: number;
}

interface AppSummary {
  id: string;
  name: string;
  description: string;
  bot_user_id: string;
  connected: boolean;
}

const THREADS_PER_AGENT = 8;

export function installAgents(kernel: Kernel): void {
  const { ctx, registry } = kernel;

  const appOfBot = (userId: unknown): string | null => {
    if (typeof userId !== 'string') return null;
    return getUser(ctx, userId)?.app_id ?? null;
  };

  const record = (appId: string, channel: string, threadTs: string, fields: Partial<Pick<ThreadRow, 'title' | 'status' | 'streaming'>>): void => {
    ctx.db.run(
      `INSERT INTO agent_threads (app_id, conversation_id, thread_ts, title, status, streaming, last_activity)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (app_id, conversation_id, thread_ts) DO UPDATE SET
         title = coalesce(?, title), status = coalesce(?, status), streaming = coalesce(?, streaming), last_activity = excluded.last_activity`,
      appId,
      channel,
      threadTs,
      fields.title ?? '',
      fields.status ?? '',
      fields.streaming ?? 0,
      nowSeconds(),
      fields.title ?? null,
      fields.status ?? null,
      fields.streaming ?? null,
    );
  };

  const known = (appId: string, channel: string, threadTs: string): boolean =>
    ctx.db.get('SELECT 1 FROM agent_threads WHERE app_id = ? AND conversation_id = ? AND thread_ts = ?', appId, channel, threadTs) !== undefined;

  const unsubscribe = ctx.bus.subscribe(({ event }) => {
    try {
      switch (event.type) {
        case 'assistant_thread_status': {
          const appId = appOfBot(event.user);
          if (appId) record(appId, String(event.channel), String(event.thread_ts), { status: String(event.status ?? '') });
          break;
        }
        case 'assistant_thread_title': {
          const appId = appOfBot(event.user);
          if (appId) record(appId, String(event.channel), String(event.thread_ts), { title: String(event.title ?? '') });
          break;
        }
        case 'message': {
          if (event.subtype === 'message_changed') {
            const message = event.message as { app_id?: string; streaming?: boolean; ts: string; thread_ts?: string } | undefined;
            if (!message?.app_id) break;
            const threadTs = message.thread_ts ?? message.ts;
            if (known(message.app_id, String(event.channel), threadTs)) {
              record(message.app_id, String(event.channel), threadTs, { streaming: message.streaming ? 1 : 0 });
            }
            break;
          }
          const appId = typeof event.app_id === 'string' ? event.app_id : null;
          if (!appId || !event.bot_id) break;
          const threadTs = typeof event.thread_ts === 'string' ? event.thread_ts : String(event.ts);
          if (event.streaming) record(appId, String(event.channel), threadTs, { streaming: 1 });
          // A reply in a thread the agent already works in: activity, and its status is over.
          else if (known(appId, String(event.channel), threadTs)) record(appId, String(event.channel), threadTs, { status: '' });
          break;
        }
      }
    } catch (error) {
      console.error('[ai] agent activity not recorded', error);
    }
  });
  kernel.onClose.push(unsubscribe);

  registry.add('client.agents.list', { auth: 'session' }, async (call) => {
    const { actor } = call;
    // Connection state comes from the app platform's own listing.
    const listing = registry.get('client.apps.list');
    const apps = listing
      ? (((await listing.handler({ ...call, args: new Args({}) })) as { apps?: AppSummary[] } | undefined)?.apps ?? [])
      : [];
    const agents = [];
    for (const app of apps) {
      // Threads only: a code channel's session (thread_ts '') is the channel itself.
      const rows = ctx.db.all<ThreadRow>("SELECT * FROM agent_threads WHERE app_id = ? AND thread_ts != '' ORDER BY last_activity DESC LIMIT 100", app.id);
      if (!app.connected && rows.length === 0) continue;
      const threads = [];
      for (const row of rows) {
        const conv = getConv(ctx, row.conversation_id);
        // Only threads the viewer could open anyway.
        if (!conv || !canSee(ctx, conv, actor.userId)) continue;
        const parent = getMessage(ctx, conv.id, row.thread_ts);
        const channel = convToApi(ctx, conv, actor.userId);
        threads.push({
          channel: conv.id,
          channel_name: channel.name ?? null,
          is_im: channel.is_im,
          thread_ts: row.thread_ts,
          title: row.title || (parent?.plain ?? parent?.text ?? '').slice(0, 120),
          status: row.status,
          streaming: row.streaming === 1,
          last_activity: row.last_activity,
          link: messageLink(conv.id, row.thread_ts, null),
        });
        if (threads.length >= THREADS_PER_AGENT) break;
      }
      const working = threads.find((thread) => thread.streaming || thread.status);
      agents.push({
        app_id: app.id,
        name: app.name,
        description: app.description,
        bot_user_id: app.bot_user_id,
        connected: app.connected,
        state: working ? (working.streaming ? 'replying' : 'working') : app.connected ? 'idle' : 'offline',
        activity: working?.status || null,
        threads,
      });
    }
    agents.sort((a, b) => Number(b.connected) - Number(a.connected) || (b.threads[0]?.last_activity ?? 0) - (a.threads[0]?.last_activity ?? 0));
    return { agents };
  });
}
