// Starts a throwaway LiveKit media server for the huddle tests.
//
// The binary is found through LIVEKIT_SERVER_BIN or `livekit-server` on PATH.
// (On macOS: `brew fetch livekit` downloads a bottle you can unpack anywhere;
// on Linux: the release tarballs at github.com/livekit/livekit.)
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { freePort, sleep, track } from './lib.mjs';

export function findLiveKit() {
  if (process.env.LIVEKIT_SERVER_BIN) return process.env.LIVEKIT_SERVER_BIN;
  const which = spawnSync('which', ['livekit-server'], { encoding: 'utf8' });
  return which.status === 0 ? which.stdout.trim() : null;
}

/** Start LiveKit on free ports, posting webhooks to `webhookUrl`. */
export async function startLiveKit({ webhookUrl }) {
  const binary = findLiveKit();
  if (!binary) throw new Error('livekit-server not found (set LIVEKIT_SERVER_BIN)');
  const [port, tcpPort, udpPort] = [await freePort(), await freePort(), await freePort()];
  const apiKey = 'APIhuddletest';
  const apiSecret = randomBytes(24).toString('hex');
  const config = [
    `port: ${port}`,
    `bind_addresses: ['127.0.0.1']`,
    'rtc:',
    `  tcp_port: ${tcpPort}`,
    `  udp_port: ${udpPort}`,
    '  use_external_ip: false',
    '  node_ip:',
    '    ipv4: 127.0.0.1',
    'keys:',
    `  ${apiKey}: ${apiSecret}`,
    'webhook:',
    `  api_key: ${apiKey}`,
    '  urls:',
    `    - ${webhookUrl}`,
    'logging:',
    '  level: warn',
  ].join('\n');
  let output = '';
  const child = track(spawn(binary, ['--config-body', config], { stdio: ['ignore', 'pipe', 'pipe'] }));
  child.stdout.on('data', (data) => (output += data));
  child.stderr.on('data', (data) => (output += data));
  const url = `ws://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`livekit-server exited:\n${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return { url, apiKey, apiSecret, child, log: () => output };
    } catch {
      // Not listening yet.
    }
    await sleep(100);
  }
  throw new Error(`livekit-server did not start:\n${output}`);
}
