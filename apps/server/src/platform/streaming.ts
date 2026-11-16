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

interface Stream {
  conversationId: string;
  ts: string;
  /** The bot user that started the stream; only it may append or stop. */
  owner: string;
  /** `text` when driven by `markdown_text`, `chunks` when driven by `chunks`; fixed by the first content. */
  mode: 'text' | 'chunks' | null;
  text: string;
  blocks: Block[];
  tasks: Task[];
  planTitle: string;
  displayMode: 'timeline' | 'plan';
  dirty: boolean;
  lastFlush: number;
  flushTimer: NodeJS.Timeout | null;
  expiry: NodeJS.Timeout | null;
}

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
 */
export class Streams {
  private readonly ctx: Ctx;
  private readonly options: PlatformOptions;
  private readonly streams = new Map<string, Stream>();

  constructor(ctx: Ctx, options: PlatformOptions) {
    this.ctx = ctx;
    this.options = options;
  }

  install(kernel: Kernel): void {
    // Streams live in memory. Whatever was open when the server last stopped is final now.
    this.ctx.db.run('UPDATE messages SET streaming = 0 WHERE streaming = 1');
    kernel.onClose.push(() => this.stop());

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
      const row = postMessage(this.ctx, {
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
      draft.ts = row.ts;
      draft.dirty = false;
      draft.lastFlush = Date.now();
      draft.expiry = setTimeout(() => this.expire(draft), this.options.streamTimeoutMs);
      draft.expiry.unref();
      this.streams.set(`${conv.id}:${row.ts}`, draft);
      return { channel: conv.id, ts: row.ts };
    });

    kernel.registry.add('chat.appendStream', { scopes: ['chat:write'] }, ({ actor, args }) => {
      const { conv, stream } = this.find(actor, args);
      const input = readInput(args);
      if (input.text === null && input.chunks === null) fail('markdown_text_or_chunks_required');
      this.absorb(stream, input);
      this.schedule(stream);
      return { channel: conv.id, ts: stream.ts };
    });

    kernel.registry.add('chat.stopStream', { scopes: ['chat:write'] }, ({ actor, args }) => {
      const { conv, stream } = this.find(actor, args);
      this.absorb(stream, readInput(args));
      const trailing = args.json<Block[]>('blocks');
      if (trailing !== undefined && (!Array.isArray(trailing) || trailing.length > MAX_STREAM_BLOCKS)) fail('invalid_blocks');
      const row = this.finish(stream, trailing ?? [], args.has('metadata') ? args.json('metadata') : undefined);
      return { channel: conv.id, ts: stream.ts, message: row ? messageToApi(this.ctx, row) : undefined };
    });
  }

  private blank(conversationId: string, ts: string, owner: string, displayMode: Stream['displayMode']): Stream {
    return {
      conversationId,
      ts,
      owner,
      mode: null,
      text: '',
      blocks: [],
      tasks: [],
      planTitle: '',
      displayMode,
      dirty: false,
      lastFlush: 0,
      flushTimer: null,
      expiry: null,
    };
  }

  private find(actor: Actor, args: Args): { conv: ConvRow; stream: Stream } {
    const conv = resolveConv(this.ctx, actor, args.req('channel', 'channel_not_found'));
    const ts = args.reqTs('ts');
    const row = getMessage(this.ctx, conv.id, ts);
    if (!row) fail('message_not_found');
    const stream = this.streams.get(`${conv.id}:${ts}`);
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
      stream.dirty = true;
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
    stream.dirty = true;
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

  private schedule(stream: Stream): void {
    if (stream.flushTimer) return;
    const wait = stream.lastFlush + 1000 / FLUSHES_PER_SECOND - Date.now();
    if (wait <= 0) {
      this.flush(stream);
      return;
    }
    stream.flushTimer = setTimeout(() => {
      stream.flushTimer = null;
      this.flush(stream);
    }, wait);
    stream.flushTimer.unref();
  }

  /** Write the stream's current content to the message and tell connected clients. */
  private flush(stream: Stream): void {
    if (!stream.dirty) return;
    const conv = this.ctx.db.get<ConvRow>('SELECT * FROM conversations WHERE id = ?', stream.conversationId);
    const row = getMessage(this.ctx, stream.conversationId, stream.ts);
    if (!conv || !row) {
      this.discard(stream);
      return;
    }
    updateMessage(this.ctx, conv, row, { text: stream.text, blocks: this.render(stream, []) }, { clientOnly: true });
    stream.dirty = false;
    stream.lastFlush = Date.now();
  }

  private discard(stream: Stream): void {
    if (stream.flushTimer) clearTimeout(stream.flushTimer);
    if (stream.expiry) clearTimeout(stream.expiry);
    this.streams.delete(`${stream.conversationId}:${stream.ts}`);
  }

  /** The app never stopped the stream: keep what arrived and mark unfinished tasks as failed. */
  private expire(stream: Stream): void {
    for (const task of stream.tasks) {
      if (task.status === 'pending' || task.status === 'in_progress') task.status = 'error';
    }
    this.finish(stream);
  }

  /**
   * Close a stream: the final content is saved, the streaming flag is cleared
   * and everyone, apps included, is told once.
   */
  private finish(stream: Stream, trailing: Block[] = [], metadata?: unknown): MsgRow | undefined {
    this.discard(stream);
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
    for (const stream of [...this.streams.values()]) this.discard(stream);
  }
}
