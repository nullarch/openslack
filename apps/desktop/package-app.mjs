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
const [, owner, repo] = /github\.com\/([^/]+)\/([^/']+)/.exec(/repo: '([^']+)'/.exec(brand)[1]);
const dirOnly = process.argv.includes('--dir');

await build({
  targets: Platform.current().createTarget(dirOnly ? 'dir' : undefined),
  // CI sets PUBLISH=1 on a version tag: installers and the update feed go to a draft GitHub release.
  publish: process.env.PUBLISH === '1' ? 'always' : 'never',
  config: {
    appId: `dev.${slug}.desktop`,
    productName: name,
    artifactName: `${slug}-\${version}-\${os}-\${arch}.\${ext}`,
    directories: { output: 'release', buildResources: 'build' },
    icon: 'build/icon.png',
    files: ['dist/**', 'build/icon.png', 'package.json'],
    protocols: [{ name, schemes: [slug] }],
    mac: { category: 'public.app-category.business', target: dirOnly ? 'dir' : ['dmg', 'zip'], identity: null },
    win: { target: dirOnly ? 'dir' : ['nsis'] },
    linux: { target: dirOnly ? 'dir' : ['AppImage', 'deb'], category: 'Network;Chat', maintainer: `${name} contributors` },
    nsis: { oneClick: true, perMachine: false },
    // Where installed copies look for updates (electron-updater); the same release CI publishes to.
    publish: [{ provider: 'github', owner, repo, releaseType: 'draft' }],
  },
});
console.log('packaged into apps/desktop/release');
