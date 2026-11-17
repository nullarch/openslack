// Browser test for Web Push through a real push service: Chrome subscribes
// (Google's push service), the person leaves, a direct message arrives, and
// the service worker shows it as a notification. Needs network access to
// fcm.googleapis.com, so it is not in the default `e2e` chain.
//
//   pnpm --filter @app/web build && node e2e/push.mjs
//
// Chrome refuses push in temporary (incognito-like) profiles, which is what
// Playwright's ordinary contexts are; this test uses a real, throwaway profile.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { browserName, run, skip, startServer, step } from './lib.mjs';

async function main() {
  if (browserName !== 'chrome') {
    skip('web push through a real push service', 'Chrome only');
    return;
  }
  const { base } = await startServer({ seed: true });
  const profile = mkdtempSync(join(tmpdir(), 'chat-push-profile-'));
  const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: process.env.HEADED !== '1', permissions: ['notifications'], locale: 'en-US' });
  try {
    const page = await context.newPage();

    await step('Maya turns on notifications: subscribed with the push service, saved by the server', async () => {
      await page.goto(`${base}/signin`);
      await page.fill('input[type="email"]', 'maya@example.com');
      await page.fill('input[type="password"]', 'demo-password');
      await page.press('input[type="password"]', 'Enter');
      await page.waitForSelector('.sidebar', { timeout: 20_000 });
      const subscribed = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
        const status = await (await fetch('/api/client.push.status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
        const padded = status.vapid_public_key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (status.vapid_public_key.length % 4)) % 4);
        const key = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
        const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        const saved = await (await fetch('/api/client.push.subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: subscription.toJSON() }) })).json();
        return { ok: saved.ok, host: new URL(subscription.endpoint).host };
      });
      assert.equal(subscribed.ok, true);
      assert.match(subscribed.host, /googleapis\.com$/);
    });

    await step('away from the app, a direct message arrives as a notification through the push service', async () => {
      await page.goto('about:blank');
      // Past the grace period in which someone who just left still counts as online.
      await page.waitForTimeout(8000);
      const signin = await fetch(`${base}/api/client.signin`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ email: 'daniel@example.com', password: 'demo-password' }) });
      const cookie = signin.headers.get('set-cookie').split(';')[0];
      const post = async (method, body) => (await fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie }, body: JSON.stringify(body) })).json();
      const maya = (await post('users.list', {})).members.find((user) => user.name.startsWith('maya')).id;
      const dm = await post('conversations.open', { users: maya });
      assert.equal((await post('chat.postMessage', { channel: dm.channel.id, text: 'Push check: are you there?' })).ok, true);
      const probe = await context.newPage();
      await probe.goto(`${base}/favicon.svg`);
      await probe.waitForFunction(
        async () => {
          const registration = await navigator.serviceWorker.getRegistration('/');
          const shown = registration ? await registration.getNotifications() : [];
          return shown.some((notification) => notification.title === 'Daniel' && notification.body === 'Push check: are you there?');
        },
        null,
        { timeout: 30_000, polling: 500 },
      );
    });
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

await run(main);
