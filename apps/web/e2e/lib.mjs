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
      // A page that stopped responding must not hold up the report.
      await page.screenshot({ path: join(shots, `failure-${index}.png`), timeout: 5000 }).catch(() => undefined);
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
    // The tests read English text: every page is English unless a test asks for another locale.
    const newContext = browser.newContext.bind(browser);
    browser.newContext = (options = {}) => newContext({ locale: 'en-US', ...options });
    const newPage = browser.newPage.bind(browser);
    browser.newPage = (options = {}) => newPage({ locale: 'en-US', ...options });
    await main(browser);
    assert.deepEqual(errors, [], 'no page errors or console errors');
    console.log(`\n${passed} steps passed. Screenshots: ${shots}`);
  } catch (error) {
    console.error(error);
    await debugDump(browser);
    process.exitCode = 1;
  } finally {
    // A browser with a page that stopped responding can fail to close; do not wait on it forever.
    const closed = await Promise.race([browser ? browser.close().then(() => true, () => true) : true, sleep(15_000).then(() => false)]);
    stopAll();
    if (!closed) {
      console.error('  the browser did not close; exiting');
      process.exit(process.exitCode || 1);
    }
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

// ── Interface languages ─────────────────────────────────────────────────────

/** Words that may stay in Latin letters in a translated interface: names from the workspace, product and protocol names, file types. */
export const ALLOWED_LATIN = new Set(
  'CSV SCIM URL API AI JSON PDF PDFs PNG JPEG GIF WebP Claude OpenAI Okta Entra ID Slack Bolt Enter Esc Shift English Aa OAuth HTTP http https vLLM Ollama LM Studio LiteLLM MB KB GB TOTP Authy Google GitHub Authenticator Password party parrot plan launch deploy name example com localhost callback SDK'.split(
    ' ',
  ),
);

/** Words from the workspace itself (people, channels, the team), which stay as they were written. */
export async function workspaceWords(page) {
  return page.evaluate(async () => {
    const boot = await (await fetch('/api/client.boot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    const words = new Set();
    const add = (text) => String(text ?? '').split(/[^A-Za-z0-9]+/).filter(Boolean).forEach((word) => words.add(word));
    for (const user of boot.users) {
      add(user.real_name);
      add(user.name);
      add(user.profile?.display_name);
      add(user.profile?.title);
    }
    for (const channel of boot.channels) add(channel.name);
    add(boot.team?.name);
    add(document.title);
    return [...words];
  });
}

/** Interface text in a part of the page (labels, buttons, headings, hints, placeholders) still in English, minus content people wrote. */
export async function leftovers(page, scope, allowed) {
  const found = await page.evaluate((selector) => {
    const out = [];
    for (const root of document.querySelectorAll(selector)) {
      const elements = root.querySelectorAll(
        'button, [role="tab"], [role="radio"], legend, label, h1, h2, h3, h4, th, .field-hint, .dialog-lead, .dialog-sub, .menu-item, .side-section-head, .notice, option, input, textarea, .stat-label, .viz-title, .empty-state, p',
      );
      for (const element of [root, ...elements]) {
        if (element.closest('.msg-body, .msg-author, .side-name, .admin-name, .report-excerpt, .mrkdwn, code, pre, .code-block, .avatar, .emoji')) continue;
        for (const attribute of ['placeholder', 'aria-label', 'title']) {
          const value = element.getAttribute?.(attribute);
          if (value) out.push(value);
        }
        // Only the element's own text, so a container does not repeat its children.
        const own = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(' ').trim();
        if (own && element.checkVisibility?.() !== false) out.push(own);
      }
    }
    return out;
  }, scope);
  const bad = [];
  for (const text of found) {
    // Code stays code: dotted or underscored identifiers (apps.manifest.*, display_information), JSON and
    // regular-expression samples.
    if (/^[{\\]/.test(text.trim())) continue;
    // …and slash commands (/remind), IP ranges (2001:db8::/32), the English time phrases the reminder parser
    // understands, and what people typed, quoted as “…” or, in Japanese, 「…」.
    const prose = text.replace(
      /[A-Za-z0-9_*/-]+(\.[A-Za-z0-9_*/-]+)+|[A-Za-z0-9]+_[A-Za-z0-9_]+|`[^`]*`|\/[a-z]+|[0-9a-f]+:[0-9a-f:]+(\/\d+)?|“[^”]*”|「[^」]*」|\b[a-z]+:[^\s,]*/g,
      ' ',
    );
    const words = prose.match(/[A-Za-z]{2,}/g) ?? [];
    const strange = words.filter((word) => !allowed.has(word));
    if (strange.length) bad.push(text);
  }
  return [...new Set(bad)];
}

export async function noSidewaysScroll(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `${label}: ${overflow}px sideways scroll`);
}

/**
 * Labels whose text runs out of their box (wider than the element and not cut
 * off on purpose with an ellipsis): what a longer translation breaks first.
 */
export async function spilled(page, scope) {
  return page.evaluate((selector) => {
    const out = [];
    for (const root of document.querySelectorAll(selector)) {
      for (const element of root.querySelectorAll('button, [role="tab"], [role="radio"], .menu-item, .side-item, legend, label, th, h1, h2, h3, .tag')) {
        if (element.checkVisibility?.() === false || element.clientWidth === 0) continue;
        const style = getComputedStyle(element);
        if (style.textOverflow === 'ellipsis' || style.overflowX === 'auto' || style.overflowX === 'scroll') continue;
        if (element.scrollWidth > element.clientWidth + 1) out.push(`${element.textContent.trim().slice(0, 40)} (${element.scrollWidth} > ${element.clientWidth})`);
      }
    }
    return [...new Set(out)];
  }, scope);
}

/** Open an item of the workspace menu (the team name at the top of the sidebar). */
export async function openTeamMenu(page, item) {
  await page.locator('.team-btn').click();
  await page.locator('.menu-item', { hasText: item }).click();
}
