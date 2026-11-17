// Browser test for code channels (Slack's agents.conversations.*): an agent
// app, connected over Socket Mode the way Slack apps connect, makes a channel
// from the message that asked for the work, reports its session, fills the
// context bar, adds a view of each kind and offers a command. A person opens
// the channel, reads every tab, clicks an action item and a Block Kit button,
// runs the agent's command, and stops it. Then the same screen in the dark
// theme and at phone width, and axe on it.
//
//   pnpm --filter @app/web build && node e2e/code-channels.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { composer, openChannel, row, run, send, shot, shots, signIn, sideItem, startServer, step, watch, wide } from './lib.mjs';

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const DIFF = `diff --git a/src/login.test.ts b/src/login.test.ts
index 3b18e51..a9c2f04 100644
--- a/src/login.test.ts
+++ b/src/login.test.ts
@@ -1,5 +1,6 @@
 import { login } from './login';
-it('logs in', async () => {
+it('logs in', { retry: 0 }, async () => {
+  await clock.freeze();
   await login('maya');
 });
 export {};
`;

const HTML = `<!doctype html><html lang="en"><head><title>Coverage</title>
<style>body{font:15px system-ui;margin:24px;color:#1a2326} h1{margin:0 0 8px} .bar{height:12px;background:#e2e7e8;border-radius:6px} .bar i{display:block;height:12px;width:91%;background:#2b8a3e;border-radius:6px}</style>
</head><body><h1>Coverage 91%</h1><div class="bar"><i></i></div><p id="js">scripts did not run</p>
<script>document.getElementById('js').textContent = 'Lines 1,204 of 1,322 · cookies seen: ' + (() => { try { return String(document.cookie.length); } catch { return 'none'; } })();</script>
</body></html>`;

/** An agent connected over Socket Mode: it acknowledges every envelope and answers a slash command. */
async function connectAgent(base, appToken) {
  const opened = await fetch(`${base}/api/apps.connections.open`, { method: 'POST', headers: { authorization: `Bearer ${appToken}` } }).then((response) => response.json());
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const envelopes = [];
  const waiters = [];
  const socket = new WebSocket(opened.url);
  socket.addEventListener('message', (message) => {
    const envelope = JSON.parse(String(message.data));
    envelopes.push(envelope);
    if (envelope.envelope_id) {
      const payload = envelope.type === 'slash_commands' ? { response_type: 'ephemeral', text: `Opening a pull request: ${envelope.payload.text}` } : undefined;
      socket.send(JSON.stringify(payload ? { envelope_id: envelope.envelope_id, payload } : { envelope_id: envelope.envelope_id }));
    }
    for (const waiter of [...waiters]) {
      if (waiter.match(envelope)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(envelope);
      }
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return {
    next(match, timeoutMs = 5000) {
      const seen = envelopes.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the agent heard nothing')), timeoutMs);
        waiters.push({ match, resolve: (envelope) => (clearTimeout(timer), resolve(envelope)) });
      });
    },
    close: () => socket.close(),
  };
}

async function api(page, method, args = {}) {
  return page.evaluate(
    async ([name, body]) => {
      const response = await fetch(`/api/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return response.json();
    },
    [method, args],
  );
}

/** Run axe on the page; serious and critical findings fail. */
async function audit(page, name) {
  await page.waitForTimeout(200);
  const violations = await page.evaluate(async (source) => {
    if (!window.axe) (0, eval)(source);
    const report = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
    });
    return report.violations.map((violation) => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.map((node) => node.target.join(' ')).slice(0, 4) }));
  }, AXE);
  const bad = violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  for (const violation of violations) console.log(`        axe ${name}: [${violation.impact}] ${violation.id} ${violation.nodes.join(', ')}`);
  assert.deepEqual(bad, [], `${name}: no serious or critical accessibility findings`);
}

async function main(browser) {
  const server = await startServer({ seed: true });
  const context = await browser.newContext({ ...wide, colorScheme: 'light' });
  const maya = watch(await context.newPage());
  await signIn(maya, server.base, 'maya@example.com');

  let agent;
  let botToken = '';
  let channel = '';
  const bot = async (method, args = {}) => {
    const result = await fetch(`${server.base}/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    }).then((response) => response.json());
    assert.equal(result.ok, true, `${method}: ${JSON.stringify(result)}`);
    return result;
  };

  try {
    await step('an agent makes a code channel from the message that asked for the work', async () => {
      const created = await api(maya, 'client.apps.create', { name: 'Coder', description: 'Fixes flaky tests' });
      assert.equal(created.ok, true);
      botToken = created.bot_token;
      agent = await connectAgent(server.base, created.app_token);
      const random = (await api(maya, 'conversations.info', { channel: '#random' })).channel.id;
      await api(maya, 'conversations.invite', { channel: random, users: created.app.bot_user_id });

      await openChannel(maya, 'random');
      await send(maya, 'Fix the flaky login test. It fails on CI about once a day.');
      const ask = row(maya, 'Fix the flaky login test');
      await ask.waitFor();
      const history = await api(maya, 'conversations.history', { channel: random, limit: 1 });
      const originTs = history.messages[0].ts;

      channel = (await bot('agents.conversations.create', { origin_channel_id: random, origin_message_ts: originTs, session_id: 'e2e-1' })).channel_id;
      await bot('agents.sessions.setStatus', { channel_id: channel, status: 'processing' });
      await bot('agents.conversations.setProperties', {
        channel_id: channel,
        code_channel: {
          context_bar_items: [
            { key: 'branch', label: 'fix/login-flake', icon: 'branch' },
            { key: 'pr', label: 'PR #42', icon: 'link', url: 'https://git.example.com/acme/app/pull/42' },
            { key: 'rerun', label: 'Re-run CI', icon: 'terminal', item_type: 'action' },
          ],
        },
      });
      await bot('agents.conversations.setView', { channel_id: channel, view_key: 'reports/coverage.html', content: HTML, name: 'Coverage' });
      await bot('agents.conversations.setView', { channel_id: channel, type: 'diff', content: DIFF, base_branch: 'main', head_branch: 'fix/login-flake' });
      await bot('agents.conversations.setView', {
        channel_id: channel,
        type: 'block_kit',
        view_key: 'controls',
        name: 'Controls',
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: 'Deploy the fix' } },
          { type: 'section', text: { type: 'mrkdwn', text: 'Tests pass *50 of 50* runs. Ship to staging?' } },
          { type: 'actions', block_id: 'deploy', elements: [{ type: 'button', action_id: 'ship', style: 'primary', text: { type: 'plain_text', text: 'Ship to staging' }, value: 'staging' }] },
        ],
      });
      const plan = await bot('canvases.create', {
        title: 'Fix plan',
        document_content: { type: 'markdown', markdown: '# Fix plan\n\n1. Freeze the clock in the login test\n2. Run it 50 times\n\nThe flake comes from a timer racing the redirect.' },
      });
      await bot('agents.conversations.setView', { channel_id: channel, type: 'canvas', view_key: 'plan', canvas_id: plan.canvas_id, access_level: 'comment', name: 'Plan' });
      await bot('agents.conversations.setCommands', { channel_id: channel, commands: [{ name: 'create-pr', description: 'Open a pull request with the fix', argument_hint: '[title]' }] });

      // The card in the thread the work started from, and the channel in Maya's sidebar.
      await ask.getByText('1 reply').waitFor();
      await sideItem(maya, 'fix-the-flaky-login-test').waitFor();
    });

    await step('the channel shows its session, the context bar and a tab per view', async () => {
      await sideItem(maya, 'fix-the-flaky-login-test').click();
      await maya.waitForSelector('.conv-name:text-is("fix-the-flaky-login-test")');
      const bar = maya.locator('.code-bar [data-agent-session]');
      await bar.locator('.agent-session-title', { hasText: 'Fix the flaky login test' }).waitFor();
      await bar.locator('.agent-session-meta', { hasText: 'Working… · Coder' }).waitFor();
      const context = maya.getByRole('group', { name: 'About this work' });
      await context.locator('[data-context-item="branch"]', { hasText: 'fix/login-flake' }).waitFor();
      const link = context.getByRole('link', { name: 'PR #42 (opens in a new tab)' });
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.match(await link.getAttribute('rel'), /noopener/);
      const tabs = maya.getByRole('tablist', { name: 'Messages, views, canvases and lists' });
      assert.deepEqual(await tabs.getByRole('tab').allInnerTexts(), ['Messages', 'Coverage', 'Diff', 'Controls', 'Plan']);
      await maya.locator('.message-content .msg').first().waitFor();
      await shot(maya, 'code-channel');
      await audit(maya, 'code channel');
    });

    await step('the HTML view runs in a sandboxed frame that cannot reach the page', async () => {
      await maya.getByRole('tab', { name: 'Coverage' }).click();
      const frame = maya.locator('iframe.code-frame');
      await frame.waitFor();
      assert.equal(await frame.getAttribute('title'), 'View from the agent: Coverage');
      const sandbox = await frame.getAttribute('sandbox');
      assert.match(sandbox, /allow-scripts/);
      assert.doesNotMatch(sandbox, /allow-same-origin/);
      const inside = maya.frameLocator('iframe.code-frame');
      await inside.locator('h1', { hasText: 'Coverage 91%' }).waitFor();
      // The script ran, and the frame's own origin is opaque: reading cookies throws.
      await inside.locator('#js', { hasText: 'Lines 1,204 of 1,322 · cookies seen: none' }).waitFor();
      await shot(maya, 'code-channel-html');
    });

    await step('the diff view: files, added and removed lines, the branches', async () => {
      await maya.getByRole('tab', { name: 'Diff' }).click();
      const diff = maya.locator('.code-diff');
      await diff.locator('.code-diff-branches', { hasText: 'main' }).waitFor();
      await diff.getByRole('region', { name: 'src/login.test.ts' }).waitFor();
      assert.equal(await diff.locator('[data-diff-line="add"]').count(), 2);
      assert.equal(await diff.locator('[data-diff-line="del"]').count(), 1);
      await diff.getByText('1 file changed').waitFor();
      await shot(maya, 'code-channel-diff');
    });

    await step('the Block Kit view: a button click reaches the agent as block_actions', async () => {
      await maya.getByRole('tab', { name: 'Controls' }).click();
      const clicked = agent.next((envelope) => envelope.type === 'interactive' && envelope.payload?.type === 'block_actions');
      await maya.locator('.code-blocks').getByRole('button', { name: 'Ship to staging' }).click();
      const payload = (await clicked).payload;
      assert.deepEqual([payload.container.type, payload.container.channel_id, payload.actions[0].action_id, payload.actions[0].value], ['view', channel, 'ship', 'staging']);
      await shot(maya, 'code-channel-blocks');
    });

    await step('the canvas view: people read and comment, only the agent writes', async () => {
      await maya.getByRole('tab', { name: 'Plan' }).click();
      const page = maya.locator('.code-view .doc-page');
      await page.locator('.canvas-content', { hasText: 'The flake comes from a timer' }).waitFor();
      await page.locator('.tag', { hasText: 'View only' }).first().waitFor();
      await page.getByRole('button', { name: 'Add a comment' }).waitFor();
      assert.equal(await page.locator('.canvas-content').getAttribute('contenteditable'), 'false', 'only the agent writes');
      await shot(maya, 'code-channel-canvas');
    });

    await step('an action item and the agent’s command, then Stop', async () => {
      await maya.getByRole('tab', { name: 'Messages' }).click();
      const acted = agent.next((envelope) => envelope.type === 'events_api' && envelope.payload?.event?.type === 'code_channel_action');
      await maya.getByRole('button', { name: 'Re-run CI' }).click();
      await maya.locator('.toast', { hasText: 'Sent to the agent.' }).waitFor();
      const action = (await acted).payload.event;
      assert.deepEqual([action.key, action.channel], ['rerun', channel]);

      await maya.locator('.toast').first().waitFor({ state: 'detached', timeout: 8000 });
      await composer(maya).fill('/create');
      const suggestion = maya.locator('.suggest [role="option"]', { hasText: '/create-pr [title]' });
      await suggestion.waitFor();
      await suggestion.getByText('Open a pull request with the fix').waitFor();
      await maya.waitForTimeout(300);
      assert.ok(await suggestion.isVisible(), 'the suggestion stays open');
      await maya.screenshot({ path: `${shots}/code-channel-command.png` });
      await composer(maya).fill('/create-pr Stabilise the login test');
      const ran = agent.next((envelope) => envelope.type === 'slash_commands');
      await composer(maya).press('Enter');
      const command = (await ran).payload;
      assert.deepEqual([command.command, command.text, command.channel_id], ['/create-pr', 'Stabilise the login test', channel]);
      await row(maya, 'Opening a pull request: Stabilise the login test').waitFor();

      const stopped = agent.next((envelope) => envelope.type === 'events_api' && envelope.payload?.event?.type === 'agent_session_stopped');
      await maya.locator('.code-bar [data-agent-stop]').click();
      await maya.locator('.toast', { hasText: 'Asked the agent to stop.' }).waitFor();
      const stop = (await stopped).payload.event;
      assert.equal(stop.channel, channel);
      assert.equal('thread_ts' in stop, false, 'the whole channel stops');
      await bot('agents.sessions.setStatus', { channel_id: channel, status: 'suspended' });
      await maya.locator('.code-bar .agent-session-meta', { hasText: 'Waiting for you' }).waitFor();
      assert.equal(await maya.locator('.code-bar [data-agent-stop]').count(), 0);
    });

    await step('dark theme and phone width', async () => {
      const layouts = [
        { name: 'dark', options: { ...wide, colorScheme: 'dark' } },
        { name: 'phone', options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light' } },
        { name: 'phone-dark', options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark' } },
      ];
      for (const layout of layouts) {
        const other = await browser.newContext(layout.options);
        const page = watch(await other.newPage());
        await signIn(page, server.base, 'maya@example.com');
        await page.goto(`${server.base}/c/${channel}`);
        await page.locator('.code-bar .agent-session-title').waitFor();
        await page.locator('.message-content .msg').first().waitFor();
        const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
        assert.ok(await fits(), `${layout.name}: no sideways scroll`);
        await shot(page, `code-channel-${layout.name}`);
        await page.getByRole('tab', { name: 'Diff' }).click();
        await page.locator('.code-diff-file').first().waitFor();
        assert.ok(await fits(), `${layout.name}: the diff scrolls inside itself`);
        await shot(page, `code-channel-${layout.name}-diff`);
        await page.getByRole('tab', { name: 'Coverage' }).click();
        await page.frameLocator('iframe.code-frame').locator('h1').waitFor();
        await shot(page, `code-channel-${layout.name}-html`);
        if (layout.name === 'dark') await audit(page, 'code channel, dark');
        await other.close();
      }
    });
  } finally {
    agent?.close();
  }
}

await run(main);
