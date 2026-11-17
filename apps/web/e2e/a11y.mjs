// Accessibility in a real browser. Three parts:
//
// 1. axe-core (WCAG 2.2 A and AA rules plus best practices) on every main surface,
//    in the light and dark themes, in every sidebar theme, and in Korean. Serious
//    and critical violations fail the run; moderate and minor ones are listed.
// 2. The core path by keyboard alone: no mouse from signing in to closing the last
//    dialog, with focus visible at every stop and back where it was after each close.
// 3. What screen readers are told (message names, live regions), less motion, and
//    forced colors.
//
//   pnpm --filter @app/web build && node apps/web/e2e/a11y.mjs
//   A11Y_REPORT=1 prints every finding in full; the whole report is also saved
//   as a11y-report.json next to the screenshots. A11Y_PART=axe runs part 1 only,
//   A11Y_PART=keyboard parts 2 and 3. The huddle bar is audited when LiveKit is
//   available (LIVEKIT_SERVER_BIN) and the browser is Chrome.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { browserName, composer, freePort, modifier, openChannel, row, run, shot, shots, signIn, startServer, step, watch, wide } from './lib.mjs';
import { findLiveKit, startLiveKit } from './livekit.mjs';

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const FAILING = new Set(['serious', 'critical']);
const ORDER = ['critical', 'serious', 'moderate', 'minor'];
const findings = new Map();
const audited = [];

// ── axe ─────────────────────────────────────────────────────────────────────

/** Run axe on the page, or on the part `include` names, and record what it finds under `surface`. */
async function audit(page, surface, include) {
  await page.waitForTimeout(150);
  // A dialog still fading in would be measured half transparent: let finite animations end first.
  await page.evaluate(() =>
    Promise.race([
      Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined))),
      new Promise((done) => setTimeout(done, 2000)),
    ]),
  );
  const target = include ?? null;
  if (target && (await page.locator(target).count()) === 0) throw new Error(`${surface}: nothing matches ${target}`);
  const violations = await page.evaluate(
    async ([source, scope]) => {
      if (!window.axe) (0, eval)(source);
      const report = await window.axe.run(scope ? { include: [[scope]] } : document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
        resultTypes: ['violations'],
        // Page-level rules (one main landmark, a level-one heading, everything in a landmark) apply to whole pages only.
        rules: scope ? { region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } } : {},
      });
      return report.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.map((node) => ({ target: node.target.flat().join(' '), html: node.html.slice(0, 160), summary: node.failureSummary })),
      }));
    },
    [AXE, target],
  );
  audited.push(surface);
  for (const violation of violations) {
    const entry = findings.get(violation.id) ?? { id: violation.id, impact: violation.impact, help: violation.help, surfaces: new Set(), nodes: [] };
    entry.surfaces.add(surface);
    for (const node of violation.nodes) entry.nodes.push({ surface, ...node });
    findings.set(violation.id, entry);
  }
}

function report() {
  const rows = [...findings.values()].sort((a, b) => ORDER.indexOf(a.impact) - ORDER.indexOf(b.impact));
  writeFileSync(
    join(shots, 'a11y-report.json'),
    JSON.stringify({ audited, findings: rows.map((entry) => ({ ...entry, surfaces: [...entry.surfaces] })) }, null, 2),
  );
  console.log(`\n  ${audited.length} surfaces audited.`);
  for (const entry of rows) {
    const bad = FAILING.has(entry.impact);
    console.log(`  ${bad ? 'BAD ' : 'note'}  [${entry.impact}] ${entry.id}: ${entry.help} — ${entry.nodes.length} on ${[...entry.surfaces].slice(0, 8).join(', ')}${entry.surfaces.size > 8 ? ', …' : ''}`);
    if (bad || process.env.A11Y_REPORT === '1') {
      for (const node of entry.nodes.slice(0, 8)) console.log(`          ${node.surface}: ${node.target}  ${(node.summary ?? '').split('\n').slice(0, 2).join(' | ')}`);
    }
  }
  return rows.filter((entry) => FAILING.has(entry.impact));
}

// ── Getting around with the mouse (part 1) ──────────────────────────────────

async function api(page, method, args = {}) {
  const result = await page.evaluate(
    async ([name, body]) => {
      const response = await fetch(`/api/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return response.json();
    },
    [method, args],
  );
  assert.ok(result.ok, `${method}: ${JSON.stringify(result)}`);
  return result;
}

const dialog = (page) => page.locator('.modal[role="dialog"]').last();

async function closeDialog(page) {
  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'detached' });
}

async function fromMenu(page, opener, item) {
  await page.locator(opener).first().click();
  await page.locator('.popover[role="menu"] .menu-item', { hasText: item }).first().click();
}

async function view(page, name) {
  await page.locator(`.sidebar .side-nav[data-view="${name}"]`).click();
  await page.waitForTimeout(300);
}

/** Things to look at that the sample workspace does not have: a canvas, a list, a workflow. */
async function fixtures(page) {
  const canvas = await api(page, 'canvases.create', {
    title: 'Launch plan',
    document_content: { type: 'markdown', markdown: '# Launch plan\n\n## Goals\n\n- Ship the beta\n- [ ] Write the notes\n\n> Keep it short.\n\n```\nnpm start\n```' },
  });
  const list = await api(page, 'slackLists.create', {
    name: 'Bugs',
    schema: [
      { key: 'title', name: 'Bug', type: 'text', is_primary_column: true },
      { key: 'status', name: 'Status', type: 'select', options: { choices: [{ value: 'open', label: 'Open', color: 'red' }, { value: 'fixed', label: 'Fixed', color: 'green' }] } },
      { key: 'owner', name: 'Owner', type: 'user' },
      { key: 'done', name: 'Done', type: 'checkbox' },
    ],
  });
  const columns = list.list_metadata.schema;
  const column = (key) => columns.find((entry) => entry.key === key).id;
  const text = (value) => [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: value }] }] }];
  await api(page, 'slackLists.items.create', { list_id: list.list_id, initial_fields: [{ column_id: column('title'), rich_text: text('Login button does nothing') }, { column_id: column('status'), select: ['open'] }] });
  await api(page, 'slackLists.items.create', { list_id: list.list_id, initial_fields: [{ column_id: column('title'), rich_text: text('Slow search') }] });
  const workflow = await api(page, 'client.workflows.save', {
    name: 'Welcome',
    trigger: { type: 'shortcut' },
    steps: [{ id: 'hi', type: 'message', destination: { to: 'trigger_channel' }, text: 'Welcome, {{trigger.user}}' }],
  });
  return { canvas: canvas.canvas_id, list: list.list_id, workflow: workflow.workflow.id };
}

async function surfaces(page, label, ids) {
  await openChannel(page, 'general');
  await audit(page, `${label}: channel`);

  await page.locator('.message-scroll .thread-summary').first().click();
  await page.locator('.panel .composer').waitFor();
  await audit(page, `${label}: thread`, '.panel');
  await page.keyboard.press('Escape');

  await row(page, 'Welcome').locator('.msg-author').first().click();
  await page.locator('.profile').waitFor();
  await audit(page, `${label}: profile`, '.panel');
  await page.keyboard.press('Escape');

  await page.locator('.conv-title').click();
  for (const tab of ['About', 'Members', 'Pins', 'Files']) {
    await page.locator('.panel .tabs [role="tab"]', { hasText: tab }).click();
    await audit(page, `${label}: details ${tab}`, '.panel');
  }
  await page.keyboard.press('Escape');

  for (const name of ['activity', 'threads', 'unreads', 'later', 'drafts', 'files', 'canvases', 'lists']) {
    await view(page, name);
    await audit(page, `${label}: ${name}`, 'main');
  }

  await openChannel(page, 'general');
  await page.keyboard.press(`${modifier}+k`);
  await dialog(page).waitFor();
  await audit(page, `${label}: quick switcher`, '.modal');
  await page.keyboard.type('launch');
  await page.waitForTimeout(150);
  await audit(page, `${label}: quick switcher, typed`, '.modal');
  await page.keyboard.press('Enter');
  await page.locator('.search-tabs').waitFor();
  await page.waitForTimeout(400);
  await audit(page, `${label}: search`, 'main');

  await openChannel(page, 'general');
  await composer(page).click();
  await composer(page).pressSequentially('@ma');
  await page.locator('.suggest-item').first().waitFor();
  await audit(page, `${label}: mention list`, '.conversation .composer-wrap, .conversation .suggest');
  await composer(page).fill('');
  await composer(page).pressSequentially('/');
  await page.locator('.suggest-item').first().waitFor();
  await audit(page, `${label}: command list`, '.conversation .suggest');
  await composer(page).fill('');
  await page.locator('.conversation .composer button[aria-label="Emoji"]').click();
  await page.locator('.picker-popover em-emoji-picker').waitFor();
  await page.waitForTimeout(500);
  await audit(page, `${label}: emoji picker`, '.picker-popover');
  await page.keyboard.type('tada');
  await page.waitForTimeout(300);
  await audit(page, `${label}: emoji search`, '.picker-popover');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  const message = row(page, 'Welcome');
  await message.hover();
  await message.locator('.msg-toolbar button[aria-label="More actions"]').click();
  await audit(page, `${label}: message menu`, '.popover[role="menu"]');
  await page.keyboard.press('Escape');

  await fromMenu(page, '.side-section-head button[aria-label="Add channels"]', 'Create a channel');
  await dialog(page).waitFor();
  await page.waitForTimeout(300);
  await audit(page, `${label}: create channel`, '.modal');
  await closeDialog(page);
  await fromMenu(page, '.side-section-head button[aria-label="Add channels"]', 'Browse channels');
  await audit(page, `${label}: browse channels`, '.modal');
  await closeDialog(page);
  await page.locator('.side-head .compose-btn[aria-label="New message"]').click();
  await audit(page, `${label}: new message`, '.modal');
  await closeDialog(page);
  await fromMenu(page, '.team-btn', 'Invite people');
  await audit(page, `${label}: invite`, '.modal');
  await closeDialog(page);

  for (const [item, name] of [
    ['Preferences', 'preferences'],
    ['Edit profile', 'edit profile'],
    ['Sign-in and security', 'sign-in and security'],
  ]) {
    await fromMenu(page, '.me-strip', item);
    await dialog(page).waitFor();
    await page.waitForTimeout(300);
    await audit(page, `${label}: ${name}`, '.modal');
    await closeDialog(page);
  }

  for (const tab of ['Members', 'Custom emoji', 'Apps', 'Workspace', 'Analytics', 'Reports', 'Audit log', 'Compliance']) {
    await fromMenu(page, '.team-btn', 'Administration');
    await page.locator('.admin-modal [role="tab"]', { hasText: tab }).click();
    await page.waitForTimeout(500);
    await audit(page, `${label}: admin ${tab}`, '.modal');
    await closeDialog(page);
  }

  await page.goto(`${new URL(page.url()).origin}/docs/${ids.canvas}`);
  await page.locator('.canvas-content').waitFor();
  await page.waitForTimeout(500);
  await audit(page, `${label}: canvas`, 'main');
  await page.goto(`${new URL(page.url()).origin}/lists/${ids.list}`);
  await page.locator('main .list-filter').waitFor();
  await page.waitForTimeout(400);
  await audit(page, `${label}: list table`, 'main');
  await page.locator('main [role="tab"]', { hasText: 'Board' }).click();
  await page.waitForTimeout(300);
  await audit(page, `${label}: list board`, 'main');
  await page.locator('main [role="tab"]', { hasText: 'Table' }).click();

  await fromMenu(page, '.team-btn', 'Workflows');
  await page.locator('.wf-view').waitFor();
  await audit(page, `${label}: workflows`, 'main');
  await page.locator('.wf-card', { hasText: 'Welcome' }).click();
  await page.waitForTimeout(500);
  await audit(page, `${label}: workflow builder`, 'main');
}

/** The huddle bar needs LiveKit and a browser that can make a call (Chrome's fake devices). */
async function huddle(browser, label, scheme) {
  const port = await freePort();
  const livekit = await startLiveKit({ webhookUrl: `http://127.0.0.1:${port}/livekit/webhook` });
  const server = await startServer({
    seed: true,
    port,
    env: { LIVEKIT_URL: livekit.url, LIVEKIT_API_KEY: livekit.apiKey, LIVEKIT_API_SECRET: livekit.apiSecret },
  });
  const context = await browser.newContext({ ...wide, colorScheme: scheme, permissions: ['microphone', 'camera'] });
  const page = watch(await context.newPage(), /getDisplayMedia|NotAllowedError|Permission denied/);
  await signIn(page, server.base, 'maya@example.com');
  await openChannel(page, 'engineering');
  await page.locator('[data-huddle-start]').click();
  await page.locator('[data-huddle-dock][data-status="connected"]').waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await audit(page, `${label}: huddle bar`, '[data-huddle-dock]');
  await audit(page, `${label}: channel with a huddle`, '.conversation');
  await context.close();
}

// ── The keyboard alone (part 2) ─────────────────────────────────────────────

/**
 * Safari's engine moves Tab between form fields only, unless the person turns on
 * "Press Tab to highlight each item"; Option+Tab reaches everything, as that setting does.
 */
const TAB = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
const BACK_TAB = browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab';

/** What has focus, and whether a focus indicator can be seen on it. */
const focused = (page) =>
  page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return null;
    const style = getComputedStyle(element);
    const ring = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 1;
    const glow = style.boxShadow && style.boxShadow !== 'none';
    // Menu items and options show focus with their background instead of a ring.
    const filled = element.matches('.menu-item, [role="option"]') && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
    const field = element.matches('input, textarea, select, [contenteditable="true"]');
    const composerRing = element.closest('.composer') ? getComputedStyle(element.closest('.composer')).boxShadow !== 'none' : false;
    return {
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute('type') ?? '',
      role: element.getAttribute('role') ?? '',
      name: (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 60),
      cls: typeof element.className === 'string' ? element.className : '',
      inModal: Boolean(element.closest('.modal')),
      inMenu: Boolean(element.closest('.popover[role="menu"]')),
      visible: ring || glow || filled || composerRing || (field && (ring || glow)),
      selector: element.closest('[data-ts]')?.getAttribute('data-ts') ?? '',
    };
  });

async function press(page, key, times = 1) {
  for (let index = 0; index < times; index += 1) await page.keyboard.press(key);
}

/**
 * Press Tab (or Shift+Tab) until `wanted(focus)` holds, checking every stop shows its focus.
 * Firefox hands focus to its own toolbar after the last element instead of wrapping, so
 * anything before the starting point is reached going back.
 */
async function tabTo(page, wanted, { back = false, limit = 80, label = 'target' } = {}) {
  const start = await focused(page);
  if (start && wanted(start)) return start;
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press(back ? BACK_TAB : TAB);
    const now = await focused(page);
    if (now) assert.ok(now.visible, `focus is visible on ${now.tag}.${now.cls} “${now.name}”`);
    if (now && wanted(now)) return now;
    if (process.env.A11Y_TRACE === '1') console.log(`    tab ${index}: ${now?.tag}.${now?.cls} “${now?.name}” ${now?.role}`);
  }
  throw new Error(`Tab never reached ${label}`);
}

async function until(page, wanted, label) {
  for (let index = 0; index < 40; index += 1) {
    const now = await focused(page);
    if (now && wanted(now)) return now;
    await page.waitForTimeout(50);
  }
  throw new Error(`focus did not reach ${label}: ${JSON.stringify(await focused(page))}`);
}

/** Open a dialog from a menu by keyboard, check Tab stays inside it, close it with Escape, and check where focus lands. */
async function dialogByKeyboard(page, opener, item, back) {
  await opener();
  await page.keyboard.press('Enter');
  await until(page, (focus) => focus.inMenu && focus.role === 'menuitem', `the first item of the menu for ${item}`);
  for (let index = 0; index < 30; index += 1) {
    const now = await focused(page);
    if (now.name.startsWith(item)) break;
    await page.keyboard.press('ArrowDown');
  }
  assert.ok((await focused(page)).name.startsWith(item), `menu item ${item}`);
  await page.keyboard.press('Enter');
  await dialog(page).waitFor();
  await until(page, (focus) => focus.inModal, `inside the ${item} dialog`);
  // Focus stays in the dialog however far you Tab, both ways.
  for (const key of [TAB, BACK_TAB]) {
    for (let index = 0; index < 25; index += 1) {
      await page.keyboard.press(key);
      const now = await focused(page);
      assert.ok(now?.inModal, `${key} ${index + 1} in ${item} stays in the dialog (focus on ${JSON.stringify(now)})`);
      assert.ok(now.visible, `focus is visible on ${now.tag}.${now.cls} “${now.name}” in ${item}`);
    }
  }
  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'detached' });
  await until(page, back, `back where ${item} was opened from`);
}

async function keyboardPath(browser, server) {
  const context = await browser.newContext({ ...wide, colorScheme: 'light' });
  const page = watch(await context.newPage());

  await step('keyboard: sign in without the mouse', async () => {
    await page.goto(server.base);
    await page.waitForURL('**/signin');
    const now = await focused(page);
    if (now?.type !== 'email') await tabTo(page, (focus) => focus.type === 'email', { label: 'the email field', limit: 15 });
    await page.keyboard.type('maya@example.com');
    await page.keyboard.press(TAB);
    await page.keyboard.type('demo-password');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.sidebar .side-item');
  });

  await step('keyboard: the skip link jumps to the messages', async () => {
    await page.locator('.message-content .msg').first().waitFor();
    // As if arriving from the browser's address bar: the next Tab starts at the top of the document.
    await page.evaluate(() => {
      document.body.tabIndex = -1;
      document.body.focus();
      document.body.removeAttribute('tabindex');
    });
    await page.keyboard.press(TAB);
    const skip = await focused(page);
    assert.equal(skip.cls, 'skip-link');
    assert.ok(await page.locator('.skip-link').isVisible());
    await page.keyboard.press('Enter');
    const landed = await until(page, (focus) => focus.role === 'article', 'a message');
    assert.ok(landed.selector, 'the newest message has focus');
  });

  await step('keyboard: arrows through the sidebar, Enter opens a channel', async () => {
    await tabTo(page, (focus) => focus.cls.includes('side-item'), { label: 'the sidebar', back: true });
    assert.equal(await page.locator('.side-scroll [tabindex="0"]').count(), 1, 'the sidebar list is one Tab stop');
    assert.match((await focused(page)).name, /^general/, 'the stop is the open channel');
    await page.keyboard.press('Home');
    assert.match((await focused(page)).name, /^Activity/, 'Home goes to the first item');
    for (let index = 0; index < 40; index += 1) {
      const now = await focused(page);
      if (now.name.startsWith('engineering')) break;
      await page.keyboard.press('ArrowDown');
    }
    assert.match((await focused(page)).name, /^engineering/);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.conv-name:text-is("engineering")');
    await until(page, (focus) => focus.cls.includes('composer-input'), 'the composer');
  });

  const text = `Typed without a mouse ${Date.now().toString().slice(-5)}`;
  await step('keyboard: send a message, open its menu, react to it from the picker', async () => {
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    await row(page, text).waitFor();
    await page.waitForTimeout(300);
    // Back from the composer to the newest message, then into its toolbar.
    await tabTo(page, (focus) => focus.role === 'article', { back: true, label: 'the newest message' });
    const own = await focused(page);
    assert.equal(own.selector, await row(page, text).getAttribute('data-ts'), 'the message just sent');
    await page.keyboard.press('ArrowUp');
    assert.notEqual((await focused(page)).selector, own.selector, 'Up moves to the message before');
    await page.keyboard.press('ArrowDown');
    assert.equal((await focused(page)).selector, own.selector);
    await tabTo(page, (focus) => focus.name === 'More actions', { label: 'More actions', limit: 15 });
    await page.keyboard.press('Enter');
    await until(page, (focus) => focus.inMenu && focus.role === 'menuitem', 'the first menu item');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.press('Home');
    await page.keyboard.press('Escape');
    await until(page, (focus) => focus.name === 'More actions', 'More actions again');
    await tabTo(page, (focus) => focus.name === 'Add reaction', { back: true, label: 'Add reaction', limit: 10 });
    await page.keyboard.press('Enter');
    await page.locator('.picker-popover em-emoji-picker').waitFor();
    await page.waitForTimeout(400);
    await page.keyboard.type('tada');
    await page.waitForTimeout(300);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await row(page, text).locator('.reaction.is-mine').waitFor();
    await until(page, (focus) => focus.name === 'Add reaction', 'Add reaction after picking');
  });

  await step('keyboard: open the thread, reply, Escape comes back to the message', async () => {
    await tabTo(page, (focus) => focus.name === 'Reply in thread', { label: 'Reply in thread', limit: 10 });
    await page.keyboard.press('Enter');
    await page.locator('.panel .composer').waitFor();
    await until(page, (focus) => focus.cls.includes('composer-input'), 'the thread composer');
    await page.keyboard.type('A reply, by keyboard');
    await page.keyboard.press('Enter');
    await page.locator('.panel .msg', { hasText: 'A reply, by keyboard' }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.panel').waitFor({ state: 'detached' });
    const back = await until(page, (focus) => focus.selector !== '', 'the message');
    assert.equal(back.selector, await row(page, text).getAttribute('data-ts'));
  });

  await step('keyboard: the quick switcher, by name and arrows', async () => {
    await page.keyboard.press(`${modifier}+k`);
    await dialog(page).waitFor();
    await until(page, (focus) => focus.role === 'combobox', 'the switcher field');
    await page.keyboard.type('rand');
    await page.waitForTimeout(150);
    const active = await page.locator('.switcher-list [role="option"][aria-selected="true"]').innerText();
    assert.match(active, /random/);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.conv-name:text-is("random")');
    await until(page, (focus) => focus.cls.includes('composer-input'), 'the composer in #random');
    // Escape on an open switcher returns focus to the composer.
    await page.keyboard.press(`${modifier}+k`);
    await dialog(page).waitFor();
    await page.keyboard.press('Escape');
    await until(page, (focus) => focus.cls.includes('composer-input'), 'the composer after Escape');
  });

  await step('keyboard: every dialog opens from its menu, keeps Tab inside, closes with Escape and returns focus', async () => {
    const meStrip = (focus) => focus.cls.includes('me-strip');
    const teamButton = (focus) => focus.cls.includes('team-btn');
    // Reach the buttons by Tab from the composer, as a person would.
    for (const item of ['Preferences', 'Edit profile', 'Sign-in and security', 'Notification schedule…']) {
      await dialogByKeyboard(page, async () => tabTo(page, meStrip, { label: 'my menu', limit: 80, back: true }), item, meStrip);
    }
    for (const item of ['Administration', 'Invite people', 'Browse channels']) {
      await dialogByKeyboard(page, async () => tabTo(page, teamButton, { label: 'the workspace menu', limit: 80, back: true }), item, teamButton);
    }
    // The section's own buttons are reached with Right from its heading.
    const addChannels = (focus) => focus.name === 'Add channels';
    await dialogByKeyboard(
      page,
      async () => {
        await tabTo(page, (focus) => focus.cls.includes('side-item') || focus.cls.includes('side-section-toggle'), { label: 'the sidebar list', limit: 80 });
        for (let index = 0; index < 40; index += 1) {
          const now = await focused(page);
          if (now.cls.includes('side-section-toggle') && now.name.startsWith('Channels')) break;
          await page.keyboard.press('ArrowUp');
        }
        await press(page, 'ArrowRight', 2);
        await until(page, addChannels, 'Add channels');
      },
      'Create a channel',
      addChannels,
    );
  });

  await step('keyboard: a dialog opened by a button returns focus to it', async () => {
    const compose = (focus) => focus.name === 'New message' && focus.cls.includes('compose-btn');
    await tabTo(page, compose, { label: 'New message', limit: 80, back: true });
    await page.keyboard.press('Enter');
    await dialog(page).waitFor();
    await until(page, (focus) => focus.inModal, 'inside the new message dialog');
    await page.keyboard.press('Escape');
    await dialog(page).waitFor({ state: 'detached' });
    await until(page, compose, 'New message again');
  });

  await step('keyboard: tabs move with the arrow keys and carry their panel', async () => {
    await tabTo(page, teamButtonPredicate, { label: 'the workspace menu', limit: 80, back: true });
    await page.keyboard.press('Enter');
    await until(page, (focus) => focus.inMenu, 'the workspace menu');
    for (let index = 0; index < 20 && !(await focused(page)).name.startsWith('Administration'); index += 1) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await dialog(page).waitFor();
    await tabTo(page, (focus) => focus.role === 'tab', { label: 'the admin tabs', limit: 10, back: true });
    assert.equal(await page.locator('.admin-modal [role="tab"][tabindex="0"]').count(), 1, 'the tabs are one Tab stop');
    await page.keyboard.press('ArrowRight');
    await page.locator('.admin-modal [role="tab"][aria-selected="true"]', { hasText: 'Custom emoji' }).waitFor();
    await page.keyboard.press('End');
    await page.locator('.admin-modal [role="tab"][aria-selected="true"]', { hasText: 'Compliance' }).waitFor();
    await page.keyboard.press('Home');
    await page.locator('.admin-modal [role="tab"][aria-selected="true"]', { hasText: 'Members' }).waitFor();
    await page.keyboard.press('Escape');
    await dialog(page).waitFor({ state: 'detached' });
  });

  await shot(page, 'a11y-keyboard');
  await context.close();
}

const teamButtonPredicate = (focus) => focus.cls.includes('team-btn');

// ── What screen readers hear, less motion, forced colors (part 3) ──────────

async function senses(browser, server) {
  await step('screen readers: a message is an article named by its author, time and text', async () => {
    const page = watch(await (await browser.newContext(wide)).newPage());
    await signIn(page, server.base, 'maya@example.com');
    await openChannel(page, 'general');
    await page.getByRole('article', { name: /^Priya \d{1,2}:\d{2}.*Welcome @Aiko to the team/ }).waitFor();
    // A follow-up from the same person (no name shown) is still named by its author.
    const names = await page.locator('.message-content > .msg.is-compact[role="article"]').evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('aria-labelledby').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ')),
    );
    for (const name of names) assert.match(name, /^\S.* \d{1,2}:\d{2}/, `a grouped message keeps its author and time: ${name}`);
    await page.context().close();
  });

  await step('screen readers: new messages in the open conversation are read out, and so are toasts', async () => {
    const maya = watch(await (await browser.newContext(wide)).newPage());
    const daniel = watch(await (await browser.newContext(wide)).newPage());
    await signIn(maya, server.base, 'maya@example.com');
    await signIn(daniel, server.base, 'daniel@example.com');
    await openChannel(maya, 'random');
    await openChannel(daniel, 'random');
    const log = maya.locator('.message-pane [role="log"][aria-live="polite"]');
    assert.equal((await log.innerText()).trim(), '', 'nothing is read out for what was already there');
    await composer(daniel).fill('Lunch is on the terrace today');
    await composer(daniel).press('Enter');
    await log.locator('p', { hasText: /^Daniel.*: Lunch is on the terrace today$/ }).waitFor();
    // The person's own messages are not read back to them.
    await composer(maya).fill('On my way');
    await composer(maya).press('Enter');
    await row(maya, 'On my way').waitFor();
    await maya.waitForTimeout(300);
    assert.doesNotMatch(await log.innerText(), /On my way/);
    // Toasts sit in live regions that are always there: polite for news, assertive for errors.
    assert.equal(await maya.locator('.toasts [role="status"][aria-live="polite"]').count(), 1);
    assert.equal(await maya.locator('.toasts [role="alert"]').count(), 1);
    await composer(maya).fill('/status :coffee: Brewing');
    await composer(maya).press('Enter');
    await maya.locator('.toasts [role="status"] .toast', { hasText: 'Status updated.' }).waitFor();
    await maya.context().close();
    await daniel.context().close();
  });

  await step('less motion: animations and transitions stop when the system asks', async () => {
    const page = watch(await (await browser.newContext({ ...wide, reducedMotion: 'reduce' })).newPage());
    await signIn(page, server.base, 'maya@example.com');
    await page.keyboard.press(`${modifier}+k`);
    await dialog(page).waitFor();
    const motion = await dialog(page).evaluate((element) => {
      const style = getComputedStyle(element);
      return { duration: Number.parseFloat(style.animationDuration), iterations: style.animationIterationCount };
    });
    assert.ok(motion.duration < 0.001, `the dialog does not animate (${motion.duration}s)`);
    assert.equal(motion.iterations, '1');
    await page.context().close();
  });

  if (browserName !== 'chrome') {
    console.log(`  skip  forced colors — only Chromium emulates them`);
    return;
  }
  await step('forced colors: the open channel and focus still show without background colors', async () => {
    const page = watch(await (await browser.newContext({ ...wide, forcedColors: 'active' })).newPage());
    await signIn(page, server.base, 'maya@example.com');
    await openChannel(page, 'general');
    const selected = await page.locator('.side-item[aria-current="page"]').evaluate((element) => getComputedStyle(element).outlineStyle);
    assert.equal(selected, 'solid', 'the open channel is outlined');
    await page.locator('.side-item[aria-current="page"]').focus();
    await page.keyboard.press('ArrowDown');
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    assert.equal(ring, 'solid', 'focus is outlined');
    await shot(page, 'a11y-forced-colors');
    await page.context().close();
  });
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main(browser) {
  const server = await startServer({ seed: true });
  const options = { ...wide, colorScheme: 'light' };
  let ids;
  if (process.env.A11Y_PART === 'keyboard') {
    await keyboardPath(browser, server);
    await senses(browser, server);
    return;
  }

  await step('axe: signed out', async () => {
    const page = watch(await (await browser.newContext(options)).newPage());
    await page.goto(server.base);
    await page.waitForURL('**/signin');
    await audit(page, 'sign-in');
    await page.context().close();
  });

  for (const [label, scheme] of [
    ['light', 'light'],
    ['dark', 'dark'],
  ]) {
    await step(`axe: every surface (${label})`, async () => {
      const page = watch(await (await browser.newContext({ ...options, colorScheme: scheme })).newPage());
      await signIn(page, server.base, 'maya@example.com');
      ids ??= await fixtures(page);
      await surfaces(page, label, ids);
      await shot(page, `a11y-${label}`);
      await page.context().close();
    });
  }

  await step('axe: every sidebar theme, light and dark', async () => {
    for (const scheme of ['light', 'dark']) {
      const page = watch(await (await browser.newContext({ ...options, colorScheme: scheme })).newPage());
      await signIn(page, server.base, 'daniel@example.com');
      for (const theme of ['forest', 'plum', 'ink', 'clay', 'mist', 'custom-light', 'custom-mid']) {
        const prefs =
          theme === 'custom-light' ? { sidebar_theme: 'custom', sidebar_color: '#f4e7b0' } : theme === 'custom-mid' ? { sidebar_theme: 'custom', sidebar_color: '#0080cc' } : { sidebar_theme: theme };
        await api(page, 'client.prefs.set', { prefs });
        await page.reload();
        await page.waitForSelector('.sidebar .side-item');
        await audit(page, `sidebar ${theme} (${scheme})`, '.sidebar');
      }
      await api(page, 'client.prefs.set', { prefs: { sidebar_theme: 'harbor' } });
      await page.context().close();
    }
  });

  await step('axe: Korean', async () => {
    const page = watch(await (await browser.newContext({ ...options, locale: 'ko-KR' })).newPage());
    await signIn(page, server.base, 'maya@example.com');
    await openChannel(page, 'general');
    await audit(page, 'korean: channel');
    await page.keyboard.press(`${modifier}+k`);
    await dialog(page).waitFor();
    await audit(page, 'korean: quick switcher', '.modal');
    await closeDialog(page);
    await fromMenu(page, '.me-strip', '환경설정');
    await audit(page, 'korean: preferences', '.modal');
    await closeDialog(page);
    await fromMenu(page, '.team-btn', '관리');
    await audit(page, 'korean: administration', '.modal');
    await closeDialog(page);
    await view(page, 'activity');
    await audit(page, 'korean: activity', 'main');
    await page.context().close();
  });

  await step('axe: Japanese', async () => {
    const page = watch(await (await browser.newContext({ ...options, locale: 'ja-JP' })).newPage());
    await signIn(page, server.base, 'maya@example.com');
    await openChannel(page, 'general');
    await audit(page, 'japanese: channel');
    await fromMenu(page, '.me-strip', '環境設定');
    await audit(page, 'japanese: preferences', '.modal');
    await closeDialog(page);
    await fromMenu(page, '.team-btn', '管理');
    await audit(page, 'japanese: administration', '.modal');
    await closeDialog(page);
    await view(page, 'activity');
    await audit(page, 'japanese: activity', 'main');
    await page.context().close();
  });

  if (findLiveKit() && browserName === 'chrome') await step('axe: the huddle bar', () => huddle(browser, 'dark', 'dark'));
  else console.log(`  skip  axe: the huddle bar — ${browserName !== 'chrome' ? 'needs Chrome’s fake devices' : 'livekit-server not found; set LIVEKIT_SERVER_BIN'}`);

  const bad = report();
  assert.equal(bad.length, 0, `${bad.length} kinds of serious or critical accessibility problems`);

  if (process.env.A11Y_PART !== 'axe') {
    await keyboardPath(browser, server);
    await senses(browser, server);
  }
}

await run(main, {
  chrome: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
});
