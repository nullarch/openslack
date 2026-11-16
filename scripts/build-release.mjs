// Build the publishable package: the server bundled into one file, plus the built web client.
//   node scripts/build-release.mjs
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'packages/cli/dist');
const pkg = JSON.parse(await readFile(join(root, 'packages/cli/package.json'), 'utf8'));

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: [join(root, 'apps/server/src/main.ts')],
  outfile: join(out, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Optional native accelerators of the WebSocket library; it works without them.
  external: ['bufferutil', 'utf-8-validate'],
  define: {
    'process.env.APP_VERSION': JSON.stringify(pkg.version),
    'process.env.APP_BUNDLED': '"1"',
  },
  // Bundled CommonJS dependencies still call require() for Node built-ins.
  banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});

const web = join(root, 'apps/web/dist');
const hasWeb = await stat(join(web, 'index.html')).then(() => true, () => false);
if (hasWeb) await cp(web, join(out, 'web'), { recursive: true });

const size = (await stat(join(out, 'server.mjs'))).size;
console.log(`server bundle  ${(size / 1024).toFixed(0)} kB`);
console.log(hasWeb ? 'web client     copied' : 'web client     MISSING — run "pnpm build" first');
if (!hasWeb) process.exitCode = 1;
