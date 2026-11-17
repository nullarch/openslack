// API throughput with one server process or several.
//
//   WORKERS=4 node apps/server/scripts/api-load-test.mjs [seconds=10] [concurrency=64]
//
// Starts the server as separate processes (WORKERS=1: one; WORKERS=4: four
// workers on one port), fills a channel with 2,000 messages, then keeps
// `concurrency` requests in flight for `seconds`, alternating between
// `conversations.history` (100 messages) and `search.messages`, and reports
// requests per second and latency percentiles. Each loop signs in as its own
// person, so the per-person API limit (6,000 calls a minute) is not what is
// measured. Client and server share one machine.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { createSession, hashPassword } from '../src/core/auth.ts';
import { addMember, getConv } from '../src/core/conversations.ts';
import { createUser } from '../src/core/users.ts';

const SECONDS = Number(process.argv[2] ?? 10);
const CONCURRENCY = Number(process.argv[3] ?? 64);
const WORKERS = Number(process.env.WORKERS ?? 1);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dataDir = mkdtempSync(join(tmpdir(), 'chat-api-load-'));
const port = await new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const chosen = probe.address().port;
    probe.close(() => resolve(chosen));
  });
});
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '../src/main.ts')], {
  env: { ...process.env, WORKERS: String(WORKERS), PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, QUIET: '1', LINK_PREVIEWS: '0', WEB_DIR: '' },
  stdio: 'inherit',
});
const base = `http://127.0.0.1:${port}`;

try {
  for (let i = 0; i < 200; i += 1) {
    if ((await fetch(`${base}/healthz`).catch(() => null))?.ok) break;
    await sleep(100);
  }
  const setup = await fetch(`${base}/api/client.setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ team_name: 'Load', email: 'owner@load.test', password: 'load test password', real_name: 'Owner' }),
  });
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const call = async (method, args) => {
    const response = await fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(args) });
    const body = await response.json();
    if (!body.ok) throw new Error(`${method}: ${body.error}`);
    return body;
  };
  const general = (await call('client.boot', {})).channels.find((channel) => channel.is_general).id;
  // People for the loops, written straight to the shared database.
  const tool = createApp({ port: 0, host: '127.0.0.1', dataDir, publicUrl: '', webDir: null, maxUploadBytes: 1024, cookieSecure: false, version: 'load', quiet: true });
  const passwordHash = await hashPassword('unused password');
  const cookies = [];
  for (let i = 0; i < CONCURRENCY; i += 1) {
    const user = createUser(tool.ctx, { email: `p${i}@load.test`, realName: `Person ${i}`, passwordHash });
    addMember(tool.ctx, getConv(tool.ctx, general), user.id, { silent: true });
    cookies.push(`sid=${createSession(tool.ctx, user.id, 'load-test')}`);
  }
  await tool.close();
  const callAs = async (who, method, args) => {
    const response = await fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies[who] }, body: JSON.stringify(args) });
    const body = await response.json();
    if (!body.ok) throw new Error(`${method}: ${body.error}`);
    return body;
  };
  const words = ['deploy', 'review', 'billing', 'search', 'release', 'incident', 'design', 'customer', 'roadmap', 'meeting'];
  for (let i = 0; i < 2000; i += 50) {
    await Promise.all(
      Array.from({ length: 50 }, (_, j) => call('chat.postMessage', { channel: general, text: `Update ${i + j}: the ${words[(i + j) % 10]} notes for ${words[(i + j * 3) % 10]} are ready` })),
    );
  }

  const latencies = [];
  let errors = 0;
  let firstError = null;
  const end = Date.now() + SECONDS * 1000;
  const loop = async (n) => {
    for (let i = n; Date.now() < end; i += 1) {
      const started = performance.now();
      try {
        if (i % 2) await callAs(n, 'conversations.history', { channel: general, limit: 100 });
        else await callAs(n, 'search.messages', { query: words[i % 10], count: 20 });
        latencies.push(performance.now() - started);
      } catch (error) {
        errors += 1;
        firstError ??= String(error.message ?? error);
      }
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, n) => loop(n)));
  const elapsed = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const at = (q) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))].toFixed(1);
  console.log(
    JSON.stringify(
      {
        server: `${WORKERS} process${WORKERS > 1 ? 'es' : ''}`,
        concurrency: CONCURRENCY,
        requestsPerSecond: Math.round(latencies.length / elapsed),
        latencyMs: { p50: at(0.5), p95: at(0.95), p99: at(0.99) },
        errors,
        ...(firstError ? { firstError } : {}),
        node: process.version,
      },
      null,
      2,
    ),
  );
} finally {
  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));
  rmSync(dataDir, { recursive: true, force: true });
}
