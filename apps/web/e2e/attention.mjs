// Third browser test: messaging and attention — Activity, Threads, All unreads,
// notification levels, Do Not Disturb, keywords, built-in commands, Later,
// scheduled messages, synced drafts, bookmarks, sidebar sections, posting
// permissions, forwarding, files and search tabs, snippets, link previews, the
// edit policy and a long history that stays bounded.
//
//   pnpm --filter @app/web build && node apps/web/e2e/attention.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attach, composer, errors, openChannel, PNG, row, run, send, shot, sideItem, signIn, sleep, startServer, step, watch, wide } from './lib.mjs';

/** Record the desktop notifications a tab would raise. */
const fakeNotifications = () => {
  window.raisedNotifications = [];
  window.Notification = class {
    static permission = 'granted';
    static requestPermission() {
      return Promise.resolve('granted');
    }
    constructor(title, options) {
      window.raisedNotifications.push({ title, body: options?.body });
    }
    close() {}
  };
};

function nav(page, view) {
  return page.locator(`.side-nav[data-view="${view}"]`);
}

async function menu(page, text) {
  await page.locator('.menu-item', { hasText: text }).first().click();
}

async function hidden(page, value) {
  await page.evaluate((state) => Object.defineProperty(document, 'visibilityState', { value: state ? 'hidden' : 'visible', configurable: true }), value);
}

const raised = (page) => page.evaluate(() => window.raisedNotifications.length);

async function toast(page, text) {
  await page.locator('.toast', { hasText: text }).first().waitFor();
}

async function mention(page, who, rest) {
  await composer(page).pressSequentially(`@${who.slice(0, 3)}`);
  await page.locator('.suggest-item', { hasText: who }).first().waitFor();
  await composer(page).press('Enter');
  await composer(page).pressSequentially(rest);
  await composer(page).press('Enter');
}

async function moreActions(page, message, item) {
  await message.hover();
  await message.locator('.msg-toolbar button[aria-label="More actions"]').click();
  await menu(page, item);
}

async function main(browser) {
  const server = await startServer({ seed: true });

  const mayaContext = await browser.newContext({ ...wide, colorScheme: 'light' });
  const danielContext = await browser.newContext({ ...wide, colorScheme: 'light' });
  await mayaContext.addInitScript(fakeNotifications);
  await danielContext.addInitScript(fakeNotifications);
  const maya = watch(await mayaContext.newPage());
  const daniel = watch(await danielContext.newPage());
  await signIn(maya, server.base, 'maya@example.com');
  await signIn(daniel, server.base, 'daniel@example.com');

  await step('activity: a mention shows up, opening it reads it, and all can be marked read', async () => {
    await openChannel(maya, 'random');
    await openChannel(daniel, 'random');
    const badge = nav(maya, 'activity').locator('.badge');
    const before = Number((await badge.textContent().catch(() => '0')) || 0);
    await mention(daniel, 'Maya', 'can you check the release notes?');
    await maya.waitForFunction((count) => Number(document.querySelector('.side-nav[data-view="activity"] .badge')?.textContent ?? 0) > count, before);
    await nav(maya, 'activity').click();
    const item = maya.locator('.activity-item', { hasText: 'can you check the release notes?' });
    await item.waitFor();
    assert.match(await item.locator('.activity-headline').textContent(), /Daniel mentioned you/);
    assert.ok(await item.evaluate((node) => node.classList.contains('is-unread')));
    // Seeded reactions to Maya's messages are activity too.
    await maya.locator('.tabs button', { hasText: 'Reactions' }).click();
    await maya.locator('.activity-item[data-activity="reaction"]').first().waitFor();
    await maya.locator('.tabs button', { hasText: 'All' }).click();
    await shot(maya, 'activity-view');
    await maya.locator('.activity-item', { hasText: 'can you check the release notes?' }).click();
    await maya.waitForSelector('.conv-name:text-is("random")');
    await row(maya, 'can you check the release notes?').waitFor();
    await nav(maya, 'activity').click();
    await maya.locator('.activity-item:not(.is-unread)', { hasText: 'can you check the release notes?' }).waitFor();
    await maya.locator('.view .conv-head button', { hasText: 'Mark all as read' }).click();
    await badge.waitFor({ state: 'detached' });
  });

  await step('threads: a reply in a followed thread makes Threads bold; the view shows it and catches you up', async () => {
    await openChannel(daniel, 'engineering');
    await row(daniel, 'the checkout test started failing').locator('.thread-summary').click();
    await daniel.locator('.panel .composer-input').fill('Pushed the fix to the PR as well.');
    await daniel.locator('.panel .composer-input').press('Enter');
    await nav(maya, 'threads').and(maya.locator('.is-unread')).waitFor();
    await nav(maya, 'threads').click();
    const card = maya.locator('.thread-card', { hasText: 'Pushed the fix to the PR as well.' });
    await card.waitFor();
    assert.ok(await card.locator('.tag-unread').count(), 'the thread is marked new');
    await shot(maya, 'threads-view');
    await maya.waitForFunction(() => !document.querySelector('.side-nav[data-view="threads"]')?.classList.contains('is-unread'), null, { timeout: 5000 });

    // Unfollowing from the thread panel stops the thread from coming back.
    await card.locator('button', { hasText: 'Reply…' }).click();
    const follow = maya.locator('.panel .follow-btn');
    await follow.locator('text=Following').waitFor();
    await follow.click();
    await follow.locator('text=Follow thread').waitFor();
    await daniel.locator('.panel .composer-input').fill('One more detail.');
    await daniel.locator('.panel .composer-input').press('Enter');
    await maya.locator('.panel .msg', { hasText: 'One more detail.' }).waitFor();
    await sleep(500);
    assert.ok(!(await nav(maya, 'threads').evaluate((node) => node.classList.contains('is-unread'))), 'an unfollowed thread does not light up');
    await follow.click();
    await follow.locator('text=Following').waitFor();
    await maya.keyboard.press('Escape');
  });

  await step('all unreads: unread conversations grouped, each marked read on its own', async () => {
    await nav(maya, 'unreads').click();
    const groups = maya.locator('.unread-group');
    await groups.first().waitFor();
    const count = await groups.count();
    assert.ok(count >= 2, `several unread conversations from the sample data (${count})`);
    await shot(maya, 'unreads-view');
    const first = groups.first();
    const id = await first.getAttribute('data-channel');
    await first.locator('button', { hasText: 'Mark as read' }).click();
    await maya.locator(`.unread-group[data-channel="${id}"]`).waitFor({ state: 'detached' });
    assert.equal(await maya.locator(`.sidebar .side-item[data-channel="${id}"].is-unread`).count(), 0);
  });

  await step('notification level: “all new messages” notifies for a plain message, “nothing” silences a mention', async () => {
    await openChannel(maya, 'support');
    await openChannel(daniel, 'support');
    await maya.locator('.notify-btn').click();
    await menu(maya, 'All new messages');
    await maya.locator('.notify-btn.is-all').waitFor();
    await hidden(maya, true);
    let before = await raised(maya);
    await send(daniel, 'Plain update about the queue');
    await maya.waitForFunction((count) => window.raisedNotifications.length > count, before);
    assert.match((await maya.evaluate(() => window.raisedNotifications.at(-1))).body, /Plain update about the queue/);
    await hidden(maya, false);
    await maya.locator('.notify-btn').click();
    await menu(maya, 'Nothing');
    await maya.locator('.notify-btn.is-nothing').waitFor();
    await hidden(maya, true);
    before = await raised(maya);
    await mention(daniel, 'Maya', 'this should stay quiet');
    await row(maya, 'this should stay quiet').waitFor();
    await sleep(300);
    assert.equal(await raised(maya), before);
    await hidden(maya, false);
    await maya.locator('.notify-btn').click();
    await menu(maya, 'Default');
  });

  await step('do not disturb: a pause shows to others, holds notifications, and “notify anyway” gets through', async () => {
    await maya.locator('.me-strip').click();
    await menu(maya, 'For 30 minutes');
    await maya.locator('.me-strip.is-paused').waitFor();
    assert.match(await maya.locator('.me-status').textContent(), /Notifications paused until/);
    await sideItem(daniel, 'Maya').click();
    await daniel.waitForSelector('.conv-name:text-is("Maya")');
    await daniel.locator('.dnd-hint', { hasText: 'Maya has paused notifications.' }).waitFor();
    await daniel.locator('.conv-dnd').waitFor();
    await hidden(maya, true);
    const before = await raised(maya);
    await send(daniel, 'urgent: the build is red');
    await row(daniel, 'urgent: the build is red').and(daniel.locator(':not(.is-pending)')).waitFor();
    await sleep(400);
    assert.equal(await raised(maya), before, 'held while paused');
    await shot(daniel, 'dnd-notify-anyway');
    await daniel.locator('.dnd-hint button', { hasText: 'Notify anyway' }).click();
    await maya.waitForFunction((count) => window.raisedNotifications.length > count, before);
    await hidden(maya, false);
    await maya.locator('.me-strip').click();
    await menu(maya, 'Resume notifications');
    await maya.locator('.me-strip.is-paused').waitFor({ state: 'detached' });
  });

  await step('keywords: a word from Preferences in someone else’s message shows up in Activity', async () => {
    await maya.locator('.me-strip').click();
    await menu(maya, 'Preferences');
    await maya.locator('.modal input[aria-label="My keywords"]').fill('deploy, 배포');
    await maya.locator('.modal button', { hasText: 'Save changes' }).click();
    await sleep(300);
    await maya.keyboard.press('Escape');
    await openChannel(daniel, 'random');
    await send(daniel, '오늘 배포는 오후 3시입니다');
    await nav(maya, 'activity').click();
    await maya.locator('.tabs button', { hasText: 'Keywords' }).click();
    await maya.locator('.activity-item', { hasText: '오늘 배포는 오후 3시입니다' }).locator('.activity-headline', { hasText: 'Your keyword “배포”' }).waitFor();
  });

  await step('built-in commands: /status, /shrug, /topic, /msg and /remind', async () => {
    await openChannel(maya, 'random');
    await send(maya, '/status :coffee: Brewing');
    await toast(maya, 'Status updated.');
    await maya.locator('.me-status', { hasText: 'Brewing' }).waitFor();
    await send(maya, '/shrug fine by me');
    await row(maya, 'fine by me').locator('.msg-body', { hasText: 'fine by me ¯\\_(ツ)_/¯' }).waitFor();
    await send(maya, '/topic Release week');
    await maya.locator('.topic-btn', { hasText: 'Release week' }).waitFor();
    await send(maya, '/msg @daniel lunch at noon?');
    await toast(maya, 'Sent to Daniel.');
    await sideItem(daniel, 'Maya').click();
    await row(daniel, 'lunch at noon?').waitFor();
    await send(maya, '/remind me to stretch in 2 seconds');
    await toast(maya, 'I’ll remind you to “stretch”');
    await sideItem(maya, 'Reminders').waitFor({ timeout: 8000 });
    await sideItem(maya, 'Reminders').click();
    await row(maya, 'Reminder: stretch.').waitFor();
    await nav(maya, 'later').click();
    await maya.locator('.tabs button', { hasText: 'Reminders' }).click();
    await maya.locator('.reminder-item', { hasText: 'stretch' }).waitFor();
    // Built-ins are offered by the composer's command list.
    await openChannel(maya, 'random');
    await composer(maya).pressSequentially('/sh');
    await maya.locator('.suggest-item', { hasText: '/shrug' }).waitFor();
    await composer(maya).fill('');
  });

  await step('later: save a message from its toolbar, find it in Later, complete it', async () => {
    await openChannel(maya, 'random');
    const message = row(maya, 'Friday demo slot is open');
    await message.hover();
    await message.locator('.msg-toolbar button[aria-label="Save for later"]').click();
    await message.locator('.msg-flag.is-saved').waitFor();
    await nav(maya, 'later').locator('.badge', { hasText: '1' }).waitFor();
    await nav(maya, 'later').click();
    const item = maya.locator('.later-item', { hasText: 'Friday demo slot is open' });
    await item.waitFor();
    await shot(maya, 'later-view');
    await item.locator('button[aria-label="Mark complete"]').click();
    await item.waitFor({ state: 'detached' });
    await maya.locator('.tabs button', { hasText: 'Completed' }).click();
    await maya.locator('.later-item', { hasText: 'Friday demo slot is open' }).waitFor();
  });

  await step('scheduled messages: schedule from the composer, find and delete it; one due now posts by itself', async () => {
    await openChannel(maya, 'random');
    await composer(maya).fill('Scheduled hello for tomorrow');
    await maya.locator('.conversation .send-more').click();
    await menu(maya, 'Tomorrow at 9:00 AM');
    await toast(maya, 'Message scheduled for tomorrow at 9:00 AM.');
    assert.equal(await composer(maya).inputValue(), '');
    await nav(maya, 'drafts').locator('.badge').waitFor();
    await nav(maya, 'drafts').click();
    await maya.locator('.tabs button', { hasText: 'Scheduled' }).click();
    const item = maya.locator('.scheduled-item', { hasText: 'Scheduled hello for tomorrow' });
    await item.waitFor();
    assert.match(await item.textContent(), /Sends tomorrow at 9:00/);
    await item.locator('button[aria-label="Delete scheduled message"]').click();
    await maya.locator('.view-empty', { hasText: 'No scheduled messages.' }).waitFor();
    // Through the API, due in two seconds: it arrives in the channel on its own.
    await openChannel(daniel, 'random');
    const channel = await daniel.evaluate(() => location.pathname.split('/').pop());
    await maya.evaluate(
      (id) => fetch('/api/chat.scheduleMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: id, text: 'Posted by the scheduler', post_at: Math.floor(Date.now() / 1000) + 2 }) }),
      channel,
    );
    await row(daniel, 'Posted by the scheduler').waitFor({ timeout: 8000 });
  });

  await step('drafts: an unsent message follows you to another tab, and leaves when you clear it', async () => {
    const other = watch(await (await browser.newContext({ ...wide, colorScheme: 'light' })).newPage());
    await signIn(other, server.base, 'maya@example.com');
    await openChannel(maya, 'support');
    await composer(maya).fill('half-written idea about onboarding');
    await nav(other, 'drafts').locator('.badge').waitFor({ timeout: 5000 });
    await nav(other, 'drafts').click();
    await other.locator('.tabs button', { hasText: 'Drafts' }).click();
    const draft = other.locator('.draft-item', { hasText: 'half-written idea about onboarding' });
    await draft.waitFor();
    await draft.click();
    await other.waitForSelector('.conv-name:text-is("support")');
    assert.equal(await composer(other).inputValue(), 'half-written idea about onboarding');
    await composer(maya).fill('');
    await other.waitForFunction(() => !document.querySelector('.side-nav[data-view="drafts"] .badge'), null, { timeout: 5000 });
    await other.context().close();
  });

  await step('bookmarks: added under the channel header, seen by others at once', async () => {
    await openChannel(maya, 'random');
    await openChannel(daniel, 'random');
    await maya.locator('.conversation .bookmark-add').click();
    await maya.locator('.modal input[type="url"]').fill('https://example.com/runbook');
    await maya.locator('.modal input:not([type="url"])').fill('Runbook');
    await maya.locator('.modal .btn-primary').click();
    await maya.locator('.bookmarks-bar .bookmark', { hasText: 'Runbook' }).waitFor();
    await daniel.locator('.bookmarks-bar .bookmark', { hasText: 'Runbook' }).waitFor();
    assert.equal(await daniel.locator('.bookmarks-bar .bookmark', { hasText: 'Runbook' }).getAttribute('href'), 'https://example.com/runbook');
  });

  await step('sidebar sections: create one, move a channel in, collapse it; it all survives a reload', async () => {
    await maya.locator('.sidebar button[aria-label="Sidebar options"]').click();
    await menu(maya, 'Create a section…');
    await maya.locator('.modal input').fill('Projects');
    await maya.locator('.modal input').press('Enter');
    const section = maya.locator('.side-section', { has: maya.locator('h3', { hasText: 'Projects' }) });
    await section.waitFor();
    await sideItem(maya, 'leadership').click({ button: 'right' });
    await maya.locator('.side-menu .menu-item', { hasText: 'Projects' }).click();
    await section.locator('.side-item', { hasText: 'leadership' }).waitFor();
    await section.locator('.side-section-toggle').click();
    await section.locator('.side-item', { hasText: 'leadership' }).waitFor({ state: 'hidden' });
    await maya.reload();
    await maya.waitForSelector('.sidebar .side-item');
    await maya.locator('.side-section.is-collapsed', { has: maya.locator('h3', { hasText: 'Projects' }) }).waitFor();
    await maya.locator('.side-section', { has: maya.locator('h3', { hasText: 'Projects' }) }).locator('.side-section-toggle').click();
    await maya.locator('.side-section', { has: maya.locator('h3', { hasText: 'Projects' }) }).locator('.side-item', { hasText: 'leadership' }).waitFor();
    await shot(maya, 'sidebar-sections');
  });

  await step('posting permissions: an announcement channel, set from the channel details', async () => {
    await openChannel(maya, 'general');
    await openChannel(daniel, 'general');
    await maya.locator('.conv-head button[aria-label="Details"]').click();
    await maya.locator('.posting select[aria-label="Who can post"]').selectOption('admins');
    await daniel.locator('.notice-bar', { hasText: 'Only admins and channel managers can post in this channel.' }).waitFor();
    assert.equal(await composer(daniel).count(), 0);
    await send(maya, 'Office closed Friday.');
    await row(daniel, 'Office closed Friday.').waitFor();
    await maya.locator('.posting select[aria-label="Who can post"]').selectOption('everyone');
    await composer(daniel).waitFor();
    await maya.keyboard.press('Escape');
  });

  await step('forwarding: a message forwarded with a comment arrives quoted', async () => {
    await openChannel(maya, 'engineering');
    await moreActions(maya, row(maya, 'dropped from 480ms to 95ms'), 'Forward message');
    await maya.locator('.forward-modal input[aria-label="To"]').fill('random');
    await maya.locator('.forward-modal .member-row', { hasText: 'random' }).click();
    await maya.locator('.forward-modal textarea').fill('FYI, nice win');
    await maya.locator('.forward-modal .btn-primary').click();
    await toast(maya, 'Message forwarded.');
    await openChannel(daniel, 'random');
    const forwarded = row(daniel, 'FYI, nice win');
    await forwarded.locator('.attachment-wrap.is-share', { hasText: 'dropped from 480ms to 95ms' }).waitFor();
    assert.match(await forwarded.locator('.attachment-footer').textContent(), /Posted in #engineering/);
  });

  await step('files: the Files view, sharing a file elsewhere, and the search tabs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-e2e-files-'));
    const path = join(dir, 'roadmap-2027.txt');
    writeFileSync(path, 'Q1: search\nQ2: calls\n');
    await openChannel(maya, 'design');
    await attach(maya, path);
    await composer(maya).press('Enter');
    await row(maya, 'roadmap-2027.txt').waitFor();
    rmSync(dir, { recursive: true, force: true });
    await nav(maya, 'files').click();
    const file = maya.locator('.file-row', { hasText: 'roadmap-2027.txt' });
    await file.waitFor();
    await file.locator('button[aria-label="Share file…"]').click();
    await maya.locator('.modal input[aria-label="To"]').fill('random');
    await maya.locator('.modal .member-row', { hasText: 'random' }).click();
    await maya.locator('.modal .btn-primary').click();
    await toast(maya, 'File shared.');
    await openChannel(daniel, 'random');
    await row(daniel, 'roadmap-2027.txt').waitFor();

    await maya.goto(`${server.base}/search?q=roadmap`);
    await maya.locator('.search-tabs button', { hasText: 'Files' }).click();
    await maya.locator('.file-row', { hasText: 'roadmap-2027.txt' }).waitFor();
    await maya.locator('.search-form input').fill('design');
    await maya.locator('.search-form input').press('Enter');
    await maya.locator('.search-tabs button', { hasText: 'Channels' }).click();
    await maya.locator('.browse-row', { hasText: 'design' }).waitFor();
    await maya.locator('.search-form input').fill('Daniel');
    await maya.locator('.search-form input').press('Enter');
    await maya.locator('.search-tabs button', { hasText: 'People' }).click();
    await maya.locator('.search-people .member-row', { hasText: 'Daniel' }).waitFor();
    await maya.locator('.search-form input').fill('');
    await maya.locator('.search-form input').focus();
    await maya.locator('.search-suggest .suggest-item', { hasText: 'roadmap' }).waitFor();
  });

  await step('snippets: a code snippet is shared with syntax highlighting', async () => {
    await openChannel(maya, 'design');
    await maya.locator('.conversation button[aria-label="Create a snippet"]').click();
    await maya.locator('.modal input').first().fill('active users');
    await maya.locator('.modal select').selectOption('sql');
    await maya.locator('.modal textarea').fill('SELECT id, name FROM users WHERE active = 1;');
    await maya.locator('.modal .btn-primary').click();
    const snippet = maya.locator('.message-scroll .file-card.is-snippet').last();
    await snippet.locator('.hljs-keyword', { hasText: 'SELECT' }).waitFor();
    assert.match(await snippet.textContent(), /1 line/);
    await shot(maya, 'snippet');
  });

  await step('edit policy: with editing turned off, people lose “Edit” on their own messages; admins keep it', async () => {
    await openChannel(daniel, 'random');
    await send(daniel, 'a message I might want to edit');
    const mine = row(daniel, 'a message I might want to edit');
    await mine.and(daniel.locator(':not(.is-pending)')).waitFor();
    await maya.locator('.team-btn').click();
    await menu(maya, 'Administration');
    await maya.locator('.admin-modal .tabs button', { hasText: 'Workspace' }).click();
    await maya.locator('.message-policy select').first().selectOption('0');
    await toast(maya, 'Saved');
    await maya.keyboard.press('Escape');
    await mine.hover();
    await mine.locator('.msg-toolbar button[aria-label="More actions"]').click();
    await daniel.locator('.menu-item', { hasText: 'Forward message' }).waitFor();
    assert.equal(await daniel.locator('.menu-item', { hasText: 'Edit message' }).count(), 0);
    await daniel.keyboard.press('Escape');
    await maya.locator('.team-btn').click();
    await menu(maya, 'Administration');
    await maya.locator('.admin-modal .tabs button', { hasText: 'Workspace' }).click();
    await maya.locator('.message-policy select').first().selectOption('-1');
    await toast(maya, 'Saved');
    await maya.keyboard.press('Escape');
  });

  await step('long history: the list keeps a bounded number of rows while scrolling through 700 messages', async () => {
    const id = await maya.evaluate(async () => {
      const post = (method, body) => fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
      const created = await post('conversations.create', { name: `long-history-${Date.now()}` });
      for (let index = 1; index <= 700; index += 1) await post('chat.postMessage', { channel: created.channel.id, text: `long line ${index}` });
      return created.channel.id;
    });
    await maya.goto(`${server.base}/c/${id}`);
    await maya.locator('.message-scroll .msg-body', { hasText: /^long line 700$/ }).waitFor();
    const rows = () => maya.locator('.message-content > .msg').count();
    const scroller = maya.locator('.message-scroll');
    let most = 0;
    for (let attempt = 0; attempt < 400 && (await maya.locator('.message-content .intro').count()) === 0; attempt += 1) {
      await scroller.evaluate((node) => node.scrollBy(0, -1200));
      await maya.waitForTimeout(40);
      if (attempt % 10 === 0) most = Math.max(most, await rows());
    }
    await maya.locator('.message-content .intro').waitFor();
    await maya.locator('.message-scroll .msg-body', { hasText: /^long line 1$/ }).waitFor();
    most = Math.max(most, await rows());
    assert.ok(most <= 360, `rows on the page stay bounded (at most ${most})`);
    assert.equal(await maya.locator('.message-scroll .msg-body', { hasText: /^long line 700$/ }).count(), 0, 'the newest end was let go');
    await maya.locator('.jump-latest').click();
    await maya.locator('.message-scroll .msg-body', { hasText: /^long line 700$/ }).waitFor();
    await maya.waitForFunction(() => {
      const node = document.querySelector('.message-scroll');
      return node && node.scrollHeight - node.scrollTop - node.clientHeight < 4;
    });
  });

  await step('dark theme: the new views read well', async () => {
    const page = watch(await (await browser.newContext({ ...wide, colorScheme: 'dark' })).newPage());
    await signIn(page, server.base, 'maya@example.com');
    await nav(page, 'activity').click();
    await page.locator('.activity-item').first().waitFor();
    await shot(page, 'activity-dark');
    await page.context().close();
  });

  await linkPreviews(browser);
}

/** On a second server with previews on, against a local "website". */
async function linkPreviews(browser) {
  const site = createServer((req, res) => {
    if (req.url === '/post') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><title>x</title><meta property="og:title" content="Shipping 2.4"><meta property="og:description" content="Faster search and a new composer."><meta property="og:site_name" content="Northwind Blog"><meta property="og:image" content="/cover.png">',
      );
    } else if (req.url === '/cover.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((done) => site.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${site.address().port}/post`;
  try {
    const server = await startServer({ seed: true, previews: true });
    const page = watch(await (await browser.newContext({ ...wide, colorScheme: 'light' })).newPage());
    await step('link previews: a link gets a card with an image served by this server; the author can remove it', async () => {
      await signIn(page, server.base, 'maya@example.com');
      await openChannel(page, 'random');
      await send(page, `Release post: ${url}`);
      const message = row(page, 'Release post:');
      const card = message.locator('.attachment-wrap.is-preview');
      await card.locator('.attachment-title', { hasText: 'Shipping 2.4' }).waitFor({ timeout: 8000 });
      assert.match(await card.textContent(), /Northwind Blog/);
      const image = card.locator('img.attachment-image');
      await image.waitFor();
      assert.match(await image.getAttribute('src'), /^\/previews\/lp[0-9a-f]{40}$/);
      await page.waitForFunction(() => {
        const img = document.querySelector('.attachment-wrap.is-preview img.attachment-image');
        return img && img.complete && img.naturalWidth > 0;
      });
      await shot(page, 'link-preview');
      await message.hover();
      await card.hover();
      await card.locator('button[aria-label="Remove preview"]').click();
      await card.waitFor({ state: 'detached' });
    });
    await page.context().close();
  } finally {
    site.close();
  }
}

await run(main);
if (errors.length) process.exitCode = 1;
