// Third browser test: the app surfaces, driven through the web client against
// a real Bolt app (compat/apps/ui-app.mjs) delivering over HTTP — the Apps
// screen's request URL settings, menus on a message, a modal with every kind of
// input, a message shortcut, App Home and link unfurls.
//
//   pnpm --filter @app/web build && node apps/web/e2e/platform.mjs
//
// See lib.mjs for the environment variables.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { composer, freePort, modifier, openChannel, root, row, run, shot, signIn, startServer, step, track, watch, wide } from './lib.mjs';

async function openAdmin(page, tab) {
  await page.locator('.team-btn').click();
  await page.locator('.menu-item', { hasText: 'Administration' }).click();
  await page.locator('.admin-modal .tabs button', { hasText: tab }).click();
}

/** Start the Bolt app over HTTP and wait until it listens. */
async function startBolt({ base, botToken, signingSecret, channel }) {
  const port = await freePort();
  const child = track(
    spawn(process.execPath, [join(root, 'compat/apps/ui-app.mjs')], {
      env: { ...process.env, BOT_TOKEN: botToken, SIGNING_SECRET: signingSecret, PORT: String(port), API_URL: `${base}/api/`, CHANNEL: channel },
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the Bolt app did not start')), 20_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => reject(new Error(`the Bolt app exited with ${code}`)));
  });
  return `http://127.0.0.1:${port}/slack/events`;
}

async function main(browser) {
  const server = await startServer({ seed: true });
  const context = await browser.newContext({ ...wide, colorScheme: 'light' });
  const maya = watch(await context.newPage(), /status of 4\d\d/);
  const frames = [];
  maya.on('websocket', (socket) => {
    socket.on('framereceived', (frame) => {
      const text = String(frame.payload);
      if (text.includes('tracker.example')) frames.push(`${Date.now()} ${text.slice(0, 160)}`);
    });
  });
  maya.on('response', async (response) => {
    if (response.url().includes('chat.postMessage')) frames.push(`${Date.now()} RESPONSE postMessage`);
  });
  await signIn(maya, server.base, 'maya@example.com');
  const random = await maya.evaluate(async () => {
    const response = await fetch('/api/conversations.info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: '#random' }) });
    return (await response.json()).channel.id;
  });
  let eventsUrl = '';
  let botUserId = '';

  await step('apps screen: create an app, then point it at a Bolt app over HTTP (a wrong URL is refused, the right one verified)', async () => {
    await openAdmin(maya, 'Apps');
    await maya.locator('.new-app input').first().fill('Tracker');
    await maya.locator('.new-app .btn-primary').click();
    const botToken = await maya.locator('.copy-field', { hasText: 'Bot token' }).locator('input').inputValue();
    const signingSecret = await maya.locator('.copy-field', { hasText: 'Signing secret' }).locator('input').inputValue();
    assert.match(botToken, /^xoxb-/);
    eventsUrl = await startBolt({ base: server.base, botToken, signingSecret, channel: random });

    await maya.locator('.check-row', { hasText: 'Socket Mode' }).locator('input').uncheck();
    const events = maya.locator('.field', { hasText: 'Events request URL' }).locator('input');
    await events.fill(eventsUrl.replace('/slack/events', '/nowhere'));
    await maya.locator('.app-detail .row-buttons .btn-primary').click();
    await maya.locator('.toast', { hasText: /verification/i }).waitFor();
    await maya.locator('.toast').first().waitFor({ state: 'detached', timeout: 8000 });

    await events.fill(eventsUrl);
    await maya.locator('.field', { hasText: 'Interactivity request URL' }).locator('input').fill(eventsUrl);
    await maya.locator('.app-detail .row-buttons .btn-primary').click();
    await maya.locator('.toast', { hasText: 'Saved' }).waitFor();
    const info = await maya.evaluate(async () => {
      const response = await fetch('/api/client.apps.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      return (await response.json()).apps.find((app) => app.name === 'Tracker');
    });
    assert.equal(info.socket_mode, false);
    assert.equal(info.events_url, eventsUrl);
    assert.equal(info.interactivity_url, eventsUrl);
    botUserId = info.bot_user_id;
  });

  await step('apps screen: shortcuts, link-preview domains and the API rate limit', async () => {
    const add = async (name, callbackId, type) => {
      await maya.locator('.shortcut-form .field', { hasText: 'Name' }).locator('input').fill(name);
      await maya.locator('.shortcut-form .field', { hasText: 'Callback ID' }).locator('input').fill(callbackId);
      await maya.locator('.shortcut-form select').selectOption(type);
      await maya.locator('.shortcut-form .btn', { hasText: 'Add shortcut' }).click();
      await maya.locator('.app-platform-settings .admin-name', { hasText: name }).waitFor();
    };
    await add('File a bug', 'file_bug', 'global');
    await add('Turn into a bug', 'quote_message', 'message');
    // Let the earlier "Saved" go, so the next one is this save's.
    await maya.locator('.toast').first().waitFor({ state: 'detached', timeout: 8000 });
    await maya.locator('.app-platform-settings .field', { hasText: 'Domains' }).locator('input').fill('tracker.example');
    await maya.locator('.app-platform-settings .inline-form .btn').click();
    await maya.locator('.toast', { hasText: 'Saved' }).last().waitFor();
    await shot(maya, 'platform-app-settings');

    await maya.locator('.back-link').click();
    await maya.locator('.toast').first().waitFor({ state: 'detached', timeout: 8000 });
    const limit = maya.locator('.rate-limit input');
    await limit.fill('5000');
    await maya.locator('.rate-limit .btn').click();
    await maya.locator('.toast', { hasText: 'Saved' }).last().waitFor();
    const limits = await maya.evaluate(async () => {
      const response = await fetch('/api/client.apps.limits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      return response.json();
    });
    assert.equal(limits.api_rate_limit_per_minute, 5000);
    const saved = await maya.evaluate(async () => {
      const response = await fetch('/api/client.apps.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      return (await response.json()).apps.find((app) => app.name === 'Tracker');
    });
    assert.deepEqual(saved.unfurl_domains, ['tracker.example']);
    assert.deepEqual(
      saved.shortcuts.map((entry) => [entry.type, entry.callback_id]),
      [
        ['global', 'file_bug'],
        ['message', 'quote_message'],
      ],
    );
    await maya.keyboard.press('Escape');
    await maya.evaluate(
      async ([channel, user]) => {
        await fetch('/api/conversations.invite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel, users: user }) });
      },
      [random, botUserId],
    );
  });

  await step('a static select and an overflow menu on a message, answered by the app over HTTP', async () => {
    await openChannel(maya, 'random');
    await composer(maya).pressSequentially('@Track');
    await maya.locator('.suggest-item', { hasText: 'Tracker' }).first().waitFor();
    await composer(maya).press('Enter');
    await composer(maya).pressSequentially('menu please');
    await composer(maya).press('Enter');
    const settings = row(maya, 'Where should build 1482 go?');
    await settings.locator('.block-select').selectOption('production');
    await row(maya, 'Environment set to production').waitFor();

    await row(maya, 'Where should build 1482 go?').locator('.block-actions .block-btn.is-icon').click();
    await maya.locator('.popover .menu-item', { hasText: 'archive' }).click();
    // The element asked for confirmation first.
    await maya.locator('.modal', { hasText: 'This changes the message for everyone.' }).locator('.btn', { hasText: 'Go ahead' }).click();
    await row(maya, 'Deploy settings: archived').waitFor();
    assert.equal(await maya.locator('.message-scroll .msg', { hasText: 'Where should build 1482 go?' }).count(), 0);
  });

  await step('a global shortcut opens a modal: required fields, external options, a pushed view, the app’s errors, and a filed bug', async () => {
    await maya.locator('.conversation .composer-foot button[aria-label="Shortcuts"]').click();
    await maya.locator('.shortcuts-menu .menu-item', { hasText: 'File a bug' }).click();
    const modal = maya.locator('.app-modal');
    await modal.locator('.modal-head', { hasText: 'File a bug' }).waitFor();
    const block = (id) => modal.locator(`.block-input-block[data-block-id="${id}"]`);

    // Required inputs are checked before the app hears anything.
    await modal.locator('.modal-foot .btn', { hasText: 'File' }).click();
    await block('title').locator('.field-error', { hasText: 'Please fill out this field.' }).waitFor();
    await block('component').locator('.field-error').waitFor();

    await block('title').locator('input').fill('Slow');
    // Changing a field clears the error shown for it.
    await block('title').locator('.field-error').waitFor({ state: 'detached' });
    await block('severity').locator('select').selectOption('high');
    assert.equal(await block('due').locator('input').inputValue(), '2026-12-01');
    await block('due').locator('input').fill('2026-12-24');
    await block('flags').locator('.block-choice', { hasText: 'regression' }).locator('input').check();
    await block('owner').locator('.block-picker').click();
    await maya.locator('.block-picker-search').fill('Daniel');
    await maya.locator('.block-picker-item', { hasText: 'Daniel' }).click();
    await block('component').locator('.block-picker').click();
    await maya.locator('.block-picker-search').fill('se');
    await maya.locator('.block-picker-item', { hasText: 'sessions' }).waitFor();
    assert.deepEqual(await maya.locator('.block-picker-item').allInnerTexts(), ['search', 'sessions']);
    await maya.locator('.block-picker-item', { hasText: 'search' }).click();
    assert.equal(await modal.locator('.field-error').count(), 0);
    await shot(maya, 'platform-modal');

    // A button in the modal makes the app push a second view; submitting it goes back with the inputs intact.
    await modal.locator('.block-btn', { hasText: 'Add steps' }).click();
    await modal.locator('.modal-head', { hasText: 'Steps' }).waitFor();
    await modal.locator('textarea').fill('1. Search for anything\n2. Wait');
    await modal.locator('.modal-foot .btn', { hasText: 'Add' }).click();
    await modal.locator('.modal-head', { hasText: 'File a bug' }).waitFor();
    assert.equal(await block('title').locator('input').inputValue(), 'Slow');
    assert.equal(await block('due').locator('input').inputValue(), '2026-12-24');

    await modal.locator('.modal-foot .btn', { hasText: 'File' }).click();
    await block('title').locator('.field-error', { hasText: 'Use at least five characters' }).waitFor();
    await block('title').locator('input').fill('Search is slow');
    await modal.locator('.modal-foot .btn', { hasText: 'File' }).click();
    await modal.waitFor({ state: 'detached' });
    const filed = row(maya, 'Bug filed by');
    await filed.waitFor();
    assert.match(await filed.locator('.msg-body').innerText(), /Search is slow · high · fix by 2026-12-24 · search · flags: regression · owner @Daniel/);
  });

  await step('a message shortcut from the message menu, answered privately with respond()', async () => {
    const target = row(maya, 'Bug filed by');
    await target.hover();
    await target.locator('.msg-toolbar button[aria-label="More actions"]').click();
    await maya.locator('.popover .menu-item', { hasText: 'Turn into a bug' }).click();
    const note = maya.locator('.message-scroll .msg.is-ephemeral', { hasText: 'Filed from the message' });
    await note.waitFor();
    assert.match(await note.innerText(), /Bug filed by/);
  });

  await step('App Home: the app’s conversation opens on the Home tab it published; a button there republishes it', async () => {
    await maya.keyboard.press(`${modifier}+k`);
    await maya.locator('.switcher-input input').fill('Tracker');
    await maya.locator('.switcher-item.is-active', { hasText: 'Tracker' }).waitFor();
    await maya.keyboard.press('Enter');
    await maya.waitForSelector('.conv-name:text-is("Tracker")');
    await maya.locator('.app-tab', { hasText: 'Home' }).click();
    const home = maya.locator('.app-home');
    await home.locator('.blocks', { hasText: 'refreshed 0 times' }).waitFor();
    await home.locator('.block-btn', { hasText: 'Refresh' }).click();
    await home.locator('.blocks', { hasText: 'refreshed 1 times' }).waitFor();
    await shot(maya, 'platform-app-home');
    await maya.locator('.app-tab', { hasText: 'Messages' }).click();
    await maya.locator('.conversation .composer-input').waitFor();
  });

  await step('a link to the app’s domain is unfurled with its preview', async () => {
    await openChannel(maya, 'random');
    await composer(maya).fill('Is this the same as https://tracker.example/BUG-7 ?');
    await composer(maya).press('Enter');
    const message = row(maya, 'Is this the same as');
    try {
      await message.locator('.attachment', { hasText: 'BUG-7' }).waitFor({ timeout: 8000 });
    } catch (error) {
      const stored = await maya.evaluate(async (channel) => {
        const response = await fetch('/api/conversations.history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel, limit: 3 }) });
        return (await response.json()).messages.map((entry) => ({ text: entry.text, attachments: entry.attachments?.length ?? 0 }));
      }, random);
      console.log('DEBUG stored', JSON.stringify(stored));
      console.log('DEBUG frames\n' + frames.join('\n'));
      throw error;
    }
    assert.match(await message.locator('.attachment').innerText(), /Search is slow/);
    await shot(maya, 'platform-unfurl');
  });

  await step('apps screen: create an app from a Slack manifest, see its problems first, then export and apply it', async () => {
    await openAdmin(maya, 'Apps');
    const panel = maya.locator('.manifest-create');
    await panel.locator('summary').click();
    const spec = {
      display_information: { name: 'Standup' },
      features: { bot_user: { display_name: 'standup' }, slash_commands: [{ command: '/standup', description: 'Post your standup' }] },
      oauth_config: { scopes: { bot: ['chat:write', 'commands'] } },
      settings: { socket_mode_enabled: true, interactivity: { is_enabled: true } },
    };
    // A scope the server does not grant is pointed out before anything is created.
    await panel.locator('textarea').fill(JSON.stringify({ ...spec, oauth_config: { scopes: { bot: ['chat:write', 'calls:write'] } } }, null, 2));
    await panel.locator('.btn-primary').click();
    await panel.locator('.manifest-problems', { hasText: '/oauth_config/scopes/bot/1' }).waitFor();
    await panel.locator('textarea').fill(JSON.stringify(spec, null, 2));
    await panel.locator('.btn-primary').click();
    await maya.locator('.app-head h3', { hasText: 'Standup' }).waitFor();
    assert.match(await maya.locator('.copy-field', { hasText: 'Bot token' }).locator('input').inputValue(), /^xoxb-/);
    assert.match(await maya.locator('.copy-field', { hasText: 'App-level token' }).locator('input').inputValue(), /^xapp-/);

    const editor = maya.locator('.manifest-editor');
    await editor.locator('summary').click();
    const text = editor.locator('textarea');
    await text.waitFor();
    const exported = JSON.parse(await text.inputValue());
    assert.equal(exported.features.slash_commands[0].command, '/standup');
    exported.display_information.description = 'Daily check-in';
    await text.fill(JSON.stringify(exported, null, 2));
    await editor.locator('.btn', { hasText: 'Apply manifest' }).click();
    await maya.locator('.toast', { hasText: 'Manifest applied' }).waitFor();
    const saved = await maya.evaluate(async () => {
      const response = await fetch('/api/client.apps.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      return (await response.json()).apps.find((app) => app.name === 'Standup');
    });
    assert.equal(saved.description, 'Daily check-in');
    await shot(maya, 'platform-manifest');
    await maya.locator('.back-link').click();
    const config = maya.locator('.config-token');
    await config.locator('.btn').click();
    assert.match(await config.locator('.copy-field', { hasText: 'configuration token' }).locator('input').inputValue(), /^xoxe\.xoxp-1-/);
    await maya.keyboard.press('Escape');
  });

  await step('sign in with this workspace: a signed-out visitor signs in on the web and comes back to the consent page', async () => {
    const redirect = 'https://wiki.example.com/auth/callback';
    const app = await maya.evaluate(async (redirectUrl) => {
      const post = async (method, body) => (await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
      const created = await post('client.apps.create', { name: 'Team Wiki' });
      await post('client.apps.update', { app: created.app.id, redirect_urls: [redirectUrl] });
      return post('client.apps.info', { app: created.app.id });
    }, redirect);
    const stranger = await browser.newContext({ ...wide, colorScheme: 'light' });
    const page = watch(await stranger.newPage());
    const authorize = `${server.base}/openid/connect/authorize?${new URLSearchParams({ response_type: 'code', scope: 'openid profile email', client_id: app.client_id, redirect_uri: redirect, state: 'xyz' })}`;
    await page.goto(authorize);
    await page.waitForURL('**/signin**');
    await page.fill('input[type="email"]', 'daniel@example.com');
    await page.fill('input[type="password"]', 'demo-password');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/openid/connect/authorize**');
    await page.locator('h1', { hasText: 'Sign in to Team Wiki' }).waitFor();
    const back = page.waitForRequest((request) => request.url().startsWith(redirect));
    await page.locator('button', { hasText: 'Continue' }).click();
    const callback = new URL((await back).url());
    assert.equal(callback.searchParams.get('state'), 'xyz');
    assert.ok(callback.searchParams.get('code'));
    await stranger.close();
  });

  void eventsUrl;
}

await run(main);
