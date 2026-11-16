import type { Attachment, Block, Message } from '@app/shared';
import type { Kernel } from '../app.ts';
import { parseBody, readBody, sendJson } from '../api/http.ts';
import type { Ctx } from '../ctx.ts';
import { canonicalTs } from '../core/clock.ts';
import { channelTypeWord, getConv, type ConvRow } from '../core/conversations.ts';
import { ApiError } from '../core/errors.ts';
import { newId, newSecret } from '../core/ids.ts';
import { deleteMessage, getMessage, postMessage, updateMessage } from '../core/messages.ts';
import { getApp, type AppRow } from './apps.ts';

/** The parts of a message an app may send in a response. */
export interface ResponseContent {
  text?: string;
  blocks?: Block[];
  attachments?: Attachment[];
}

const MAX_USES = 5;
const TTL_MS = 30 * 60_000;
const EPHEMERAL_TTL_MS = 30 * 60_000;
const MAX_EPHEMERALS = 5000;

function truthy(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/** Pick `text`, `blocks` and `attachments` out of a loosely typed payload. */
export function readResponseContent(body: Record<string, unknown>): ResponseContent {
  const content: ResponseContent = {};
  if (typeof body.text === 'string' && body.text !== '') content.text = body.text;
  for (const key of ['blocks', 'attachments'] as const) {
    let value = body[key];
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        throw new ApiError('invalid_payload', {}, 400);
      }
    }
    if (Array.isArray(value) && value.length > 0) content[key] = value as Block[];
  }
  return content;
}

export function hasContent(content: ResponseContent): boolean {
  return Boolean(content.text || content.blocks?.length || content.attachments?.length);
}

// ── Ephemeral messages ──────────────────────────────────────────────────────

export interface EphemeralRecord {
  message: Message;
  conversationId: string;
  userId: string;
  appId: string | null;
  expires: number;
}

/**
 * Ephemeral messages are never stored, yet a button on one must still reach
 * the app that sent it, and the app may replace or delete it through a
 * `response_url`. This keeps recent ones in memory, picked up from the bus.
 */
export class EphemeralStore {
  private readonly ctx: Ctx;
  private readonly records = new Map<string, EphemeralRecord>();

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  install(kernel: Kernel): void {
    const unsubscribe = this.ctx.bus.subscribe((busEvent) => {
      const { event, audience } = busEvent;
      if (event.type !== 'message' || event.is_ephemeral !== true || event.subtype !== undefined) return;
      if (!('users' in audience) || audience.users.length !== 1) return;
      if (typeof event.channel !== 'string' || typeof event.ts !== 'string') return;
      this.sweep();
      this.records.set(`${event.channel}:${event.ts}`, {
        message: event as unknown as Message,
        conversationId: event.channel,
        userId: audience.users[0]!,
        appId: typeof event.app_id === 'string' ? event.app_id : null,
        expires: Date.now() + EPHEMERAL_TTL_MS,
      });
    });
    kernel.onClose.push(unsubscribe);
  }

  private sweep(): void {
    if (this.records.size < MAX_EPHEMERALS) return;
    const now = Date.now();
    for (const [key, record] of this.records) {
      if (record.expires <= now || this.records.size >= MAX_EPHEMERALS) this.records.delete(key);
    }
  }

  get(conversationId: string, ts: string): EphemeralRecord | undefined {
    const record = this.records.get(`${conversationId}:${ts}`);
    return record && record.expires > Date.now() ? record : undefined;
  }

  /** Show a message to one member only, as the app. Returns its timestamp. */
  post(conv: ConvRow, app: AppRow, userId: string, content: ResponseContent, threadTs?: string | null): string {
    const ts = this.ctx.clock.eventTs();
    const message: Message = {
      type: 'message',
      ts,
      text: content.text ?? '',
      user: app.bot_user_id,
      bot_id: app.bot_id,
      app_id: app.id,
      is_ephemeral: true,
      channel: conv.id,
      channel_type: channelTypeWord(conv),
      event_ts: ts,
    };
    if (content.blocks?.length) message.blocks = content.blocks;
    if (content.attachments?.length) message.attachments = content.attachments;
    if (threadTs) message.thread_ts = threadTs;
    this.ctx.bus.emit({ event: { ...message }, audience: { users: [userId] }, clientOnly: true });
    return ts;
  }

  /** Replace an ephemeral message in place for the person who can see it. */
  replace(record: EphemeralRecord, content: ResponseContent): void {
    const previous = record.message;
    const next: Message = { ...previous, text: content.text ?? '' };
    delete next.blocks;
    delete next.attachments;
    if (content.blocks?.length) next.blocks = content.blocks;
    if (content.attachments?.length) next.attachments = content.attachments;
    record.message = next;
    const eventTs = this.ctx.clock.eventTs();
    this.ctx.bus.emit({
      event: {
        type: 'message',
        subtype: 'message_changed',
        hidden: true,
        is_ephemeral: true,
        channel: record.conversationId,
        ts: eventTs,
        event_ts: eventTs,
        message: next,
        previous_message: previous,
      },
      audience: { users: [record.userId] },
      clientOnly: true,
    });
  }

  remove(record: EphemeralRecord): void {
    this.records.delete(`${record.conversationId}:${record.message.ts}`);
    const eventTs = this.ctx.clock.eventTs();
    this.ctx.bus.emit({
      event: {
        type: 'message',
        subtype: 'message_deleted',
        hidden: true,
        is_ephemeral: true,
        channel: record.conversationId,
        ts: eventTs,
        deleted_ts: record.message.ts,
        event_ts: eventTs,
        previous_message: record.message,
      },
      audience: { users: [record.userId] },
      clientOnly: true,
    });
  }
}

// ── response_url ────────────────────────────────────────────────────────────

interface Hook {
  secret: string;
  appId: string;
  kind: 'actions' | 'commands';
  conversationId: string;
  /** The person who clicked or ran the command; ephemeral responses go to them. */
  userId: string;
  /** The message the interaction happened on (absent for slash commands). */
  sourceTs: string | null;
  sourceEphemeral: boolean;
  uses: number;
  expires: number;
}

export interface NewHook {
  app: AppRow;
  kind: 'actions' | 'commands';
  conversationId: string;
  userId: string;
  sourceTs?: string | null;
  sourceEphemeral?: boolean;
}

/**
 * `response_url`: a short-lived URL handed to an app with each interaction and
 * slash command. The app may POST a message payload to it up to five times
 * within thirty minutes to answer where the interaction happened, without any
 * channel permission.
 */
export class ResponseHooks {
  private readonly ctx: Ctx;
  private readonly ephemerals: EphemeralStore;
  private readonly hooks = new Map<string, Hook>();

  constructor(ctx: Ctx, ephemerals: EphemeralStore) {
    this.ctx = ctx;
    this.ephemerals = ephemerals;
  }

  install(kernel: Kernel): void {
    kernel.router.add('POST', /^\/hooks\/(actions|commands)\/([A-Z0-9]+)\/([A-Z0-9]+)\/([A-Za-z0-9_-]+)$/, async ({ req, res, params }) => {
      const [kind, appId, id, secret] = params;
      const hook = this.hooks.get(id!);
      const app = hook ? getApp(this.ctx, hook.appId) : undefined;
      if (!hook || !app || hook.kind !== kind || hook.appId !== appId || hook.secret !== secret || hook.expires <= Date.now()) {
        sendJson(res, 404, { ok: false, error: 'expired_url' });
        return;
      }
      if (hook.uses >= MAX_USES) {
        sendJson(res, 404, { ok: false, error: 'used_url' });
        return;
      }
      let body = parseBody(String(req.headers['content-type'] ?? ''), await readBody(req));
      // Form-encoded callers put the JSON in a `payload` field.
      if (typeof body.payload === 'string') {
        try {
          body = JSON.parse(body.payload) as Record<string, unknown>;
        } catch {
          throw new ApiError('invalid_payload', {}, 400);
        }
      }
      hook.uses += 1;
      this.apply(hook, app, body);
      sendJson(res, 200, { ok: true });
    });
  }

  /** Create a `response_url` for one interaction. */
  create(input: NewHook): string {
    const now = Date.now();
    for (const [key, hook] of this.hooks) {
      if (hook.expires <= now) this.hooks.delete(key);
    }
    const id = newId('', 12);
    const secret = newSecret(18);
    this.hooks.set(id, {
      secret,
      appId: input.app.id,
      kind: input.kind,
      conversationId: input.conversationId,
      userId: input.userId,
      sourceTs: input.sourceTs ?? null,
      sourceEphemeral: input.sourceEphemeral ?? false,
      uses: 0,
      expires: now + TTL_MS,
    });
    return `${this.ctx.config.publicUrl}/hooks/${input.kind}/${input.app.id}/${id}/${secret}`;
  }

  /**
   * Carry out a response. For an interaction on a message the default is to
   * replace that message; `replace_original: false` publishes a new one
   * instead, `delete_original` removes it. A slash command has no source
   * message, so its responses are always new messages. New messages are
   * ephemeral unless `response_type` is `in_channel`.
   */
  apply(hook: Hook, app: AppRow, body: Record<string, unknown>): void {
    const conv = getConv(this.ctx, hook.conversationId);
    if (!conv) throw new ApiError('channel_not_found', {}, 404);
    const content = readResponseContent(body);
    const onMessage = hook.kind === 'actions' && hook.sourceTs !== null;
    const deleteOriginal = onMessage && truthy(body.delete_original);
    const replaceOriginal =
      onMessage && !deleteOriginal && (body.replace_original === undefined ? true : truthy(body.replace_original));

    if (deleteOriginal) {
      this.deleteSource(hook, conv);
      if (!hasContent(content)) return;
    } else if (replaceOriginal) {
      if (!hasContent(content)) throw new ApiError('no_text', {}, 400);
      this.replaceSource(hook, conv, content);
      return;
    }
    if (!hasContent(content)) throw new ApiError('no_text', {}, 400);
    this.publish(conv, app, hook.userId, body, content);
  }

  /** Post a new message in answer to an interaction or command. */
  publish(conv: ConvRow, app: AppRow, userId: string, body: Record<string, unknown>, content: ResponseContent): void {
    const threadTs = typeof body.thread_ts === 'string' ? canonicalTs(body.thread_ts) : null;
    if (body.response_type === 'in_channel') {
      postMessage(this.ctx, {
        conv,
        userId: app.bot_user_id,
        botId: app.bot_id,
        appId: app.id,
        text: content.text ?? '',
        blocks: content.blocks ?? null,
        attachments: content.attachments ?? null,
        threadTs: threadTs && getMessage(this.ctx, conv.id, threadTs) ? threadTs : null,
      });
      return;
    }
    this.ephemerals.post(conv, app, userId, content, threadTs);
  }

  private deleteSource(hook: Hook, conv: ConvRow): void {
    if (hook.sourceEphemeral) {
      const record = this.ephemerals.get(conv.id, hook.sourceTs!);
      if (record) this.ephemerals.remove(record);
      return;
    }
    const row = getMessage(this.ctx, conv.id, hook.sourceTs!);
    if (row) deleteMessage(this.ctx, conv, row);
  }

  private replaceSource(hook: Hook, conv: ConvRow, content: ResponseContent): void {
    if (hook.sourceEphemeral) {
      const record = this.ephemerals.get(conv.id, hook.sourceTs!);
      if (!record) throw new ApiError('message_not_found', {}, 404);
      this.ephemerals.replace(record, content);
      return;
    }
    const row = getMessage(this.ctx, conv.id, hook.sourceTs!);
    if (!row) throw new ApiError('message_not_found', {}, 404);
    updateMessage(this.ctx, conv, row, {
      text: content.text ?? '',
      blocks: content.blocks ?? null,
      attachments: content.attachments ?? null,
    });
  }
}
