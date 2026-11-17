// Canvases and lists in a real browser: two people edit one canvas live and
// see each other's cursors; one drops off, keeps typing, reconnects and both
// converge; a comment on a selection is resolved; a saved version is
// restored; a list board drag changes an item's status for the other person;
// assigning someone puts the item in their Activity. Screenshots: light,
// dark and phone width.
import assert from 'node:assert/strict';
import { openChannel, run, shot, signIn, startServer, step, watch, wide } from './lib.mjs';

const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: false, hasTouch: true };

const apiCall = (page, method, args) =>
  page.evaluate(
    async ([name, body]) => {
      const response = await fetch(`/api/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!result.ok) throw new Error(`${name}: ${result.error}`);
      return result;
    },
    [method, args],
  );

/** The canvas text, block by block, without other people's cursor labels. */
const editorText = (page, selector = '.canvas-scroll .canvas-content') =>
  page.locator(selector).first().evaluate((element) => {
    const copy = element.cloneNode(true);
    copy.querySelectorAll('.collaboration-carets__caret').forEach((caret) => caret.remove());
    return Array.from(copy.querySelectorAll('p, h1, h2, h3, pre, th, td'))
      .map((block) => block.textContent)
      .join('\n');
  });

async function waitForText(page, pattern, label, timeout = 10_000) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeout) {
    last = await editorText(page).catch(() => '');
    if (pattern.test(last)) return last;
    await page.waitForTimeout(150);
  }
  throw new Error(`timed out waiting for ${label}; text was: ${JSON.stringify(last)}`);
}

/** Put the caret at the end of the canvas. */
async function caretAtEnd(page) {
  await page.locator('.canvas-content').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
}

await run(async (browser) => {
  const { base } = await startServer({ seed: true });
  // Sockets that drop on purpose log connection errors in some browsers.
  const expected = /WebSocket|canvas/;
  const mayaContext = await browser.newContext({ ...wide, colorScheme: 'light' });
  const danielContext = await browser.newContext({ ...wide, colorScheme: 'dark' });
  const maya = watch(await mayaContext.newPage(), expected);
  const daniel = watch(await danielContext.newPage(), expected);

  // Daniel's canvas connections go through this switch, so the test can take him offline.
  let danielOffline = false;
  const danielSockets = new Set();
  await daniel.routeWebSocket(/\/canvas\//, (ws) => {
    if (danielOffline) {
      ws.close({ code: 1001, reason: 'offline' });
      return;
    }
    ws.connectToServer();
    danielSockets.add(ws);
    ws.onClose(() => danielSockets.delete(ws));
  });

  await signIn(maya, base, 'maya@example.com');
  await signIn(daniel, base, 'daniel@example.com');
  const danielId = (await apiCall(daniel, 'auth.test', {})).user_id;

  await step('a new canvas opens as a tab of the channel; the other person sees the tab and the text live', async () => {
    await openChannel(maya, 'engineering');
    await maya.locator('.doc-tab-add').click();
    await maya.locator('.menu-item', { hasText: 'New canvas' }).click();
    await maya.locator('.doc-page .canvas-content').waitFor();
    const title = maya.locator('.doc-title.is-editable');
    await title.fill('Launch notes');
    await title.press('Enter');
    await maya.locator('.doc-tab', { hasText: 'Launch notes' }).waitFor();
    await maya.locator('.canvas-status').waitFor({ state: 'detached' });
    await maya.locator('.canvas-content').click();
    await maya.keyboard.type('Hello from Maya');
    await maya.keyboard.press('Enter');

    await openChannel(daniel, 'engineering');
    await daniel.locator('.doc-tab', { hasText: 'Launch notes' }).click();
    await waitForText(daniel, /Hello from Maya/, 'Maya’s text at Daniel');
  });

  await step('both type at once and converge; each sees the other’s cursor with their name', async () => {
    await caretAtEnd(daniel);
    await daniel.keyboard.type('Daniel was here');
    await caretAtEnd(maya);
    await maya.keyboard.type('Maya again');
    const both = /(?=[\s\S]*Daniel was here)(?=[\s\S]*Maya again)/;
    await waitForText(maya, both, 'both lines at Maya');
    await waitForText(daniel, both, 'both lines at Daniel');
    assert.equal(await editorText(maya), await editorText(daniel));
    await daniel.locator('.collaboration-carets__label', { hasText: 'Maya' }).waitFor();
    await maya.locator('.collaboration-carets__label', { hasText: 'Daniel' }).waitFor();
    await maya.locator(`.canvas-presence [data-present="${danielId}"]`).waitFor();
  });

  await step('mentioning someone puts the canvas in their Activity', async () => {
    await caretAtEnd(maya);
    await maya.keyboard.press('Enter');
    await maya.keyboard.type('Ping @Dani');
    await maya.locator('.suggest-menu .suggest-item', { hasText: 'Daniel' }).first().waitFor();
    await maya.keyboard.press('Enter');
    await maya.locator('.canvas-content .mention', { hasText: '@Daniel' }).waitFor();
    await daniel.locator('.side-nav[data-view="activity"] .badge').waitFor({ timeout: 10_000 });
  });

  await step('one person drops off, keeps typing, comes back, and both converge', async () => {
    danielOffline = true;
    for (const ws of danielSockets) ws.close({ code: 1001, reason: 'offline' });
    await daniel.locator('.canvas-status.is-offline').waitFor();
    await caretAtEnd(daniel);
    await daniel.keyboard.press('Enter');
    await daniel.keyboard.type('typed while offline');
    await caretAtEnd(maya);
    await maya.keyboard.press('Enter');
    await maya.keyboard.type('typed meanwhile online');
    await daniel.waitForTimeout(500);
    assert.doesNotMatch(await editorText(maya), /typed while offline/);
    await shot(daniel, 'canvas-offline-dark');
    danielOffline = false;
    const both = /(?=[\s\S]*typed while offline)(?=[\s\S]*typed meanwhile online)/;
    await waitForText(maya, both, 'offline edit reaching Maya', 20_000);
    await waitForText(daniel, both, 'online edit reaching Daniel', 20_000);
    await daniel.locator('.canvas-status.is-offline').waitFor({ state: 'detached' });
    assert.equal(await editorText(maya), await editorText(daniel));
  });

  await step('a comment on selected text is seen by the other person and resolved', async () => {
    await daniel.locator('.canvas-content p', { hasText: 'Hello from Maya' }).click({ clickCount: 3 });
    await daniel.locator('.canvas-toolbar [aria-label="Comment"]').click();
    const box = daniel.locator('.canvas-side .comment-thread.is-draft textarea');
    await box.fill('Should this say hi to everyone?');
    await box.press('Enter');
    await daniel.locator('.comment-thread[data-thread]').waitFor();
    await daniel.locator('.canvas-content .comment-mark').waitFor();
    await maya.locator('.doc-head button', { hasText: '1 comment' }).click();
    const thread = maya.locator('.comment-thread[data-thread]');
    await thread.waitFor();
    assert.match(await thread.innerText(), /Hello from Maya[\s\S]*Should this say hi to everyone\?/);
    await maya.locator('.canvas-content .comment-mark').waitFor();
    await shot(maya, 'canvas-comments-light');
    await thread.locator('button', { hasText: 'Resolve' }).click();
    await daniel.locator('.comment-thread[data-thread]').waitFor({ state: 'detached' });
    await daniel.locator('.canvas-content .comment-mark').waitFor({ state: 'detached' });
  });

  await step('a saved version is restored, and the restore reaches the other person', async () => {
    await maya.locator('.doc-head [aria-label="Version history"]').click();
    await maya.locator('.canvas-side button', { hasText: 'Save a version' }).click();
    await maya.locator('.modal input').fill('Before the rewrite');
    await maya.locator('.modal-foot button', { hasText: 'Save a version' }).click();
    await maya.locator('.version-item', { hasText: 'Before the rewrite' }).waitFor();
    const before = await editorText(maya);

    await maya.locator('.canvas-content').click();
    await maya.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
    await maya.keyboard.type('Everything was replaced');
    await waitForText(daniel, /^Everything was replaced$/, 'the rewrite at Daniel');

    await maya.locator('.version-item', { hasText: 'Before the rewrite' }).click();
    await maya.locator('.version-modal .canvas-content').waitFor();
    assert.match(await editorText(maya, '.version-modal .canvas-content'), /Hello from Maya/);
    await shot(maya, 'canvas-version-preview');
    await maya.locator('.version-modal .modal-foot button', { hasText: 'Restore this version' }).click();
    await waitForText(daniel, /Hello from Maya[\s\S]*typed while offline/, 'the restored text at Daniel');
    await waitForText(maya, /Hello from Maya/, 'the restored text at Maya');
    assert.equal((await editorText(daniel)).trim(), before.trim());
    await maya.locator('.version-item', { hasText: 'Before restore' }).waitFor();
  });

  let listId;
  await step('a list from the bug tracker template: dragging a card on the board changes its status for the other person', async () => {
    await maya.locator('.doc-tab-add').click();
    await maya.locator('.menu-item', { hasText: 'From a template' }).click();
    await maya.locator('.template-card', { hasText: 'Bug tracker' }).click();
    await maya.locator('.doc-tab', { hasText: 'Bug tracker' }).waitFor();
    await maya.locator('.list-table').waitFor();
    listId = await maya.locator('[data-doc-page]').getAttribute('data-doc-page');
    const add = maya.locator('.list-add input');
    await add.fill('Login button does nothing');
    await add.press('Enter');
    await maya.locator('.list-table tr[data-item]', { hasText: '' }).first().waitFor();
    await maya.locator('.list-table input[value="Login button does nothing"]').waitFor();
    await shot(maya, 'list-table-light');

    await daniel.locator('.doc-tab', { hasText: 'Bug tracker' }).click();
    await daniel.locator('.list-bar [role="tab"]', { hasText: 'Board' }).click();
    const card = (page, lane) => page.locator(`.board-lane[data-lane="${lane}"] .board-card`, { hasText: 'Login button does nothing' });
    await card(daniel, '').waitFor();

    await maya.locator('.list-bar [role="tab"]', { hasText: 'Board' }).click();
    const source = card(maya, '');
    await source.waitFor();
    const from = await source.boundingBox();
    const to = await maya.locator('.board-lane[data-lane="in_progress"] .board-cards').boundingBox();
    await maya.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await maya.mouse.down();
    await maya.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 10, { steps: 4 });
    await maya.mouse.move(to.x + to.width / 2, to.y + 20, { steps: 12 });
    await maya.mouse.up();
    await card(maya, 'in_progress').waitFor();
    await card(daniel, 'in_progress').waitFor({ timeout: 10_000 });
    await shot(daniel, 'list-board-dark');
  });

  await step('assigning someone puts the item in their Activity', async () => {
    await maya.locator('.list-bar [role="tab"]', { hasText: 'Table' }).click();
    await maya.locator('.list-table td[data-column="assignee"] .cell-button').first().click();
    await maya.locator('.people-picker input').fill('Daniel');
    await maya.locator('.people-picker .menu-item', { hasText: 'Daniel' }).first().click();
    await maya.keyboard.press('Escape');
    await maya.locator('.list-table td[data-column="assignee"] .cell-person', { hasText: 'Daniel' }).waitFor();
    await daniel.locator('.side-nav[data-view="activity"]').click();
    const row = daniel.locator('[data-activity="list_assigned"]');
    await row.waitFor({ timeout: 10_000 });
    assert.match(await row.innerText(), /assigned you an item[\s\S]*Bug tracker[\s\S]*Login button does nothing/);
    await daniel.locator('[data-activity="canvas_mention"]').waitFor();
    await shot(daniel, 'activity-docs-dark');
    await row.click();
    await daniel.locator(`[data-doc-page="${listId}"]`).waitFor();
  });

  await step('canvas text is found by search, and a canvas link in a message shows a card', async () => {
    await daniel.goto(`${base}/search?q=${encodeURIComponent('typed meanwhile')}`);
    await daniel.locator('.search-tabs [role="tab"]', { hasText: 'Canvases & lists' }).click();
    await daniel.locator('.doc-result', { hasText: 'Launch notes' }).waitFor();
    const canvas = (await apiCall(maya, 'client.docs.list', { kind: 'canvas' })).docs.find((doc) => doc.title === 'Launch notes');
    await maya.locator('.doc-tab', { hasText: 'Messages' }).click();
    await maya.locator('.message-content .msg').first().waitFor();
    await apiCall(maya, 'chat.postMessage', { channel: canvas.conversation_id, text: `Notes are here: ${canvas.permalink}` });
    await maya.locator(`.doc-card[data-doc-card="${canvas.id}"]`).waitFor();
    await shot(maya, 'canvas-link-card');
  });

  await step('phone width: the canvas and the board fit without sideways scrolling', async () => {
    const context = await browser.newContext({ ...phone, colorScheme: 'light' });
    const page = watch(await context.newPage(), expected);
    await signIn(page, base, 'daniel@example.com');
    const canvas = (await apiCall(page, 'client.docs.list', { kind: 'canvas' })).docs.find((doc) => doc.title === 'Launch notes');
    await page.goto(`${base}/docs/${canvas.id}`);
    await page.locator('.canvas-content').waitFor();
    await waitForText(page, /Hello from Maya/, 'the canvas on a phone');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `page scrolls sideways by ${overflow}px`);
    await shot(page, 'canvas-phone');
    await page.goto(`${base}/lists/${listId}`);
    await page.locator('.list-bar [role="tab"]', { hasText: 'Board' }).click();
    await page.locator('.board-card').first().waitFor();
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
    await shot(page, 'list-board-phone');
    await context.close();
  });
});
