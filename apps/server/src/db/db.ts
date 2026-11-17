import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { MIGRATIONS } from './schema.ts';

export type Param = SQLInputValue;

/**
 * Thin wrapper over the built-in SQLite driver: cached prepared statements,
 * typed row helpers and nestable transactions. All calls are synchronous, so a
 * transaction body runs to completion without interleaving with other requests.
 */
export class Db {
  readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    // The busy timeout first: another process may be writing while this one opens the file,
    // and every later statement (switching to WAL included) should wait for it, not fail.
    this.raw.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
    `);
    this.migrate();
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.raw.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const result = this.statement(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get<T>(sql: string, ...params: Param[]): T | undefined {
    return this.statement(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: Param[]): T[] {
    return this.statement(sql).all(...params) as T[];
  }

  /** Run `fn` atomically. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth += 1;
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  /**
   * Bring the schema up to date. Several processes may start at once against
   * the same file: each migration takes the write lock first and reads the
   * version again under it, so only one of them applies it.
   */
  private migrate(): void {
    const version = (): number => (this.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    while (version() < MIGRATIONS.length) {
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        const current = version();
        if (current < MIGRATIONS.length) {
          this.raw.exec(MIGRATIONS[current]!);
          this.raw.exec(`PRAGMA user_version = ${current + 1}`);
        }
        this.raw.exec('COMMIT');
      } catch (error) {
        this.raw.exec('ROLLBACK');
        throw error;
      }
    }
  }

  close(): void {
    this.statements.clear();
    this.raw.close();
  }
}
