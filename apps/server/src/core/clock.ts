import type { Db } from '../db/db.ts';

export const ZERO_TS = '0000000000.000000';

function tsToMicros(ts: string): bigint {
  const [seconds = '0', micros = '0'] = ts.split('.');
  return BigInt(seconds) * 1_000_000n + BigInt(micros.padEnd(6, '0').slice(0, 6));
}

function microsToTs(micros: bigint): string {
  const seconds = micros / 1_000_000n;
  const rest = micros % 1_000_000n;
  return `${seconds.toString().padStart(10, '0')}.${rest.toString().padStart(6, '0')}`;
}

/**
 * Issues message timestamps. A `ts` identifies a message inside its conversation,
 * so it must be unique and strictly increasing per conversation. The latest
 * stored `ts` is read each time (an index lookup): another process sharing the
 * database may have written one since; callers issue inside the transaction
 * that inserts, which holds the write lock.
 */
export class Clock {
  private readonly last = new Map<string, bigint>();
  private readonly db: Db;
  private lastNow = 0n;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * The current time in microseconds, never repeating and never going back:
   * wall-clock milliseconds, with the last three digits counting up within a
   * millisecond. A read position stamped now therefore always sorts before a
   * message stamped a moment later.
   */
  private now(): bigint {
    const wall = BigInt(Date.now()) * 1000n;
    this.lastNow = wall > this.lastNow ? wall : this.lastNow + 1n;
    return this.lastNow;
  }

  next(conversationId: string): string {
    const row = this.db.get<{ ts: string | null }>('SELECT max(ts) AS ts FROM messages WHERE conversation_id = ?', conversationId);
    const stored = row?.ts ? tsToMicros(row.ts) : 0n;
    const remembered = this.last.get(conversationId) ?? 0n;
    const last = stored > remembered ? stored : remembered;
    const now = this.now();
    const value = now > last ? now : last + 1n;
    this.last.set(conversationId, value);
    return microsToTs(value);
  }

  /** Register a timestamp issued elsewhere (imports) so later ones stay above it. */
  observe(conversationId: string, ts: string): void {
    const micros = tsToMicros(ts);
    const last = this.last.get(conversationId);
    if (last === undefined || micros > last) this.last.set(conversationId, micros);
  }

  /** A timestamp for events that are not messages. */
  eventTs(): string {
    return microsToTs(this.now());
  }
}

/** Normalise a caller-supplied ts to the canonical fixed-width form, or null when malformed. */
export function canonicalTs(input: string): string | null {
  if (!/^\d{1,10}(\.\d{1,6})?$/.test(input)) return null;
  return microsToTs(tsToMicros(input));
}
