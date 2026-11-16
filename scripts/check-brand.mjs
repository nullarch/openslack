// Fails when the product name is written anywhere in source code other than the
// brand module, so that a rename stays a one-file change.
//   node scripts/check-brand.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIRS = ['apps/server/src', 'apps/server/test', 'apps/web/src', 'apps/web/e2e', 'packages/shared/src', 'compat/test', 'compat/scripts', 'scripts'];
const ALLOWED = new Set(['packages/shared/src/brand.ts', 'scripts/check-brand.mjs']);
const EXTENSIONS = /\.(ts|tsx|mts|mjs|js|jsx|css|html|sql)$/;

const brand = readFileSync(join(root, 'packages/shared/src/brand.ts'), 'utf8');
const name = /name: '([^']+)'/.exec(brand)?.[1];
const slug = /slug: '([^']+)'/.exec(brand)?.[1];
if (!name || !slug) throw new Error('could not read the brand module');
const pattern = new RegExp(`${name}|${slug}`, 'i');

function* files(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (EXTENSIONS.test(entry)) yield full;
  }
}

const hits = [];
for (const dir of SOURCE_DIRS) {
  for (const file of files(join(root, dir))) {
    const path = relative(root, file);
    if (ALLOWED.has(path)) continue;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (pattern.test(line)) hits.push(`${path}:${index + 1}: ${line.trim().slice(0, 120)}`);
      });
  }
}

if (hits.length) {
  console.error(`The product name appears outside packages/shared/src/brand.ts (${hits.length}):\n` + hits.join('\n'));
  console.error('\nImport BRAND from @app/shared instead.');
  process.exit(1);
}
console.log('brand check passed');
