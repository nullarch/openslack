// Administration in a real browser: a member reports a message and an admin
// removes it; a member hides a person; analytics with its charts and table
// view; the audit log with its CSV export; retention; dark theme and phone
// width for the analytics screen.
//
//   pnpm --filter @app/web build && node apps/web/e2e/admin.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { composer, openChannel, row, run, shot, signIn, startServer, step, watch, wide } from './lib.mjs';

async function openAdmin(page, tab) {
  await page.locator('.team-btn').click();
  await page.locator('.menu-item', { hasText: 'Administration' }).click();
  await page.locator('.admin-modal .tabs button', { hasText: tab }).click();
}

async function moreActions(page, message, item) {
  await message.hover();
  await message.locator('.msg-toolbar button[aria-label="More actions"]').click();
  await page.locator('.menu-item', { hasText: item }).first().click();
}

async function main(browser) {
  const server = await startServer({ seed: true });
  const maya = watch(await (await browser.newContext({ ...wide, colorScheme: 'light', acceptDownloads: true })).newPage());
  const daniel = watch(await (await browser.newContext({ ...wide, colorScheme: 'light' })).newPage());
  await signIn(maya, server.base, 'maya@example.com');
  await signIn(daniel, server.base, 'daniel@example.com');
  await openChannel(daniel, 'random');

  await step('a member reports a message from its menu', async () => {
    await moreActions(daniel, row(daniel, 'oat milk'), 'Report message');
    const dialog = daniel.locator('.modal[role="dialog"]');
    await dialog.locator('textarea').fill('Not appropriate for this channel');
    await dialog.locator('button', { hasText: 'Report' }).click();
    await daniel.locator('.toast', { hasText: 'Reported' }).waitFor();
  });

  await step('an admin sees the report and removes the message for everyone', async () => {
    await openAdmin(maya, 'Reports');
    const report = maya.locator('.report-item', { hasText: 'oat milk' });
    await report.waitFor();
    assert.match(await report.innerText(), /Not appropriate for this channel/);
    await shot(maya, 'admin-reports');
    await report.locator('button', { hasText: 'Remove message' }).click();
    await maya.locator('.modal[role="dialog"] button', { hasText: 'Remove message' }).last().click();
    await maya.locator('.toast', { hasText: 'Message removed' }).waitFor();
    await maya.locator('.reports-admin', { hasText: 'No open reports.' }).waitFor();
    await row(daniel, 'oat milk').waitFor({ state: 'detached' });
  });

  await step('a member hides a person: their messages fold to one line until shown', async () => {
    await row(daniel, 'kimchi jjigae').locator('.msg-author').click();
    await daniel.locator('.profile button', { hasText: 'Hide their messages' }).click();
    const folded = daniel.locator('.msg.is-hidden-author').first();
    await folded.waitFor();
    assert.equal(await row(daniel, 'kimchi jjigae').count(), 0);
    await folded.locator('button', { hasText: 'Show' }).click();
    await row(daniel, 'kimchi jjigae').waitFor();
    await daniel.locator('.profile button', { hasText: 'Show their messages' }).click();
    await daniel.locator('.msg.is-hidden-author').first().waitFor({ state: 'detached' });
  });

  await step('analytics: tiles, a chart with a tooltip, the same data as a table', async () => {
    await maya.locator('.admin-modal .tabs button', { hasText: 'Analytics' }).click();
    await maya.locator('.stat-tile').first().waitFor();
    assert.equal(await maya.locator('.stat-tile').count(), 4);
    const chart = maya.locator('.viz-card').first();
    assert.ok((await chart.locator('path.viz-mark').count()) >= 1, 'columns are drawn');
    const hits = chart.locator('rect.viz-hit');
    await hits.last().hover();
    await chart.locator('.viz-tooltip').waitFor();
    assert.match(await chart.locator('.viz-tooltip').innerText(), /Active/);
    await maya.locator('.viz-card').nth(1).locator('.viz-legend li').first().waitFor();
    assert.equal(await maya.locator('.viz-card').nth(1).locator('.viz-legend li').count(), 3);
    await shot(maya, 'admin-analytics');
    await chart.locator('button', { hasText: 'Show as table' }).click();
    assert.equal(await chart.locator('tbody tr').count(), 30);
    await maya.locator('.analytics-range button', { hasText: 'Last 7 days' }).click();
    await maya.locator('.viz-card').first().locator('rect.viz-hit').nth(6).waitFor();
    assert.equal(await maya.locator('.viz-card').first().locator('rect.viz-hit').count(), 7);
  });

  await step('audit log: what happened, filtered, exported as CSV', async () => {
    await maya.locator('.admin-modal .tabs button', { hasText: 'Audit log' }).click();
    const table = maya.locator('.audit-table');
    await table.waitFor();
    assert.match(await table.innerText(), /Removed a reported message/);
    await maya.locator('.audit-tools select').selectOption('reported_message_removed');
    await maya.waitForFunction(() => [...document.querySelectorAll('.audit-table tbody tr')].every((tr) => tr.textContent.includes('Removed a reported message')));
    const download = maya.waitForEvent('download');
    await maya.locator('.audit-tools button', { hasText: 'Export CSV' }).click();
    const file = await download;
    assert.match(file.suggestedFilename(), /^audit-log-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = await readFile(await file.path(), 'utf8');
    assert.match(csv.split('\n')[0], /^time,action,actor_type,actor,entity_type,entity,ip_address,user_agent$/);
    assert.match(csv, /reported_message_removed/);
  });

  await step('retention: an owner applies a policy; nothing old enough means nothing to confirm', async () => {
    await maya.locator('.admin-modal .tabs button', { hasText: 'Workspace' }).click();
    const retention = maya.locator('.retention-setting');
    await retention.waitFor();
    await retention.locator('.field', { hasText: 'Messages in channels' }).locator('select').selectOption('3650');
    await retention.locator('button', { hasText: 'Apply retention' }).click();
    await maya.locator('.toast', { hasText: 'Saved' }).waitFor();
    const policy = await maya.evaluate(async () => (await (await fetch('/api/client.admin.retention', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()).retention);
    assert.equal(policy.messages_days, 3650);
    await retention.locator('.field', { hasText: 'Messages in channels' }).locator('select').selectOption('0');
    await retention.locator('button', { hasText: 'Apply retention' }).click();
    await maya.keyboard.press('Escape');
  });

  await step('compliance: turning on card-number detection refuses such a message with a clear reason', async () => {
    await openAdmin(maya, 'Compliance');
    const section = maya.locator('.compliance-section').first();
    await section.locator('.check-row', { hasText: 'Payment card numbers' }).locator('input').check();
    await section.locator('textarea').fill('my card 4111 1111 1111 1111');
    await section.locator('button', { hasText: 'Check' }).click();
    await section.locator('.notice', { hasText: 'Payment card numbers' }).waitFor();
    await section.locator('.btn-primary', { hasText: 'Save' }).click();
    await maya.locator('.toast', { hasText: 'Saved' }).last().waitFor();
    await maya.keyboard.press('Escape');
    await openChannel(daniel, 'random');
    await composer(daniel).fill('card 4111 1111 1111 1111');
    await composer(daniel).press('Enter');
    await daniel.locator('.toast, .msg.is-failed', { hasText: /card numbers|sensitive|allow/i }).first().waitFor();
    await maya.evaluate(async () => {
      await fetch('/api/client.admin.dlp.set', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ detectors: [], custom: [] }) });
    });
  });

  await step('a channel from the Project template starts with its brief and task list', async () => {
    await maya.locator('.side-section-head button[aria-label="Add channels"]').first().click();
    await maya.locator('.menu-item', { hasText: 'Create a channel' }).first().click();
    const dialog = maya.locator('.modal[role="dialog"]');
    await dialog.locator('input').first().fill('website relaunch');
    await dialog.locator('.template-option', { hasText: 'Project' }).click();
    await dialog.locator('.btn-primary').last().click();
    await maya.locator('.conv-title', { hasText: 'website-relaunch' }).waitFor();
    await maya.locator('.doc-tab', { hasText: 'Project brief' }).waitFor();
    await maya.locator('.doc-tab', { hasText: 'Tasks' }).waitFor();
    await shot(maya, 'admin-channel-template');
  });

  await step('sign-in and security lists where you are signed in', async () => {
    await maya.locator('.me-strip').click();
    await maya.locator('.menu-item', { hasText: 'Sign-in and security' }).click();
    const sessions = maya.locator('.sessions-section');
    await sessions.waitFor();
    assert.ok((await sessions.locator('li').count()) >= 1);
    await sessions.locator('.tag', { hasText: 'This device' }).waitFor();
    await maya.keyboard.press('Escape');
  });

  await step('compliance: the IP allowlist shows where you connect from and refuses to lock you out; barriers keep groups apart', async () => {
    await maya.evaluate(async () => {
      const post = (method, body) => fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
      const users = (await post('users.list', {})).members;
      const id = (name) => users.find((user) => user.name.startsWith(name)).id;
      await post('usergroups.create', { name: 'Research', handle: 'research', users: id('daniel') });
      await post('usergroups.create', { name: 'Sales', handle: 'sales', users: id('sofia') });
    });
    await openAdmin(maya, 'Compliance');
    const network = maya.locator('.compliance-section', { hasText: 'Allowed network addresses' });
    await network.locator('.muted', { hasText: 'You are connecting from 127.0.0.1' }).waitFor();
    await network.locator('textarea').fill('198.51.100.0/24');
    await network.locator('.btn-primary', { hasText: 'Save' }).click();
    await maya.locator('.modal[role="dialog"] .btn', { hasText: 'Save' }).last().click();
    await maya.locator('.toast', { hasText: 'shut you out' }).waitFor();
    const barriers = maya.locator('.compliance-section', { hasText: 'Information barriers' });
    await barriers.locator('.field', { hasText: /^Group/ }).locator('select').selectOption({ label: 'Research' });
    await barriers.locator('.field', { hasText: 'Kept apart from' }).locator('select').selectOption({ label: 'Sales' });
    await barriers.locator('.btn', { hasText: 'Add barrier' }).click();
    await barriers.locator('.admin-name', { hasText: 'Research is kept apart from Sales' }).waitFor();
    const refused = await daniel.evaluate(async () => {
      const users = (await (await fetch('/api/users.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()).members;
      const sofia = users.find((user) => user.name.startsWith('sofia')).id;
      return (await fetch('/api/conversations.open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ users: sofia }) })).json();
    });
    assert.equal(refused.detail, 'information_barrier');
    await shot(maya, 'admin-compliance');
    await barriers.locator('.btn', { hasText: 'Remove' }).click();
    await barriers.locator('.admin-name').first().waitFor({ state: 'detached' });
    await maya.keyboard.press('Escape');
  });

  await step('dark theme and phone width: analytics fits', async () => {
    for (const layout of [
      { name: 'dark', options: { ...wide, colorScheme: 'dark' } },
      { name: 'phone', options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light' } },
    ]) {
      const context = await browser.newContext(layout.options);
      const page = watch(await context.newPage());
      await signIn(page, server.base, 'maya@example.com').catch(async () => {
        // On a phone the sidebar is a drawer: sign-in lands on the channel view.
        await page.waitForSelector('.conv-title, .sidebar');
      });
      if (layout.name === 'phone') {
        await page.locator('.mobile-menu, button[aria-label="Open sidebar"], .drawer-toggle').first().click().catch(() => undefined);
      }
      await openAdmin(page, 'Analytics');
      await page.locator('.stat-tile').first().waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `no sideways scroll (${overflow}px)`);
      await shot(page, `admin-analytics-${layout.name}`);
      await context.close();
    }
  });
}

await run(main);
