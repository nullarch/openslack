// Drives the real Electron app against a seeded server: first run with a
// server given, sign in, the dock badge follows the unread count, links to
// other sites go to the default browser, a deep link opens a message, and a
// second server keeps its own session.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SCHEME = /slug: '([^']+)'/.exec(readFileSync(join(root, 'packages/shared/src/brand.ts'), 'utf8'))[1];

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

async function startServer() {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'desktop-server-'));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(root, 'apps/server/src/main.ts')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: base, DATA_DIR: dataDir, SEED_DEMO: '1', QUIET: '1', NODE_NO_WARNINGS: '1', WEB_DIR: join(root, 'apps/web/dist'), LINK_PREVIEWS: '0' },
    stdio: 'inherit',
  });
  for (let i = 0; i < 100; i += 1) {
    if (await fetch(`${base}/healthz`).then((response) => response.ok, () => false)) break;
    await sleep(100);
  }
  return { base, child, dataDir };
}

async function api(base, cookie, method, args = {}) {
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(args),
  });
  const setCookie = response.headers.get('set-cookie');
  const body = await response.json();
  assert.equal(body.ok, true, `${method}: ${JSON.stringify(body)}`);
  return { body, cookie: setCookie ? setCookie.split(';')[0] : cookie };
}

describe('desktop app', { timeout: 120_000 }, () => {
  let server;
  let other;
  let app;
  let profile;

  before(async () => {
    server = await startServer();
    other = await startServer();
    profile = mkdtempSync(join(tmpdir(), 'desktop-profile-'));
    app = await electron.launch({
      args: [join(here, '..'), '--lang=en-US'],
      env: { ...process.env, APP_USER_DATA: profile, APP_SERVER_URL: server.base },
    });
  });
  after(async () => {
    await app?.close().catch(() => undefined);
    for (const entry of [server, other]) {
      entry?.child.kill();
      rmSync(entry?.dataDir ?? '/nonexistent', { recursive: true, force: true });
    }
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  });

  test('opens the given server and signs in inside the app window', async () => {
    const page = await app.firstWindow();
    await page.waitForURL(`${server.base}/**`);
    await page.waitForURL('**/signin');
    await page.fill('input[type="email"]', 'maya@example.com');
    await page.fill('input[type="password"]', 'demo-password');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.sidebar .side-item');
  });

  test('the dock badge follows the unread count in the title', async () => {
    const page = await app.firstWindow();
    // Open a channel that is fully read, so new unread elsewhere is counted.
    await page.locator('.sidebar .side-item', { has: page.locator('.side-name', { hasText: /^random$/ }) }).first().click();
    const daniel = await api(server.base, '', 'client.signin', { email: 'daniel@example.com', password: 'demo-password' });
    const boot = (await api(server.base, daniel.cookie, 'client.boot')).body;
    const maya = boot.users.find((user) => user.name.startsWith('maya'));
    const dm = (await api(server.base, daniel.cookie, 'conversations.open', { users: maya.id })).body.channel.id;
    await api(server.base, daniel.cookie, 'chat.postMessage', { channel: dm, text: 'are you around?' });
    let badge = 0;
    for (let i = 0; i < 50 && badge === 0; i += 1) {
      await sleep(100);
      badge = await app.evaluate(({ app: electronApp }) => electronApp.getBadgeCount());
    }
    assert.ok(badge > 0, 'the badge shows unread messages');
    // Reading everything clears it.
    await page.locator('.sidebar .side-item', { hasText: 'Daniel' }).first().click();
    for (let i = 0; i < 50 && badge !== 0; i += 1) {
      await sleep(100);
      badge = await app.evaluate(({ app: electronApp }) => electronApp.getBadgeCount());
    }
    const title = await page.title();
    assert.equal(/^\(\d+\)/.test(title) ? badge > 0 : badge === 0, true, `title "${title}" and badge ${badge} agree`);
  });

  test('links to other sites open in the default browser, not in the app', async () => {
    const page = await app.firstWindow();
    await app.evaluate(({ shell }) => {
      globalThis.__opened = [];
      shell.openExternal = async (url) => {
        globalThis.__opened.push(url);
      };
    });
    await page.evaluate(() => window.open('https://example.com/docs', '_blank'));
    await sleep(300);
    const opened = await app.evaluate(() => globalThis.__opened);
    assert.deepEqual(opened, ['https://example.com/docs']);
    assert.equal(app.windows().length, 1);
    assert.ok(page.url().startsWith(server.base));
  });

  test('a deep link opens a message on the matching server', async () => {
    const maya = await api(server.base, '', 'client.signin', { email: 'maya@example.com', password: 'demo-password' });
    const boot = (await api(server.base, maya.cookie, 'client.boot')).body;
    const general = boot.channels.find((channel) => channel.is_general).id;
    const posted = (await api(server.base, maya.cookie, 'chat.postMessage', { channel: general, text: 'deep link target' })).body;
    const path = `/archives/${general}/p${posted.ts.replace('.', '')}`;
    await app.evaluate(({ app: electronApp }, link) => electronApp.emit('open-url', { preventDefault() {} }, link), `${SCHEME}://${new URL(server.base).host}${path}`);
    const page = await app.firstWindow();
    await page.waitForURL(`${server.base}${path}`);
    await page.locator('.message-scroll .msg', { hasText: 'deep link target' }).waitFor();
  });

  test('a second server lives in its own window with its own session', async () => {
    const before = app.windows().length;
    const adder = app.waitForEvent('window');
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu().items.find((entry) => entry.label === 'Servers').submenu.items.find((entry) => entry.label.startsWith('Add a server'));
      item.click();
    });
    const form = await adder;
    await form.waitForSelector('#address');
    await form.fill('#address', other.base);
    const serverWindow = app.waitForEvent('window');
    await form.click('#submit');
    const second = await serverWindow;
    await second.waitForURL(`${other.base}/**`);
    await second.waitForURL('**/signin');
    assert.ok(app.windows().length >= before);
    const menu = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu().items.find((entry) => entry.label === 'Servers').submenu.items.filter((entry) => entry.type === 'radio').map((entry) => entry.sublabel),
    );
    assert.deepEqual(menu.sort(), [server.base, other.base].sort());
  });
});
