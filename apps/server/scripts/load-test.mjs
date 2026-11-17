// Delivery latency under many open connections.
//
//   node apps/server/scripts/load-test.mjs [connections=1000] [people=250] [messages=60]
//
// Starts a server in this process with a throwaway data directory, creates
// `people` members (all in the default channel), opens `connections` client
// WebSockets spread across them, then posts `messages` messages one after
// another through the HTTP API and measures, for every open connection, the
// time from sending the request to the event arriving. Reports p50/p95/p99
// over all deliveries. Client and server share one machine, so the numbers
// include the cost of the client side too.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.ts';
import { createSession, hashPassword } from '../src/core/auth.ts';
import { addMember, getConv } from '../src/core/conversations.ts';
import { createUser } from '../src/core/users.ts';

const CONNECTIONS = Number(process.argv[2] ?? 1000);
const PEOPLE = Number(process.argv[3] ?? 250);
const MESSAGES = Number(process.argv[4] ?? 60);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dataDir = mkdtempSync(join(tmpdir(), 'chat-load-'));
const app = createApp({
  port: 0,
  host: '127.0.0.1',
  dataDir,
  publicUrl: '',
  webDir: null,
  maxUploadBytes: 1024 * 1024,
  cookieSecure: false,
  version: 'load-test',
  quiet: true,
});
const port = await app.listen();
const base = `http://127.0.0.1:${port}`;

try {
  // ── Workspace and people ─────────────────────────────────────────────────
  const setup = await fetch(`${base}/api/client.setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ team_name: 'Load', email: 'owner@load.test', password: 'load test password', real_name: 'Owner' }),
  });
  const ownerCookie = setup.headers.get('set-cookie').split(';')[0];
  const ctx = app.ctx;
  const general = ctx.db.get("SELECT id FROM conversations WHERE is_general = 1");
  const passwordHash = await hashPassword('unused password');
  const cookies = [];
  for (let i = 0; i < PEOPLE; i += 1) {
    const user = createUser(ctx, { email: `p${i}@load.test`, realName: `Person ${i}`, passwordHash });
    addMember(ctx, getConv(ctx, general.id), user.id, { silent: true });
    cookies.push(`sid=${createSession(ctx, user.id, 'load-test')}`);
  }

  // ── Connections ──────────────────────────────────────────────────────────
  const sockets = [];
  const pending = new Map(); // marker → send time
  const latencies = [];
  let received = 0;
  const opened = [];
  for (let i = 0; i < CONNECTIONS; i += 1) {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { cookie: cookies[i % PEOPLE] } });
    socket.on('message', (data) => {
      const text = data.toString();
      if (!text.includes('load-marker-')) return;
      const marker = /load-marker-(\d+)/.exec(text)?.[1];
      const sent = pending.get(marker);
      if (sent === undefined) return;
      latencies.push(performance.now() - sent);
      received += 1;
    });
    opened.push(new Promise((resolve, reject) => {
      socket.once('message', resolve); // hello
      socket.once('error', reject);
    }));
    sockets.push(socket);
    if (i % 100 === 99) await Promise.all(opened.slice(-100));
  }
  await Promise.all(opened);
  const rssAfterConnect = process.memoryUsage().rss;

  // ── Messages ─────────────────────────────────────────────────────────────
  const expected = MESSAGES * CONNECTIONS;
  const started = performance.now();
  for (let i = 0; i < MESSAGES; i += 1) {
    pending.set(String(i), performance.now());
    const response = await fetch(`${base}/api/chat.postMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ channel: general.id, text: `status update load-marker-${i}` }),
    });
    if (!(await response.json()).ok) throw new Error('post failed');
    await sleep(50);
  }
  for (let i = 0; i < 100 && received < expected; i += 1) await sleep(100);
  const elapsed = performance.now() - started;

  latencies.sort((a, b) => a - b);
  const at = (q) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))].toFixed(1);
  console.log(
    JSON.stringify(
      {
        connections: CONNECTIONS,
        people: PEOPLE,
        messages: MESSAGES,
        deliveries: `${received}/${expected}`,
        latencyMs: { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: latencies.at(-1).toFixed(1) },
        deliveriesPerSecond: Math.round(received / (elapsed / 1000)),
        rssMB: Math.round(rssAfterConnect / 1048576),
        node: process.version,
      },
      null,
      2,
    ),
  );
  if (received < expected) process.exitCode = 1;
  for (const socket of sockets) socket.terminate();
} finally {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
