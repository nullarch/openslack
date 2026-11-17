import type { Huddle, HuddleRoom } from '@app/shared';
import { readBody, sendJson } from '../api/http.ts';
import type { Kernel } from '../app.ts';
import { canSee, getConv, getMember, resolveConv, type ConvRow } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { getMessage, messageDecorators, postMessage, updateMessage } from '../core/messages.ts';
import { getUser } from '../core/users.ts';
import type { Ctx } from '../ctx.ts';
import { accessToken, deleteRoom, listParticipants, verifyWebhook, type LiveKitConfig } from './livekit.ts';

/**
 * Huddles: a call that belongs to a conversation. This server keeps the state
 * (who is in, when it started) and hands out LiveKit tokens; audio, video and
 * screen sharing travel through LiveKit. Without LiveKit configured the
 * methods report huddles as disabled and nothing else changes.
 *
 * Participants are added when they ask to join and removed when they leave.
 * Tabs that vanish without saying so are caught two ways: LiveKit's webhooks
 * (when the operator points them here) and a periodic comparison with the
 * room's real participant list.
 */

interface HuddleRow {
  id: string;
  conversation_id: string;
  ts: string;
  room: string;
  created_by: string;
  started: number;
  ended: number | null;
  participants: string;
  joined_at: string;
  history: string;
}

const TOKEN_TTL_SECONDS = 10 * 60;

function list(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function roomOf(row: HuddleRow): HuddleRoom {
  return {
    id: row.id,
    channels: [row.conversation_id],
    created_by: row.created_by,
    date_start: Math.floor(row.started / 1000),
    date_end: row.ended ? Math.floor(row.ended / 1000) : 0,
    has_ended: row.ended !== null,
    participants: row.ended ? [] : list(row.participants),
    participant_history: list(row.history),
  };
}

export function huddleToApi(row: HuddleRow): Huddle {
  return { ...roomOf(row), channel: row.conversation_id, ts: row.ts };
}

function activeIn(ctx: Ctx, conversationId: string): HuddleRow | undefined {
  return ctx.db.get<HuddleRow>('SELECT * FROM huddles WHERE conversation_id = ? AND ended IS NULL', conversationId);
}

function activeByRoom(ctx: Ctx, room: string): HuddleRow | undefined {
  return ctx.db.get<HuddleRow>('SELECT * FROM huddles WHERE room = ? AND ended IS NULL', room);
}

function reload(ctx: Ctx, id: string): HuddleRow {
  return ctx.db.get<HuddleRow>('SELECT * FROM huddles WHERE id = ?', id)!;
}

function emitChanged(ctx: Ctx, row: HuddleRow): void {
  const conv = getConv(ctx, row.conversation_id);
  if (!conv) return;
  ctx.bus.emit({
    event: { type: 'huddle_changed', channel: conv.id, huddle: huddleToApi(row), event_ts: ctx.clock.eventTs() },
    // Public channels are visible to everyone in the workspace, members or not.
    audience: conv.kind === 'public' ? { all: true } : { conversation: conv.id },
    clientOnly: true,
  });
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest} minute${rest === 1 ? '' : 's'}` : ''}`;
}

function people(ids: string[]): string {
  const mentions = ids.map((id) => `<@${id}>`);
  if (mentions.length <= 1) return mentions.join('');
  return `${mentions.slice(0, -1).join(', ')} and ${mentions.at(-1)}`;
}

export class Huddles {
  private readonly ctx: Ctx;
  private readonly config: LiveKitConfig | null;
  private timer: NodeJS.Timeout | null = null;
  private readonly reconcileMs: number;
  private readonly joinGraceMs: number;
  private readonly leftChecks = new Set<NodeJS.Timeout>();

  constructor(ctx: Ctx) {
    this.ctx = ctx;
    this.config = ctx.config.livekit ?? null;
    this.reconcileMs = Number(process.env.HUDDLE_RECONCILE_MS ?? 20_000);
    this.joinGraceMs = Number(process.env.HUDDLE_JOIN_GRACE_MS ?? 30_000);
  }

  get enabled(): boolean {
    return this.config !== null;
  }

  private requireConfig(): LiveKitConfig {
    return this.config ?? fail('huddles_disabled');
  }

  /** Huddles running in conversations the viewer can see. */
  visibleTo(userId: string): Huddle[] {
    return this.ctx.db
      .all<HuddleRow>('SELECT * FROM huddles WHERE ended IS NULL ORDER BY started')
      .filter((row) => {
        const conv = getConv(this.ctx, row.conversation_id);
        return conv !== undefined && canSee(this.ctx, conv, userId);
      })
      .map(huddleToApi);
  }

  private start(conv: ConvRow, userId: string): HuddleRow {
    const message = postMessage(this.ctx, { conv, userId, text: 'A huddle started', subtype: 'huddle_thread' });
    const id = newId('R');
    const team = this.ctx.requireTeam().id;
    this.ctx.db.run(
      'INSERT INTO huddles (id, conversation_id, ts, room, created_by, started) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      conv.id,
      message.ts,
      `${team}-${conv.id}`,
      userId,
      Date.now(),
    );
    return reload(this.ctx, id);
  }

  /** Add someone to the conversation's huddle, starting one if none runs. Returns the huddle and their media token. */
  join(conv: ConvRow, userId: string): { huddle: Huddle; token: string; url: string } {
    const config = this.requireConfig();
    if (conv.is_archived === 1) fail('is_archived');
    if (!getMember(this.ctx, conv.id, userId)) fail('not_in_channel');
    let row = activeIn(this.ctx, conv.id) ?? this.start(conv, userId);
    row = this.addParticipant(row, userId);
    const user = getUser(this.ctx, userId);
    const token = accessToken(config, {
      identity: userId,
      name: user ? user.display_name || user.real_name || user.name : userId,
      ttlSeconds: TOKEN_TTL_SECONDS,
      video: { room: row.room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
    });
    return { huddle: huddleToApi(row), token, url: config.url };
  }

  private addParticipant(row: HuddleRow, userId: string): HuddleRow {
    const participants = list(row.participants);
    const history = list(row.history);
    const joinedAt = JSON.parse(row.joined_at) as Record<string, number>;
    joinedAt[userId] = Date.now();
    if (!participants.includes(userId)) participants.push(userId);
    if (!history.includes(userId)) history.push(userId);
    this.ctx.db.run(
      'UPDATE huddles SET participants = ?, history = ?, joined_at = ? WHERE id = ?',
      JSON.stringify(participants),
      JSON.stringify(history),
      JSON.stringify(joinedAt),
      row.id,
    );
    const fresh = reload(this.ctx, row.id);
    emitChanged(this.ctx, fresh);
    return fresh;
  }

  /** Take someone out of a huddle; the huddle ends when nobody is left. */
  remove(row: HuddleRow, userId: string): void {
    const participants = list(row.participants);
    if (!participants.includes(userId)) return;
    const left = participants.filter((id) => id !== userId);
    this.ctx.db.run('UPDATE huddles SET participants = ? WHERE id = ?', JSON.stringify(left), row.id);
    const fresh = reload(this.ctx, row.id);
    if (left.length === 0) this.end(fresh);
    else emitChanged(this.ctx, fresh);
  }

  leave(conv: ConvRow, userId: string): void {
    const row = activeIn(this.ctx, conv.id);
    if (row) this.remove(row, userId);
  }

  end(row: HuddleRow): void {
    if (row.ended !== null) return;
    const ended = Date.now();
    this.ctx.db.run('UPDATE huddles SET ended = ?, participants = ? WHERE id = ?', ended, '[]', row.id);
    const fresh = reload(this.ctx, row.id);
    const conv = getConv(this.ctx, row.conversation_id);
    const message = conv ? getMessage(this.ctx, conv.id, row.ts) : undefined;
    if (conv && message) {
      const who = list(fresh.history);
      const text = `Huddle ended after ${duration(ended - row.started)}${who.length ? `. ${people(who)} joined.` : '.'}`;
      // A system update: not an edit by anyone.
      updateMessage(this.ctx, conv, message, { text });
    }
    emitChanged(this.ctx, fresh);
    if (this.config) void deleteRoom(this.config, row.room).catch(() => undefined);
  }

  // ── Keeping state honest ─────────────────────────────────────────────────

  startTimers(): void {
    if (!this.config || this.reconcileMs <= 0) return;
    this.timer = setInterval(() => void this.reconcile(), this.reconcileMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const timer of this.leftChecks) clearTimeout(timer);
    this.leftChecks.clear();
  }

  /** Drop participants LiveKit no longer has, once they have had time to connect. */
  async reconcile(): Promise<void> {
    if (!this.config || !this.ctx.instances.isLeader()) return;
    for (const row of this.ctx.db.all<HuddleRow>('SELECT * FROM huddles WHERE ended IS NULL')) {
      let present: string[];
      try {
        present = await listParticipants(this.config, row.room);
      } catch {
        continue; // LiveKit unreachable: change nothing.
      }
      const current = reload(this.ctx, row.id);
      if (current.ended !== null) continue;
      const joinedAt = JSON.parse(current.joined_at) as Record<string, number>;
      for (const userId of list(current.participants)) {
        const since = Date.now() - (joinedAt[userId] ?? 0);
        if (!present.includes(userId) && since > this.joinGraceMs) this.remove(reload(this.ctx, row.id), userId);
      }
    }
  }

  /** Apply a verified LiveKit webhook. */
  async webhook(event: { event?: string; room?: { name?: string }; participant?: { identity?: string } }): Promise<void> {
    const room = event.room?.name;
    if (!room) return;
    const row = activeByRoom(this.ctx, room);
    if (!row) return;
    const identity = event.participant?.identity;
    if (event.event === 'room_finished') {
      this.end(row);
    } else if (event.event === 'participant_joined' && identity) {
      // Only people who were given a token can be in the room, but check membership anyway.
      if (getMember(this.ctx, row.conversation_id, identity)) this.addParticipant(row, identity);
    } else if (event.event === 'participant_left' && identity) {
      // The same person reconnecting from another tab shows up as left-then-joined; look again shortly.
      const timer = setTimeout(() => {
        this.leftChecks.delete(timer);
        void (async () => {
          let present: string[] = [];
          try {
            present = await listParticipants(this.config!, room);
          } catch {
            present = [];
          }
          const current = activeByRoom(this.ctx, room);
          if (current && !present.includes(identity)) this.remove(current, identity);
        })();
      }, 1500);
      timer.unref();
      this.leftChecks.add(timer);
    }
  }
}

function decorateHuddleMessage(ctx: Ctx, row: { subtype: string | null; conversation_id: string; ts: string }, message: { room?: HuddleRoom }): void {
  if (row.subtype !== 'huddle_thread') return;
  const huddle = ctx.db.get<HuddleRow>('SELECT * FROM huddles WHERE conversation_id = ? AND ts = ?', row.conversation_id, row.ts);
  if (huddle) message.room = roomOf(huddle);
}

export function installHuddles(kernel: Kernel): Huddles {
  const { ctx, registry, router } = kernel;
  const huddles = new Huddles(ctx);

  // Module-wide list; use the context passed in, not this app's, since several apps can share a process (tests).
  if (!messageDecorators.includes(decorateHuddleMessage)) messageDecorators.push(decorateHuddleMessage);

  registry.add('client.huddles.info', { auth: 'session' }, ({ actor }) => ({
    enabled: huddles.enabled,
    url: ctx.config.livekit?.url ?? null,
    huddles: huddles.visibleTo(actor.userId),
  }));

  registry.add('client.huddles.join', { auth: 'session' }, ({ actor, args }) => {
    if (!huddles.enabled) fail('huddles_disabled');
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    return huddles.join(conv, actor.userId);
  });

  registry.add('client.huddles.leave', { auth: 'session' }, ({ actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    huddles.leave(conv, actor.userId);
  });

  router.add('POST', /^\/livekit\/webhook$/, async ({ req, res }) => {
    const config = ctx.config.livekit;
    const body = await readBody(req, 256 * 1024);
    if (!config || !verifyWebhook(config, body, req.headers.authorization)) {
      sendJson(res, 401, { ok: false, error: 'invalid_signature' });
      return;
    }
    try {
      await huddles.webhook(JSON.parse(body.toString('utf8')) as Parameters<Huddles['webhook']>[0]);
    } catch (error) {
      console.error('[huddles] webhook failed', error);
    }
    sendJson(res, 200, { ok: true });
  });

  huddles.startTimers();
  kernel.onClose.push(() => huddles.stop());
  return huddles;
}
