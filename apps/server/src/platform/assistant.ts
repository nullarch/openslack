import type { Kernel } from '../app.ts';
import type { Ctx } from '../ctx.ts';
import { resolveConv, type ConvRow } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { getMessage } from '../core/messages.ts';
import type { PlatformOptions } from './options.ts';

const SCOPES = ['assistant:write', 'chat:write'];

/**
 * `assistant.threads.*`: what an agent shows while it works. A status
 * ("is thinking…") is live state, not a message: it goes to connected clients
 * as an `assistant_thread_status` event and disappears when the app posts in
 * that thread, when the app clears it, or after two minutes.
 */
export class AssistantThreads {
  private readonly ctx: Ctx;
  private readonly options: PlatformOptions;
  /** Active statuses by `<conversation>:<thread>:<bot user>`. */
  private readonly statuses = new Map<string, NodeJS.Timeout>();

  constructor(ctx: Ctx, options: PlatformOptions) {
    this.ctx = ctx;
    this.options = options;
  }

  install(kernel: Kernel): void {
    const { ctx } = this;

    kernel.registry.add('assistant.threads.setStatus', { scopes: SCOPES }, ({ actor, args }) => {
      const conv = resolveConv(ctx, actor, args.req('channel_id', 'channel_not_found'));
      const threadTs = args.reqTs('thread_ts', 'invalid_thread_ts');
      if (!getMessage(ctx, conv.id, threadTs)) fail('invalid_thread_ts', { detail: 'Thread not found' });
      const status = (args.str('status') ?? '').slice(0, 200);
      const loading = args.has('loading_messages') ? args.list('loading_messages').slice(0, 10) : undefined;
      this.setStatus(conv, threadTs, actor.userId, status, loading);
    });

    kernel.registry.add('assistant.threads.setTitle', { scopes: SCOPES }, ({ actor, args }) => {
      const conv = resolveConv(ctx, actor, args.req('channel_id', 'channel_not_found'));
      const threadTs = args.reqTs('thread_ts', 'invalid_thread_ts');
      if (!getMessage(ctx, conv.id, threadTs)) fail('invalid_thread_ts', { detail: 'Thread not found' });
      ctx.bus.emit({
        event: {
          type: 'assistant_thread_title',
          channel: conv.id,
          thread_ts: threadTs,
          title: args.req('title').slice(0, 200),
          user: actor.userId,
        },
        audience: { conversation: conv.id },
        clientOnly: true,
      });
    });

    kernel.registry.add('assistant.threads.setSuggestedPrompts', { scopes: SCOPES }, ({ actor, args }) => {
      const conv = resolveConv(ctx, actor, args.req('channel_id', 'channel_not_found'));
      const threadTs = args.ts('thread_ts');
      if (threadTs && !getMessage(ctx, conv.id, threadTs)) fail('invalid_thread_ts', { detail: 'Thread not found' });
      const prompts = args.json<{ title?: unknown; message?: unknown }[]>('prompts');
      if (!Array.isArray(prompts) || prompts.length === 0) fail('invalid_arguments', { needed: 'prompts' });
      const event: { type: string; [key: string]: unknown } = {
        type: 'assistant_thread_prompts',
        channel: conv.id,
        title: args.str('title') ?? '',
        prompts: prompts
          .slice(0, 4)
          .map((prompt) => ({ title: String(prompt.title ?? ''), message: String(prompt.message ?? '') })),
        user: actor.userId,
      };
      if (threadTs) event.thread_ts = threadTs;
      ctx.bus.emit({ event, audience: { conversation: conv.id }, clientOnly: true });
    });

    // An app's own message in the thread replaces its status.
    const unsubscribe = ctx.bus.subscribe(({ event }) => {
      if (event.type !== 'message' || event.subtype !== undefined || event.is_ephemeral === true) return;
      if (typeof event.channel !== 'string' || typeof event.user !== 'string' || typeof event.ts !== 'string') return;
      const threadTs = typeof event.thread_ts === 'string' ? event.thread_ts : event.ts;
      const key = `${event.channel}:${threadTs}:${event.user}`;
      if (!this.statuses.has(key)) return;
      const conv = ctx.db.get<ConvRow>('SELECT * FROM conversations WHERE id = ?', event.channel);
      if (conv) this.setStatus(conv, threadTs, event.user, '');
    });
    kernel.onClose.push(() => {
      unsubscribe();
      for (const timer of this.statuses.values()) clearTimeout(timer);
      this.statuses.clear();
    });
  }

  private setStatus(conv: ConvRow, threadTs: string, userId: string, status: string, loading?: string[]): void {
    const key = `${conv.id}:${threadTs}:${userId}`;
    const previous = this.statuses.get(key);
    if (previous) clearTimeout(previous);
    this.statuses.delete(key);
    if (status === '' && !previous) return;
    if (status !== '') {
      const timer = setTimeout(() => this.setStatus(conv, threadTs, userId, ''), this.options.statusTimeoutMs);
      timer.unref();
      this.statuses.set(key, timer);
    }
    const event: { type: string; [key: string]: unknown } = {
      type: 'assistant_thread_status',
      channel: conv.id,
      thread_ts: threadTs,
      user: userId,
      status,
    };
    if (loading?.length) event.loading_messages = loading;
    this.ctx.bus.emit({ event, audience: { conversation: conv.id }, clientOnly: true });
  }
}
