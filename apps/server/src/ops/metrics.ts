import { timingSafeEqual } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Kernel } from '../app.ts';
import { ApiError } from '../core/errors.ts';

/**
 * `/metrics` in the Prometheus text format, behind `METRICS_TOKEN` (sent as a
 * bearer token). Without a token the endpoint does not exist.
 */

type Labels = Record<string, string>;

class Counter {
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  inc(labels: Labels, by = 1): void {
    const key = JSON.stringify(labels);
    const entry = this.values.get(key);
    if (entry) entry.value += by;
    else this.values.set(key, { labels, value: by });
  }

  entries(): { labels: Labels; value: number }[] {
    return [...this.values.values()];
  }
}

function labelText(labels: Labels): string {
  const parts = Object.entries(labels).map(([key, value]) => `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Count every API call by method and outcome. Installed last, so it wraps the
 * methods every other module registered.
 */
export function installMetrics(kernel: Kernel): void {
  const { ctx, registry, router } = kernel;
  const calls = new Counter();
  const started = Date.now();
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  kernel.onClose.push(() => {
    loop.disable();
  });

  for (const name of registry.names()) {
    const def = registry.get(name)!;
    const original = def.handler;
    def.handler = async (call) => {
      try {
        const result = await original(call);
        calls.inc({ method: name, result: 'ok' });
        return result;
      } catch (error) {
        calls.inc({ method: name, result: error instanceof ApiError ? error.code : 'internal_error' });
        throw error;
      }
    };
  }

  router.add('GET', /^\/metrics$/, ({ req, res }) => {
    const token = ctx.config.metricsToken;
    if (!token) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!sameToken(given, token)) {
      res.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Bearer' });
      res.end('Unauthorized');
      return;
    }
    const count = (sql: string): number => ctx.db.get<{ n: number }>(sql)?.n ?? 0;
    const lines: string[] = [];
    const gauge = (name: string, help: string, values: { labels?: Labels; value: number }[], type = 'gauge'): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const entry of values) lines.push(`${name}${labelText(entry.labels ?? {})} ${entry.value}`);
    };
    const memory = process.memoryUsage();
    gauge('process_resident_memory_bytes', 'Resident memory of the server process.', [{ value: memory.rss }]);
    gauge('process_heap_used_bytes', 'JavaScript heap in use.', [{ value: memory.heapUsed }]);
    gauge('process_uptime_seconds', 'Seconds since the server started.', [{ value: Math.round((Date.now() - started) / 1000) }]);
    gauge('nodejs_eventloop_delay_p99_seconds', 'Event loop delay, 99th percentile since start.', [{ value: loop.percentile(99) / 1e9 }]);
    gauge('chat_connected_people', 'People with at least one realtime connection.', [{ value: ctx.presence.onlineUsers().length }]);
    gauge('chat_accounts', 'Accounts by kind.', [
      { labels: { kind: 'member' }, value: count("SELECT count(*) AS n FROM users WHERE deleted = 0 AND is_bot = 0 AND guest = ''") },
      { labels: { kind: 'guest' }, value: count("SELECT count(*) AS n FROM users WHERE deleted = 0 AND is_bot = 0 AND guest != ''") },
      { labels: { kind: 'bot' }, value: count('SELECT count(*) AS n FROM users WHERE deleted = 0 AND is_bot = 1') },
      { labels: { kind: 'deactivated' }, value: count('SELECT count(*) AS n FROM users WHERE deleted = 1') },
    ]);
    gauge(
      'chat_conversations',
      'Conversations by kind.',
      ctx.db.all<{ kind: string; n: number }>('SELECT kind, count(*) AS n FROM conversations GROUP BY kind').map((row) => ({ labels: { kind: row.kind }, value: row.n })),
    );
    gauge('chat_messages', 'Messages stored.', [{ value: count('SELECT max(id) AS n FROM messages') }]);
    gauge('chat_file_bytes', 'Bytes of uploaded files.', [{ value: count('SELECT coalesce(sum(size), 0) AS n FROM files') }]);
    gauge('chat_event_deliveries_pending', 'Events waiting to be delivered to apps over HTTP.', [{ value: count('SELECT count(*) AS n FROM outbox') }]);
    gauge('chat_push_subscriptions', 'Devices subscribed to push notifications.', [{ value: count('SELECT count(*) AS n FROM push_subscriptions') }]);
    gauge('chat_api_requests_total', 'API calls by method and outcome since start.', calls.entries(), 'counter');
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`${lines.join('\n')}\n`);
  });
}
