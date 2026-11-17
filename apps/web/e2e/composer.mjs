// The composer edits what you see, as Slack's does: markup typed as you go
// becomes formatting, shortcuts and the toolbar format the selection, mentions
// and emoji are chips, pasted rich text keeps what a message can hold, and a
// message is sent as mrkdwn `text` plus a `rich_text` block, which is what the
// other person sees and what apps read. Drafts and editing keep the formatting.
// "Format messages with markup" in Preferences brings back the plain-text composer.
//
//   pnpm --filter @app/web build && node apps/web/e2e/composer.mjs
import assert from 'node:assert/strict';
import { browserName, composer, composerText, modifier, openChannel, row, run, shot, signIn, skip, startServer, step, watch, wide } from './lib.mjs';

/** The newest message in a conversation, as the API (and so every app) has it. */
function latest(page, channel) {
  return page.evaluate(async (id) => {
    const response = await fetch('/api/conversations.history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: id, limit: 1 }) });
    return (await response.json()).messages[0];
  }, channel);
}

/** Paste through a synthetic clipboard event, as the browser delivers one. */
function paste(page, data) {
  return page.evaluate((items) => {
    const target = document.querySelector('.conversation .composer-input');
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(items)) transfer.setData(type, value);
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, data);
}

/** Select the last characters typed, and let the browser report the selection (ProseMirror reads it from `selectionchange`). */
async function select(page, characters) {
  for (let index = 0; index < characters; index += 1) await page.keyboard.press('Shift+ArrowLeft');
  await page.waitForFunction((count) => String(window.getSelection()).length === count, characters);
  await page.evaluate(() => new Promise((done) => setTimeout(done, 0)));
}

await run(async (browser) => {
  const server = await startServer({ seed: true });
  const maya = watch(await (await browser.newContext({ ...wide, colorScheme: 'light' })).newPage());
  const daniel = watch(await (await browser.newContext({ ...wide, colorScheme: 'light' })).newPage());
  await signIn(maya, server.base, 'maya@example.com');
  await signIn(daniel, server.base, 'daniel@example.com');
  await openChannel(maya, 'random');
  await openChannel(daniel, 'random');
  const channel = await maya.evaluate(() => location.pathname.split('/').pop());
  const input = composer(maya);
  const tool = (label) => maya.locator(`.conversation .composer-tools button[aria-label="${label}"]`);

  await step('the composer is a labelled, multi-line text box under a labelled toolbar', async () => {
    assert.equal(await input.getAttribute('role'), 'textbox');
    assert.equal(await input.getAttribute('aria-multiline'), 'true');
    assert.equal(await input.getAttribute('aria-label'), 'Message #random');
    assert.equal(await input.getAttribute('contenteditable'), 'true');
    assert.equal(await maya.locator('.conversation .composer-tools').getAttribute('aria-label'), 'Formatting');
    assert.equal(await tool('Bold').getAttribute('aria-pressed'), 'false');
  });

  await step('markup typed as you go becomes formatting; Shift+Enter makes lines, items and blocks', async () => {
    await input.pressSequentially('Plan: *ship* _soon_ ~later~ `npm test`');
    for (const [tag, text] of [['strong', 'ship'], ['em', 'soon'], ['s', 'later'], ['code', 'npm test']]) {
      assert.equal(await input.locator(tag, { hasText: text }).count(), 1, `${text} is ${tag}`);
    }
    assert.equal(await composerText(input), 'Plan: ship soon later npm test', 'the markers are gone');
    await input.press('Shift+Enter');
    await input.pressSequentially('- first');
    await input.press('Shift+Enter');
    await input.pressSequentially('second');
    // An empty item, then out of the list, as in Slack.
    await input.press('Shift+Enter');
    await input.press('Shift+Enter');
    await input.pressSequentially('1. one');
    await input.press('Shift+Enter');
    await input.press('Shift+Enter');
    await input.pressSequentially('> quoted');
    await input.press('Shift+Enter');
    await input.press('Shift+Enter');
    await input.pressSequentially('```');
    await input.pressSequentially('const x = 1;');
    assert.equal(await input.locator('ul > li').count(), 2);
    assert.equal(await input.locator('ol > li').count(), 1);
    assert.equal(await input.locator('blockquote', { hasText: 'quoted' }).count(), 1);
    assert.equal(await input.locator('pre', { hasText: 'const x = 1;' }).count(), 1);
    await shot(maya, 'composer-rich-light');

    await input.press('Enter');
    const message = row(daniel, 'Plan:');
    await message.locator('strong', { hasText: 'ship' }).waitFor();
    assert.equal(await message.locator('em', { hasText: 'soon' }).count(), 1);
    assert.equal(await message.locator('ul li').count(), 2);
    assert.equal(await message.locator('ol li').count(), 1);
    assert.equal(await message.locator('blockquote', { hasText: 'quoted' }).count(), 1);
    assert.equal(await message.locator('pre.code-block', { hasText: 'const x = 1;' }).count(), 1);
    assert.equal(await composerText(input), '', 'sent and cleared');

    const sent = await latest(maya, channel);
    assert.equal(sent.text, 'Plan: *ship* _soon_ ~later~ `npm test`\n• first\n• second\n1. one\n&gt; quoted\n```\nconst x = 1;\n```');
    assert.deepEqual(
      sent.blocks[0].elements.map((element) => element.type),
      ['rich_text_section', 'rich_text_list', 'rich_text_list', 'rich_text_quote', 'rich_text_preformatted'],
    );
    assert.deepEqual(sent.blocks[0].elements[0].elements[1], { type: 'text', text: 'ship', style: { bold: true } });
    assert.equal(sent.blocks[0].elements[2].style, 'ordered');
  });

  await step('shortcuts and the toolbar format the selection, and the toolbar shows what is on', async () => {
    await input.pressSequentially('make this loud');
    await select(maya, 4);
    await input.press(`${modifier}+b`);
    await input.locator('strong', { hasText: 'loud' }).waitFor();
    assert.equal(await tool('Bold').getAttribute('aria-pressed'), 'true');
    await input.press(`${modifier}+i`);
    await input.locator('em', { hasText: 'loud' }).waitFor();
    await input.press(`${modifier}+Shift+x`);
    await input.locator('s', { hasText: 'loud' }).waitFor();
    assert.equal(await tool('Strikethrough').getAttribute('aria-pressed'), 'true');
    await tool('Bulleted list').click();
    await input.locator('ul li', { hasText: 'make this loud' }).waitFor();
    assert.equal(await tool('Bulleted list').getAttribute('aria-pressed'), 'true');
    await tool('Bulleted list').click();
    assert.equal(await input.locator('ul').count(), 0);
    await tool('Quote').click();
    await input.locator('blockquote').waitFor();
    await tool('Quote').click();
    await input.fill('');
  });

  await step('mentions and emoji are chips; a known :shortcode: typed in full becomes its emoji', async () => {
    await input.pressSequentially('@Dan');
    await maya.locator('.suggest-item', { hasText: 'Daniel' }).first().waitFor();
    assert.equal(await input.getAttribute('aria-controls'), await maya.locator('.conversation .suggest').getAttribute('id'));
    // Escape closes the list and nothing else; Enter then sends nothing picked from it.
    await input.press('Escape');
    await maya.locator('.conversation .suggest').waitFor({ state: 'detached' });
    assert.equal(await composerText(input), '@Dan');
    await input.pressSequentially('i');
    await maya.locator('.suggest-item', { hasText: 'Daniel' }).first().waitFor();
    await input.press('Enter');
    await input.pressSequentially('look :tada: #engi');
    await maya.locator('.suggest-item', { hasText: 'engineering' }).waitFor();
    await input.press('Tab');
    assert.equal(await input.locator('.mention', { hasText: '@Daniel' }).count(), 1);
    assert.equal(await input.locator('.mention', { hasText: '#engineering' }).count(), 1);
    assert.equal(await input.locator('.emoji[data-emoji="tada"]').count(), 1);
    // A chip goes with one Backspace, as a whole.
    await input.press('Backspace');
    await input.press('Backspace');
    assert.equal(await input.locator('.mention', { hasText: '#engineering' }).count(), 0);
    await input.press('Enter');
    await row(daniel, 'look').locator('.mention.is-me', { hasText: '@Daniel' }).waitFor();
    assert.equal(await row(daniel, 'look').locator('.msg-body .emoji').innerText(), '🎉');
    const sent = await latest(maya, channel);
    assert.match(sent.text, /^<@U[A-Z0-9]+> look :tada:$/);
    assert.deepEqual(
      sent.blocks[0].elements[0].elements.map((element) => element.type),
      ['user', 'text', 'emoji'],
    );
  });

  await step('a link from the toolbar, sent as a link', async () => {
    await input.pressSequentially('see docs');
    await select(maya, 4);
    await tool('Link').click();
    await maya.locator('.modal input').fill('example.com/docs');
    await maya.locator('.modal input').press('Enter');
    await input.locator('a[href="https://example.com/docs"]', { hasText: 'docs' }).waitFor();
    await input.press('Enter');
    await row(daniel, 'see docs').locator('a[href="https://example.com/docs"]', { hasText: 'docs' }).waitFor();
    const sent = await latest(maya, channel);
    assert.equal(sent.text, 'see <https://example.com/docs|docs>');
    assert.deepEqual(sent.blocks[0].elements[0].elements[1], { type: 'link', url: 'https://example.com/docs', text: 'docs' });
  });

  await step('editing in place keeps the formatting and replaces the block', async () => {
    await input.press('ArrowUp');
    const editor = maya.locator('.edit-box .edit-input');
    await editor.locator('a[href="https://example.com/docs"]').waitFor();
    assert.equal(await editor.getAttribute('role'), 'textbox');
    await editor.pressSequentially(' *now*');
    await editor.locator('strong', { hasText: 'now' }).waitFor();
    await editor.press('Enter');
    const edited = row(daniel, 'see docs');
    await edited.locator('strong', { hasText: 'now' }).waitFor();
    await edited.locator('.msg-edited').waitFor();
    const sent = await latest(maya, channel);
    assert.equal(sent.text, 'see <https://example.com/docs|docs> *now*');
    assert.deepEqual(sent.blocks[0].elements[0].elements.at(-1), { type: 'text', text: 'now', style: { bold: true } });
  });

  if (browserName === 'firefox') {
    skip('paste: rich text keeps bold, italic, links and lists; plain text keeps its lines', "Firefox drops data from a synthetic paste event");
  } else
    await step('paste: rich text keeps bold, italic, links and lists; plain text keeps its lines', async () => {
      await input.click();
      await paste(maya, {
        'text/html':
          '<h1>Release</h1><p>Read <b>this</b> and <i>that</i> at <a href="https://example.com/notes">the notes</a></p><ul><li>one</li><li>two</li></ul><img src="https://example.com/x.png"><table><tr><td>cell</td></tr></table>',
        'text/plain': 'Release',
      });
      await input.locator('strong', { hasText: 'this' }).waitFor();
      assert.equal(await input.locator('em', { hasText: 'that' }).count(), 1);
      assert.equal(await input.locator('a[href="https://example.com/notes"]').count(), 1);
      assert.equal(await input.locator('ul li').count(), 2);
      assert.equal(await input.locator('h1, img, table').count(), 0, 'what a message cannot hold is dropped');
      assert.match(await composerText(input), /Release[\s\S]*cell/, 'its words stay');
      await input.fill('');
      await paste(maya, { 'text/plain': 'line one\n\nline *three*' });
      assert.equal(await composerText(input), 'line one\n\nline *three*', 'plain text is pasted as it is, blank line included');
      await input.fill('');
    });

  await step('a draft keeps its formatting when you come back to it', async () => {
    await input.pressSequentially('draft with *bold*');
    await input.press('Shift+Enter');
    await input.pressSequentially('- item');
    await openChannel(maya, 'general');
    await openChannel(maya, 'random');
    await input.locator('strong', { hasText: 'bold' }).waitFor();
    assert.equal(await input.locator('ul li', { hasText: 'item' }).count(), 1);
    await input.fill('');
  });

  await step('phone width and the dark theme', async () => {
    const phone = watch(await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark', hasTouch: true })).newPage());
    await signIn(phone, server.base, 'maya@example.com');
    await phone.goto(`${server.base}/c/${channel}`);
    const small = composer(phone);
    await small.waitFor();
    await small.pressSequentially('On a *phone* @Dan');
    await phone.locator('.suggest-item', { hasText: 'Daniel' }).first().waitFor();
    await small.press('Enter');
    await small.press('Shift+Enter');
    await small.pressSequentially('- one');
    const tools = await phone.locator('.conversation .composer-tools').evaluate((node) => ({ width: node.scrollWidth, room: node.clientWidth, page: document.documentElement.scrollWidth }));
    assert.ok(tools.width <= tools.room + 1, `the toolbar fits (${tools.width} of ${tools.room}px)`);
    assert.ok(tools.page <= 390, 'nothing scrolls sideways');
    await shot(phone, 'composer-rich-phone-dark');
    await small.fill('');
    await phone.context().close();
  });

  await step('“Format messages with markup” brings back the plain-text composer', async () => {
    await maya.locator('.me-strip').click();
    await maya.locator('.menu-item', { hasText: 'Preferences' }).click();
    await maya.locator('.modal label', { hasText: 'Format messages with markup' }).click();
    await maya.keyboard.press('Escape');
    assert.equal(await input.evaluate((node) => node.tagName), 'TEXTAREA');
    await input.fill('*plain* markup');
    assert.equal(await input.inputValue(), '*plain* markup', 'the asterisks stay as typed');
    await input.press('Enter');
    await row(daniel, 'markup').locator('strong', { hasText: 'plain' }).waitFor();
    const sent = await latest(maya, channel);
    assert.equal(sent.text, '*plain* markup');
    assert.deepEqual(sent.blocks[0].elements[0].elements[0], { type: 'text', text: 'plain', style: { bold: true } }, 'apps still get the structure');
    await input.press('ArrowUp');
    assert.equal(await maya.locator('.edit-box .edit-input').evaluate((node) => node.tagName), 'TEXTAREA');
    assert.equal(await composerText(maya.locator('.edit-box .edit-input')), '*plain* markup');
    await maya.keyboard.press('Escape');
    await maya.locator('.me-strip').click();
    await maya.locator('.menu-item', { hasText: 'Preferences' }).click();
    await maya.locator('.modal label', { hasText: 'Format messages with markup' }).click();
    await maya.keyboard.press('Escape');
    await input.locator('xpath=self::*[@contenteditable="true"]').waitFor();
  });
});
