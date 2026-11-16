// End-to-end check of the headline claim, through the real UI:
// an agent written with the official Bolt SDK (examples/hello-agent) connects
// to a local server, a person mentions it in the browser, the reply streams
// into a thread, and a button click reaches the agent.
//
//   pnpm --filter @app/web build && pnpm --filter @app/web e2e:agent
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const shots = process.env.SHOTS_DIR ?? join(here, 'shots');
mkdirSync(shots, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const children = [];
let browser;
let dataDir;

async function main() {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  dataDir = mkdtempSync(join(tmpdir(), 'chat-agent-e2e-'));

  const server = spawn('node', [join(root, 'apps/server/src/main.ts')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SEED_DEMO: '1', QUIET: '1', NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(server);
  for (let i = 0; i < 100; i += 1) {
    if (await fetch(`${base}/healthz`).then((response) => response.ok, () => false)) break;
    await sleep(100);
  }

  // Create the app the way an admin would, through the API the Apps screen uses.
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
  const created = await call('client.apps.create', { name: 'Hello Agent', description: 'Example agent built with Bolt' });
  const boot = await call('client.boot');
  const random = boot.channels.find((channel) => channel.name === 'random');
  await call('conversations.invite', { channel: random.id, users: created.app.bot_user_id });

  // The agent is an unmodified Bolt app; only the API address points here.
  let agentOutput = '';
  const agent = spawn('node', [join(root, 'examples/hello-agent/app.mjs')], {
    env: { ...process.env, BOT_TOKEN: created.bot_token, APP_TOKEN: created.app_token, API_URL: `${base}/api/` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(agent);
  agent.stdout.on('data', (data) => (agentOutput += data));
  agent.stderr.on('data', (data) => (agentOutput += data));
  for (let i = 0; i < 100 && !agentOutput.includes('connected'); i += 1) await sleep(100);
  assert.match(agentOutput, /connected/, `agent did not connect:\n${agentOutput}`);
  console.log('  ok    the Bolt agent connected over Socket Mode');

  browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForURL('**/signin');
  await page.fill('input[type="email"]', 'maya@example.com');
  await page.fill('input[type="password"]', 'demo-password');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.sidebar .side-item');

  await page.locator('.sidebar .side-item', { has: page.locator('.side-name', { hasText: /^random$/ }) }).first().click();
  await page.waitForSelector('.conv-name:text-is("random")');
  const composer = page.locator('.conversation .composer-input');
  await composer.pressSequentially('@Hello');
  await page.locator('.suggest-item', { hasText: 'Hello Agent' }).first().waitFor();
  await composer.press('Enter');
  await composer.pressSequentially('what has been going on in here?');
  await composer.press('Enter');
  console.log('  ok    a person mentioned the agent from the browser');

  // The agent answers in a thread under the mention.
  const mention = page.locator('.message-scroll .msg', { hasText: 'what has been going on in here?' }).last();
  await mention.locator('.thread-summary').click({ timeout: 15_000 });
  const panel = page.locator('.panel');
  await panel.locator('.md', { hasText: 'Recent activity' }).waitFor({ timeout: 15_000 });
  await page.screenshot({ path: join(shots, 'agent-streaming-live.png') });
  const confirm = panel.getByRole('button', { name: 'Looks right' });
  await confirm.waitFor({ timeout: 20_000 });
  await panel.locator('.md', { hasText: 'slackApiUrl' }).waitFor();
  console.log('  ok    the reply streamed into the thread as Markdown and ended with buttons');
  await page.mouse.move(700, 22);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, 'agent-reply.png') });

  await confirm.click();
  await panel.locator('.msg', { hasText: 'Confirmed by' }).waitFor({ timeout: 10_000 });
  console.log('  ok    the button click reached the agent and it answered');
  await page.mouse.move(700, 22);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, 'agent-confirmed.png') });

  console.log(`\nAgent round trip passed. Screenshots: ${shots}`);
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  // Stop only the processes this script started.
  for (const child of children) child.kill();
  await sleep(300);
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}
