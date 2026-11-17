// Browser test for automation: build a shortcut workflow with a form and a
// message step, publish it, run it as another person and read the run
// history; an emoji-reaction workflow that answers in the thread; a workflow
// started from its link; a custom response; dark theme and phone width.
//
//   pnpm --filter @app/web build && node e2e/workflows.mjs
import assert from 'node:assert/strict';
import { openChannel, row, run, send, shot, signIn, startServer, step, watch, wide } from './lib.mjs';

async function api(page, method, args = {}) {
  return page.evaluate(
    async ([name, body]) => {
      const response = await fetch(`/api/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return response.json();
    },
    [method, args],
  );
}

async function teamMenu(page, label) {
  await page.locator('.team-btn').click();
  await page.locator('.menu-item', { hasText: label }).click();
}

/** The input of the field labelled exactly `label` inside `scope`. */
function field(scope, label) {
  return scope.locator('.field', { has: scope.page().locator(`.field-label:text-is("${label}")`) }).locator('input, select, textarea').first();
}

async function addStep(page, scope, label) {
  await scope.locator('.wf-add').last().click();
  await page.locator('.menu .menu-item', { hasText: label }).click();
}

async function main(browser) {
  const server = await startServer({ seed: true });
  const context = await browser.newContext({ ...wide, colorScheme: 'light' });
  const maya = watch(await context.newPage());
  await signIn(maya, server.base, 'maya@example.com');
  const other = await browser.newContext({ ...wide, colorScheme: 'light' });
  const daniel = watch(await other.newPage());
  await signIn(daniel, server.base, 'daniel@example.com');
  const ids = {
    random: (await api(maya, 'conversations.info', { channel: '#random' })).channel.id,
    engineering: (await api(maya, 'conversations.info', { channel: '#engineering' })).channel.id,
  };
  let requestId = '';

  await step('build a shortcut workflow with a form and a message, then publish it', async () => {
    await teamMenu(maya, 'Workflows');
    await maya.locator('.wf-intro').waitFor();
    await maya.getByRole('button', { name: 'New workflow' }).click();
    await maya.locator('.wf-builder').waitFor();
    await field(maya.locator('.wf-meta'), 'Name').fill('Time off request');
    assert.equal(await maya.locator('.wf-trigger select').first().inputValue(), 'shortcut');

    // Step 1: a form with two questions.
    await addStep(maya, maya.locator('.wf-builder'), 'Collect info in a form');
    const form = maya.locator('.wf-step[data-step="form_1"]');
    await field(form, 'Form title').fill('Time off');
    const questions = form.locator('.wf-fields > li');
    await field(questions.nth(0), 'Question').fill('Dates');
    await form.getByRole('button', { name: 'Add a question' }).click();
    await field(questions.nth(1), 'Question').fill('Kind');
    await questions.nth(1).getByLabel('Answer type').selectOption('select');
    await field(questions.nth(1), 'Choices (comma-separated)').fill('Vacation, Sick');
    await field(questions.nth(1), 'Choices (comma-separated)').blur();
    await questions.nth(1).getByLabel('Required').check();

    // Step 2: a message to #random that uses the answers.
    await addStep(maya, maya.locator('.wf-builder'), 'Send a message');
    const message = maya.locator('.wf-step[data-step="message_1"]');
    await message.getByLabel('Send to').selectOption('channel');
    await field(message, 'Channel').selectOption({ label: '#random' });
    const text = field(message, 'Message');
    await text.fill('Time off: ');
    // The variable menu offers what the form collects.
    await message.getByLabel('Insert a variable: Message').selectOption({ label: '1. Dates' });
    assert.equal(await text.inputValue(), 'Time off: {{steps.form_1.answer}}');
    await text.fill('Time off ({{steps.form_1.question_2}}): {{steps.form_1.answer}} for {{steps.form_1.user}}');
    await shot(maya, 'workflows-builder');

    await maya.locator('.wf-actions').getByRole('button', { name: 'Publish' }).click();
    await maya.waitForURL(/\/workflows\/Wf[A-Z0-9]+$/);
    await maya.locator('.wf-meta .wf-badge', { hasText: 'Published' }).waitFor();
    requestId = maya.url().split('/').pop();
    await maya.locator('.wf-runs', { hasText: 'No runs yet.' }).waitFor();
  });

  await step('another person runs it from the composer’s shortcuts: the form, then the message', async () => {
    await openChannel(daniel, 'random');
    await daniel.locator('.conversation .composer-foot button[aria-label="Shortcuts"]').click();
    await daniel.locator('.shortcuts-menu .menu-item', { hasText: 'Time off request' }).click();
    const modal = daniel.locator('.app-modal');
    await modal.locator('.modal-head', { hasText: 'Time off' }).waitFor();
    const block = (id) => modal.locator(`.block-input-block[data-block-id="${id}"]`);
    // Required questions are checked before anything continues.
    await modal.locator('.modal-foot .btn', { hasText: 'Submit' }).click();
    await block('question_2').locator('.field-error').waitFor();
    await block('answer').locator('input').fill('Dec 24–26');
    await block('question_2').locator('select').selectOption('Sick');
    await shot(daniel, 'workflows-form');
    await modal.locator('.modal-foot .btn', { hasText: 'Submit' }).click();
    await modal.waitFor({ state: 'detached' });
    const posted = row(daniel, 'Time off (Sick): Dec 24–26 for');
    await posted.waitFor();
    await posted.locator('.mention', { hasText: 'Daniel' }).waitFor();
    // It comes from the workflow, under the workflow's name.
    await posted.locator('.msg-author', { hasText: 'Time off request' }).waitFor();
  });

  await step('the run history shows who ran it and each step', async () => {
    const latest = maya.locator('.wf-run').first();
    await latest.locator('.wf-run-status', { hasText: 'Completed' }).waitFor({ timeout: 10_000 });
    await latest.locator('summary', { hasText: 'started by Daniel' }).waitFor();
    await latest.locator('summary').click();
    await latest.locator('.wf-run-log li', { hasText: 'form_1' }).first().waitFor();
    await latest.locator('.wf-run-log li', { hasText: 'message_1' }).waitFor();
    await shot(maya, 'workflows-runs');
    await maya.getByRole('button', { name: 'All workflows' }).click();
    await maya.locator('.wf-card', { hasText: 'Time off request' }).locator('.wf-badge', { hasText: 'Published' }).waitFor();
    await maya.locator('.wf-card', { hasText: 'Last run' }).waitFor();
    await shot(maya, 'workflows-list');
  });

  await step('an emoji reaction in the chosen channel answers in the message’s thread', async () => {
    await maya.getByRole('button', { name: 'New workflow' }).click();
    await field(maya.locator('.wf-meta'), 'Name').fill('Eyes on it');
    await maya.locator('.wf-trigger select').first().selectOption('reaction');
    await field(maya.locator('.wf-trigger'), 'Channel').selectOption({ label: '#engineering' });
    assert.equal(await field(maya.locator('.wf-trigger'), 'Emoji name').inputValue(), 'eyes');
    await addStep(maya, maya.locator('.wf-builder'), 'Send a message');
    const message = maya.locator('.wf-step[data-step="message_1"]');
    assert.equal(await message.getByLabel('Send to').inputValue(), 'thread');
    await field(message, 'Message').fill('{{trigger.user}} is on it');
    await maya.locator('.wf-actions').getByRole('button', { name: 'Publish' }).click();
    await maya.locator('.wf-meta .wf-badge', { hasText: 'Published' }).waitFor();

    await openChannel(daniel, 'engineering');
    await send(daniel, 'the staging deploy is stuck');
    const target = row(daniel, 'the staging deploy is stuck');
    await target.waitFor();
    await target.hover();
    await target.locator('.msg-toolbar button[aria-label="Add reaction"]').click();
    const picker = daniel.locator('em-emoji-picker');
    await picker.waitFor();
    await picker.locator('input[type="search"]').fill('eyes');
    await picker.locator('button[aria-label="👀"]').first().click();
    await target.locator('.reaction.is-mine').waitFor();
    await target.locator('.thread-summary').waitFor({ timeout: 10_000 });
    const history = await api(daniel, 'conversations.history', { channel: ids.engineering, limit: 1 });
    const replies = await api(daniel, 'conversations.replies', { channel: ids.engineering, ts: history.messages[0].ts });
    assert.match(replies.messages[1].text, /^<@U[A-Z0-9]+> is on it$/);
    await maya.locator('.wf-run .wf-run-status', { hasText: 'Completed' }).waitFor({ timeout: 10_000 });
  });

  await step('a link starts its workflow for whoever opens it', async () => {
    const saved = await api(maya, 'client.workflows.save', {
      name: 'Say hi',
      trigger: { type: 'link' },
      steps: [{ id: 'hi', type: 'message', destination: { to: 'trigger_channel' }, text: 'Started from a link by {{trigger.user}}' }],
    });
    const published = await api(maya, 'client.workflows.publish', { workflow: saved.workflow.id });
    assert.ok(published.ok, JSON.stringify(published));
    const linkUrl = (await api(maya, 'client.workflows.get', { workflow: saved.workflow.id })).workflow.link_url;
    assert.match(linkUrl, /\/workflow\/[0-9a-f]+$/);
    await daniel.goto(linkUrl);
    const card = daniel.locator('.wf-link-card');
    await card.locator('h2', { hasText: 'Say hi' }).waitFor();
    await card.getByRole('button', { name: 'Start' }).click();
    await daniel.waitForURL(`**/c/${ids.engineering}`);
    await row(daniel, 'Started from a link by').waitFor();

    // Featured in the channel (workflows.featured.add): one click in the bookmarks bar starts it there.
    const triggerId = (await api(maya, 'client.workflows.get', { workflow: saved.workflow.id })).workflow.trigger_id;
    assert.equal((await api(maya, 'workflows.featured.add', { channel_id: ids.engineering, trigger_ids: [triggerId] })).ok, true);
    const chip = daniel.locator(`.bookmarks-bar [data-featured-workflow="${triggerId}"]`, { hasText: 'Say hi' });
    await chip.waitFor();
    const before = await daniel.locator('.msg', { hasText: 'Started from a link by' }).count();
    await chip.click();
    await daniel.locator('.toast', { hasText: 'Workflow started' }).waitFor();
    await daniel.waitForFunction((count) => document.querySelectorAll('.msg').length > 0 && [...document.querySelectorAll('.msg')].filter((node) => node.textContent?.includes('Started from a link by')).length > count, before);
    await shot(daniel, 'workflow-featured');
  });

  await step('custom responses: an admin adds one and it answers in public channels', async () => {
    await teamMenu(maya, 'Administration');
    await maya.locator('.modal .tabs button', { hasText: 'Workspace' }).click();
    const admin = maya.locator('.responses-admin');
    await field(admin, 'Phrase').fill('wifi password');
    await field(admin, 'Reply with').fill('It’s on the fridge.');
    await admin.getByRole('button', { name: 'Add response' }).click();
    await admin.locator('.admin-list li', { hasText: 'wifi password' }).waitFor();
    await shot(maya, 'workflows-responses');
    await maya.keyboard.press('Escape');

    await openChannel(daniel, 'random');
    await send(daniel, 'what is the WiFi password again?');
    await row(daniel, 'It’s on the fridge.').waitFor();
  });

  await step('dark theme and phone width: the list, the builder and the run history fit', async () => {
    const layouts = [
      { name: 'dark', options: { ...wide, colorScheme: 'dark' } },
      { name: 'phone', options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light' } },
    ];
    for (const layout of layouts) {
      const ctx = await browser.newContext(layout.options);
      const page = watch(await ctx.newPage());
      await signIn(page, server.base, 'maya@example.com');
      await page.goto(`${server.base}/workflows`);
      await page.locator('.wf-card').first().waitFor();
      await shot(page, `workflows-${layout.name}-list`);
      await page.goto(`${server.base}/workflows/${requestId}`);
      await page.locator('.wf-step[data-step="form_1"]').waitFor();
      await page.locator('.wf-run').first().waitFor();
      const viewport = page.viewportSize();
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        `${layout.name}: no sideways scroll in the builder`,
      );
      const actions = await page.locator('.wf-actions').boundingBox();
      assert.ok(actions.x >= 0 && actions.x + actions.width <= viewport.width, `${layout.name}: the actions fit`);
      await shot(page, `workflows-${layout.name}-builder`);
      await ctx.close();
    }
  });

  await other.close();
}

run(main);
