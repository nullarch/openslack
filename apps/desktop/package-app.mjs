// Package the desktop app with electron-builder: `node package-app.mjs [--dir]`.
// The product name and identifiers come from the brand module, like everywhere else.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, Platform } from 'electron-builder';

const here = dirname(fileURLToPath(import.meta.url));
const brand = readFileSync(join(here, '../../packages/shared/src/brand.ts'), 'utf8');
const name = /name: '([^']+)'/.exec(brand)[1];
const slug = /slug: '([^']+)'/.exec(brand)[1];
const dirOnly = process.argv.includes('--dir');

await build({
  targets: Platform.current().createTarget(dirOnly ? 'dir' : undefined),
  config: {
    appId: `dev.${slug}.desktop`,
    productName: name,
    directories: { output: 'release' },
    files: ['dist/**', 'package.json'],
    protocols: [{ name, schemes: [slug] }],
    mac: { category: 'public.app-category.business', target: dirOnly ? 'dir' : ['dmg', 'zip'], identity: null },
    win: { target: dirOnly ? 'dir' : ['nsis'] },
    linux: { target: dirOnly ? 'dir' : ['AppImage', 'deb'], category: 'Network;Chat' },
    publish: null,
  },
});
console.log('packaged into apps/desktop/release');
