import type { Kernel } from '../app.ts';
import { fail } from '../core/errors.ts';
import { deleteFile, type FileRow } from '../core/files.ts';
import { nowSeconds } from '../core/ids.ts';
import { refreshLastTs, refreshThread } from '../core/messages.ts';
import type { Ctx } from '../ctx.ts';

/**
 * Data retention: a workspace can keep messages and files for a set number of
 * days, with its own setting for direct messages. An hourly sweep deletes what
 * is older. A thread parent older than the limit whose thread still has newer
 * replies stays as a "deleted" placeholder so the thread remains reachable.
 * Imports land in the past, so they are swept on the next run like anything else.
 */

export interface RetentionPolicy {
  /** Days to keep messages in channels; 0 keeps them forever. */
  messages_days: number;
  /** Days to keep direct and group direct messages; null follows `messages_days`. */
  dm_days: number | null;
  /** Days to keep files; 0 keeps them forever. */
  files_days: number;
}

const KEEP_ALL: RetentionPolicy = { messages_days: 0, dm_days: null, files_days: 0 };
const DAY = 86_400;
const CHUNK = 2000;
const MAX_DAYS = 36_500;

export function retentionPolicy(ctx: Ctx): RetentionPolicy {
  try {
    const prefs = JSON.parse(ctx.team()?.prefs ?? '{}') as { retention?: Partial<RetentionPolicy> };
    const raw = prefs.retention ?? {};
    const days = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? Math.min(value, MAX_DAYS) : 0);
    return { messages_days: days(raw.messages_days), dm_days: raw.dm_days === null || raw.dm_days === undefined ? null : days(raw.dm_days), files_days: days(raw.files_days) };
  } catch {
    return KEEP_ALL;
  }
}

const tsBefore = (seconds: number): string => `${String(seconds).padStart(10, '0')}.000000`;

/** Tables that hang off a message by (conversation_id, ts), found from the schema so later tables are covered too. */
function dependentTables(ctx: Ctx): string[] {
  const tables = ctx.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'messages%' AND name NOT LIKE 'sqlite_%'");
  return tables
    .filter(({ name }) => {
      const columns = ctx.db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${name.replace(/'/g, "''")}')`).map((column) => column.name);
      return columns.includes('conversation_id') && columns.includes('ts');
    })
    .map(({ name }) => name);
}

export interface SweepResult {
  messages: number;
  placeholders: number;
  files: number;
}

/** Count what the policy would delete now, without deleting it. */
export function retentionPreview(ctx: Ctx, policy: RetentionPolicy): { messages: number; files: number } {
  const now = nowSeconds();
  let messages = 0;
  if (policy.messages_days) {
    messages += ctx.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.kind IN ('public', 'private') AND m.ts < ? AND m.subtype IS NOT 'tombstone'",
      tsBefore(now - policy.messages_days * DAY),
    )!.n;
  }
  const dmDays = policy.dm_days ?? policy.messages_days;
  if (dmDays) {
    messages += ctx.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.kind IN ('im', 'mpim') AND m.ts < ? AND m.subtype IS NOT 'tombstone'",
      tsBefore(now - dmDays * DAY),
    )!.n;
  }
  const files = policy.files_days ? ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM files WHERE created < ? AND state != 'pending'", now - policy.files_days * DAY)!.n : 0;
  return { messages, files };
}

/** Delete everything the policy no longer keeps. Works in chunks so the server stays responsive. */
export async function sweepRetention(ctx: Ctx, policy = retentionPolicy(ctx)): Promise<SweepResult> {
  const result: SweepResult = { messages: 0, placeholders: 0, files: 0 };
  const now = nowSeconds();
  const dependents = dependentTables(ctx);
  const yieldNow = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  const sweepKind = async (kinds: string[], days: number): Promise<void> => {
    if (!days) return;
    const cutoff = tsBefore(now - days * DAY);
    const conversations = ctx.db.all<{ id: string }>(`SELECT id FROM conversations WHERE kind IN (${kinds.map(() => '?').join(', ')})`, ...kinds);
    for (const { id } of conversations) {
      for (;;) {
        const rows = ctx.db.all<{ id: number; ts: string; thread_ts: string | null }>(
          "SELECT id, ts, thread_ts FROM messages WHERE conversation_id = ? AND ts < ? AND subtype IS NOT 'tombstone' ORDER BY ts LIMIT ?",
          id,
          cutoff,
          CHUNK,
        );
        if (rows.length === 0) break;
        ctx.db.tx(() => {
          const threads = new Set<string>();
          for (const row of rows) {
            const parent = row.thread_ts === row.ts;
            const newerReplies = parent && ctx.db.get('SELECT 1 FROM messages WHERE conversation_id = ? AND thread_ts = ? AND ts >= ? LIMIT 1', id, row.ts, cutoff);
            if (newerReplies) {
              ctx.db.run(
                `UPDATE messages SET subtype = 'tombstone', text = 'This message was deleted.', plain = '', blocks = NULL, attachments = NULL, files = NULL, metadata = NULL WHERE id = ?`,
                row.id,
              );
              result.placeholders += 1;
              threads.add(row.ts);
            } else {
              ctx.db.run('DELETE FROM messages WHERE id = ?', row.id);
              result.messages += 1;
              if (row.thread_ts && !parent) threads.add(row.thread_ts);
            }
            for (const table of dependents) ctx.db.run(`DELETE FROM ${table} WHERE conversation_id = ? AND ts = ?`, id, row.ts);
          }
          for (const threadTs of threads) {
            if (ctx.db.get('SELECT 1 FROM messages WHERE conversation_id = ? AND ts = ?', id, threadTs)) refreshThread(ctx, id, threadTs);
          }
          refreshLastTs(ctx, id);
        });
        await yieldNow();
        if (rows.length < CHUNK) break;
      }
    }
  };

  await sweepKind(['public', 'private'], policy.messages_days);
  await sweepKind(['im', 'mpim'], policy.dm_days ?? policy.messages_days);

  if (policy.files_days) {
    const before = now - policy.files_days * DAY;
    for (;;) {
      const files = ctx.db.all<FileRow>("SELECT * FROM files WHERE created < ? AND state != 'pending' ORDER BY created LIMIT ?", before, CHUNK);
      for (const file of files) {
        await deleteFile(ctx, file);
        result.files += 1;
      }
      if (files.length < CHUNK) break;
    }
  }
  return result;
}

export function installRetention(kernel: Kernel): void {
  const { ctx } = kernel;
  let running: Promise<unknown> | null = null;
  const run = (): Promise<unknown> => {
    running ??= sweepRetention(ctx)
      .catch((error: unknown) => console.error('[retention]', error))
      .finally(() => {
        running = null;
      });
    return running;
  };
  const timer = setInterval(() => {
    if (ctx.team()) void run();
  }, 3_600_000);
  timer.unref();
  kernel.onClose.push(async () => {
    clearInterval(timer);
    await running;
  });

  /** The policy, and how much it would delete if it ran now. */
  kernel.registry.add('client.admin.retention', { auth: 'admin' }, ({ args }) => {
    const policy = args.has('preview') ? readPolicy(args.json('preview')) : retentionPolicy(ctx);
    return { retention: retentionPolicy(ctx), would_delete: retentionPreview(ctx, policy) };
  });

  /** Owners set the policy; deleting starts right away. */
  kernel.registry.add('client.admin.setRetention', { auth: 'admin' }, async ({ actor, args }) => {
    if (actor.role !== 'owner' && actor.role !== 'primary_owner') fail('not_allowed');
    const policy = readPolicy(args.json('retention'));
    const team = ctx.requireTeam();
    ctx.db.run("UPDATE team SET prefs = json_set(prefs, '$.retention', json(?)) WHERE id = ?", JSON.stringify(policy), team.id);
    ctx.invalidateTeam();
    await run();
    return { retention: retentionPolicy(ctx) };
  });
}

function readPolicy(value: unknown): RetentionPolicy {
  if (!value || typeof value !== 'object') fail('invalid_arguments', { arg: 'retention' });
  const raw = value as Record<string, unknown>;
  const days = (entry: unknown, name: string): number => {
    if (entry === undefined || entry === null || entry === 0) return 0;
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1 || entry > MAX_DAYS) fail('invalid_retention', { field: name });
    return entry;
  };
  return {
    messages_days: days(raw.messages_days, 'messages_days'),
    dm_days: raw.dm_days === null || raw.dm_days === undefined ? null : days(raw.dm_days, 'dm_days'),
    files_days: days(raw.files_days, 'files_days'),
  };
}
