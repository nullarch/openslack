// The interface in Japanese: a Japanese browser gets Japanese everywhere it
// matters (no English left in the shell, menus, views, Preferences or
// Administration), with Japanese fonts, dates and clock; English switches to
// Japanese from Preferences; keywords typed with 、 are kept apart; an input
// method's Esc does not close a dialog; and labels neither spill out of their
// boxes nor push the page sideways at desktop and phone width.
//
//   pnpm --filter @app/web build && node apps/web/e2e/i18n-ja.mjs
import assert from 'node:assert/strict';
import {
  ALLOWED_LATIN,
  browserName,
  leftovers,
  noSidewaysScroll,
  openChannel,
  openTeamMenu,
  row,
  run,
  shot,
  signIn,
  spilled,
  startServer,
  step,
  watch,
  wide,
  workspaceWords,
} from './lib.mjs';

const japanese = { ...wide, locale: 'ja-JP', colorScheme: 'light' };
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ja-JP' };

/** Latin words the Japanese interface keeps on purpose, besides those every language keeps. */
const ALLOWED = new Set([...ALLOWED_LATIN, 'Webhook', 'WebSocket']);

async function prefs(page) {
  return page.evaluate(async () => (await (await fetch('/api/client.boot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()).prefs);
}

async function main(browser) {
  const server = await startServer({ seed: true });
  const context = await browser.newContext(japanese);
  const maya = watch(await context.newPage());
  let allowed;
  const check = async (label, scope) => {
    const left = await leftovers(maya, scope, allowed);
    assert.deepEqual(left, [], `English left in ${label}: ${JSON.stringify(left)}`);
    const spill = await spilled(maya, scope);
    assert.deepEqual(spill, [], `text spilling out of its box in ${label}: ${JSON.stringify(spill)}`);
  };

  await step('a Japanese browser gets the Japanese sign-in page, Japanese fonts first', async () => {
    await maya.goto(server.base);
    await maya.waitForURL('**/signin');
    await maya.locator('button[type="submit"]', { hasText: 'サインイン' }).waitFor();
    assert.equal(await maya.evaluate(() => document.documentElement.lang), 'ja');
    // Kanji must not fall through to a Korean font (Malgun Gothic is on every Windows).
    const fonts = await maya.evaluate(() => getComputedStyle(document.body).fontFamily);
    assert.ok(fonts.indexOf('Hiragino Sans') > 0 && !/Malgun|Noto Sans KR|Apple SD Gothic/.test(fonts), fonts);
    await shot(maya, 'ja-signin');
    await signIn(maya, server.base, 'maya@example.com');
    allowed = new Set([...ALLOWED, ...(await workspaceWords(maya))]);
  });

  await step('the shell: sidebar, channel header, composer and message menu are Japanese', async () => {
    await openChannel(maya, 'random');
    await maya.locator('.side-item', { hasText: 'アクティビティ' }).first().waitFor();
    const placeholder = '#random へのメッセージ';
    await maya.locator(`.composer textarea[placeholder="${placeholder}"], .composer [aria-placeholder="${placeholder}"], .composer [data-placeholder="${placeholder}"]`).first().waitFor();
    // Japanese clocks are 24-hour unless asked otherwise.
    assert.doesNotMatch(await row(maya, 'oat milk').locator('time').first().innerText(), /AM|PM|午前|午後/);
    const message = row(maya, 'oat milk');
    await message.hover();
    await message.locator('.msg-toolbar button[aria-label="その他"]').click();
    await maya.locator('.menu-item', { hasText: 'リンクをコピー' }).waitFor();
    for (const scope of ['.sidebar', '.conv-head', '.composer-wrap', '.menu']) await check(`the shell (${scope})`, scope);
    await maya.keyboard.press('Escape');
    await openChannel(maya, 'design');
    await noSidewaysScroll(maya, 'desktop shell');
    await shot(maya, 'ja-shell');
  });

  await step('views: activity, threads, later, drafts, files, canvases and lists are Japanese', async () => {
    for (const nav of ['アクティビティ', 'スレッド', '後で', '下書きと送信済み', 'ファイル', 'キャンバス', 'リスト']) {
      const item = maya.locator('.side-item', { hasText: nav }).first();
      if (!(await item.count())) continue;
      await item.click();
      await maya.locator('.sheet .view-title').first().waitFor();
      await maya.waitForTimeout(300);
      await check(nav, '.sheet');
    }
    await maya.locator('.side-item', { hasText: 'アクティビティ' }).first().click();
    await maya.locator('.sheet .view-title').first().waitFor();
    await shot(maya, 'ja-activity');
  });

  await step('details, profile, dialogs, search and workflows are Japanese', async () => {
    await openChannel(maya, 'random');
    await maya.locator('.conv-head button[aria-label="詳細"]').click();
    await maya.locator('.panel').first().waitFor();
    await check('channel details', '.panel');
    await row(maya, 'oat milk').locator('.msg-author').click();
    await maya.locator('.profile').waitFor();
    await check('profile', '.panel');
    await maya.keyboard.press('Escape');
    await openTeamMenu(maya, 'メンバーを招待する');
    await maya.locator('.modal[role="dialog"]').waitFor();
    await check('invite dialog', '.modal');
    await maya.keyboard.press('Escape');
    await maya.locator('.topbar-search').click();
    await maya.locator('.modal input').first().fill('oat');
    await maya.waitForTimeout(300);
    await check('quick switcher', '.modal');
    await maya.locator('.modal *', { hasText: '「oat」でメッセージを検索' }).last().click();
    await maya.locator('.search-view .result').first().waitFor();
    await maya.locator('.search-view', { hasText: '件のメッセージ' }).first().waitFor();
    await check('search results', '.search-view');
    await shot(maya, 'ja-search');
    await openTeamMenu(maya, 'ワークフロー');
    await maya.waitForTimeout(500);
    await check('workflows', '.sheet');
    await openChannel(maya, 'random');
  });

  await step('Preferences and Administration are Japanese, tab by tab, with nothing spilling over', async () => {
    await openTeamMenu(maya, '環境設定');
    const dialog = maya.locator('.modal[role="dialog"]');
    await dialog.locator('legend', { hasText: '言語' }).waitFor();
    await dialog.locator('[role="radio"]', { hasText: '日本語' }).waitFor();
    await check('Preferences', '.modal');
    await noSidewaysScroll(maya, 'desktop preferences');
    await shot(maya, 'ja-preferences');
    await maya.keyboard.press('Escape');

    await openTeamMenu(maya, '管理');
    for (const tab of ['メンバー', 'カスタム絵文字', 'アプリ', 'ワークスペース', 'アナリティクス', '報告', '監査ログ', 'コンプライアンス']) {
      await maya.locator('.admin-modal .tabs button', { hasText: tab }).click();
      await maya.waitForTimeout(400);
      await check(`Administration → ${tab}`, '.admin-modal');
      if (tab === 'ワークスペース') await shot(maya, 'ja-admin-workspace');
    }
    await maya.locator('.admin-modal .tabs button', { hasText: 'アナリティクス' }).click();
    await maya.locator('.stat-tile').first().waitFor();
    await noSidewaysScroll(maya, 'desktop administration');
    await shot(maya, 'ja-admin-analytics');
    await maya.keyboard.press('Escape');
  });

  await step('keywords typed with 、 are saved as separate words', async () => {
    await openTeamMenu(maya, '環境設定');
    const field = maya.locator('.modal input[aria-label="マイキーワード"]');
    await field.fill('デプロイ、リリース，障害');
    await field.press('Enter');
    await maya.waitForFunction(async () => (await (await fetch('/api/client.boot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()).prefs.highlight_words === 'デプロイ, リリース, 障害');
    await maya.keyboard.press('Escape');
  });

  if (browserName === 'chrome') {
    await step('Esc that cancels an input method’s conversion leaves the dialog open', async () => {
      await openTeamMenu(maya, '環境設定');
      const field = maya.locator('.modal input[aria-label="マイキーワード"]');
      await field.click();
      const cdp = await context.newCDPSession(maya);
      // Chrome's own input-method path: an active composition, then Esc as the keyboard sends it.
      await cdp.send('Input.imeSetComposition', { text: 'かいぎ', selectionStart: 3, selectionEnd: 3 });
      await maya.evaluate(() => {
        window.escComposing = new Promise((done) => document.activeElement.addEventListener('keydown', (event) => done(event.isComposing), { once: true }));
      });
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      assert.equal(await maya.evaluate(() => window.escComposing), true, 'Chrome reports the Esc as part of the conversion');
      await maya.waitForTimeout(200);
      assert.equal(await maya.locator('.modal[role="dialog"]').count(), 1, 'the dialog stays open while converting');
      // Commit the conversion; the next Esc is an ordinary one and closes the dialog.
      await cdp.send('Input.insertText', { text: '会議' });
      assert.match(await field.inputValue(), /会議$/);
      await maya.keyboard.press('Escape');
      await maya.locator('.modal[role="dialog"]').waitFor({ state: 'detached' });
      await cdp.detach();
    });
  }

  await step('an English browser switches to Japanese, then to a 12-hour clock, from Preferences', async () => {
    const english = await browser.newContext({ ...wide, locale: 'en-US' });
    const daniel = watch(await english.newPage());
    await signIn(daniel, server.base, 'daniel@example.com');
    await openTeamMenu(daniel, 'Preferences');
    const reloaded = daniel.waitForEvent('load');
    await daniel.locator('.modal [role="radio"]', { hasText: '日本語' }).click();
    await reloaded;
    await daniel.waitForSelector('.sidebar .side-item');
    await daniel.locator('.side-item', { hasText: 'アクティビティ' }).first().waitFor();
    assert.equal(await daniel.evaluate(() => document.documentElement.lang), 'ja');
    await openChannel(daniel, 'random');
    // Dates in Japanese (今日, 昨日 or 11月17日火曜日), even though the browser asks for English.
    const divider = await daniel.locator('.divider-day').first().innerText();
    assert.match(divider, /^(今日|昨日|\d+月\d+日.曜日|\d+年\d+月\d+日)$/, `day divider: ${divider}`);
    await openTeamMenu(daniel, '環境設定');
    const again = daniel.waitForEvent('load');
    await daniel.locator('.modal [role="radio"]', { hasText: '12 時間制' }).click();
    await again;
    await daniel.waitForSelector('.sidebar .side-item');
    await openChannel(daniel, 'random');
    const stamp = await row(daniel, 'oat milk').locator('time').first().innerText();
    assert.match(stamp, /午前|午後/, `12-hour clock in Japanese, got ${stamp}`);
    const saved = await prefs(daniel);
    assert.equal(saved.language, 'ja');
    assert.equal(saved.time_format, '12h');
    await english.close();
  });

  await step('phone width, light and dark: nothing sideways or spilling in the shell, Preferences or Administration', async () => {
    for (const [name, options] of [
      ['light', { ...phone, colorScheme: 'light' }],
      ['dark', { ...phone, colorScheme: 'dark' }],
    ]) {
      const small = await browser.newContext(options);
      const page = watch(await small.newPage());
      await page.goto(server.base);
      await page.waitForURL('**/signin');
      await page.fill('input[type="email"]', 'maya@example.com');
      await page.fill('input[type="password"]', 'demo-password');
      await page.click('button[type="submit"]');
      await page.waitForSelector('.message-content .msg');
      await noSidewaysScroll(page, `${name} shell`);
      assert.deepEqual(await spilled(page, '.conv-head, .composer-wrap'), [], `${name} shell`);
      await shot(page, `ja-phone-${name}`);
      const drawer = async () => {
        // A closed drawer is slid off-screen, not hidden, so look at where it is.
        const open = await page.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().left >= 0);
        if (open) return;
        await page.locator('.conv-head .only-narrow').click();
        await page.locator('.sidebar .team-btn').waitFor();
        await page.waitForTimeout(350);
      };
      await drawer();
      assert.deepEqual(await spilled(page, '.sidebar'), [], `${name} sidebar`);
      await shot(page, `ja-phone-${name}-sidebar`);
      await openTeamMenu(page, '環境設定');
      await page.locator('.modal legend', { hasText: '言語' }).waitFor();
      await noSidewaysScroll(page, `${name} preferences`);
      assert.deepEqual(await spilled(page, '.modal'), [], `${name} preferences`);
      await shot(page, `ja-phone-${name}-preferences`);
      await page.keyboard.press('Escape');
      await drawer();
      await openTeamMenu(page, '管理');
      for (const tab of ['メンバー', 'ワークスペース', 'アナリティクス']) {
        await page.locator('.admin-modal .tabs button', { hasText: tab }).click();
        await page.waitForTimeout(400);
        await noSidewaysScroll(page, `${name} administration → ${tab}`);
        assert.deepEqual(await spilled(page, '.admin-modal'), [], `${name} administration → ${tab}`);
      }
      await page.locator('.stat-tile').first().waitFor();
      await shot(page, `ja-phone-${name}-admin`);
      await small.close();
    }
  });
}

await run(main);
