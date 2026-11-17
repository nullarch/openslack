import type { Db } from '../db/db.ts';

const SWEEP_EVERY_MS = 30_000;

/**
 * Short-lived values that any server process may be asked about: a
 * `response_url` the app calls back, a `trigger_id` it exchanges, a one-time
 * code in a sign-in flow, a ticket for a WebSocket. They are kept in the
 * database rather than in memory, because the call that uses one may reach
 * another process than the one that handed it out (see "Several processes" in
 * docs/ARCHITECTURE.md). Each value has a lifetime; expired rows are swept now
 * and then by whichever process writes.
 */
export class Transient {
  private readonly db: Db;
  private lastSweep = 0;

  constructor(db: Db) {
    this.db = db;
  }

  /** Store `value` under `kind` and `key` for `ttlMs`, replacing what was there. */
  put(kind: string, key: string, value: unknown, ttlMs: number): void {
    const now = Date.now();
    this.sweep(now);
    this.db.run(
      'INSERT INTO transient (kind, key, value, expires) VALUES (?, ?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET value = excluded.value, expires = excluded.expires',
      kind,
      key,
      JSON.stringify(value),
      now + ttlMs,
    );
  }

  /** The value, unless it is missing or its lifetime is over. */
  get<T>(kind: string, key: string): T | undefined {
    const row = this.db.get<{ value: string }>('SELECT value FROM transient WHERE kind = ? AND key = ? AND expires > ?', kind, key, Date.now());
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  /** Read and remove in one step: of two callers racing for the same key, one gets it. */
  take<T>(kind: string, key: string): T | undefined {
    const row = this.db.get<{ value: string; expires: number }>('DELETE FROM transient WHERE kind = ? AND key = ? RETURNING value, expires', kind, key);
    return row && row.expires > Date.now() ? (JSON.parse(row.value) as T) : undefined;
  }

  /**
   * Change a value atomically: `change` gets the current value and returns the
   * next one (kept with the same lifetime), or undefined to leave it as it is.
   * Returns what `change` returned.
   */
  update<T>(kind: string, key: string, change: (value: T) => T | undefined): T | undefined {
    return this.db.tx(() => {
      const row = this.db.get<{ value: string }>('SELECT value FROM transient WHERE kind = ? AND key = ? AND expires > ?', kind, key, Date.now());
      if (!row) return undefined;
      const next = change(JSON.parse(row.value) as T);
      if (next !== undefined) this.db.run('UPDATE transient SET value = ? WHERE kind = ? AND key = ?', JSON.stringify(next), kind, key);
      return next;
    });
  }

  delete(kind: string, key: string): void {
    this.db.run('DELETE FROM transient WHERE kind = ? AND key = ?', kind, key);
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    this.db.run('DELETE FROM transient WHERE expires <= ?', now);
  }
}

/** A map-like view of one kind of short-lived value whose lifetime is its own `expires` (ms). */
export interface SharedMap<T extends { expires: number }> {
  set(key: string, value: T): void;
  get(key: string): T | undefined;
  /** Read and remove at once: a one-time code is used by one caller only. */
  take(key: string): T | undefined;
  delete(key: string): void;
}

export function sharedMap<T extends { expires: number }>(transient: Transient, kind: string): SharedMap<T> {
  return {
    set: (key, value) => transient.put(kind, key, value, Math.max(1, value.expires - Date.now())),
    get: (key) => transient.get<T>(kind, key),
    take: (key) => transient.take<T>(kind, key),
    delete: (key) => transient.delete(kind, key),
  };
}
