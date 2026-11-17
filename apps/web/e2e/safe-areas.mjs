// Browser test for phones with a notch: with the insets of an iPhone (the
// status bar 59px, the home indicator 34px; tokens.css --safe-*), nothing fixed
// to the screen's edges is drawn under them: the conversation, the sidebar
// drawer and its menu, dialogs, the details panel, toasts, the call screen and
// the sign-in page.
//
//   pnpm --filter @app/web build && node e2e/safe-areas.mjs
import assert from 'node:assert/strict';
import { openTeamMenu, run, shot, signIn, startServer, step, watch } from './lib.mjs';

const TOP = 59;
const BOTTOM = 34;
const phone = { viewport: { width: 402, height: 874 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };
const INSETS = `:root { --safe-top: ${TOP}px; --safe-bottom: ${BOTTOM}px; }`;

/** The element is inside the part of the screen the status bar and the home indicator leave free. */
async function clear(page, selector, label) {
  const box = await page.locator(selector).first().boundingBox();
  assert.ok(box, `${label}: not on screen`);
  const height = page.viewportSize().height;
  assert.ok(box.y >= TOP - 0.5, `${label}: starts at ${Math.round(box.y)}px, under the status bar (${TOP}px)`);
  assert.ok(box.y + box.height <= height - BOTTOM + 0.5, `${label}: ends at ${Math.round(box.y + box.height)}px, under the home indicator (${height - BOTTOM}px)`);
}

async function main(browser) {
  const server = await startServer({ seed: true });
  const page = watch(await (await browser.newContext(phone)).newPage());
  await signIn(page, server.base, 'maya@example.com');
  await page.addStyleTag({ content: INSETS });
  await page.locator('.conv-head').waitFor();

  await step('the conversation: header below the status bar, composer above the home indicator', async () => {
    await clear(page, '.conv-head', 'conversation header');
    await clear(page, '.composer', 'composer');
    await shot(page, 'safe-conversation');
  });

  await step('the sidebar drawer and its menu', async () => {
    await page.getByRole('button', { name: 'Open sidebar' }).click();
    await page.locator('.is-drawer-open').waitFor();
    // The drawer slides in: measure where it settles.
    await page.waitForTimeout(300);
    await clear(page, '.sidebar .team-btn', 'drawer header');
    await clear(page, '.sidebar .side-foot, .sidebar .me-bar, .sidebar > :last-child', 'drawer bottom');
    await shot(page, 'safe-drawer');
    await page.locator('.team-btn').click();
    await clear(page, '.popover.menu', 'workspace menu');
    await page.keyboard.press('Escape');
  });

  await step('a long dialog fits between the status bar and the home indicator', async () => {
    await openTeamMenu(page, 'Browse channels');
    await page.locator('.modal .browse-row').first().waitFor();
    await clear(page, '.modal', 'browse dialog');
    // A row's details stay on one line each (they wrapped a letter at a time on phones).
    const tall = await page.locator('.browse-joined').first().evaluate((node) => node.getBoundingClientRect().height);
    assert.ok(tall < 24, `"joined" wraps (${tall}px tall)`);
    await shot(page, 'safe-dialog');
    await page.keyboard.press('Escape');
  });

  await step('the details panel', async () => {
    // Close the drawer by tapping beside it.
    if (await page.locator('.is-drawer-open').count()) await page.mouse.click(390, 500);
    await page.locator('.is-drawer-open').waitFor({ state: 'detached' });
    await page.locator('.conv-title').click();
    await page.locator('.panel').waitFor();
    await clear(page, '.panel', 'details panel');
    await page.keyboard.press('Escape');
  });

  await step('toasts and the call screen keep clear', async () => {
    const boxes = await page.evaluate(() => {
      const toasts = document.createElement('div');
      toasts.className = 'toasts';
      toasts.innerHTML = '<div class="toast">Copied</div>';
      const stage = document.createElement('div');
      stage.className = 'huddle-stage';
      stage.innerHTML = '<div class="probe" style="height:40px"></div>';
      document.body.append(toasts, stage);
      const result = { toast: toasts.getBoundingClientRect().bottom, stageTop: stage.querySelector('.probe').getBoundingClientRect().top };
      toasts.remove();
      stage.remove();
      return result;
    });
    assert.ok(boxes.toast <= 874 - BOTTOM, `toast ends at ${boxes.toast}px`);
    assert.ok(boxes.stageTop >= TOP, `call screen content starts at ${boxes.stageTop}px`);
  });

  await step('the sign-in page', async () => {
    const guest = watch(await (await browser.newContext({ ...phone, viewport: { width: 402, height: 520 } })).newPage());
    await guest.goto(server.base);
    await guest.addStyleTag({ content: INSETS });
    await guest.locator('.auth .auth-card').waitFor();
    // Scrolled to the top, the first thing on the page is below the status bar.
    const top = await guest.locator('.auth-brand').evaluate((node) => node.getBoundingClientRect().top + window.scrollY);
    assert.ok(top >= TOP, `sign-in page content starts at ${top}px`);
    await shot(guest, 'safe-signin');
  });
}

await run(main);
