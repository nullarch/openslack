// End-to-end smoke test: starts a real server with the sample workspace, drives
// the built web client in the system Chrome, and saves screenshots.
//
//   pnpm --filter @app/web build && pnpm --filter @app/web e2e
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
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const serverRoot = resolve(process.env.SERVER_ROOT ?? root);
const shots = resolve(process.env.SHOTS_DIR ?? join(root, 'apps/web/e2e/shots'));
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
mkdirSync(shots, { recursive: true });

// A 2×2 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQoYGBgAGwQBAfMqSXQAAAAASUVORK5CYII=',
  'base64',
);

function freePort() {
  return new Promise((done, fail) => {
    const probe = net.createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

const servers = [];

/** Start a server of our own on a free port with a throwaway data directory. */
async function startServer({ seed }) {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'chat-e2e-'));
  const child = spawn(process.execPath, ['apps/server/src/main.ts'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      WEB_DIR: join(root, 'apps/web/dist'),
      SEED_DEMO: seed ? '1' : '',
      QUIET: '1',
      NODE_NO_WARNINGS: '1',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const server = { port, dataDir, child, base: `http://127.0.0.1:${port}` };
  servers.push(server);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${server.base}/healthz`);
      if (response.ok) return server;
    } catch {
      // Not listening yet.
    }
    await new Promise((wait) => setTimeout(wait, 100));
  }
  throw new Error('server did not start');
}

function stopServers() {
  for (const server of servers) {
    server.child.kill('SIGTERM');
    rmSync(server.dataDir, { recursive: true, force: true });
  }
}

let browser;
let passed = 0;
let hasPlatform = false;
const errors = [];

async function step(name, run) {
  const started = Date.now();
  try {
    await run();
    passed += 1;
    console.log(`  ok    ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    throw error;
  }
}

/** On failure, save what every open page looked like and print what the pages logged. */
async function debugDump() {
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

function watch(page) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text());
  });
}

async function shot(page, name) {
  // Park the pointer where it highlights nothing, and let toasts and transitions settle.
  await page.mouse.move(700, 22);
  await page.locator('.toast').first().waitFor({ state: 'detached', timeout: 7000 }).catch(() => undefined);
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function signIn(page, base, email) {
  await page.goto(base);
  await page.waitForURL('**/signin');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', 'demo-password');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.sidebar .side-item');
}

function sideItem(page, name) {
  return page.locator('.sidebar .side-item', { has: page.locator('.side-name', { hasText: new RegExp(`^${name}$`) }) }).first();
}

async function openChannel(page, name) {
  await sideItem(page, name).click();
  await page.waitForSelector(`.conv-name:text-is("${name}")`);
  await page.waitForSelector('.message-content .msg');
}

function row(page, text) {
  return page.locator('.message-scroll .msg', { hasText: text }).last();
}

function composer(page) {
  return page.locator('.conversation .composer-input');
}

async function send(page, text) {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

async function setTheme(page, label) {
  await page.locator('.me-strip').click();
  await page.locator('.menu-item', { hasText: 'Preferences' }).click();
  await page.locator('.segmented button', { hasText: label }).click();
  await page.keyboard.press('Escape');
}

async function openAtlasThread(page) {
  await openChannel(page, 'engineering');
  await row(page, 'the checkout test started failing').locator('.thread-summary').click();
  // The Markdown renderer is a separate chunk; wait for its output, not the plain-text placeholder.
  await page.locator('.panel .md .code-block.is-diff .diff-line.add').first().waitFor();
}

async function main() {
  browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
  const seeded = await startServer({ seed: true });
  const wide = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };

  const mayaContext = await browser.newContext({ ...wide, colorScheme: 'light' });
  const maya = await mayaContext.newPage();
  const danielContext = await browser.newContext({ ...wide, colorScheme: 'light' });
  const daniel = await danielContext.newPage();
  watch(maya);
  watch(daniel);

  // Keep a handle on Maya's realtime connection so a step can deliver events
  // the server would send when an app is at work.
  let deliver = null;
  let dropConnection = null;
  await maya.routeWebSocket(/\/ws$/, (socket) => {
    socket.connectToServer();
    deliver = (event) => socket.send(JSON.stringify(event));
    dropConnection = () => socket.close();
  });

  await step('sign in and see the sample workspace', async () => {
    await signIn(maya, seeded.base, 'maya@example.com');
    for (const name of ['general', 'engineering', 'deploys', 'design', 'support', 'random', 'leadership']) {
      await sideItem(maya, name).waitFor();
    }
    // Starred holds #engineering; unread channels are bold; Daniel's DM has a mention badge.
    assert.equal(await maya.locator('.side-section', { hasText: 'Starred' }).locator('.side-item').count(), 1);
    assert.ok(await sideItem(maya, 'deploys').evaluate((node) => node.classList.contains('is-unread')));
    assert.equal(await sideItem(maya, 'Daniel').locator('.badge').innerText(), '1');
    assert.match(await maya.title(), /Northwind/);
  });

  await step('engineering: agent thread with Markdown, a diff and buttons', async () => {
    await openAtlasThread(maya);
    const panel = maya.locator('.panel');
    assert.ok((await panel.locator('.code-block.is-diff .diff-line.add').count()) >= 1);
    assert.equal(await panel.locator('.block-btn.is-primary').innerText(), 'Open pull request');
    assert.equal(await panel.locator('.md ol li').count(), 3);
    await maya.keyboard.press('Escape');
  });

  await step('deploys: Block Kit cards and the unread divider', async () => {
    await openChannel(maya, 'deploys');
    await maya.locator('.block-fields').first().waitFor();
    assert.equal(await maya.locator('.block-btn.is-primary', { hasText: 'Promote to production' }).count(), 1);
    assert.equal(await maya.locator('.block-btn.is-danger', { hasText: 'Roll back' }).count(), 1);
    assert.ok((await maya.locator('.block-context').count()) >= 1);
    assert.equal(await maya.locator('.divider-new').count(), 1);
    // Section fields sit in two real columns, not shrink-wrapped.
    const width = await maya.locator('.block-fields').first().evaluate((node) => node.getBoundingClientRect().width);
    assert.ok(width > 400, `fields grid should be wide, got ${width}`);
    await shot(maya, 'deploys-light');
  });

  await step('two people: send, edit, react, thread and delete in real time', async () => {
    await signIn(daniel, seeded.base, 'daniel@example.com');
    await openChannel(maya, 'general');
    await openChannel(daniel, 'general');
    const text = `Smoke check ${Date.now()}`;
    await send(maya, text);
    await row(daniel, text).waitFor();

    // Edit with the up arrow, as in Slack. It edits the message just sent, never an older one.
    await maya.locator('.message-scroll .msg:not(.is-pending)', { hasText: text }).waitFor();
    await composer(maya).press('ArrowUp');
    const editor = maya.locator('.edit-box textarea');
    assert.equal(await editor.inputValue(), text);
    await editor.fill(`${text} (revised)`);
    await editor.press('Enter');
    await row(daniel, `${text} (revised)`).locator('.msg-edited').waitFor();
    assert.equal(await daniel.locator('.message-scroll .msg', { hasText: '2.4 ships Thursday' }).count(), 1);

    // Daniel reacts from the hover toolbar; Maya sees the pill.
    const theirs = row(daniel, text);
    await theirs.hover();
    await theirs.locator('.msg-toolbar .icon-btn').first().click();
    await row(maya, text).locator('.reaction .reaction-count', { hasText: '1' }).waitFor();

    // Daniel replies in a thread; Maya sees the summary appear.
    await theirs.hover();
    await theirs.locator('.msg-toolbar button[aria-label="Reply in thread"]').click();
    const reply = daniel.locator('.panel .composer-input');
    await reply.fill('Replying in the thread');
    await reply.press('Enter');
    await row(maya, text).locator('.thread-count', { hasText: '1 reply' }).waitFor();
    await daniel.keyboard.press('Escape');

    // Typing indicator.
    await composer(daniel).pressSequentially('typ');
    await maya.locator('.typing-text', { hasText: 'Daniel is typing' }).waitFor();
    await composer(daniel).fill('');

    // Maya deletes a fresh message; it disappears for Daniel.
    const doomed = `Delete me ${Date.now()}`;
    await send(maya, doomed);
    await row(daniel, doomed).waitFor();
    const mine = row(maya, doomed);
    await mine.hover();
    await mine.locator('.msg-toolbar button[aria-label="More actions"]').click();
    await maya.locator('.menu-item', { hasText: 'Delete message' }).click();
    await maya.locator('.modal .btn-danger').click();
    await row(daniel, doomed).waitFor({ state: 'detached' });
  });

  await step('a mention elsewhere raises a badge and the tab title; opening clears it', async () => {
    await openChannel(maya, 'random');
    await openChannel(daniel, 'support');
    await composer(daniel).pressSequentially('@May');
    await daniel.locator('.suggest-item', { hasText: 'Maya' }).first().waitFor();
    await composer(daniel).press('Enter');
    await composer(daniel).pressSequentially('can you look at this?');
    await composer(daniel).press('Enter');
    await sideItem(maya, 'support').locator('.badge', { hasText: '1' }).waitFor();
    assert.match(await maya.title(), /^\(\d+\)/);
    await openChannel(maya, 'support');
    await row(maya, 'can you look at this?').locator('.mention.is-me').waitFor();
    await sideItem(maya, 'support').locator('.badge').waitFor({ state: 'detached' });
  });

  await step('composer: channel and emoji autocomplete, formatting, the emoji picker', async () => {
    await openChannel(maya, 'random');
    const input = composer(maya);
    await input.pressSequentially('see #engi');
    await maya.locator('.suggest-item', { hasText: 'engineering' }).waitFor();
    await input.press('Tab');
    await input.pressSequentially(':rock');
    await maya.locator('.suggest-item', { hasText: ':rocket:' }).waitFor();
    await input.press('Enter');
    await input.pressSequentially('done');
    await input.press(`${modifier}+a`);
    await maya.locator('.composer-tools button[aria-label="Bold"]').click();
    await input.press('Enter');
    const sent = row(maya, 'done');
    await sent.locator('strong .channel-link', { hasText: '#engineering' }).waitFor();
    assert.equal(await sent.locator('.emoji').first().innerText(), '🚀');

    // The picker is a separate chunk that loads on first use.
    await sent.hover();
    await sent.locator('.msg-toolbar button[aria-label="Add reaction"]').click();
    const picker = maya.locator('em-emoji-picker');
    await picker.waitFor();
    await picker.locator('input[type="search"]').fill('tada');
    await picker.locator('button[aria-label="🎉"]').first().click();
    await sent.locator('.reaction.is-mine').waitFor();
  });

  await step('channels: create one, star it, edit its topic, mark unread', async () => {
    const name = `launch-${Date.now().toString().slice(-6)}`;
    await maya.locator('.side-section', { hasText: 'Channels' }).hover();
    await maya.locator('.side-section-head button[aria-label="Add channels"]').click();
    await maya.locator('.menu-item', { hasText: 'Create a channel' }).click();
    await maya.locator('.modal input').first().fill(name);
    await maya.locator('.modal .btn-primary').click();
    await maya.waitForSelector(`.conv-name:text-is("${name}")`);
    await send(maya, 'First');
    await send(maya, 'Second');
    await row(maya, 'Second').waitFor();

    await maya.locator('.conv-head .star-btn').click();
    await maya.locator('.side-section', { hasText: 'Starred' }).locator('.side-name', { hasText: name }).waitFor();

    await maya.locator('.topic-btn').click();
    await maya.locator('.modal input').fill('Ship it on *Thursday*');
    await maya.locator('.modal .btn-primary').click();
    await maya.locator('.conv-topic strong', { hasText: 'Thursday' }).waitFor();

    // Daniel can find and join it from the channel browser, and reads Maya's messages.
    await daniel.locator('.team-btn').click();
    await daniel.locator('.menu-item', { hasText: 'Browse channels' }).click();
    await daniel.locator('.modal .wide-search').fill(name);
    await daniel.locator('.browse-row', { hasText: name }).locator('.btn-primary').click();
    await daniel.waitForSelector(`.conv-name:text-is("${name}")`);
    await row(daniel, 'Second').waitFor();
    await send(daniel, 'Third, from Daniel');
    await row(maya, 'Third, from Daniel').waitFor();

    // Mark unread from Daniel's message: the badge state returns and stays while Maya is here.
    const third = row(maya, 'Third, from Daniel');
    await third.hover();
    await third.locator('.msg-toolbar button[aria-label="More actions"]').click();
    await maya.locator('.menu-item', { hasText: 'Mark unread from here' }).click();
    await maya.locator('.divider-new').waitFor();
    await openChannel(maya, 'random');
    assert.ok(await sideItem(maya, name).evaluate((node) => node.classList.contains('is-unread')));
  });

  await step('file upload shows an inline image for both people', async () => {
    await openChannel(maya, 'general');
    await openChannel(daniel, 'general');
    await maya.locator('.conversation .composer-foot input[type="file"]').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
    await maya.locator('.upload-chip .upload-sub', { hasText: /B$/ }).waitFor();
    await composer(maya).fill('Screenshot attached');
    await composer(maya).press('Enter');
    for (const page of [maya, daniel]) {
      const message = row(page, 'Screenshot attached');
      await message.locator('.file-image img').waitFor();
      const loaded = await message.locator('.file-image img').evaluate((image) => image.decode().then(() => image.naturalWidth > 0));
      assert.ok(loaded, 'uploaded image should load');
    }
    // A text file gets a card with an expandable preview.
    await maya.locator('.conversation .composer-foot input[type="file"]').setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Release notes\n\nAll good.') });
    await maya.locator('.upload-chip .upload-sub', { hasText: /B$/ }).waitFor();
    await composer(maya).press('Enter');
    const card = daniel.locator('.file-card.is-text', { hasText: 'notes.md' }).last();
    await card.locator('.link-btn').click();
    await card.locator('.file-preview', { hasText: 'Release notes' }).waitFor();
  });

  await step('search: Korean text and the from: modifier', async () => {
    const marker = `배포 일정 공유드립니다 ${Date.now()}`;
    await send(maya, `오늘 ${marker}`);
    await row(daniel, marker).waitFor();
    await maya.keyboard.press(`${modifier}+k`);
    await maya.locator('.switcher-input input').fill('배포');
    await maya.locator('.switcher-item', { hasText: 'Search messages for' }).click();
    await maya.locator('.result', { hasText: marker }).first().waitFor();
    await shot(maya, 'search-light');

    const field = maya.locator('.search-form input');
    await field.fill('배포 from:@Daniel');
    await field.press('Enter');
    await maya.locator('.search-none').waitFor();
    await field.fill('배포 from:@Maya in:#general');
    await field.press('Enter');
    await maya.locator('.result', { hasText: marker }).first().waitFor();
    // Opening a result jumps to the message in its channel.
    await maya.locator('.result', { hasText: marker }).first().click();
    await maya.waitForSelector('.conv-name:text-is("general")');
    await row(maya, marker).waitFor();
  });

  await step('quick switcher jumps to a person; profile and status', async () => {
    await maya.keyboard.press(`${modifier}+k`);
    await maya.locator('.switcher-input input').fill('sofia');
    await maya.locator('.switcher-item.is-active', { hasText: 'Sofia' }).waitFor();
    await maya.keyboard.press('Enter');
    await maya.waitForSelector('.conv-name:text-is("Sofia")');
    await maya.locator('.conv-title').click();
    await maya.locator('.panel .profile-name', { hasText: 'Sofia Rossi' }).waitFor();
    await maya.keyboard.press('Escape');

    await maya.locator('.me-strip').click();
    await maya.locator('.menu-item', { hasText: 'Set a status' }).click();
    await maya.locator('.status-row input').fill('Reviewing the release');
    await maya.locator('.modal .btn-primary').click();
    await maya.locator('.me-status', { hasText: 'Reviewing the release' }).waitFor();
  });

  await step('administration: members, a custom emoji, the apps screen', async () => {
    await maya.locator('.team-btn').click();
    await maya.locator('.menu-item', { hasText: 'Administration' }).click();
    assert.equal(await maya.locator('.admin-body .admin-list > li').count(), 7);
    await maya.locator('.admin-modal .tabs button', { hasText: 'Custom emoji' }).click();
    await maya.locator('.emoji-admin input').first().fill('e2e-square');
    await maya.locator('.emoji-admin input[type="file"]').setInputFiles({ name: 'square.png', mimeType: 'image/png', buffer: PNG });
    await maya.locator('.emoji-admin .btn-primary').click();
    await maya.locator('.emoji-admin .admin-name', { hasText: ':e2e-square:' }).waitFor();
    await maya.locator('.admin-modal .tabs button', { hasText: 'Apps' }).click();
    await maya.locator('.apps-admin').waitFor();
    await shot(maya, 'admin-apps');
    // With the app platform present: create an app, see its tokens once, add a slash command.
    if ((await maya.locator('.apps-admin .notice').count()) === 0) {
      hasPlatform = true;
      await maya.locator('.new-app input').first().fill('E2E Bot');
      await maya.locator('.new-app .btn-primary').click();
      const secrets = maya.locator('.secrets .copy-row input');
      await secrets.first().waitFor();
      assert.match(await secrets.nth(0).inputValue(), /^xoxb-/);
      assert.match(await secrets.nth(1).inputValue(), /^xapp-/);
      assert.match(await maya.locator('.secrets .code-block').innerText(), /slackApiUrl: 'http:\/\/127\.0\.0\.1:\d+\/api\/'/);
      await shot(maya, 'admin-app-created');
      await maya.locator('.command-form input').nth(0).fill('/e2e');
      await maya.locator('.command-form input').nth(1).fill('Run the end-to-end check');
      await maya.locator('.command-form .btn').click();
      await maya.locator('.app-detail .admin-name', { hasText: '/e2e' }).waitFor();
      await maya.locator('.back-link').click();
      await maya.locator('.app-row', { hasText: 'E2E Bot' }).waitFor();
    }
    await maya.keyboard.press('Escape');
    await openChannel(maya, 'random');
    if (hasPlatform) {
      await composer(maya).pressSequentially('/e2');
      await maya.locator('.suggest-item', { hasText: '/e2e' }).waitFor();
      await composer(maya).fill('');
    }
    await send(maya, 'custom :e2e-square: emoji');
    await row(maya, 'custom').locator('img.emoji-custom').waitFor();
  });

  await step('agent at work: status, suggested prompts, a streamed reply with a plan, an ephemeral note', async () => {
    await openAtlasThread(maya);
    const channel = new URL(maya.url()).pathname.split('/').pop();
    const threadTs = await row(maya, 'the checkout test started failing').getAttribute('data-ts');
    const atlas = await maya.evaluate(async () => {
      const response = await fetch('/api/users.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const body = await response.json();
      return body.members.find((member) => member.name === 'atlas').id;
    });
    const ts = (offset) => (Date.now() / 1000 + offset).toFixed(6);
    const panel = maya.locator('.panel');

    deliver({ type: 'assistant_thread_status', channel, thread_ts: threadTs, user: atlas, status: 'is reading the test logs…' });
    await panel.locator('.assistant-status', { hasText: 'Atlas is reading the test logs' }).waitFor();
    deliver({
      type: 'assistant_thread_prompts',
      channel,
      thread_ts: threadTs,
      user: atlas,
      title: 'Try asking',
      prompts: [{ title: 'Show the failing test', message: 'Show me the failing test' }],
    });
    await panel.locator('.prompt-chip', { hasText: 'Show the failing test' }).waitFor();

    const streamTs = ts(2);
    const base = { type: 'message', user: atlas, bot_id: 'B0E2E', ts: streamTs, thread_ts: threadTs, text: 'Opening the pull request' };
    deliver({ ...base, channel, streaming: true, blocks: [{ type: 'markdown', text: 'Opening the **pull request**' }] });
    await panel.locator('.msg-body.is-streaming').waitFor();
    await panel.locator('.assistant-status').waitFor({ state: 'detached' });
    const blocks = [
      { type: 'markdown', text: 'Opening the **pull request** now.\n\n```ts\nconst total = roundHalfEven(amount, 2);\n```' },
      {
        type: 'plan',
        title: 'Fix tax rounding',
        tasks: [
          { task_id: 't1', title: 'Push the branch', status: 'complete' },
          { task_id: 't2', title: 'Open pull request #482', status: 'in_progress', details: 'Waiting for checks' },
          { task_id: 't3', title: 'Ask for review', status: 'pending' },
        ],
      },
    ];
    deliver({ type: 'message', subtype: 'message_changed', hidden: true, channel, ts: ts(3), message: { ...base, streaming: true, blocks } });
    assert.equal(await panel.locator('.plan .task').count(), 3);
    await panel.locator('.plan .task.is-active', { hasText: 'Open pull request #482' }).waitFor();
    await shot(maya, 'agent-streaming');
    deliver({ type: 'message', subtype: 'message_changed', hidden: true, channel, ts: ts(4), message: { ...base, blocks } });
    await panel.locator('.msg-body.is-streaming').waitFor({ state: 'detached' });
    await maya.keyboard.press('Escape');

    // An ephemeral note that the app then rewrites and removes.
    const noteTs = ts(5);
    deliver({ type: 'message', channel, user: atlas, bot_id: 'B0E2E', ts: noteTs, text: 'Only you can see this', is_ephemeral: true });
    const note = maya.locator('.message-scroll .msg.is-ephemeral');
    await note.locator('.msg-note', { hasText: 'Only visible to you' }).waitFor();
    deliver({
      type: 'message',
      subtype: 'message_changed',
      is_ephemeral: true,
      channel,
      ts: ts(6),
      message: { type: 'message', user: atlas, bot_id: 'B0E2E', ts: noteTs, text: 'Rewritten by the app' },
    });
    await note.locator('.msg-body', { hasText: 'Rewritten by the app' }).waitFor();
    deliver({ type: 'message', subtype: 'message_deleted', is_ephemeral: true, channel, ts: ts(7), deleted_ts: noteTs });
    await note.waitFor({ state: 'detached' });
  });

  await step('pins, channel details and adding people', async () => {
    await openChannel(maya, 'design');
    const target = row(maya, 'Dark theme contrast pass is done');
    await target.hover();
    await target.locator('.msg-toolbar button[aria-label="More actions"]').click();
    await maya.locator('.menu-item', { hasText: 'Pin to this conversation' }).click();
    await target.locator('.msg-flag', { hasText: 'Pinned' }).waitFor();
    await maya.locator('.conv-head button[aria-label="Details"]').click();
    await maya.locator('.panel .tabs button', { hasText: 'Pins' }).click();
    await maya.locator('.panel .pin-card', { hasText: 'Dark theme contrast pass is done' }).waitFor();
    await maya.locator('.panel .tabs button', { hasText: 'Members' }).click();
    await maya.locator('.panel .member-list > li').first().waitFor();
    assert.equal(await maya.locator('.panel .member-list > li').count(), 4);
    await maya.locator('.panel .members-tools .btn').click();
    await maya.locator('.modal .member-row', { has: maya.locator('.member-name', { hasText: /^Tom/ }) }).click();
    await maya.locator('.modal .btn-primary').click();
    await maya.locator('.panel .member-list .member-name', { hasText: /^Tom/ }).waitFor();
    await row(maya, 'has joined the channel').waitFor();
    await maya.keyboard.press('Escape');
  });

  await step('permalinks open the message and flash it; a reply link opens its thread', async () => {
    await openChannel(maya, 'engineering');
    const channel = new URL(maya.url()).pathname.split('/').pop();
    const ts = await row(maya, 'p95 on').getAttribute('data-ts');
    await maya.goto(`${seeded.base}/archives/${channel}/p${ts.replace('.', '')}`);
    await maya.locator(`.message-scroll .msg.is-highlighted[data-ts="${ts}"]`).waitFor();
    const reply = await maya.evaluate(async ({ channel: id, ts: parent }) => {
      const response = await fetch('/api/conversations.replies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: id, ts: parent }) });
      return (await response.json()).messages[1].ts;
    }, { channel, ts });
    await maya.goto(`${seeded.base}/archives/${channel}/p${reply.replace('.', '')}?thread_ts=${ts}&cid=${channel}`);
    await maya.locator(`.panel .msg[data-ts="${reply}"]`).waitFor();
  });

  await step('history: scrolling up loads earlier messages without losing the place', async () => {
    await openChannel(maya, 'random');
    const channel = new URL(maya.url()).pathname.split('/').pop();
    await maya.evaluate(async (id) => {
      for (let index = 1; index <= 70; index += 1) {
        await fetch('/api/chat.postMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: id, text: `bulk line ${index}` }) });
      }
    }, channel);
    await maya.reload();
    await row(maya, 'bulk line 70').waitFor();
    const line = (number) => maya.locator('.message-scroll .msg-body', { hasText: new RegExp(`^bulk line ${number}$`) });
    assert.equal(await line(5).count(), 0, 'older messages are not loaded yet');
    // Scroll up in steps, as a person would; the list fetches the previous page near the top.
    const scroller = maya.locator('.message-scroll');
    for (let attempt = 0; attempt < 60 && (await line(5).count()) === 0; attempt += 1) {
      await scroller.evaluate((node) => node.scrollBy(0, -500));
      await maya.waitForTimeout(80);
    }
    await line(5).waitFor();
    // The message that was on screen when the earlier page arrived is still on screen.
    const position = await scroller.evaluate((node) => ({ top: node.scrollTop, max: node.scrollHeight - node.clientHeight }));
    assert.ok(position.top < position.max - 200, 'the view stays in history instead of snapping to the newest message');
    assert.ok(position.top > 300, `the earlier page is added above the view, not under it (scrollTop ${position.top})`);
    await maya.locator('.jump-latest').click();
    await maya.waitForFunction(() => {
      const node = document.querySelector('.message-scroll');
      return node && node.scrollHeight - node.scrollTop - node.clientHeight < 4;
    });
  });

  await step('a dropped connection reconnects and catches up', async () => {
    await openChannel(maya, 'general');
    await openChannel(daniel, 'general');
    dropConnection();
    await maya.locator('.conn-pill').waitFor();
    const missed = `Sent while Maya was offline ${Date.now()}`;
    await send(daniel, missed);
    await maya.locator('.conn-pill').waitFor({ state: 'detached', timeout: 15000 });
    await row(maya, missed).waitFor();
  });

  await step('dropping a file on the conversation attaches it', async () => {
    const data = await maya.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['dropped'], 'dropped.txt', { type: 'text/plain' }));
      return transfer;
    });
    await maya.dispatchEvent('.conversation', 'dragenter', { dataTransfer: data });
    assert.equal(await maya.locator('.conversation').getAttribute('data-dragging'), 'true');
    await maya.dispatchEvent('.conversation', 'drop', { dataTransfer: data });
    await maya.locator('.upload-chip', { hasText: 'dropped.txt' }).locator('.upload-sub', { hasText: /B$/ }).waitFor();
    await maya.locator('.upload-chip button').click();
    await maya.locator('.upload-chip').waitFor({ state: 'detached' });
  });

  await step('a button click is answered, or explained when no app is listening', async () => {
    await openChannel(maya, 'deploys');
    await maya.locator('.block-btn', { hasText: 'View logs' }).click();
    // Without a connected app the click cannot be delivered; the client says so instead of failing silently.
    await maya.locator('.toast-error').waitFor();
    await maya.locator('.block-btn.is-pending').waitFor({ state: 'detached' });
  });

  await step('dark theme', async () => {
    await setTheme(maya, 'Dark');
    assert.equal(await maya.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await openChannel(maya, 'deploys');
    await shot(maya, 'deploys-dark');
    await maya.reload();
    await maya.waitForSelector('.sidebar .side-item');
    assert.equal(await maya.evaluate(() => document.documentElement.dataset.theme), 'dark', 'the theme survives a reload');
  });

  await step('phone width: drawer navigation and no sideways scroll', async () => {
    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
    const phone = await phoneContext.newPage();
    watch(phone);
    await phone.goto(seeded.base);
    await phone.waitForURL('**/signin');
    await phone.fill('input[type="email"]', 'sofia@example.com');
    await phone.fill('input[type="password"]', 'demo-password');
    await phone.screenshot({ path: join(shots, 'phone-signin.png') });
    await phone.click('button[type="submit"]');
    await phone.waitForSelector('.message-content .msg');
    // Sofia is not in #engineering, yet the link to it in #general shows its name.
    await phone.locator('.channel-link', { hasText: '#engineering' }).first().waitFor();
    await phone.screenshot({ path: join(shots, 'phone-conversation.png') });
    await phone.locator('.conv-head .only-narrow').click();
    await phone.locator('.sidebar .side-name', { hasText: 'design' }).click();
    await phone.waitForSelector('.conv-name:text-is("design")');
    await phone.locator('.conv-head .only-narrow').click();
    await phone.locator('.side-search').waitFor();
    await phone.waitForTimeout(300);
    await phone.screenshot({ path: join(shots, 'phone-drawer.png') });
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, 'no horizontal overflow at phone width');
    await phoneContext.close();
  });

  await step('first run: create a workspace on an empty server, invite a second person', async () => {
    const fresh = await startServer({ seed: false });
    const context = await browser.newContext(wide);
    const page = await context.newPage();
    watch(page);
    await page.goto(fresh.base);
    await page.waitForURL('**/setup');
    await page.screenshot({ path: join(shots, 'setup.png') });
    const fields = page.locator('.auth-card input');
    await fields.nth(0).fill('Acme');
    await fields.nth(1).fill('Olive Owner');
    await fields.nth(2).fill('olive@example.com');
    await fields.nth(3).fill('a long password');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.conv-name:text-is("general")');
    await send(page, 'First message in a new workspace');
    await row(page, 'First message in a new workspace').waitFor();

    await page.locator('.team-btn').click();
    await page.locator('.menu-item', { hasText: 'Invite people' }).click();
    await page.locator('.modal .btn-primary', { hasText: 'Create invite link' }).click();
    const link = await page.locator('.copy-row input').inputValue();
    assert.match(link, /\/join\//);
    const guestContext = await browser.newContext(wide);
    const guest = await guestContext.newPage();
    watch(guest);
    await guest.goto(link);
    const joinFields = guest.locator('.auth-card input');
    await joinFields.nth(0).fill('Gus Guest');
    await joinFields.nth(1).fill('gus@example.com');
    await joinFields.nth(2).fill('another long password');
    await guest.click('button[type="submit"]');
    await guest.waitForSelector('.conv-name:text-is("general")');
    await row(guest, 'First message in a new workspace').waitFor();
    await row(page, 'has joined the channel').waitFor();
    // A wrong password is explained on the sign-in form.
    const stranger = await (await browser.newContext(wide)).newPage();
    await stranger.goto(fresh.base);
    await stranger.waitForURL('**/signin');
    await stranger.fill('input[type="email"]', 'olive@example.com');
    await stranger.fill('input[type="password"]', 'not the password');
    await stranger.click('button[type="submit"]');
    await stranger.locator('.auth-error').waitFor();
    await context.close();
    await guestContext.close();
  });

  await step('light theme hero shot with a thread open', async () => {
    await setTheme(maya, 'Light');
    await openAtlasThread(maya);
    await shot(maya, 'hero-light');
    await setTheme(maya, 'Dark');
    await shot(maya, 'hero-dark');
    await setTheme(maya, 'Light');
  });

  assert.deepEqual(errors, [], 'no page errors or console errors');
  await browser.close();
  console.log(`\n${passed} steps passed. Screenshots: ${shots}`);
}

main()
  .then(() => {
    stopServers();
  })
  .catch(async (error) => {
    console.error(error);
    await debugDump();
    await browser?.close().catch(() => undefined);
    stopServers();
    process.exit(1);
  });
