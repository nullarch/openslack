// Bundle the Electron main process, the preload script and the "add a server" page into dist/.
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
await mkdir(out, { recursive: true });

const common = { bundle: true, platform: 'node', target: 'node22', external: ['electron'], logLevel: 'warning', legalComments: 'none' };
await build({ ...common, entryPoints: [join(here, 'src/main.ts')], outfile: join(out, 'main.cjs'), format: 'cjs' });
await build({ ...common, entryPoints: [join(here, 'src/preload.ts')], outfile: join(out, 'preload.cjs'), format: 'cjs' });
await build({ ...common, platform: 'browser', target: 'chrome120', entryPoints: [join(here, 'src/add-server.ts')], outfile: join(out, 'add-server.js'), format: 'iife', external: [] });
await copyFile(join(here, 'src/add-server.html'), join(out, 'add-server.html'));
console.log('desktop built');
