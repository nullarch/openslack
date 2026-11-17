// Install the packed command into an empty folder and use it the way a newcomer would:
// `npx <command>` starts, serves the web client, a workspace is set up, a message is
// posted and found again by a Korean search. Works on Windows, macOS and Linux.
//
//   node scripts/smoke-installed.mjs packages/cli/<name>-<version>.tgz
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tarball = resolve(process.argv[2] ?? '');
const slug = /slug: '([^']+)'/.exec(readFileSync(new URL('../packages/shared/src/brand.ts', import.meta.url), 'utf8'))[1];
const windows = process.platform === 'win32';
const folder = mkdtempSync(join(tmpdir(), 'smoke-install-'));
const data = mkdtempSync(join(tmpdir(), 'smoke-data-'));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: folder, stdio: 'inherit', shell: windows });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed`);
}

const port = await new Promise((done) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port: free } = probe.address();
    probe.close(() => done(free));
  });
});
const base = `http://127.0.0.1:${port}`;

run('npm', ['init', '-y']);
run('npm', ['install', '--no-audit', '--no-fund', tarball]);

const started = Date.now();
// Its own process group, so stopping it stops the server npx started too (npx does not pass signals on everywhere).
const server = spawn('npx', [slug], { cwd: folder, shell: windows, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: base, DATA_DIR: data } });
let output = '';
server.stdout.on('data', (chunk) => (output += chunk));
server.stderr.on('data', (chunk) => (output += chunk));

try {
  let healthy = false;
  for (let i = 0; i < 120 && !healthy; i += 1) {
    healthy = await fetch(`${base}/healthz`).then((response) => response.ok, () => false);
    if (!healthy) await sleep(500);
  }
  assert.ok(healthy, `the server did not start:\n${output}`);
  console.log(`started in ${Date.now() - started} ms`);

  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root">/, 'the web client is served');

  const call = async (method, args, cookie = '') => {
    const response = await fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(args) });
    const body = await response.json();
    assert.equal(body.ok, true, `${method}: ${JSON.stringify(body)}`);
    return { body, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? cookie };
  };
  const setup = await call('client.setup', { team_name: 'Smoke', email: 'owner@smoke.test', password: 'a long enough password', real_name: 'Smoke Owner', tz: 'UTC' });
  const boot = await call('client.boot', {}, setup.cookie);
  const general = boot.body.channels.find((channel) => channel.is_general).id;
  await call('chat.postMessage', { channel: general, text: '설치 확인 메시지입니다' }, setup.cookie);
  const found = await call('search.messages', { query: '확인 메시지' }, setup.cookie);
  assert.equal(found.body.messages.total, 1);
  console.log(`ok on ${process.platform} ${process.arch}, Node ${process.version}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (windows) spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']);
  else {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill();
    }
  }
  server.stdout.destroy();
  server.stderr.destroy();
  await sleep(500);
  rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
  rmSync(data, { recursive: true, force: true, maxRetries: 5 });
  // Nothing of the server may keep this script alive.
  process.exit(process.exitCode ?? 0);
}
