// Prove a backup works end to end: seed a server, back it up while it keeps
// running and taking writes, restore the copy into a new directory, start a
// second server on it, and check what it serves.
//
//   node scripts/backup-restore-test.mjs
//
// Starts only its own two servers, on free ports, and stops them by PID.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = join(root, 'apps/server/src/main.ts');
const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];
const dirs = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(dataDir, extra = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', main], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, QUIET: '1', ...extra },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    if (await fetch(`${base}/healthz`).then((r) => r.ok, () => false)) return { base, child };
    await sleep(100);
  }
  throw new Error('server did not start');
}

function client(base) {
  let cookie = '';
  const call = async (method, args = {}) => {
    const response = await fetch(`${base}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(args),
    });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const body = await response.json();
    assert.equal(body.ok, true, `${method}: ${JSON.stringify(body)}`);
    return body;
  };
  call.cookie = () => cookie;
  return call;
}

async function main_() {
  const live = mkdtempSync(join(tmpdir(), 'chat-live-'));
  const copy = mkdtempSync(join(tmpdir(), 'chat-copy-'));
  dirs.push(live, copy);

  const first = await startServer(live, { SEED_DEMO: '1' });
  const call = client(first.base);
  await call('client.signin', { email: 'maya@example.com', password: 'demo-password' });
  const before = await call('chat.postMessage', { channel: '#general', text: 'written before the backup' });
  const bytes = Buffer.from('backup me');
  const upload = await call('files.getUploadURLExternal', { filename: 'note.txt', length: bytes.length });
  await fetch(upload.upload_url.replace(/^http:\/\/localhost:\d+/, first.base), { method: 'POST', body: bytes });
  await call('files.completeUploadExternal', { files: [{ id: upload.file_id }], channel_id: before.channel, initial_comment: 'with a file' });

  // Keep writing while the backup runs.
  let writing = true;
  const writer = (async () => {
    let n = 0;
    while (writing) await call('chat.postMessage', { channel: '#random', text: `during backup ${n++}` });
  })();
  const { stdout } = await run(process.execPath, ['--disable-warning=ExperimentalWarning', main, 'backup', copy], { env: { ...process.env, DATA_DIR: live } });
  writing = false;
  await writer;
  console.log(`  ok    ${stdout.trim()}`);
  await call('chat.postMessage', { channel: '#general', text: 'written after the backup' });

  const second = await startServer(copy);
  const restored = client(second.base);
  await restored('client.signin', { email: 'maya@example.com', password: 'demo-password' });
  const history = await restored('conversations.history', { channel: '#general', limit: 100 });
  const texts = history.messages.map((message) => message.text);
  assert.ok(texts.includes('written before the backup'), 'the message from before the backup is there');
  assert.ok(!texts.includes('written after the backup'), 'nothing from after the backup');
  const withFile = history.messages.find((message) => message.text === 'with a file');
  const path = new URL(withFile.files[0].url_private).pathname;
  const file = await fetch(`${second.base}${path}`, { headers: { cookie: restored.cookie() } });
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes, 'the uploaded file came along');
  assert.equal((await fetch(`${second.base}${path}`)).status, 404, 'and still needs a session');
  const search = await restored('search.messages', { query: 'written before' });
  assert.equal(search.messages.total, 1, 'the search index came along');
  console.log('  ok    restored server serves the snapshot: messages, search and files');

  const sizes = await restored('client.boot');
  assert.ok(sizes.channels.length >= 5, 'channels came along');
  console.log('\nBackup and restore passed.');
}

try {
  await main_();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await sleep(300);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
