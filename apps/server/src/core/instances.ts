import { hostname } from 'node:os';
import type { Db } from '../db/db.ts';
import { newHex } from './ids.ts';

type Handler = (body: unknown, origin: string) => void;

interface Subscription {
  handler: Handler;
  /** Also receive this process's own messages, in the shared order. */
  own: boolean;
}

export interface InstanceOptions {
  /** Started to share the database with other processes (CLUSTER=1, or a worker under WORKERS). */
  shared: boolean;
  heartbeatMs?: number;
  /** A process whose heartbeat is older than this is gone. */
  deadAfterMs?: number;
  pollMs?: number;
}

interface InstanceRow {
  id: string;
  host: string;
  pid: number;
  shared: number;
  seen: number;
}

const LEADER = 'leader';
const KEEP_MESSAGES_MS = 60_000;

/** Another server process is using the data directory and the two cannot share it. */
export class DataDirInUse extends Error {}

/**
 * The server processes using one database, and how they reach each other.
 *
 * Every serving process registers here and renews a heartbeat. One of them
 * holds the `leader` lease and runs the periodic jobs (scheduled messages,
 * digests, retention, recaps…), so each runs once however many processes there
 * are; when the leader stops or dies another takes the lease over within
 * seconds and runs whatever fell due meanwhile.
 *
 * Processes started to share the database (`shared`) send each other messages
 * through the `instance_messages` table, which each reads by polling a hundred
 * times a second: the event bus uses it to reach WebSockets held by
 * other processes, Socket Mode to reach an app connected elsewhere, live
 * canvases to pass edits along. A process that is not shared sends nothing
 * and is the leader from the start; it refuses to serve while another process
 * is using the same data directory.
 */
export class Instances {
  readonly id = newHex(8);
  readonly shared: boolean;
  private readonly db: Db;
  private readonly heartbeatMs: number;
  private readonly deadAfterMs: number;
  private readonly pollMs: number;
  private readonly handlers = new Map<string, Subscription[]>();
  private readonly leaderHooks: (() => void)[] = [];
  private readonly goneHooks: ((ids: string[]) => void)[] = [];
  private leading = false;
  private registered = false;
  private lastMessage = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private poller: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(db: Db, options: InstanceOptions) {
    this.db = db;
    this.shared = options.shared;
    this.heartbeatMs = options.heartbeatMs ?? 1000;
    this.deadAfterMs = options.deadAfterMs ?? 10_000;
    this.pollMs = options.pollMs ?? 10;
  }

  /** True when this process runs the periodic jobs. */
  isLeader(): boolean {
    return this.leading;
  }

  /** Run `hook` whenever this process becomes the leader (at start when it is alone). */
  onLeader(hook: () => void): void {
    this.leaderHooks.push(hook);
    if (this.leading) this.safely(hook);
  }

  /** Run `hook` on the leader when other processes have stopped or died. */
  onGone(hook: (ids: string[]) => void): void {
    this.goneHooks.push(hook);
  }

  /**
   * Receive messages on `topic` sent by other processes; with `own`, this
   * process's too, so that everything arrives in the one order the table gives.
   */
  on(topic: string, handler: Handler, options: { own?: boolean } = {}): void {
    const list = this.handlers.get(topic) ?? [];
    list.push({ handler, own: options.own === true });
    this.handlers.set(topic, list);
  }

  /** Send a message to every other process, or to one. Nothing is sent when not shared. */
  publish(topic: string, body: unknown, target: string | null = null): void {
    if (!this.shared || this.stopped) return;
    this.db.run(
      'INSERT INTO instance_messages (origin, target, topic, body, created) VALUES (?, ?, ?, ?, ?)',
      this.id,
      target,
      topic,
      JSON.stringify(body),
      Date.now(),
    );
  }

  /** Heartbeats at or before this time (ms) belong to processes that are gone. */
  cutoff(): number {
    return Date.now() - this.deadAfterMs;
  }

  /** Ids of the processes alive now, this one included. */
  alive(): string[] {
    if (!this.shared) return [this.id];
    return this.db
      .all<{ id: string }>('SELECT id FROM instances WHERE seen > ? ORDER BY started, id', Date.now() - this.deadAfterMs)
      .map((row) => row.id);
  }

  /**
   * Register and start the heartbeat. Waits out a heartbeat that may belong to
   * a process that just crashed; throws `DataDirInUse` when another process is
   * really using the directory and the two are not both shared.
   */
  async start(): Promise<void> {
    if (this.registered) return;
    await this.checkOthers();
    const now = Date.now();
    this.db.run(
      'INSERT INTO instances (id, host, pid, shared, started, seen) VALUES (?, ?, ?, ?, ?, ?)',
      this.id,
      hostname(),
      process.pid,
      this.shared ? 1 : 0,
      now,
      now,
    );
    this.registered = true;
    this.lastMessage = this.db.get<{ id: number | null }>('SELECT max(id) AS id FROM instance_messages')?.id ?? 0;
    this.beat();
    this.heartbeat = setInterval(() => this.beat(), this.heartbeatMs);
    this.heartbeat.unref();
    if (this.shared) {
      this.poller = setInterval(() => this.poll(), this.pollMs);
      this.poller.unref();
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.poller) clearInterval(this.poller);
    if (!this.registered) return;
    try {
      this.poll();
      // Leave the rows for the next leader to clean up as a gone process (it
      // announces presence for the people who were connected here), but make
      // this process dead at once and free the lease.
      this.db.run('UPDATE instances SET seen = 0 WHERE id = ?', this.id);
      this.db.run('DELETE FROM leases WHERE name = ? AND holder = ?', LEADER, this.id);
      if (!this.shared) this.forget([this.id]);
    } catch {
      // The database may already be closed in a failed start.
    }
    this.leading = false;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async checkOthers(): Promise<void> {
    const others = (): InstanceRow[] =>
      this.db.all<InstanceRow>('SELECT id, host, pid, shared, seen FROM instances WHERE id != ? AND seen > ?', this.id, Date.now() - this.deadAfterMs);
    let live = others();
    if (live.length === 0) return;
    if (this.shared && live.every((row) => row.shared === 1)) {
      const elsewhere = live.find((row) => row.host !== hostname());
      if (elsewhere) {
        console.warn(`[instances] process ${elsewhere.pid} on ${elsewhere.host} shares this database; SQLite needs every process on one machine`);
      }
      return;
    }
    // A heartbeat that stops advancing belonged to a process that is gone (a crash just before this start).
    const before = new Map(live.map((row) => [row.id, row.seen]));
    const wait = Math.max(...live.map((row) => row.seen + this.deadAfterMs - Date.now())) + this.heartbeatMs;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(wait, this.deadAfterMs + this.heartbeatMs))));
    live = others().filter((row) => row.seen !== before.get(row.id));
    if (live.length > 0) {
      const row = live[0]!;
      throw new DataDirInUse(
        `Another server process (pid ${row.pid} on ${row.host}) is using this data directory. Stop it, or start every process with CLUSTER=1 to run several.`,
      );
    }
    this.forget([...before.keys()]);
  }

  private beat(): void {
    if (this.stopped) return;
    const now = Date.now();
    try {
      this.db.run('UPDATE instances SET seen = ? WHERE id = ?', now, this.id);
      this.db.run(
        `INSERT INTO leases (name, holder, expires) VALUES (?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, expires = excluded.expires
         WHERE leases.holder = excluded.holder OR leases.expires <= ?`,
        LEADER,
        this.id,
        now + this.deadAfterMs / 2,
        now,
      );
      const holder = this.db.get<{ holder: string }>('SELECT holder FROM leases WHERE name = ?', LEADER)?.holder;
      if (holder === this.id && !this.leading) this.becomeLeader();
      else if (holder !== this.id) this.leading = false;
      if (this.leading) this.tidy(now);
    } catch (error) {
      console.error('[instances] heartbeat failed', error);
    }
  }

  private becomeLeader(): void {
    this.leading = true;
    for (const hook of this.leaderHooks) this.safely(hook);
  }

  /** Leader only: forget processes that stopped beating, and old messages. */
  private tidy(now: number): void {
    const gone = this.db
      .all<{ id: string }>('SELECT id FROM instances WHERE id != ? AND seen <= ?', this.id, now - this.deadAfterMs)
      .map((row) => row.id);
    // A stopped process sets `seen` to 0; it is gone at once, not after the timeout.
    if (gone.length) {
      // Hooks look at what the gone processes held (presence, sockets) before it is forgotten.
      for (const hook of this.goneHooks) this.safely(() => hook(gone));
      this.forget(gone);
    }
    this.db.run('DELETE FROM instance_messages WHERE created < ?', now - KEEP_MESSAGES_MS);
  }

  private forget(ids: string[]): void {
    this.db.tx(() => {
      for (const id of ids) {
        this.db.run('DELETE FROM instances WHERE id = ?', id);
        this.db.run('DELETE FROM instance_presence WHERE instance = ?', id);
        this.db.run('DELETE FROM instance_sockets WHERE instance = ?', id);
      }
    });
  }

  private poll(): void {
    if (!this.shared) return;
    for (;;) {
      const rows = this.db.all<{ id: number; origin: string; target: string | null; topic: string; body: string }>(
        'SELECT id, origin, target, topic, body FROM instance_messages WHERE id > ? ORDER BY id LIMIT 500',
        this.lastMessage,
      );
      for (const row of rows) {
        this.lastMessage = row.id;
        if (row.target !== null && row.target !== this.id) continue;
        const own = row.origin === this.id;
        const subscriptions = this.handlers.get(row.topic)?.filter((entry) => !own || entry.own);
        if (!subscriptions?.length) continue;
        let body: unknown;
        try {
          body = JSON.parse(row.body);
        } catch {
          continue;
        }
        for (const { handler } of subscriptions) this.safely(() => handler(body, row.origin));
      }
      if (rows.length < 500) return;
    }
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      console.error('[instances] handler failed', error);
    }
  }
}
