import type { Ctx } from '../ctx.ts';
import { fail } from '../core/errors.ts';
import { newSecret } from '../core/ids.ts';
import { getApp, type AppRow } from './apps.ts';
import { allowPrivateTargets, OutboundError, post, type FailureReason } from './net.ts';
import type { PlatformOptions } from './options.ts';
import { signedHeaders } from './signing.ts';

interface OutboxRow {
  id: number;
  app_id: string;
  url: string;
  body: string;
  attempt: number;
  next_at: number;
  last_error: string | null;
  created: number;
}

const MAX_IN_FLIGHT = 16;
const SWEEP_INTERVAL_MS = 5000;

/**
 * Events API over HTTP: each event is POSTed to the app's request URL, signed
 * with its signing secret. A delivery that is not answered with a 2xx within
 * the acknowledgement window is retried on Slack's schedule with
 * `X-Slack-Retry-Num` and `X-Slack-Retry-Reason`. Deliveries wait in the
 * `outbox` table, so pending retries survive a restart.
 */
export class HttpDelivery {
  private readonly ctx: Ctx;
  private readonly options: PlatformOptions;
  private readonly inFlight = new Set<number>();
  /** Fires when the earliest queued retry comes due. */
  private wake: NodeJS.Timeout | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(ctx: Ctx, options: PlatformOptions) {
    this.ctx = ctx;
    this.options = options;
  }

  start(): void {
    this.sweeper = setInterval(() => this.drain(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
    this.drain();
  }

  stop(): void {
    this.stopped = true;
    if (this.sweeper) clearInterval(this.sweeper);
    if (this.wake) clearTimeout(this.wake);
  }

  /** Queue one event for an app and try to deliver it right away. */
  enqueue(app: AppRow, body: string): void {
    if (!app.events_url) return;
    const now = Date.now();
    this.ctx.db.run(
      'INSERT INTO outbox (app_id, url, body, attempt, next_at, created) VALUES (?, ?, ?, 0, ?, ?)',
      app.id,
      app.events_url,
      body,
      now,
      now,
    );
    this.drain();
  }

  /** Number of deliveries still waiting (used by tests and admin screens). */
  pending(appId: string): number {
    return this.ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM outbox WHERE app_id = ?', appId)?.n ?? 0;
  }

  /**
   * Wake up when the next retry is due. Re-armed after every drain, so a timer
   * that fires a moment early simply arms itself again.
   */
  private arm(): void {
    if (this.wake) clearTimeout(this.wake);
    this.wake = null;
    const next = this.ctx.db.get<{ at: number | null }>('SELECT min(next_at) AS at FROM outbox WHERE next_at > ?', Date.now());
    if (!next || next.at === null) return;
    this.wake = setTimeout(() => this.drain(), Math.max(1, next.at - Date.now() + 1));
    this.wake.unref();
  }

  private drain(): void {
    if (this.stopped) return;
    this.arm();
    const room = MAX_IN_FLIGHT - this.inFlight.size;
    if (room <= 0) return;
    const due = this.ctx.db.all<OutboxRow>(
      'SELECT * FROM outbox WHERE next_at <= ? ORDER BY next_at, id LIMIT ?',
      Date.now(),
      MAX_IN_FLIGHT * 2,
    );
    let started = 0;
    for (const row of due) {
      if (started >= room) break;
      if (this.inFlight.has(row.id)) continue;
      this.inFlight.add(row.id);
      started += 1;
      void this.attempt(row)
        .catch((error: unknown) => console.error('[platform] event delivery failed unexpectedly', error))
        .finally(() => {
          this.inFlight.delete(row.id);
          if (!this.stopped) this.drain();
        });
    }
  }

  private async attempt(row: OutboxRow): Promise<void> {
    const app = getApp(this.ctx, row.app_id);
    if (!app || app.socket_mode === 1) {
      this.ctx.db.run('DELETE FROM outbox WHERE id = ?', row.id);
      return;
    }
    const headers = signedHeaders(app.signing_secret, row.body, 'application/json');
    if (row.attempt > 0) {
      headers['x-slack-retry-num'] = String(row.attempt);
      headers['x-slack-retry-reason'] = row.last_error ?? 'unknown_error';
    }
    let reason: FailureReason | null;
    let noRetry = false;
    try {
      const response = await post(row.url, {
        headers,
        body: row.body,
        timeoutMs: this.options.ackTimeoutMs,
        allowPrivate: allowPrivateTargets(this.ctx),
      });
      reason = response.status >= 200 && response.status < 300 ? null : 'http_error';
      noRetry = response.headers['x-slack-no-retry'] === '1';
    } catch (error) {
      reason = error instanceof OutboundError ? error.reason : 'unknown_error';
      // A target this server refuses to call will not become allowed by retrying.
      noRetry = reason === 'blocked_address';
    }
    // The server may have shut down while the app was answering; the row stays queued for the next start.
    if (this.stopped) return;
    if (reason === null) {
      this.ctx.db.run('DELETE FROM outbox WHERE id = ?', row.id);
      return;
    }

    const delay = this.options.retryDelaysMs[row.attempt];
    if (noRetry || delay === undefined) {
      this.ctx.db.run('DELETE FROM outbox WHERE id = ?', row.id);
      if (!this.ctx.config.quiet) {
        console.warn(`[platform] dropped an event for ${row.app_id} after ${row.attempt + 1} attempt(s): ${reason}`);
      }
      return;
    }
    this.ctx.db.run(
      'UPDATE outbox SET attempt = ?, next_at = ?, last_error = ? WHERE id = ?',
      row.attempt + 1,
      Date.now() + delay,
      reason === 'blocked_address' ? 'connection_failed' : reason,
      row.id,
    );
  }

  /**
   * The URL verification handshake: send a signed `url_verification` request
   * and require the challenge back, as plain text, form-encoded or JSON.
   */
  async verifyUrl(app: AppRow, url: string): Promise<void> {
    const challenge = newSecret(32);
    const body = JSON.stringify({ token: app.verification_token, challenge, type: 'url_verification' });
    let answer: string;
    let contentType: string;
    try {
      const response = await post(url, {
        headers: signedHeaders(app.signing_secret, body, 'application/json'),
        body,
        timeoutMs: this.options.ackTimeoutMs,
        allowPrivate: allowPrivateTargets(this.ctx),
      });
      if (response.status < 200 || response.status >= 300) {
        fail('url_verification_failed', { detail: `http_status_${response.status}` });
      }
      answer = response.body.trim();
      contentType = String(response.headers['content-type'] ?? '');
    } catch (error) {
      if (error instanceof OutboundError) fail('url_verification_failed', { detail: error.reason });
      throw error;
    }
    let echoed = answer;
    if (contentType.includes('application/json')) {
      try {
        echoed = String((JSON.parse(answer) as { challenge?: unknown }).challenge ?? '');
      } catch {
        echoed = '';
      }
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      echoed = new URLSearchParams(answer).get('challenge') ?? '';
    }
    if (echoed !== challenge) fail('url_verification_failed', { detail: 'challenge_mismatch' });
  }
}
