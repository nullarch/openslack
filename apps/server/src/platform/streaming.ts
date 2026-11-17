import type { Block } from '@app/shared';
import type { Kernel } from '../app.ts';
import { postTarget } from '../api/methods/chat.ts';
import type { Args } from '../api/registry.ts';
import type { Actor, Ctx } from '../ctx.ts';
import { resolveConv, type ConvRow } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { getMessage, messageToApi, postMessage, updateMessage, type MsgRow } from '../core/messages.ts';
import type { PlatformOptions } from './options.ts';

type Json = Record<string, unknown>;

const MAX_STREAM_TEXT = 12_000;
const MAX_STREAM_BLOCKS = 50;
const MAX_TASKS = 50;
/** Clients get at most this many updates of one streamed message per second. */
const FLUSHES_PER_SECOND = 10;

interface Task extends Json {
  task_id: string;
  title: string;
  status: string;
}

/** What is kept of an open stream, in the `streams` table. */
interface StreamState {
  /** The bot user that started the stream; only it may append or stop. */
  owner: string;
  /** `text` when driven by `markdown_text`, `chunks` when driven by `chunks`; fixed by the first content. */
  mode: 'text' | 'chunks' | null;
  text: string;
  blocks: Block[];
  tasks: Task[];
  planTitle: string;
  displayMode: 'timeline' | 'plan';
}

interface Stream extends StreamState {
  conversationId: string;
  ts: string;
}

/** This process's timers for a stream it served calls for. */
interface LocalTimers {
  flush: NodeJS.Timeout | null;
  lastFlush: number;
  expiry: NodeJS.Timeout | null;
}

const SWEEP_MS = 5000;

interface Input {
  text: string | null;
  chunks: Json[] | null;
}

function readInput(args: Args): Input {
  const text = args.str('markdown_text');
  const chunks = args.json<Json[]>('chunks');
  if (text !== undefined && text !== '' && chunks !== undefined) fail('cannot_provide_both_markdown_text_and_chunks');
  if (chunks !== undefined && !Array.isArray(chunks)) fail('invalid_chunks');
  return { text: text !== undefined && text !== '' ? text : null, chunks: chunks ?? null };
}

function richText(text: string): Json {
  return { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }] };
}

/**
 * Streamed messages (`chat.startStream`, `chat.appendStream`, `chat.stopStream`):
 * one message that grows while an agent writes it. The accumulated Markdown is
 * kept as a `markdown` block and as the fallback `text`; task updates become
 * `task_card` blocks or one `plan` block. While it is open the message carries
 * `streaming: true`, and connected clients see it change at most ten times a
 * second. Apps see the message appear and the final version, not every step.
 *
 * An open stream's content is kept in the `streams` table, so the app's next
 * call may reach any process, and a stream survives a restart. One the app
 * never stops is closed when its time is up: by the process that started it,
 * or by the leader's sweep when that process is gone.
 */
export class Streams {
  private readonly ctx: Ctx;
  private readonly options: PlatformOptions;
  private readonly timers = new Map<string, LocalTimers>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(ctx: Ctx, options: PlatformOptions) {
    this.ctx = ctx;
    this.options = options;
  }

  install(kernel: Kernel): void {
    kernel.onClose.push(() => this.stop());
    // Messages left streaming without a stored stream (an older server kept streams in memory) are final now.
    this.ctx.instances.onLeader(() => {
      this.ctx.db.run(
        'UPDATE messages SET streaming = 0 WHERE streaming = 1 AND NOT EXISTS (SELECT 1 FROM streams s WHERE s.conversation_id = messages.conversation_id AND s.ts = messages.ts)',
      );
      this.sweep();
    });
    this.sweeper = setInterval(() => {
      if (this.ctx.instances.isLeader()) this.sweep();
    }, SWEEP_MS);
    this.sweeper.unref();

    kernel.registry.add('chat.startStream', { scopes: ['chat:write'] }, ({ actor, args }) => {
      const conv = postTarget(this.ctx, actor, args);
      const input = readInput(args);
      const displayMode = args.str('task_display_mode') === 'plan' ? 'plan' : 'timeline';
      // "0" means "not in a thread", as it does on Slack.
      const threadArg = args.str('thread_ts');
      const threadTs = threadArg && threadArg !== '0' ? args.ts('thread_ts') : undefined;
      if (threadTs && !getMessage(this.ctx, conv.id, threadTs)) fail('invalid_thread_ts');

      const draft = this.blank(conv.id, '', actor.userId, displayMode);
      this.absorb(draft, input);
      const row = this.ctx.db.tx(() => {
        const posted = postMessage(this.ctx, {
          conv,
          userId: actor.userId,
          botId: actor.botId,
          appId: actor.isBot ? actor.appId : null,
          text: draft.text,
          blocks: this.render(draft, []),
          threadTs,
          streaming: true,
          username: args.str('username') ?? null,
          iconEmoji: args.str('icon_emoji') ?? null,
          iconUrl: args.str('icon_url') ?? null,
        });
        draft.ts = posted.ts;
        this.ctx.db.run(
          'INSERT INTO streams (conversation_id, ts, owner, state, expires) VALUES (?, ?, ?, ?, ?)',
          conv.id,
          posted.ts,
          actor.userId,
          JSON.stringify(stateOf(draft)),
          Date.now() + this.options.streamTimeoutMs,
        );
        return posted;
      });
      const local = this.local(conv.id, row.ts);
      local.lastFlush = Date.now();
      local.expiry = setTimeout(() => this.expire(conv.id, row.ts), this.options.streamTimeoutMs);
      local.expiry.unref();
      return { channel: conv.id, ts: row.ts };
    });

    kernel.registry.add('chat.appendStream', { scopes: ['chat:write'] }, ({ actor, args }) => {
      const input = readInput(args);
      if (input.text === null && input.chunks === null) fail('markdown_text_or_chunks_required');
      const { conv, ts } = this.ctx.db.tx(() => {
        const found = this.find(actor, args);
        this.absorb(found.stream, input);
        this.save(found.stream);
        return { conv: found.conv, ts: found.stream.ts };
      });
      this.schedule(conv.id, ts);
      return { channel: conv.id, ts };
    });

    kernel.registry.add('chat.stopStream', { scopes: ['chat:write'] }, ({ actor, args }) => {
      const trailing = args.json<Block[]>('blocks');
      if (trailing !== undefined && (!Array.isArray(trailing) || trailing.length > MAX_STREAM_BLOCKS)) fail('invalid_blocks');
      const { conv, stream } = this.ctx.db.tx(() => {
        const found = this.find(actor, args);
        this.absorb(found.stream, readInput(args));
        this.ctx.db.run('DELETE FROM streams WHERE conversation_id = ? AND ts = ?', found.conv.id, found.stream.ts);
        return found;
      });
      const row = this.finish(stream, trailing ?? [], args.has('metadata') ? args.json('metadata') : undefined);
      return { channel: conv.id, ts: stream.ts, message: row ? messageToApi(this.ctx, row) : undefined };
    });
  }

  private blank(conversationId: string, ts: string, owner: string, displayMode: Stream['displayMode']): Stream {
    return { conversationId, ts, owner, mode: null, text: '', blocks: [], tasks: [], planTitle: '', displayMode };
  }

  private load(conversationId: string, ts: string): Stream | undefined {
    const row = this.ctx.db.get<{ state: string }>('SELECT state FROM streams WHERE conversation_id = ? AND ts = ?', conversationId, ts);
    return row ? { ...(JSON.parse(row.state) as StreamState), conversationId, ts } : undefined;
  }

  private save(stream: Stream): void {
    this.ctx.db.run('UPDATE streams SET state = ? WHERE conversation_id = ? AND ts = ?', JSON.stringify(stateOf(stream)), stream.conversationId, stream.ts);
  }

  private local(conversationId: string, ts: string): LocalTimers {
    const key = `${conversationId}:${ts}`;
    let timers = this.timers.get(key);
    if (!timers) {
      timers = { flush: null, lastFlush: 0, expiry: null };
      this.timers.set(key, timers);
    }
    return timers;
  }

  private find(actor: Actor, args: Args): { conv: ConvRow; stream: Stream } {
    const conv = resolveConv(this.ctx, actor, args.req('channel', 'channel_not_found'));
    const ts = args.reqTs('ts');
    const row = getMessage(this.ctx, conv.id, ts);
    if (!row) fail('message_not_found');
    const stream = this.load(conv.id, ts);
    if (!stream || row.streaming !== 1) fail('message_not_in_streaming_state');
    if (stream.owner !== actor.userId) fail('message_not_owned_by_app');
    return { conv, stream };
  }

  /** Add one call's content to the stream. */
  private absorb(stream: Stream, input: Input): void {
    if (input.text !== null) {
      if (stream.mode === 'chunks') fail('streaming_mode_mismatch');
      stream.mode = 'text';
      if (stream.text.length + input.text.length > MAX_STREAM_TEXT) fail('msg_too_long');
      stream.text += input.text;
      return;
    }
    if (input.chunks === null || input.chunks.length === 0) return;
    if (stream.mode === 'text') fail('streaming_mode_mismatch');
    stream.mode = 'chunks';
    for (const chunk of input.chunks) {
      if (!chunk || typeof chunk !== 'object') fail('invalid_chunks');
      if (chunk.type === 'markdown_text' && typeof chunk.text === 'string') {
        if (stream.text.length + chunk.text.length > MAX_STREAM_TEXT) fail('msg_too_long');
        stream.text += chunk.text;
      } else if (chunk.type === 'blocks' && Array.isArray(chunk.blocks)) {
        for (const block of chunk.blocks as Block[]) {
          if (!block || typeof block !== 'object' || typeof block.type !== 'string') fail('invalid_chunks');
          const index = block.block_id ? stream.blocks.findIndex((entry) => entry.block_id === block.block_id) : -1;
          if (index >= 0) stream.blocks[index] = block;
          else if (stream.blocks.length < MAX_STREAM_BLOCKS) stream.blocks.push(block);
        }
      } else if (chunk.type === 'task_update' && typeof chunk.id === 'string') {
        this.upsertTask(stream, chunk);
      } else if (chunk.type === 'plan_update' && typeof chunk.title === 'string') {
        stream.planTitle = chunk.title;
      } else {
        fail('invalid_chunks');
      }
    }
  }

  private upsertTask(stream: Stream, chunk: Json): void {
    let task = stream.tasks.find((entry) => entry.task_id === chunk.id);
    if (!task) {
      if (stream.tasks.length >= MAX_TASKS) return;
      task = { task_id: chunk.id as string, title: '', status: 'pending' };
      stream.tasks.push(task);
    }
    if (typeof chunk.title === 'string') task.title = chunk.title;
    if (typeof chunk.status === 'string') task.status = chunk.status;
    if (typeof chunk.hide_title === 'boolean') task.hide_title = chunk.hide_title;
    if (chunk.icon && typeof chunk.icon === 'object') task.icon = chunk.icon;
    if (typeof chunk.details === 'string' && chunk.details.length <= MAX_STREAM_TEXT) task.details = richText(chunk.details);
    if (typeof chunk.output === 'string' && chunk.output.length <= MAX_STREAM_TEXT) task.output = richText(chunk.output);
    if (Array.isArray(chunk.sources)) {
      if (chunk.sources.length > 50) fail('invalid_arguments');
      task.sources = chunk.sources;
    }
  }

  /** The message's blocks: the Markdown so far, the tasks, streamed blocks, then any trailing blocks. */
  private render(stream: Stream, trailing: Block[]): Block[] {
    const blocks: Block[] = [];
    if (stream.text) blocks.push({ type: 'markdown', text: stream.text });
    if (stream.displayMode === 'plan') {
      if (stream.tasks.length > 0 || stream.planTitle) {
        blocks.push({ type: 'plan', title: stream.planTitle, tasks: stream.tasks });
      }
    } else {
      // Tasks that have not started are not shown in the timeline.
      for (const task of stream.tasks) {
        if (task.status !== 'pending') blocks.push({ type: 'task_card', ...task });
      }
    }
    blocks.push(...stream.blocks, ...trailing);
    return blocks;
  }

  private schedule(conversationId: string, ts: string): void {
    const local = this.local(conversationId, ts);
    if (local.flush) return;
    const wait = local.lastFlush + 1000 / FLUSHES_PER_SECOND - Date.now();
    if (wait <= 0) {
      this.flush(conversationId, ts);
      return;
    }
    local.flush = setTimeout(() => {
      local.flush = null;
      this.flush(conversationId, ts);
    }, wait);
    local.flush.unref();
  }

  /** Write the stream's current content to the message and tell connected clients. */
  private flush(conversationId: string, ts: string): void {
    const local = this.local(conversationId, ts);
    const stream = this.load(conversationId, ts);
    const conv = this.ctx.db.get<ConvRow>('SELECT * FROM conversations WHERE id = ?', conversationId);
    const row = getMessage(this.ctx, conversationId, ts);
    if (!stream || !conv || !row || row.streaming !== 1) {
      // Stopped meanwhile, perhaps by another process.
      this.forget(conversationId, ts);
      return;
    }
    updateMessage(this.ctx, conv, row, { text: stream.text, blocks: this.render(stream, []) }, { clientOnly: true });
    local.lastFlush = Date.now();
  }

  private forget(conversationId: string, ts: string): void {
    const key = `${conversationId}:${ts}`;
    const local = this.timers.get(key);
    if (!local) return;
    if (local.flush) clearTimeout(local.flush);
    if (local.expiry) clearTimeout(local.expiry);
    this.timers.delete(key);
  }

  /** The app never stopped the stream: keep what arrived and mark unfinished tasks as failed. */
  private expire(conversationId: string, ts: string): void {
    const stream = this.ctx.db.tx(() => {
      const found = this.load(conversationId, ts);
      if (found) this.ctx.db.run('DELETE FROM streams WHERE conversation_id = ? AND ts = ?', conversationId, ts);
      return found;
    });
    if (!stream) {
      this.forget(conversationId, ts);
      return;
    }
    for (const task of stream.tasks) {
      if (task.status === 'pending' || task.status === 'in_progress') task.status = 'error';
    }
    this.finish(stream);
  }

  /** Leader: close streams whose time is up and whose process is gone (or restarted). */
  private sweep(): void {
    for (const row of this.ctx.db.all<{ conversation_id: string; ts: string }>('SELECT conversation_id, ts FROM streams WHERE expires <= ?', Date.now())) {
      this.expire(row.conversation_id, row.ts);
    }
  }

  /**
   * Close a stream: the final content is saved, the streaming flag is cleared
   * and everyone, apps included, is told once.
   */
  private finish(stream: Stream, trailing: Block[] = [], metadata?: unknown): MsgRow | undefined {
    this.forget(stream.conversationId, stream.ts);
    const conv = this.ctx.db.get<ConvRow>('SELECT * FROM conversations WHERE id = ?', stream.conversationId);
    const row = getMessage(this.ctx, stream.conversationId, stream.ts);
    if (!conv || !row) return undefined;
    return updateMessage(this.ctx, conv, row, {
      text: stream.text,
      blocks: this.render(stream, trailing),
      streaming: false,
      ...(metadata === undefined ? {} : { metadata }),
    });
  }

  private stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const key of [...this.timers.keys()]) {
      const [conversationId, ts] = key.split(':') as [string, string];
      this.forget(conversationId, ts);
    }
  }
}

function stateOf(stream: Stream): StreamState {
  const { owner, mode, text, blocks, tasks, planTitle, displayMode } = stream;
  return { owner, mode, text, blocks, tasks, planTitle, displayMode };
}
