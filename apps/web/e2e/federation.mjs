// Browser test for a channel shared between two servers: an admin of the first
// shares a channel from its details, an admin of the second accepts the link
// under Administration → Shared channels, and the two organisations talk in
// it, each seeing the other's organisation next to their names.
//
//   pnpm --filter @app/web build && node e2e/federation.mjs
import assert from 'node:assert/strict';
import { noSidewaysScroll, openChannel, openTeamMenu, row, run, send, shot, signIn, startServer, step, watch, wide } from './lib.mjs';

/** A second organisation on its own server: Globex, with Gus as its owner. */
async function setUpGlobex(base) {
  const response = await fetch(`${base}/api/client.setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ team_name: 'Globex', email: 'gus@globex.test', password: 'globex long password', real_name: 'Gus Globex' }),
  });
  assert.equal((await response.json()).ok, true);
}

async function main(browser) {
  const northwind = await startServer({ seed: true });
  const globex = await startServer({ seed: false });
  await setUpGlobex(globex.base);
  const maya = watch(await (await browser.newContext({ ...wide })).newPage());
  const gus = watch(await (await browser.newContext({ ...wide })).newPage());
  await signIn(maya, northwind.base, 'maya@example.com');
  await signIn(gus, globex.base, 'gus@globex.test', 'globex long password');
  let link = '';

  await step('an admin shares a channel from its details and gets a link', async () => {
    await openChannel(maya, 'design');
    await maya.locator('.conv-title').click();
    await maya.getByRole('button', { name: 'Share with another organisation' }).click();
    const field = maya.locator('.shared-with .copy-field input');
    await field.waitFor();
    link = await field.inputValue();
    assert.match(link, /\/connect\/I[A-Z0-9]+\./);
    await shot(maya, 'federation-share-link');
    await maya.keyboard.press('Escape');
  });

  await step('an admin of the other server accepts it under Administration → Shared channels', async () => {
    await openTeamMenu(gus, 'Administration');
    await gus.locator('.admin-modal .tabs button', { hasText: 'Shared channels' }).click();
    await gus.getByLabel('Invitation link').fill(link);
    await gus.getByLabel('Channel name here').fill('northwind-design');
    await shot(gus, 'federation-accept');
    await gus.getByRole('button', { name: 'Accept and join' }).click();
    await gus.locator('.conv-name', { hasText: 'northwind-design' }).waitFor();
    // The channel's recent history came along, with Northwind next to its people's names.
    await gus.locator('.conv-heading .tag-external', { hasText: 'Northwind' }).waitFor();
    await gus.locator('.msg .tag-external', { hasText: 'Northwind' }).first().waitFor();
  });

  await step('the two organisations talk in it, each seeing the other’s name', async () => {
    await send(gus, 'Hello from Globex');
    const arrived = row(maya, 'Hello from Globex');
    await arrived.waitFor({ timeout: 10_000 });
    await arrived.locator('.tag-external', { hasText: 'Globex' }).waitFor();
    await send(maya, 'Welcome, Gus');
    await row(gus, 'Welcome, Gus').waitFor({ timeout: 10_000 });
    await maya.locator('.conv-heading .tag-external', { hasText: 'Globex' }).waitFor();
    await shot(maya, 'federation-channel');
    await shot(gus, 'federation-channel-other-side');
  });

  await step('the connection is listed for the admin, and the page fits a phone', async () => {
    await openTeamMenu(maya, 'Administration');
    await maya.locator('.admin-modal .tabs button', { hasText: 'Shared channels' }).click();
    await maya.locator('.connection', { hasText: 'Globex' }).locator('li', { hasText: '#design' }).waitFor();
    await maya.setViewportSize({ width: 390, height: 844 });
    await noSidewaysScroll(maya, 'shared channels admin');
    await shot(maya, 'federation-admin-phone');
  });
}

await run(main);
