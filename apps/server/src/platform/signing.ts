import { createHmac } from 'node:crypto';

/**
 * Sign an outgoing request the way Slack does: HMAC-SHA256 over
 * `v0:<timestamp>:<raw body>` with the app's signing secret, sent as
 * `X-Slack-Signature: v0=<hex>` next to `X-Slack-Request-Timestamp`.
 */
export function signature(signingSecret: string, timestamp: number, body: string): string {
  return `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

export function signedHeaders(signingSecret: string, body: string, contentType: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    'content-type': contentType,
    'x-slack-request-timestamp': String(timestamp),
    'x-slack-signature': signature(signingSecret, timestamp, body),
  };
}
