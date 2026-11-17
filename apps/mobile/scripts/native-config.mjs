// Write what the native projects need from the brand module, so the product
// name stays in packages/shared/src/brand.ts: the URL scheme that opens a
// server in the app (`<slug>://open?server=https://chat.example.com`).
// Run after `cap add` or `cap sync`; it changes nothing when already done.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const brand = readFileSync(join(root, '../../packages/shared/src/brand.ts'), 'utf8');
const slug = /slug: '([^']+)'/.exec(brand)?.[1];
if (!slug) throw new Error('could not read the brand module');

const plist = join(root, 'ios/App/App/Info.plist');
if (existsSync(plist)) {
  let text = readFileSync(plist, 'utf8');
  if (!text.includes('<key>CFBundleURLTypes</key>')) {
    const block = `\t<key>CFBundleURLTypes</key>\n\t<array>\n\t\t<dict>\n\t\t\t<key>CFBundleURLSchemes</key>\n\t\t\t<array>\n\t\t\t\t<string>${slug}</string>\n\t\t\t</array>\n\t\t</dict>\n\t</array>\n`;
    const end = text.lastIndexOf('</dict>');
    text = `${text.slice(0, end)}${block}${text.slice(end)}`;
    writeFileSync(plist, text);
    console.log(`ios: URL scheme ${slug}://`);
  }
}

const manifest = join(root, 'android/app/src/main/AndroidManifest.xml');
if (existsSync(manifest)) {
  let text = readFileSync(manifest, 'utf8');
  if (!text.includes(`android:scheme="${slug}"`)) {
    const filter = `\n            <intent-filter>\n                <action android:name="android.intent.action.VIEW" />\n                <category android:name="android.intent.category.DEFAULT" />\n                <category android:name="android.intent.category.BROWSABLE" />\n                <data android:scheme="${slug}" />\n            </intent-filter>\n`;
    const anchor = text.indexOf('</activity>');
    text = `${text.slice(0, anchor)}${filter}        ${text.slice(anchor)}`;
    writeFileSync(manifest, text);
    console.log(`android: URL scheme ${slug}://`);
  }
}
