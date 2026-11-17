// Browser test for the AI features, against a stand-in Claude Messages API
// (no credentials, no cost): connect a model, summarise a thread, answer a
// search question with citations, translate a message, rewrite a draft,
// set up a daily recap, talk to the assistant and keep a memory, and open the
// Agents view.
//
//   pnpm --filter @app/web build && node e2e/ai.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { composer, composerText, openChannel, row, run, send, shot, signIn, sideItem, startServer, step, watch, wide } from './lib.mjs';

/** The stand-in: answers by what the request is for, streaming like the real API. */
async function fakeClaude() {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      requests.push({ headers: req.headers, body });
      const system = String(body.system ?? '');
      const prompt = String(body.messages?.[0]?.content ?? '');
      let text;
      if (system.includes('You translate')) text = 'Le gel du code est prévu pour mercredi à 18 h UTC.';
      else if (system.includes('help someone edit')) text = 'Could you please review the release notes by Friday?';
      else if (system.includes('connection works')) text = 'ready';
      else if (system.includes('daily recap')) text = '### #general\n- Release 2.4 ships Thursday [1].';
      else if (system.includes('answer a question')) text = 'The code freeze is Wednesday at 18:00 UTC [1].';
      else if (system.includes('built-in assistant')) text = 'The code freeze is Wednesday at 18:00 UTC [1].\n<remember>Maya runs the release.</remember>';
      else {
        const cited = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) => `[${match[1]}]`).slice(0, 2);
        text = `**Where it stands**\n\n- Atlas found the rounding bug and has a fix ready ${cited.join('')}\n- Daniel agreed half-even is right for tax ${cited[1] ?? ''}`;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('message_start', {
        message: { id: 'msg_fake', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } },
      });
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      const pieces = text.match(/\S+\s*|\s+/g) ?? [text];
      let index = 0;
      const tick = () => {
        if (index < pieces.length) {
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: pieces[index] } });
          index += 1;
          setTimeout(tick, 15);
          return;
        }
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
        send('message_stop', {});
        res.end();
      };
      tick();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
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

async function teamMenu(page, label) {
  await page.locator('.team-btn').click();
  await page.locator('.menu-item', { hasText: label }).click();
}

async function main(browser) {
  const claude = await fakeClaude();
  const server = await startServer({ seed: true });
  const context = await browser.newContext({ ...wide, colorScheme: 'light', locale: 'fr-FR' });
  const maya = watch(await context.newPage());
  await signIn(maya, server.base, 'maya@example.com');

  try {
    await step('off by default: no AI controls until an admin connects a model', async () => {
      await openChannel(maya, 'engineering');
      assert.equal(await maya.locator('.conv-head .ai-btn').count(), 0);
      assert.equal(claude.requests.length, 0);
    });

    await step('AI settings: an admin connects Claude and tests the connection; the key is not shown again', async () => {
      await teamMenu(maya, 'AI settings');
      const dialog = maya.locator('.modal.ai-settings');
      await dialog.waitFor();
      await dialog.locator('input[type="url"]').fill(claude.url);
      await dialog.locator('input[type="password"]').fill('sk-ant-browser-test-9876');
      await dialog.getByRole('button', { name: 'Connect' }).click();
      await dialog.locator('.field-hint', { hasText: 'Saved key sk-a…9876' }).waitFor();
      assert.equal(await dialog.locator('input[type="password"]').inputValue(), '');
      await dialog.getByRole('button', { name: 'Test connection' }).click();
      await dialog.locator('.ai-ok', { hasText: 'The model replied “ready”' }).waitFor();
      const sent = claude.requests.at(-1);
      assert.equal(sent.body.model, 'claude-opus-5-5');
      assert.equal(sent.body.fallbacks, 'default');
      assert.equal(sent.headers['x-api-key'], 'sk-ant-browser-test-9876');
      assert.equal(sent.headers.authorization, undefined);
      await shot(maya, 'ai-settings');
      await maya.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
    });

    await step('a thread summary streams into a private sheet with sources that lead back', async () => {
      await row(maya, 'the checkout test started failing').locator('.thread-summary').click();
      await maya.locator('.panel .ai-chip', { hasText: 'Summarize thread' }).click();
      const sheet = maya.locator('.ai-sheet');
      await sheet.locator('.ai-private', { hasText: 'Only visible to you' }).waitFor();
      await sheet.locator('.ai-text', { hasText: 'Atlas found the rounding bug' }).waitFor();
      await sheet.locator('.ai-citations li').first().waitFor();
      assert.ok((await sheet.locator('.ai-citations li').count()) >= 2);
      assert.match(await sheet.locator('.ai-note').innerText(), /Based on \d+ messages/);
      // The citation numbers in the text are links into the conversation.
      assert.match(await sheet.locator('.ai-text a').first().getAttribute('href'), /^\/archives\/C[A-Z0-9]+\/p\d{16}/);
      await shot(maya, 'ai-thread-summary');
      await sheet.getByRole('button', { name: 'Close' }).click();
      await sheet.waitFor({ state: 'detached' });
    });

    await step('a channel summary from the header covers today', async () => {
      await maya.locator('.conv-head .ai-btn').click();
      await maya.locator('.menu-item', { hasText: 'Summarize today' }).click();
      const sheet = maya.locator('.ai-sheet');
      await sheet.locator('strong', { hasText: 'Today in #engineering' }).waitFor();
      await sheet.locator('.ai-text', { hasText: 'Where it stands' }).waitFor();
      await sheet.getByRole('button', { name: 'Close' }).click();
    });

    await step('a search question is answered from the results, with numbered sources', async () => {
      await maya.goto(`${server.base}/search?q=freeze`);
      await maya.locator('.search-view').waitFor();
      await maya.getByRole('button', { name: 'Answer with AI' }).click();
      const answer = maya.locator('.ai-answer');
      await answer.locator('.ai-text', { hasText: 'The code freeze is Wednesday at 18:00 UTC' }).waitFor();
      await answer.locator('.ai-citations li').first().waitFor();
      assert.match(await answer.locator('.ai-citations li').first().innerText(), /freeze/i);
      await shot(maya, 'ai-search-answer');
      // A source opens the message in its conversation.
      await answer.locator('.ai-citations a').first().click();
      await maya.waitForURL(/\/c\/C[A-Z0-9]+/);
    });

    await step('translate a message in place, into the browser’s language', async () => {
      await openChannel(maya, 'general');
      const message = row(maya, '2.4 ships Thursday');
      await message.hover();
      await message.getByRole('button', { name: 'More actions' }).click();
      await maya.locator('.menu-item', { hasText: 'Translate' }).click();
      const translation = message.locator('.ai-translation');
      await translation.locator('.ai-translation-text', { hasText: 'Le gel du code' }).waitFor();
      assert.match(JSON.stringify(claude.requests.at(-1).body.messages), /fr-FR/);
      await translation.getByRole('button', { name: 'Show original' }).click();
      await translation.waitFor({ state: 'detached' });
    });

    await step('help me write: rewrite a draft without sending it, then undo', async () => {
      const draft = 'can u look at release notes by fri';
      await composer(maya).fill(draft);
      const before = await maya.locator('.message-scroll .msg').count();
      await maya.locator('.conversation .composer-tools .ai-btn').click();
      await maya.locator('.menu-item', { hasText: 'Make more formal' }).click();
      await maya.waitForFunction(() => document.querySelector('.conversation .composer-input')?.textContent === 'Could you please review the release notes by Friday?');
      assert.equal(await maya.locator('.message-scroll .msg').count(), before);
      await maya.locator('.conversation .composer-tools .ai-btn').click();
      await maya.locator('.menu-item', { hasText: 'Undo AI edit' }).click();
      assert.equal(await composerText(composer(maya)), draft);
      await composer(maya).fill('');
    });

    await step('daily recap: choose channels and a time, then get one now as a direct message', async () => {
      await teamMenu(maya, 'Daily recap');
      const dialog = maya.locator('.modal.ai-recap');
      await dialog.locator('.check-row', { hasText: '#general' }).locator('input').check();
      await dialog.locator('input[type="time"]').fill('08:15');
      await dialog.getByRole('button', { name: 'Save recap' }).click();
      await dialog.locator('.field-hint', { hasText: 'Next recap:' }).waitFor();
      await dialog.getByRole('button', { name: 'Send one now' }).click();
      await maya.locator('.toast', { hasText: 'Recap sent' }).waitFor();
      await maya.keyboard.press('Escape');
      await sideItem(maya, 'Recaps').click();
      await row(maya, 'Release 2.4 ships Thursday').waitFor();
      assert.match(await row(maya, 'Release 2.4 ships Thursday').locator('a').first().getAttribute('href'), /\/archives\//);
      await shot(maya, 'ai-recap-dm');
    });

    await step('assistant: ask in its direct message, keep what it proposes only by choice, forget it in Preferences', async () => {
      await maya.locator('.side-nav[data-view="assistant"]').click();
      await maya.locator('.conv-head', { hasText: 'Assistant' }).waitFor();
      await send(maya, 'When is the code freeze? I run the release.');
      const answer = row(maya, 'The code freeze is Wednesday at 18:00 UTC');
      await answer.waitFor();
      assert.equal(await answer.getByText('<remember>').count(), 0);
      assert.match(await answer.locator('a').first().getAttribute('href'), /\/archives\//);
      await answer.getByText('Remember this? Maya runs the release.').waitFor();
      await shot(maya, 'ai-assistant');
      await answer.getByRole('button', { name: 'Remember', exact: true }).click();
      await answer.getByText('Remembered: Maya runs the release.').waitFor();
      await maya.locator('.me-strip').click();
      await maya.locator('.menu-item', { hasText: 'Preferences' }).click();
      const memory = maya.locator('.assistant-memory');
      await memory.locator('li', { hasText: 'Maya runs the release.' }).waitFor();
      await memory.locator('input').fill('I prefer short answers');
      await memory.getByRole('button', { name: 'Add' }).click();
      await memory.locator('li', { hasText: 'I prefer short answers' }).waitFor();
      await memory.locator('li', { hasText: 'Maya runs the release.' }).getByRole('button').click();
      await memory.locator('li', { hasText: 'Maya runs the release.' }).waitFor({ state: 'detached' });
      await shot(maya, 'ai-assistant-memory');
      await maya.keyboard.press('Escape');
    });

    await step('agents view: an app working in a thread shows its status and the thread', async () => {
      const created = await api(maya, 'client.apps.create', { name: 'Triage Agent', description: 'Sorts incoming issues' });
      assert.equal(created.ok, true);
      const general = (await api(maya, 'conversations.info', { channel: '#general' })).channel.id;
      await api(maya, 'conversations.invite', { channel: general, users: created.app.bot_user_id });
      const parent = (await api(maya, 'chat.postMessage', { channel: general, text: 'Can someone triage the checkout bug reports?' })).ts;
      const status = await fetch(`${server.base}/api/assistant.threads.setStatus`, {
        method: 'POST',
        headers: { authorization: `Bearer ${created.bot_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ channel_id: general, thread_ts: parent, status: 'is sorting 14 reports…' }),
      }).then((response) => response.json());
      assert.equal(status.ok, true);
      await teamMenu(maya, 'Agents');
      await maya.waitForURL(/\/agents$/);
      const card = maya.locator('.agent-card', { hasText: 'Triage Agent' });
      await card.locator('.agent-state', { hasText: 'Working' }).waitFor();
      await card.locator('.agent-activity', { hasText: 'is sorting 14 reports' }).waitFor();
      await shot(maya, 'ai-agents');
      await card.locator('.agent-threads button', { hasText: 'triage the checkout bug' }).click();
      await maya.locator('.panel .msg', { hasText: 'triage the checkout bug' }).first().waitFor();
    });

    await step('dark theme and phone width: the sheet, the answer box, the dialog and the Agents view fit', async () => {
      const ids = {
        engineering: (await api(maya, 'conversations.info', { channel: '#engineering' })).channel.id,
      };
      const layouts = [
        { name: 'dark', options: { ...wide, colorScheme: 'dark' } },
        { name: 'phone', options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light' } },
      ];
      for (const layout of layouts) {
        const context = await browser.newContext(layout.options);
        const page = watch(await context.newPage());
        await signIn(page, server.base, 'maya@example.com');
        await page.goto(`${server.base}/c/${ids.engineering}`);
        await page.locator('.conv-head .ai-btn').click();
        await page.locator('.menu-item', { hasText: 'Summarize today' }).click();
        const sheet = page.locator('.ai-sheet');
        await sheet.locator('.ai-citations li').first().waitFor();
        const box = await sheet.boundingBox();
        const viewport = page.viewportSize();
        assert.ok(box.x >= 0 && box.x + box.width <= viewport.width, `${layout.name}: the sheet fits the width`);
        assert.ok(box.y >= 0 && box.y + box.height <= viewport.height, `${layout.name}: the sheet fits the height`);
        await shot(page, `ai-${layout.name}-summary`);
        await sheet.getByRole('button', { name: 'Close' }).click();

        await page.goto(`${server.base}/search?q=freeze`);
        await page.getByRole('button', { name: 'Answer with AI' }).click();
        await page.locator('.ai-answer .ai-citations li').first().waitFor();
        await shot(page, `ai-${layout.name}-answer`);

        await page.goto(`${server.base}/agents`);
        await page.locator('.agent-card', { hasText: 'Triage Agent' }).waitFor();
        await shot(page, `ai-${layout.name}-agents`);
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
          `${layout.name}: no sideways scroll on the Agents view`,
        );

        await page.goto(`${server.base}/c/${ids.engineering}`);
        await page.locator('.conv-head').waitFor();
        if (layout.name === 'phone') {
          await page.locator('.conv-head .only-narrow').click();
        }
        await page.locator('.team-btn').click();
        await page.locator('.menu-item', { hasText: 'AI settings' }).click();
        const dialog = page.locator('.modal.ai-settings');
        await dialog.locator('.check-row').first().waitFor();
        const dialogBox = await dialog.boundingBox();
        assert.ok(dialogBox.x >= 0 && dialogBox.x + dialogBox.width <= viewport.width, `${layout.name}: the dialog fits the width`);
        await shot(page, `ai-${layout.name}-settings`);
        await context.close();
      }
    });

    await step('turning AI off removes the controls again', async () => {
      await teamMenu(maya, 'AI settings');
      const dialog = maya.locator('.modal.ai-settings');
      await dialog.getByRole('button', { name: 'Turn AI off' }).click();
      await dialog.getByRole('button', { name: 'Connect' }).waitFor();
      await maya.keyboard.press('Escape');
      await openChannel(maya, 'engineering');
      await maya.locator('.conv-head .ai-btn').waitFor({ state: 'detached' });
    });
  } finally {
    claude.close();
  }
}

await run(main);
