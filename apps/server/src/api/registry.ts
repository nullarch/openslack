import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Actor, Ctx } from '../ctx.ts';
import { canonicalTs } from '../core/clock.ts';
import { fail } from '../core/errors.ts';

/** Arguments of an API call, merged from the query string and the body. */
export class Args {
  readonly raw: Record<string, unknown>;

  constructor(raw: Record<string, unknown>) {
    this.raw = raw;
  }

  has(name: string): boolean {
    const value = this.raw[name];
    return value !== undefined && value !== null && value !== '';
  }

  str(name: string): string | undefined {
    const value = this.raw[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return undefined;
  }

  /** A required string; a missing one fails with `invalid_arguments` unless `error` names something better. */
  req(name: string, error = 'invalid_arguments'): string {
    const value = this.str(name);
    if (value === undefined || value === '') fail(error, error === 'invalid_arguments' ? { needed: name } : {});
    return value;
  }

  bool(name: string, fallback = false): boolean {
    const value = this.raw[name];
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return value === 'true' || value === '1' || value === 1;
  }

  int(name: string, fallback: number, range: { min?: number; max?: number } = {}): number {
    const value = this.raw[name];
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Math.trunc(Number(value));
    if (!Number.isFinite(parsed)) fail('invalid_arguments', { needed: name });
    return Math.max(range.min ?? -Infinity, Math.min(range.max ?? Infinity, parsed));
  }

  /** A structured value that may arrive as JSON text (form-encoded calls) or already parsed (JSON bodies). */
  json<T>(name: string): T | undefined {
    const value = this.raw[name];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') return value as T;
    try {
      return JSON.parse(value) as T;
    } catch {
      fail('invalid_arguments', { needed: name });
    }
  }

  /** A list given as an array or as comma-separated text. */
  list(name: string): string[] {
    const value = this.raw[name];
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (typeof value !== 'string') return [];
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
      } catch {
        // Fall through to comma splitting.
      }
    }
    return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
  }

  /** A message timestamp in canonical form. */
  ts(name: string, error = 'invalid_arguments'): string | undefined {
    const value = this.str(name);
    if (value === undefined || value === '') return undefined;
    return canonicalTs(value) ?? fail(error === 'invalid_arguments' ? 'invalid_ts_latest' : error);
  }

  reqTs(name: string, error = 'message_not_found'): string {
    const value = this.str(name);
    if (!value) fail('invalid_arguments', { needed: name });
    return canonicalTs(value) ?? fail(error);
  }
}

export interface Call {
  ctx: Ctx;
  actor: Actor;
  args: Args;
  req: IncomingMessage;
  res: ServerResponse;
}

export interface PublicCall extends Omit<Call, 'actor'> {
  actor: Actor | null;
}

type Result = Record<string, unknown> | void;

export interface MethodDef {
  /**
   * Who may call: `any` credential (default), a browser `session` only,
   * a workspace `admin`, or `none` (no credential needed).
   */
  auth: 'any' | 'session' | 'admin' | 'none';
  /** Token scopes, any one of which permits the call. Sessions are unrestricted. */
  scopes: string[];
  handler: (call: Call) => Result | Promise<Result>;
}

export interface MethodOptions {
  auth?: 'any' | 'session' | 'admin';
  scopes?: string[];
}

export class Registry {
  private readonly methods = new Map<string, MethodDef>();

  /** Register an authenticated method. */
  add(name: string, options: MethodOptions, handler: (call: Call) => Result | Promise<Result>): void {
    this.methods.set(name, { auth: options.auth ?? 'any', scopes: options.scopes ?? [], handler });
  }

  /** Register a method that works without credentials (`actor` may be null). */
  addPublic(name: string, handler: (call: PublicCall) => Result | Promise<Result>): void {
    this.methods.set(name, { auth: 'none', scopes: [], handler: handler as MethodDef['handler'] });
  }

  get(name: string): MethodDef | undefined {
    return this.methods.get(name);
  }

  names(): string[] {
    return [...this.methods.keys()].sort();
  }
}

// ── Cursor pagination ───────────────────────────────────────────────────────

export function encodeCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  const decoded = Buffer.from(cursor, 'base64').toString('utf8');
  if (!decoded) fail('invalid_cursor');
  return decoded;
}

/** Slice a list by an offset cursor and report the next cursor in Slack's `response_metadata`. */
export function pageByOffset<T>(items: T[], cursor: string | undefined, limit: number): {
  page: T[];
  response_metadata: { next_cursor: string };
} {
  const decoded = decodeCursor(cursor);
  const offset = decoded ? Number(decoded.replace(/^offset:/, '')) : 0;
  if (!Number.isInteger(offset) || offset < 0) fail('invalid_cursor');
  const page = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? encodeCursor(`offset:${offset + limit}`) : '';
  return { page, response_metadata: { next_cursor: next } };
}
