// Browser test for an organisation with several workspaces: an admin creates
// a workspace under Administration → Organisation and adds someone to it; that
// person switches the sidebar to it and creates a channel there, which people
// outside the workspace cannot find until an admin shows it in every
// workspace; an admin role is handed out from the same tab.
//
//   pnpm --filter @app/web build && node e2e/org.mjs
import assert from 'node:assert/strict';
import { noSidewaysScroll, openChannel, openTeamMenu, run, send, shot, sideItem, signIn, startServer, step, watch, wide } from './lib.mjs';

async function findInBrowser(page, name) {
  await openTeamMenu(page, 'Browse channels');
  await page.locator('.modal .wide-search').fill(name);
  // Give the search a moment to answer.
  await page.waitForTimeout(800);
  const found = await page.locator('.modal .browse-row', { hasText: name }).count();
  await page.keyboard.press('Escape');
  return found > 0;
}

async function main(browser) {
  const server = await startServer({ seed: true });
  const maya = watch(await (await browser.newContext({ ...wide })).newPage());
  const daniel = watch(await (await browser.newContext({ ...wide })).newPage());
  const sofia = watch(await (await browser.newContext({ ...wide })).newPage());
  await signIn(maya, server.base, 'maya@example.com');
  await signIn(daniel, server.base, 'daniel@example.com');
  await signIn(sofia, server.base, 'sofia@example.com');

  await step('an admin creates a workspace and adds someone to it', async () => {
    await openTeamMenu(maya, 'Administration');
    await maya.locator('.admin-modal .tabs button', { hasText: 'Organisation' }).click();
    const create = maya.locator('.org-create');
    await create.getByLabel('Name', { exact: true }).fill('Engineering');
    await create.getByLabel('Short name').fill('engineering');
    await create.getByRole('button', { name: 'Create workspace' }).click();
    const workspace = maya.locator('.org-workspace', { hasText: 'Engineering' });
    await workspace.waitFor();
    await workspace.getByLabel('Add someone…').selectOption({ label: 'Daniel Okafor' });
    await workspace.getByRole('button', { name: 'Add', exact: true }).click();
    await workspace.locator('.admin-list li', { hasText: 'Daniel Okafor' }).waitFor();
    await shot(maya, 'org-workspaces');
  });

  await step('an admin role is handed out from the same tab', async () => {
    const assign = maya.locator('.org-assign');
    await assign.getByLabel('Role…').selectOption({ label: 'Channel Admin' });
    await assign.getByLabel('Person…').selectOption({ label: 'Sofia Rossi' });
    await assign.getByRole('button', { name: 'Assign' }).click();
    await maya.locator('.admin-list li', { hasText: 'Sofia Rossi' }).filter({ hasText: 'Channel Admin' }).waitFor();
    await shot(maya, 'org-roles');
    await maya.setViewportSize({ width: 390, height: 844 });
    await noSidewaysScroll(maya, 'organisation admin');
    await shot(maya, 'org-admin-phone');
    await maya.setViewportSize(wide.viewport);
    await maya.keyboard.press('Escape');
  });

  const channel = `eng-builds-${Date.now().toString().slice(-5)}`;

  await step('the person added switches the sidebar to the workspace and creates a channel there', async () => {
    // The workspace arrives without a reload.
    await daniel.locator('.team-btn').click();
    await daniel.locator('.menu-item', { hasText: 'Engineering' }).click();
    await daniel.locator('.team-btn .team-name', { hasText: 'Engineering' }).waitFor();
    // The organisation's own channels are not in this workspace's sidebar.
    await sideItem(daniel, 'random').waitFor({ state: 'detached' });
    await daniel.locator('.side-section', { hasText: 'Channels' }).hover();
    await daniel.locator('.side-section-head button[aria-label="Add channels"]').click();
    await daniel.locator('.menu-item', { hasText: 'Create a channel' }).click();
    await daniel.locator('.modal input').first().fill(channel);
    await daniel.locator('.modal .btn-primary').click();
    await daniel.waitForSelector(`.conv-name:text-is("${channel}")`);
    await send(daniel, 'Nightly build is green');
    await shot(daniel, 'org-workspace-sidebar');
    // Back to all workspaces: everything is listed again.
    await daniel.locator('.team-btn').click();
    await daniel.locator('.menu-item', { hasText: 'All workspaces' }).click();
    await sideItem(daniel, 'random').waitFor();
  });

  await step('someone outside the workspace cannot find its channel', async () => {
    assert.equal(await findInBrowser(sofia, channel), false);
  });

  await step('an admin shows the channel in every workspace from its details; then everyone finds it', async () => {
    await openTeamMenu(maya, 'Browse channels');
    await maya.locator('.modal .wide-search').fill(channel);
    await maya.locator('.browse-row', { hasText: channel }).locator('.browse-main').click();
    await maya.waitForSelector(`.conv-name:text-is("${channel}")`);
    await maya.locator('.conv-title').click();
    const select = maya.locator('.channel-workspace select');
    await select.waitFor();
    assert.equal(await select.locator('option:checked').textContent(), 'Engineering');
    await select.selectOption({ label: 'Every workspace' });
    await shot(maya, 'org-channel-workspace');
    await maya.keyboard.press('Escape');
    assert.equal(await findInBrowser(sofia, channel), true);
  });

  await openChannel(daniel, channel);
}

await run(main);
