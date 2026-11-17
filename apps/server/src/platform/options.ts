/** Timing knobs of the app platform. Defaults follow Slack's published behaviour. */
export interface PlatformOptions {
  /** How long an app has to acknowledge an event, interaction or command. */
  ackTimeoutMs: number;
  /** Delay before each redelivery of an unacknowledged event; its length is the number of retries. */
  retryDelaysMs: number[];
  /** How long a streamed message may stay open before it is finalised. */
  streamTimeoutMs: number;
  /** How long a status set with `assistant.threads.setStatus` stays up without a message. */
  statusTimeoutMs: number;
  /** How long a `trigger_id` can be exchanged for a modal. */
  triggerTtlMs: number;
}

function numbers(value: string | undefined): number[] | null {
  if (!value) return null;
  const parsed = value.split(',').map((part) => Number(part.trim()));
  return parsed.every((entry) => Number.isFinite(entry) && entry >= 0) ? parsed : null;
}

/**
 * Three seconds to acknowledge; retries nearly immediately, after one minute
 * and after five minutes. `EVENT_ACK_TIMEOUT_MS` and `EVENT_RETRY_DELAYS_MS`
 * (comma-separated) override them, which the tests use to avoid waiting.
 */
export function platformOptions(env: NodeJS.ProcessEnv = process.env): PlatformOptions {
  return {
    ackTimeoutMs: numbers(env.EVENT_ACK_TIMEOUT_MS)?.[0] ?? 3000,
    retryDelaysMs: numbers(env.EVENT_RETRY_DELAYS_MS) ?? [0, 60_000, 300_000],
    streamTimeoutMs: numbers(env.STREAM_TIMEOUT_MS)?.[0] ?? 10 * 60_000,
    statusTimeoutMs: numbers(env.STATUS_TIMEOUT_MS)?.[0] ?? 2 * 60_000,
    triggerTtlMs: numbers(env.TRIGGER_TTL_MS)?.[0] ?? 3000,
  };
}
