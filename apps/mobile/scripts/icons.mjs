// Draws the app icons and splash screens of both native projects from the
// mark in www/icon.svg (its rounded square's colour is the background), in
// place of Capacitor's placeholders. Run after `cap add`, or when the mark
// changes. Needs `rsvg-convert` (Homebrew: librsvg) and macOS `sips`.
//
//   node scripts/icons.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, 'www/icon.svg'), 'utf8');
const background = /<rect[^>]*fill="([^"]+)"/.exec(source)?.[1];
// The mark: everything in the 64×64 icon but its rounded square.
const mark = source.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<rect[^>]*\/>/, '');
if (!background || !mark.trim()) throw new Error('could not read www/icon.svg');

const work = mkdtempSync(join(tmpdir(), 'icons-'));
let count = 0;

/** Renders an SVG to a PNG of this size; `opaque` drops the alpha channel (the App Store refuses it in icons). */
function render(svg, width, height, out, { opaque = false } = {}) {
  const file = join(work, `${count++}.svg`);
  writeFileSync(file, svg);
  if (!opaque) {
    execFileSync('rsvg-convert', ['-w', String(width), '-h', String(height), '-o', out, file]);
    return;
  }
  const png = join(work, `${count++}.png`);
  const jpeg = join(work, `${count++}.jpg`);
  execFileSync('rsvg-convert', ['-w', String(width), '-h', String(height), '-o', png, file]);
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '100', png, '--out', jpeg], { stdio: 'ignore' });
  execFileSync('sips', ['-s', 'format', 'png', jpeg, '--out', out], { stdio: 'ignore' });
}

/** The mark centred on a canvas: `size` is the share of the shorter side the 64-unit icon takes. */
const canvas = (width, height, size, { fill = true, shape = 'square' } = {}) => {
  const side = Math.min(width, height) * size;
  const scale = side / 64;
  const back = !fill
    ? ''
    : shape === 'circle'
      ? `<circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 2}" fill="${background}"/>`
      : shape === 'rounded'
        ? `<rect width="${width}" height="${height}" rx="${(width * 15) / 64}" fill="${background}"/>`
        : `<rect width="${width}" height="${height}" fill="${background}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${back}<g transform="translate(${(width - side) / 2} ${(height - side) / 2}) scale(${scale})">${mark}</g></svg>`;
};

// iOS: one 1024 icon, full bleed (the system rounds it), and the splash.
const ios = join(root, 'ios/App/App/Assets.xcassets');
if (existsSync(ios)) {
  render(canvas(1024, 1024, 1), 1024, 1024, join(ios, 'AppIcon.appiconset/AppIcon-512@2x.png'), { opaque: true });
  for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    render(canvas(2732, 2732, 0.22), 2732, 2732, join(ios, 'Splash.imageset', name), { opaque: true });
  }
  console.log('ios: icon and splash');
}

// Android: legacy and round icons, the adaptive icon's foreground (108 dp, the
// mark inside the 66 dp the launcher always shows) on the background colour, and splashes.
const res = join(root, 'android/app/src/main/res');
if (existsSync(res)) {
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [density, factor] of Object.entries(densities)) {
    const icon = 48 * factor;
    render(canvas(icon, icon, 1, { shape: 'rounded' }), icon, icon, join(res, `mipmap-${density}/ic_launcher.png`));
    render(canvas(icon, icon, 0.92, { shape: 'circle' }), icon, icon, join(res, `mipmap-${density}/ic_launcher_round.png`));
    const foreground = 108 * factor;
    render(canvas(foreground, foreground, 0.76, { fill: false }), foreground, foreground, join(res, `mipmap-${density}/ic_launcher_foreground.png`));
  }
  writeFileSync(
    join(res, 'values/ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${background}</color>\n</resources>\n`,
  );
  const splashes = {
    drawable: [480, 320],
    'drawable-land-mdpi': [480, 320],
    'drawable-land-hdpi': [800, 480],
    'drawable-land-xhdpi': [1280, 720],
    'drawable-land-xxhdpi': [1600, 960],
    'drawable-land-xxxhdpi': [1920, 1280],
    'drawable-port-mdpi': [320, 480],
    'drawable-port-hdpi': [480, 800],
    'drawable-port-xhdpi': [720, 1280],
    'drawable-port-xxhdpi': [960, 1600],
    'drawable-port-xxxhdpi': [1280, 1920],
  };
  for (const [folder, [width, height]] of Object.entries(splashes)) {
    render(canvas(width, height, 0.3), width, height, join(res, `${folder}/splash.png`));
  }
  console.log('android: icons, adaptive icon and splashes');
}

rmSync(work, { recursive: true, force: true });
