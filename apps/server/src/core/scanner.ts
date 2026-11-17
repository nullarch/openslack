import { connect } from 'node:net';
import type { Readable } from 'node:stream';

/**
 * Virus scanning of uploads with ClamAV's daemon (clamd) over its INSTREAM
 * command: no client library, a TCP connection and a few framed writes.
 * Configured with CLAMAV_URL=tcp://host:3310.
 */

export interface ScannerConfig {
  host: string;
  port: number;
  /** Files larger than this are not sent (clamd refuses streams over its StreamMaxLength, 25 MB by default). */
  maxBytes: number;
  /** When clamd cannot be reached: accept the upload unscanned (true) or refuse it (false, the default). */
  failOpen: boolean;
}

export type ScanResult = { clean: true } | { clean: false; signature: string } | { error: string };

export function scannerFromEnv(env: NodeJS.ProcessEnv): ScannerConfig | null {
  const raw = env.CLAMAV_URL?.trim();
  if (!raw) return null;
  const url = new URL(raw.includes('://') ? raw : `tcp://${raw}`);
  if (url.protocol !== 'tcp:') throw new Error('CLAMAV_URL must look like tcp://clamav:3310');
  return {
    host: url.hostname,
    port: Number(url.port || 3310),
    maxBytes: Number(env.CLAMAV_MAX_MB ?? 25) * 1024 * 1024,
    failOpen: env.CLAMAV_FAIL_OPEN === '1',
  };
}

/** Stream bytes to clamd and read its verdict. */
export function scanStream(config: ScannerConfig, body: Readable, timeoutMs = 60_000): Promise<ScanResult> {
  return new Promise((resolve) => {
    let settled = false;
    let reply = '';
    const socket = connect({ host: config.host, port: config.port });
    const finish = (result: ScanResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      body.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish({ error: 'timeout' }));
    socket.on('error', (error) => finish({ error: error.message }));
    socket.on('data', (chunk) => {
      reply += chunk.toString('utf8');
      if (!reply.includes('\0')) return;
      const answer = reply.slice(0, reply.indexOf('\0')).replace(/^stream:\s*/, '').trim();
      if (answer === 'OK') finish({ clean: true });
      else if (answer.endsWith(' FOUND')) finish({ clean: false, signature: answer.slice(0, -' FOUND'.length) });
      else finish({ error: answer || 'no answer' });
    });
    socket.on('connect', async () => {
      try {
        socket.write('zINSTREAM\0');
        for await (const chunk of body) {
          const data = chunk as Buffer;
          for (let offset = 0; offset < data.length; offset += 64 * 1024) {
            const part = data.subarray(offset, offset + 64 * 1024);
            const head = Buffer.alloc(4);
            head.writeUInt32BE(part.length);
            if (!socket.write(Buffer.concat([head, part]))) await new Promise((next) => socket.once('drain', next));
          }
        }
        socket.write(Buffer.alloc(4));
      } catch (error) {
        finish({ error: error instanceof Error ? error.message : String(error) });
      }
    });
    socket.on('close', () => finish({ error: reply ? reply.trim() : 'connection closed' }));
  });
}
