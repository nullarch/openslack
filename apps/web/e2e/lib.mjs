// Shared pieces of the browser tests: starting a server of our own, driving
// the built client in the system Chrome, and reporting.
//
// Environment: SHOTS_DIR (where screenshots go), HEADED=1 (watch it run),
// SERVER_ROOT (run the server from another checkout of this repository).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright-core';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const serverRoot = resolve(process.env.SERVER_ROOT ?? root);
export const shots = resolve(process.env.SHOTS_DIR ?? join(root, 'apps/web/e2e/shots'));
export const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
export const wide = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
mkdirSync(shots, { recursive: true });

// A 2×2 PNG.
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQoYGBgAGwQBAfMqSXQAAAAASUVORK5CYII=',
  'base64',
);

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function freePort() {
  return new Promise((done, fail) => {
    const probe = net.createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

const children = [];
const dataDirs = [];

/** Remember a process this test started, so it is stopped (by PID) at the end. */
export function track(child) {
  children.push(child);
  return child;
}

/** Start a server of our own on a free port with a throwaway data directory. */
export async function startServer({ seed, previews = false, port: chosenPort, env = {} }) {
  const port = chosenPort ?? (await freePort());
  const dataDir = mkdtempSync(join(tmpdir(), 'chat-e2e-'));
  dataDirs.push(dataDir);
  const base = `http://127.0.0.1:${port}`;
  const child = track(
    spawn(process.execPath, ['apps/server/src/main.ts'], {
      cwd: serverRoot,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        // URLs the server hands out (webhooks, files) must be reachable exactly as written.
        PUBLIC_URL: base,
        DATA_DIR: dataDir,
        WEB_DIR: join(root, 'apps/web/dist'),
        SEED_DEMO: seed ? '1' : '',
        // Link previews fetch from the network; only the tests about them turn them on.
        LINK_PREVIEWS: previews ? '1' : '0',
        ...env,
        QUIET: '1',
        NODE_NO_WARNINGS: '1',
        ...env,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    }),
  );
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) return { port, dataDir, child, base };
    } catch {
      // Not listening yet.
    }
    await sleep(100);
  }
  throw new Error('server did not start');
}

function stopAll() {
  for (const child of children) child.kill('SIGTERM');
  for (const dataDir of dataDirs) rmSync(dataDir, { recursive: true, force: true });
}

let passed = 0;
export const errors = [];

export async function step(name, body) {
  const started = Date.now();
  try {
    await body();
    passed += 1;
    console.log(`  ok    ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    throw error;
  }
}

/** Report a step that could not run here, without counting it as passed. */
export function skip(name, reason) {
  console.log(`  skip  ${name} — ${reason}`);
}

/**
 * Collect uncaught errors and console errors from a page; the run fails if any
 * remain at the end. `expected` names console errors a step provokes on purpose.
 */
export function watch(page, expected) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/Failed to load resource/.test(text) || expected?.test(text)) return;
    errors.push(text);
  });
  return page;
}

/** On failure, save what every open page looked like and print what the pages logged. */
async function debugDump(browser) {
  if (!browser) return;
  let index = 0;
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      index += 1;
      await page.screenshot({ path: join(shots, `failure-${index}.png`) }).catch(() => undefined);
      console.log(`  page ${index}: ${page.url()}`);
    }
  }
  if (errors.length > 0) console.log('  page errors:\n   ', errors.join('\n    '));
}

/**
 * The browser under test: the system Chrome by default; BROWSER=webkit (Safari's
 * engine) or BROWSER=firefox use Playwright's builds, installed with
 * `npx playwright-core install webkit firefox`.
 */
export const browserName = process.env.BROWSER ?? 'chrome';

/** Launch the browser under test; `extra` holds launch options per browser: `{ chrome, firefox, webkit }`. */
export function launchBrowser(extra = {}) {
  const headless = process.env.HEADED !== '1';
  if (browserName === 'webkit') return webkit.launch({ headless, ...extra.webkit });
  if (browserName === 'firefox') return firefox.launch({ headless, ...extra.firefox });
  return chromium.launch({ channel: 'chrome', headless, ...extra.chrome });
}

/** Launch the browser, run `main(browser)`, then stop everything this run started. */
export async function run(main, launchOptions = {}) {
  let browser;
  try {
    browser = await launchBrowser(launchOptions);
    await main(browser);
    assert.deepEqual(errors, [], 'no page errors or console errors');
    console.log(`\n${passed} steps passed. Screenshots: ${shots}`);
  } catch (error) {
    console.error(error);
    await debugDump(browser);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => undefined);
    stopAll();
  }
}

// ── Driving the client ──────────────────────────────────────────────────────

export async function shot(page, name) {
  // Park the pointer where it highlights nothing, and let toasts and transitions settle.
  await page.mouse.move(700, 22);
  await page.locator('.toast').first().waitFor({ state: 'detached', timeout: 7000 }).catch(() => undefined);
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

export async function signIn(page, base, email, password = 'demo-password') {
  await page.goto(base);
  await page.waitForURL('**/signin');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.sidebar .side-item');
}

export function sideItem(page, name) {
  return page.locator('.sidebar .side-item', { has: page.locator('.side-name', { hasText: new RegExp(`^${name}$`) }) }).first();
}

export async function openChannel(page, name) {
  await sideItem(page, name).click();
  await page.waitForSelector(`.conv-name:text-is("${name}")`);
  await page.waitForSelector('.message-content .msg');
}

export function row(page, text) {
  return page.locator('.message-scroll .msg', { hasText: text }).last();
}

export function composer(page) {
  return page.locator('.conversation .composer-input');
}

export async function send(page, text) {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

export async function setTheme(page, label) {
  await page.locator('.me-strip').click();
  await page.locator('.menu-item', { hasText: 'Preferences' }).click();
  await page.locator('.segmented button', { hasText: label }).click();
  await page.keyboard.press('Escape');
}

/** Attach a file through the composer's file input and wait for the upload to finish. */
export async function attach(page, file) {
  await page.locator('.conversation .composer-foot input[type="file"]').setInputFiles(file);
  await page.locator('.upload-chip', { hasText: file.name }).locator('.upload-sub', { hasText: /B$/ }).waitFor();
}
