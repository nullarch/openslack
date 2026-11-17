/**
 * One timer for everything that happens later (scheduled messages, reminders).
 * Each source says when its next item is due and runs what is due; the timer
 * wakes at the earliest of them, and at least once a minute. Items stored in
 * the database survive a restart: whatever fell due while the server was down
 * runs at start-up.
 *
 * With several processes only the leader runs it. Another process that
 * schedules or cancels something tells the leader to look again, and a process
 * that becomes the leader runs whatever fell due meanwhile.
 */
import type { Instances } from '../core/instances.ts';


export interface TimedSource {
  /** The next due time in seconds, or null when nothing is waiting. */
  next(): number | null;
  /** Run everything due at or before `now` (seconds). */
  run(now: number): void;
}

const MAX_SLEEP_MS = 60_000;

export class Scheduler {
  private readonly sources: TimedSource[] = [];
  private readonly instances: Instances;
  private readonly topic: string;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;

  /** `name` tells this scheduler's messages between processes apart from another's. */
  constructor(instances: Instances, name: string) {
    this.instances = instances;
    this.topic = `scheduler.${name}`;
    instances.on(this.topic, () => {
      if (instances.isLeader()) this.arm();
    });
    instances.onLeader(() => this.arm());
  }

  add(source: TimedSource): void {
    this.sources.push(source);
  }

  /** Recompute when to wake. Call after anything is scheduled or cancelled. */
  arm(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.instances.isLeader()) {
      this.instances.publish(this.topic, null);
      return;
    }
    let next: number | null = null;
    for (const source of this.sources) {
      const due = source.next();
      if (due !== null && (next === null || due < next)) next = due;
    }
    const delay = next === null ? MAX_SLEEP_MS : Math.max(0, Math.min(MAX_SLEEP_MS, next * 1000 - Date.now()));
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref();
  }

  private tick(): void {
    if (this.stopped || this.running || !this.instances.isLeader()) return;
    this.running = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      for (const source of this.sources) {
        try {
          source.run(now);
        } catch (error) {
          console.error('[scheduler] a timed job failed', error);
        }
      }
    } finally {
      this.running = false;
      this.arm();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
