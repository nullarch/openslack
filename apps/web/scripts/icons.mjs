// Render the app icons (PNG) from the mark, with the system Chrome.
//   node apps/web/scripts/icons.mjs
// Writes public/icons/*.png; run again only when the mark changes.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const out = join(dirname(fileURLToPath(import.meta.url)), '../public/icons');
mkdirSync(out, { recursive: true });

/** The mark on the brand background. `inset` shrinks it for maskable icons, whose edges may be cropped. */
function svg(size, { inset = 0, rounded = true } = {}) {
  const scale = 1 - inset * 2;
  const offset = 64 * inset;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
<rect width="64" height="64" rx="${rounded ? 15 : 0}" fill="#0F2A33"/>
<g transform="translate(${offset} ${offset}) scale(${scale})">
<path d="M46.6 21.2A18 18 0 1 0 50 32" fill="none" stroke="#F5B63A" stroke-width="7.5" stroke-linecap="round"/>
<circle cx="49" cy="19" r="4.2" fill="#fff"/></g></svg>`;
}

const icons = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'maskable-512.png', size: 512, inset: 0.12, rounded: false },
  { name: 'apple-touch-icon.png', size: 180, rounded: false },
  { name: 'badge-96.png', size: 96 },
];

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage();
  for (const icon of icons) {
    await page.setViewportSize({ width: icon.size, height: icon.size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg(icon.size, icon)}</body></html>`);
    await page.locator('svg').screenshot({ path: join(out, icon.name), omitBackground: true });
    console.log(`  ${icon.name}`);
  }
} finally {
  await browser.close();
}
