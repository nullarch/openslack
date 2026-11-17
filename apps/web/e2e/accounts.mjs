// Browser tests for accounts and administration: mailed sign-in codes and
// password resets, single sign-on, two-factor sign-in, workspace settings and
// permissions, profile fields, invite requests, user groups, guests, public
// channel pages, export, and the installable app.
//
//   pnpm --filter @app/web build && node apps/web/e2e/accounts.mjs
import assert from 'node:assert/strict';
import { MailSink } from '../../server/test/mail-sink.ts';
import { FakeIdentityProvider } from '../../server/test/fake-idp.ts';
import { currentStep, totpAt } from '../../server/src/accounts/totp.ts';
import { openChannel, run, send, shot, sideItem, signIn, skip, startServer, step, watch, wide } from './lib.mjs';

const code = (secret, offset = 0) => totpAt(secret.replace(/\s+/g, ''), currentStep() + offset);

async function waitForApp(page) {
  await page.waitForSelector('.sidebar .side-item', { timeout: 15_000 });
}

async function teamMenu(page, item) {
  await page.locator('.team-btn').click();
  await page.locator('.menu-item', { hasText: item }).click();
}

async function meMenu(page, item) {
  await page.locator('.me-strip').click();
  await page.locator('.menu-item', { hasText: item }).click();
}

async function openAdmin(page, tab) {
  await teamMenu(page, 'Administration');
  await page.locator('.admin-modal .tabs button', { hasText: tab }).click();
}

/** Close every open dialog with its close button (focus may have left the dialog, so Escape is not enough). */
async function closeDialogs(page) {
  for (let i = 0; i < 3; i += 1) {
    const close = page.locator('.modal-head button[aria-label="Close"]');
    if ((await close.count()) === 0) return;
    await close.last().click();
  }
}

function modal(page, title) {
  return page.locator('.modal', { has: page.locator('.modal-head h2', { hasText: title }) });
}

/** Turn on two-factor sign-in through whatever setup form is on screen; returns the secret. */
async function completeTwoFactorSetup(page) {
  const secret = (await page.locator('[data-testid="totp-secret"]').innerText()).trim();
  await page.locator('.twofactor-setup input').fill(code(secret));
  await page.locator('.twofactor-setup button[type="submit"]').click();
  await page.locator('.backup-codes li').first().waitFor();
  assert.equal(await page.locator('.backup-codes li').count(), 10);
  await page.locator('button', { hasText: 'I saved them' }).click();
  return secret;
}

async function main(browser) {
  const sink = new MailSink();
  const smtpUrl = await sink.start();
  const idp = new FakeIdentityProvider();
  const issuer = await idp.start();
  const server = await startServer({
    seed: true,
    env: { SMTP_URL: smtpUrl, MAIL_FROM: 'Northwind <chat@example.com>', OIDC_ISSUER: issuer, OIDC_CLIENT_ID: idp.clientId, OIDC_CLIENT_SECRET: idp.clientSecret, OIDC_NAME: 'Northwind SSO' },
  });
  const page = async () => watch(await (await browser.newContext(wide)).newPage(), /two_factor_setup_required|401|WebSocket connection/);

  const daniel = await page();
  const sofia = await page();
  const maya = await page();

  await step('sign-in offers single sign-on and mail options, and a mailed code signs in', async () => {
    await daniel.goto(server.base);
    await daniel.waitForURL('**/signin');
    await daniel.locator('a.auth-provider', { hasText: 'Continue with Northwind SSO' }).waitFor();
    await shot(daniel, 'accounts-signin');
    await daniel.locator('button', { hasText: 'Email me a sign-in code' }).click();
    await daniel.fill('input[type="email"]', 'daniel@example.com');
    await daniel.locator('button[type="submit"]').click();
    const mail = await sink.next((item) => item.to.includes('daniel@example.com'));
    const sent = /\b(\d{6})\b/.exec(mail.subject)[1];
    await daniel.locator('input[autocomplete="one-time-code"]').fill(sent);
    await daniel.locator('button[type="submit"]').click();
    await waitForApp(daniel);
  });

  await step('a forgotten password is reset from a mailed link', async () => {
    await sofia.goto(`${server.base}/signin`);
    await sofia.locator('button', { hasText: 'Forgot your password?' }).click();
    await sofia.fill('input[type="email"]', 'sofia@example.com');
    await sofia.locator('button[type="submit"]').click();
    await sofia.locator('.auth-card h1', { hasText: 'Check your email' }).waitFor();
    const mail = await sink.next((item) => item.to.includes('sofia@example.com'));
    const link = /(\/reset\/[A-Za-z0-9_.-]+)/.exec(mail.text)[1];
    await sofia.goto(`${server.base}${link}`);
    await sofia.fill('input[type="password"]', 'sofia has a new password');
    await sofia.locator('button[type="submit"]').click();
    await waitForApp(sofia);
  });

  await step('single sign-on creates an account on first use', async () => {
    idp.person = { sub: 'sso-pat', email: 'pat@example.com', email_verified: true, name: 'Pat Single' };
    const pat = await page();
    await pat.goto(`${server.base}/signin`);
    await pat.locator('a.auth-provider', { hasText: 'Continue with Northwind SSO' }).click();
    await waitForApp(pat);
    await pat.locator('.me-strip', { hasText: 'Pat Single' }).waitFor();
    await pat.context().close();
  });

  await step('two-factor sign-in: set up from the security dialog, then required at sign-in', async () => {
    await signIn(maya, server.base, 'maya@example.com');
    await meMenu(maya, 'Sign-in and security');
    await modal(maya, 'Sign-in and security').locator('button', { hasText: 'Set up two-factor sign-in' }).click();
    await maya.locator('.qr').waitFor();
    await shot(maya, 'accounts-two-factor-setup');
    const secret = await completeTwoFactorSetup(maya);
    await maya.locator('.security-on').waitFor();
    await closeDialogs(maya);

    const again = await page();
    await again.goto(`${server.base}/signin`);
    await again.fill('input[type="email"]', 'maya@example.com');
    await again.fill('input[type="password"]', 'demo-password');
    await again.locator('button[type="submit"]').click();
    await again.locator('.auth-card h1', { hasText: 'Two-factor sign-in' }).waitFor();
    await again.locator('input[autocomplete="one-time-code"]').fill(code(secret, 1));
    await again.locator('button[type="submit"]').click();
    await waitForApp(again);
    await again.context().close();
    maya.secret = secret;
  });

  await step('workspace settings: permissions and profile fields take effect for members', async () => {
    await openAdmin(maya, 'Workspace');
    const settings = maya.locator('.workspace-settings');
    await settings.locator('.permission-row', { hasText: 'Who can create channels' }).locator('select').selectOption('admins');
    await settings.locator('button', { hasText: 'Add field' }).click();
    const field = settings.locator('.profile-field-row').last();
    await field.locator('input').first().fill('Team');
    await field.locator('select').selectOption('options_list');
    await field.locator('input').nth(1).fill('Engineering, Design');
    await settings.locator('.profile-fields-editor button', { hasText: 'Save changes' }).click();
    await maya.locator('.toast', { hasText: 'Saved' }).waitFor();
    await shot(maya, 'accounts-workspace-settings');
    await closeDialogs(maya);

    // Daniel's open tab learns the new rule without a reload.
    await daniel.locator('.sidebar .section-head button[aria-label="Add channels"], .sidebar button[aria-label="Add channels"]').first().click();
    await daniel.locator('.menu-item', { hasText: 'Browse channels' }).waitFor();
    assert.equal(await daniel.locator('.menu-item', { hasText: 'Create a channel' }).count(), 0);
    await daniel.keyboard.press('Escape');

    await meMenu(daniel, 'Edit profile');
    await daniel.locator('.field', { has: daniel.locator('.field-label', { hasText: /^Team$/ }) }).locator('select').selectOption('Engineering');
    await modal(daniel, 'Edit profile').locator('button', { hasText: 'Save changes' }).click();
    await daniel.locator('.modal').waitFor({ state: 'detached' });
  });

  await step('the profile panel shows custom fields', async () => {
    const api = async (method, args) => {
      const response = await maya.request.post(`${server.base}/api/${method}`, { data: args, headers: { origin: server.base } });
      return response.json();
    };
    const users = await api('users.list', {});
    const danielUser = users.members.find((user) => user.name === 'daniel');
    assert.ok(Object.values(danielUser.profile.fields ?? {}).some((value) => value.value === 'Engineering'));
    await openChannel(maya, 'engineering');
    await maya.locator('.msg', { hasText: 'Good catch' }).locator('.msg-author', { hasText: 'Daniel' }).click();
    await maya.locator('.profile-custom', { hasText: 'Team' }).locator('dd', { hasText: 'Engineering' }).waitFor();
    await maya.keyboard.press('Escape');
  });

  await step('when only admins invite, a member asks and an admin approves', async () => {
    await openAdmin(maya, 'Workspace');
    await maya.locator('.permission-row', { hasText: 'Who can invite people' }).locator('select').selectOption('admins');
    await closeDialogs(maya);
    await daniel.locator('.side-add', { hasText: 'Request an invite' }).click();
    const dialog = modal(daniel, 'Ask an admin to invite someone');
    await dialog.locator('input[type="email"]').fill('friend@example.com');
    await dialog.locator('button[type="submit"]').click();
    await dialog.locator('text=Request sent').waitFor();
    await closeDialogs(daniel);

    await maya.locator('.team-btn').click();
    await maya.locator('.menu-item', { hasText: 'Administration (1)' }).click();
    await maya.locator('.admin-section', { hasText: 'friend@example.com' }).locator('button', { hasText: 'Approve' }).click();
    const mail = await sink.next((item) => item.to.includes('friend@example.com'));
    assert.match(mail.text, /\/join\//);
    await closeDialogs(maya);
    await openAdmin(maya, 'Workspace');
    await maya.locator('.permission-row', { hasText: 'Who can invite people' }).locator('select').selectOption('everyone');
    await closeDialogs(maya);
  });

  await step('user groups: create one, mention it from the composer, members get the mention', async () => {
    await openChannel(sofia, 'random');
    await teamMenu(maya, 'User groups');
    await modal(maya, 'User groups').locator('button', { hasText: 'New group' }).click();
    const form = maya.locator('.group-form');
    await form.locator('.field', { hasText: 'Name' }).first().locator('input').fill('Designers');
    await form.locator('.field', { hasText: 'Handle' }).locator('input').fill('design');
    await form.locator('.check-list').first().locator('label', { hasText: 'Sofia' }).locator('input').check();
    await form.locator('button[type="submit"]').click();
    await maya.locator('.group-list', { hasText: '@design' }).waitFor();
    await shot(maya, 'accounts-groups');
    await closeDialogs(maya);

    await openChannel(maya, 'general');
    const box = maya.locator('.conversation .composer-input');
    await box.pressSequentially('@desig');
    await maya.locator('.suggest-item', { hasText: '@design' }).click();
    await box.pressSequentially('please look at the empty states');
    await box.press('Enter');
    await maya.locator('.message-scroll .msg', { hasText: 'please look at the empty states' }).locator('.mention', { hasText: '@design' }).waitFor();
    await sideItem(sofia, 'general').locator('.badge').waitFor();
  });

  await step('a guest is invited by mail and sees only their channel', async () => {
    await teamMenu(maya, 'Invite people');
    const dialog = modal(maya, 'Invite people');
    await dialog.locator('.guest-options .check-row input').check();
    await dialog.locator('.guest-options .check-list label', { hasText: 'design' }).locator('input').check();
    await dialog.locator('input[type="email"]').fill('guest@agency.example');
    await dialog.locator('button', { hasText: 'Create invite link' }).click();
    const mail = await sink.next((item) => item.to.includes('guest@agency.example'));
    await closeDialogs(maya);
    const link = /(\/join\/[A-Za-z0-9_-]+)/.exec(mail.text)[1];

    const guest = await page();
    await guest.goto(`${server.base}${link}`);
    await guest.locator('.field', { hasText: 'Your name' }).locator('input').fill('Gus Guest');
    await guest.fill('input[type="password"]', 'a guest password');
    await guest.locator('button[type="submit"]').click();
    await waitForApp(guest);
    const names = await guest.locator('.sidebar .side-item .side-name').allInnerTexts();
    assert.ok(names.includes('design'), names.join(','));
    assert.ok(!names.includes('general') && !names.includes('random'), names.join(','));
    await guest.locator('.team-btn').click();
    assert.equal(await guest.locator('.menu-item', { hasText: 'Browse channels' }).count(), 0);
    assert.equal(await guest.locator('.menu-item', { hasText: 'Invite people' }).count(), 0);
    await guest.keyboard.press('Escape');
    await shot(guest, 'accounts-guest');
    await guest.context().close();
  });

  await step('a channel opened to the web is readable without signing in', async () => {
    await openChannel(maya, 'random');
    await maya.locator('button[aria-label="Details"]').first().click();
    const web = maya.locator('.web-settings');
    await web.locator('.check-row', { hasText: 'Readable on the web' }).locator('input').check();
    const href = await web.locator('a', { hasText: 'Open public page' }).getAttribute('href');
    const visitor = await (await browser.newContext(wide)).newPage();
    await visitor.goto(`${server.base}${href}`);
    await visitor.locator('h1', { hasText: '#random' }).waitFor();
    await visitor.locator('.msg', { hasText: 'oat milk' }).waitFor();
    assert.equal(await visitor.locator('script').count(), 0);
    await shot(visitor, 'accounts-public-page');
    await visitor.context().close();
    await maya.keyboard.press('Escape');
  });

  await step('an owner downloads the export', async () => {
    await openAdmin(maya, 'Workspace');
    const [download] = await Promise.all([maya.waitForEvent('download'), maya.locator('a', { hasText: 'Download export' }).click()]);
    assert.match(download.suggestedFilename(), /-export-\d{4}-\d{2}-\d{2}\.zip$/);
    const path = await download.path();
    const { statSync } = await import('node:fs');
    assert.ok(statSync(path).size > 2000);
    await closeDialogs(maya);
  });

  await step('requiring two-factor sign-in sends members to set it up, then back in', async () => {
    await openAdmin(maya, 'Workspace');
    await maya.locator('.check-row', { hasText: 'Require two-factor sign-in' }).locator('input').check();
    await closeDialogs(maya);
    // The open client may already have switched on its next call; a reload makes it certain.
    await daniel.reload();
    await daniel.locator('.auth-card h1', { hasText: 'Set up two-factor sign-in' }).waitFor({ timeout: 15_000 });
    await completeTwoFactorSetup(daniel);
    await waitForApp(daniel);
    await openAdmin(maya, 'Workspace');
    await maya.locator('.check-row', { hasText: 'Require two-factor sign-in' }).locator('input').uncheck();
    await closeDialogs(maya);
  });

  await step('installable: a manifest with the workspace name, a service worker, an offline shell', async () => {
    const manifest = await (await fetch(`${server.base}/manifest.webmanifest`)).json();
    assert.equal(manifest.name, 'Northwind');
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));
    for (const icon of manifest.icons) assert.equal((await fetch(`${server.base}${icon.src}`)).headers.get('content-type'), 'image/png');
    const scope = await sofia.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    assert.equal(scope, `${server.base}/`);
    // Once the worker controls the page it caches the shell and the assets; offline, the app still opens.
    await sofia.reload();
    await waitForApp(sofia);
    await sofia.context().setOffline(true);
    await sofia.reload();
    await sofia.locator('.splash h1', { hasText: 'reach the server' }).waitFor();
    await sofia.context().setOffline(false);
  });

  skip('push notifications in the browser', 'headless Chrome has no push service to subscribe to; the server side is tested in apps/server/test/push.test.ts');

  await sink.stop();
  await idp.stop();
}

await run(main);
