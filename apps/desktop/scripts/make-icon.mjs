// Render the app icon (build/icon.png, 1024×1024) from the web client's favicon,
// with the margin macOS icons keep around the tile. electron-builder makes the
// .icns and .ico from it. Run after changing apps/web/public/favicon.svg.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(here, '../../web/public/favicon.svg'), 'utf8');
const out = join(here, '../build/icon.png');
mkdirSync(dirname(out), { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(
  `<html><body style="margin:0;background:transparent"><div style="width:1024px;height:1024px;display:grid;place-items:center">
    <div style="width:824px;height:824px;filter:drop-shadow(0 10px 18px rgba(0,0,0,.28))">${svg.replace('<svg ', '<svg width="824" height="824" ')}</div>
  </div></body></html>`,
);
await page.screenshot({ path: out, omitBackground: true });
await browser.close();
console.log(`wrote ${out}`);
