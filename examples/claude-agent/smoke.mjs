// Checks the wiring of app.mjs without spending anything: a stand-in for the
// Claude Messages API answers with a fixed streamed reply, and a local server
// plays the chat workspace. What it proves: the agent receives a mention,
// reads the conversation, sends it to Claude with the expected request shape,
// and streams the answer into the thread. It does not exercise a real model.
//
//   node smoke.mjs        (from this folder, after `pnpm install` at the root)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const REPLY = 'Daniel asked about the **freeze**; it is still on for Thursday.';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// ── A stand-in for POST /v1/messages (streaming) ────────────────────────────
const requests = [];
const fakeClaude = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', {
      message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 0 } },
    });
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    for (const piece of REPLY.match(/\S+\s*/g)) send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: piece } });
    send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
    send('message_stop', {});
    res.end();
  });
});

const children = [];
const dataDir = mkdtempSync(join(tmpdir(), 'claude-agent-smoke-'));
try {
  const claudePort = await listen(fakeClaude);
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;

  const server = spawn(process.execPath, [join(root, 'apps/server/src/main.ts')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: base, DATA_DIR: dataDir, SEED_DEMO: '1', QUIET: '1', NODE_NO_WARNINGS: '1' },
    stdio: 'inherit',
  });
  children.push(server);
  for (let i = 0; i < 80; i += 1) {
    if (await fetch(`${base}/healthz`).then((response) => response.ok, () => false)) break;
    await sleep(100);
  }

  let cookie = '';
  const call = async (method, args = {}) => {
    const response = await fetch(`${base}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(args),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const result = await response.json();
    assert.equal(result.ok, true, `${method}: ${JSON.stringify(result)}`);
    return result;
  };
  await call('client.signin', { email: 'maya@example.com', password: 'demo-password' });
  const created = await call('client.apps.create', { name: 'Claude', description: 'Example agent' });
  const general = (await call('client.boot')).channels.find((channel) => channel.name === 'general');
  await call('conversations.invite', { channel: general.id, users: created.app.bot_user_id });

  let output = '';
  const agent = spawn(process.execPath, [join(here, 'app.mjs')], {
    env: {
      ...process.env,
      BOT_TOKEN: created.bot_token,
      APP_TOKEN: created.app_token,
      API_URL: `${base}/api/`,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${claudePort}`,
      ANTHROPIC_API_KEY: 'test-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(agent);
  agent.stdout.on('data', (data) => (output += data));
  agent.stderr.on('data', (data) => (output += data));
  for (let i = 0; i < 100 && !output.includes('connected'); i += 1) await sleep(100);
  assert.match(output, /connected/, output);

  const mention = await call('chat.postMessage', { channel: general.id, text: `<@${created.app.bot_user_id}> is the freeze still on?` });
  let reply;
  for (let i = 0; i < 60; i += 1) {
    await sleep(150);
    const thread = await call('conversations.replies', { channel: general.id, ts: mention.ts });
    reply = thread.messages[1];
    if (reply && !reply.streaming) break;
  }

  assert.ok(reply, `no reply; agent output:\n${output}`);
  assert.equal(reply.bot_id, created.app.bot_id);
  assert.equal(reply.blocks?.find((block) => block.type === 'markdown')?.text, REPLY);

  assert.equal(requests.length, 1);
  const sent = requests[0];
  assert.match(sent.url, /^\/v1\/messages(\?|$)/);
  assert.equal(sent.body.model, 'claude-opus-5-5');
  assert.equal(sent.body.stream, true);
  assert.equal(sent.body.fallbacks, 'default');
  assert.match(String(sent.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
  // The transcript reached the model with names resolved and the request last.
  const prompt = sent.body.messages[0].content;
  assert.match(prompt, /Maya: @Claude is the freeze still on\?$/);
  assert.match(prompt, /2\.4 ships Thursday/);
  console.log('claude-agent smoke test passed');
} finally {
  for (const child of children) child.kill();
  fakeClaude.close();
  await sleep(200);
  rmSync(dataDir, { recursive: true, force: true });
}
