// The interface in Korean, and the display preferences: a Korean browser gets
// Korean everywhere it matters (no English left in the shell, menus,
// Preferences or Administration), switching language and clock from
// Preferences reloads into them, sidebar themes keep text readable, and
// nothing overflows at phone width in light or dark.
//
//   pnpm --filter @app/web build && node apps/web/e2e/i18n.mjs
import assert from 'node:assert/strict';
import { ALLOWED_LATIN as ALLOWED, leftovers, noSidewaysScroll, openChannel, openTeamMenu as openMenu, row, run, shot, signIn, startServer, step, watch, wide, workspaceWords } from './lib.mjs';

const korean = { ...wide, locale: 'ko-KR', colorScheme: 'light' };
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ko-KR' };

async function main(browser) {
  const server = await startServer({ seed: true });
  const context = await browser.newContext(korean);
  const maya = watch(await context.newPage());
  let allowed;

  await step('a Korean browser gets the Korean sign-in page', async () => {
    await maya.goto(server.base);
    await maya.waitForURL('**/signin');
    await maya.locator('button[type="submit"]', { hasText: '로그인' }).waitFor();
    assert.equal(await maya.evaluate(() => document.documentElement.lang), 'ko');
    await signIn(maya, server.base, 'maya@example.com');
    allowed = new Set([...ALLOWED, ...(await workspaceWords(maya))]);
  });

  await step('the shell: sidebar, channel header, composer and message menu are Korean', async () => {
    await openChannel(maya, 'random');
    await maya.locator('.side-item', { hasText: '활동' }).first().waitFor();
    await maya.locator('.composer textarea[placeholder="#random에 메시지 보내기"], .composer [aria-placeholder="#random에 메시지 보내기"], .composer [data-placeholder="#random에 메시지 보내기"]').first().waitFor();
    const message = row(maya, 'oat milk');
    await message.hover();
    await message.locator('.msg-toolbar button[aria-label="더 보기"]').click();
    await maya.locator('.menu-item', { hasText: '링크 복사' }).waitFor();
    const left = [
      ...(await leftovers(maya, '.sidebar', allowed)),
      ...(await leftovers(maya, '.conv-head', allowed)),
      ...(await leftovers(maya, '.composer-wrap', allowed)),
      ...(await leftovers(maya, '.menu', allowed)),
    ];
    assert.deepEqual(left, [], `English left in the shell: ${JSON.stringify(left)}`);
    await maya.keyboard.press('Escape');
    // A system line from the server is shown in Korean too.
    await openChannel(maya, 'design');
    await shot(maya, 'ko-shell');
  });

  await step('views: activity, threads, later, files are Korean', async () => {
    for (const [nav, scope] of [
      ['활동', '.sheet'],
      ['스레드', '.sheet'],
      ['나중에', '.sheet'],
      ['파일', '.sheet'],
    ]) {
      await maya.locator('.side-item', { hasText: nav }).first().click();
      await maya.locator('.sheet .view-title').first().waitFor();
      const left = await leftovers(maya, scope, allowed);
      assert.deepEqual(left, [], `English left in ${nav}: ${JSON.stringify(left)}`);
    }
    await openChannel(maya, 'random');
  });

  await step('details, profile, dialogs, search, canvases, lists and workflows are Korean', async () => {
    const check = async (label, scope) => {
      const left = await leftovers(maya, scope, allowed);
      assert.deepEqual(left, [], `English left in ${label}: ${JSON.stringify(left)}`);
    };
    await openChannel(maya, 'random');
    await maya.locator('.conv-head button[aria-label="세부 정보"]').click();
    await maya.locator('.panel').first().waitFor();
    await check('channel details', '.panel');
    await row(maya, 'oat milk').locator('.msg-author').click();
    await maya.locator('.profile').waitFor();
    await check('profile', '.panel');
    await maya.keyboard.press('Escape');
    await openMenu(maya, '사람 초대하기');
    await maya.locator('.modal[role="dialog"]').waitFor();
    await check('invite dialog', '.modal');
    await maya.keyboard.press('Escape');
    await maya.locator('.topbar-search').click();
    await maya.locator('.modal input').first().fill('oat');
    await maya.waitForTimeout(300);
    await check('quick switcher', '.modal');
    await maya.locator('.modal *', { hasText: '“oat” 메시지 검색' }).last().click();
    await maya.locator('.search-view .result').first().waitFor();
    await check('search results', '.search-view');
    for (const nav of ['캔버스', '리스트']) {
      await maya.locator('.side-item', { hasText: nav }).first().click();
      await maya.waitForTimeout(500);
      await check(nav, '.sheet');
    }
    await openMenu(maya, '워크플로');
    await maya.waitForTimeout(500);
    await check('workflows', '.sheet');
    await shot(maya, 'ko-workflows');
    await openChannel(maya, 'random');
  });

  await step('Preferences and Administration are Korean, tab by tab', async () => {
    await openMenu(maya, '환경설정');
    const prefs = maya.locator('.modal[role="dialog"]');
    await prefs.locator('legend', { hasText: '언어' }).waitFor();
    let left = await leftovers(maya, '.modal', allowed);
    assert.deepEqual(left, [], `English left in Preferences: ${JSON.stringify(left)}`);
    await shot(maya, 'ko-preferences');
    await maya.keyboard.press('Escape');

    await openMenu(maya, '관리');
    for (const tab of ['멤버', '맞춤 이모지', '앱', '워크스페이스', '통계', '신고', '감사 로그']) {
      await maya.locator('.admin-modal .tabs button', { hasText: tab }).click();
      await maya.waitForTimeout(400);
      left = await leftovers(maya, '.admin-modal', allowed);
      assert.deepEqual(left, [], `English left in Administration → ${tab}: ${JSON.stringify(left)}`);
    }
    await maya.locator('.admin-modal .tabs button', { hasText: '통계' }).click();
    await maya.locator('.stat-tile').first().waitFor();
    await shot(maya, 'ko-admin-analytics');
    await maya.keyboard.press('Escape');
  });

  await step('sidebar themes: a preset and a light custom color keep the sidebar text readable', async () => {
    await openMenu(maya, '환경설정');
    const dialog = maya.locator('.modal[role="dialog"]');
    await dialog.locator('.sidebar-swatch', { hasText: '숲' }).click();
    await maya.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--chrome').trim() === '#1f3d2c');
    await dialog.locator('.sidebar-swatch', { hasText: '직접 고르기' }).click();
    const hexInput = dialog.locator('.sidebar-hex');
    await hexInput.fill('#f2e8c9');
    await hexInput.blur();
    await maya.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--chrome').trim() === '#f2e8c9');
    // Every sidebar label against the sidebar background: at least 4.5:1.
    const worst = await maya.evaluate(() => {
      const parse = (color) => color.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
      const lum = ([r, g, b]) => {
        const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      // The sidebar sits on the chrome color (the sidebar element itself is transparent).
      const chrome = getComputedStyle(document.documentElement).getPropertyValue('--chrome').trim().replace('#', '');
      const background = [0, 2, 4].map((index) => Number.parseInt(chrome.slice(index, index + 2), 16));
      let min = { ratio: 99, where: '' };
      // The selected item sits on the accent color, not on the sidebar: it is checked against its own background.
      for (const element of document.querySelectorAll('.sidebar .side-item:not(.is-selected) .side-name, .sidebar .side-section-head')) {
        const color = parse(getComputedStyle(element).color);
        const [a, b] = [lum(color), lum(background)].sort((x, y) => y - x);
        const ratio = (a + 0.05) / (b + 0.05);
        if (ratio < min.ratio) min = { ratio, where: `${element.className} ${getComputedStyle(element).color}` };
      }
      return min;
    });
    assert.ok(worst.ratio >= 4.5, `sidebar text contrast ${worst.ratio.toFixed(2)}:1 at ${worst.where}`);
    await maya.keyboard.press('Escape');
    await shot(maya, 'ko-sidebar-custom');
    // It survives a reload (painted before the workspace loads).
    await maya.reload();
    await maya.waitForSelector('.sidebar .side-item');
    assert.equal(await maya.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--chrome').trim()), '#f2e8c9');
    await openMenu(maya, '환경설정');
    await maya.locator('.modal .sidebar-swatch', { hasText: '항구' }).click();
    await maya.keyboard.press('Escape');
  });

  await step('an English browser switches to Korean and to a 24-hour clock from Preferences', async () => {
    const english = await browser.newContext({ ...wide, locale: 'en-US' });
    const daniel = watch(await english.newPage());
    await signIn(daniel, server.base, 'daniel@example.com');
    await openChannel(daniel, 'random');
    assert.match(await row(daniel, 'oat milk').locator('time').first().innerText(), /AM|PM/);
    await openMenu(daniel, 'Preferences');
    const reloaded = daniel.waitForEvent('load');
    await daniel.locator('.modal [role="radio"]', { hasText: '한국어' }).click();
    await reloaded;
    await daniel.waitForSelector('.sidebar .side-item');
    await daniel.locator('.side-item', { hasText: '활동' }).first().waitFor();
    await openMenu(daniel, '환경설정');
    const again = daniel.waitForEvent('load');
    await daniel.locator('.modal [role="radio"]', { hasText: '24시간' }).click();
    await again;
    await daniel.waitForSelector('.sidebar .side-item');
    await openChannel(daniel, 'random');
    const stamp = await row(daniel, 'oat milk').locator('time').first().innerText();
    assert.doesNotMatch(stamp, /오전|오후|AM|PM/, `24-hour clock, got ${stamp}`);
    const prefs = await daniel.evaluate(async () => (await (await fetch('/api/client.boot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()).prefs);
    assert.equal(prefs.language, 'ko');
    assert.equal(prefs.time_format, '24h');
    // Another device of the same person follows on its first load.
    const other = watch(await (await browser.newContext({ ...wide, locale: 'en-US' })).newPage());
    await signIn(other, server.base, 'daniel@example.com').catch(() => undefined);
    await other.locator('.side-item', { hasText: '활동' }).first().waitFor({ timeout: 15_000 });
    await english.close();
  });

  await step('email notifications are offered only when the server can send mail, and the choice is kept', async () => {
    await openMenu(maya, '환경설정');
    assert.equal(await maya.locator('.modal legend', { hasText: '이메일 알림' }).count(), 0, 'no mail, no email option');
    await maya.keyboard.press('Escape');
    // Nothing is sent in this step; the address only has to be configured.
    const mailServer = await startServer({ seed: true, env: { SMTP_URL: 'smtp://127.0.0.1:2', MAIL_FROM: 'Northwind <chat@example.com>' } });
    const page = watch(await (await browser.newContext(korean)).newPage());
    await signIn(page, mailServer.base, 'maya@example.com');
    await openMenu(page, '환경설정');
    const email = page.locator('.modal .pref-group', { has: page.locator('legend', { hasText: '이메일 알림' }) });
    await email.locator('select').selectOption('1h');
    await page.waitForFunction(async () => (await (await fetch('/api/client.boot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()).prefs.email_notifications === '1h');
    assert.deepEqual(await email.locator('option').allInnerTexts(), ['15분마다', '1시간마다', '받지 않음']);
    await page.context().close();
  });

  await step('phone width and dark theme: no sideways scroll in the shell, Preferences or Administration', async () => {
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
      await shot(page, `ko-phone-${name}`);
      // On a phone the sidebar (with the workspace menu) is a drawer opened from the header.
      const drawer = async () => {
        // A closed drawer is slid off-screen, not hidden, so look at where it is.
        const open = await page.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().left >= 0);
        if (open) return;
        await page.locator('.conv-head .only-narrow').click();
        await page.locator('.sidebar .team-btn').waitFor();
        await page.waitForTimeout(350);
      };
      await drawer();
      await openMenu(page, '환경설정');
      await page.locator('.modal legend', { hasText: '언어' }).waitFor();
      await noSidewaysScroll(page, `${name} preferences`);
      await shot(page, `ko-phone-${name}-preferences`);
      await page.keyboard.press('Escape');
      await drawer();
      await openMenu(page, '관리');
      await page.locator('.admin-modal .tabs button', { hasText: '통계' }).click();
      await page.locator('.stat-tile').first().waitFor();
      await noSidewaysScroll(page, `${name} administration`);
      await shot(page, `ko-phone-${name}-admin`);
      await small.close();
    }
  });
}

await run(main);
