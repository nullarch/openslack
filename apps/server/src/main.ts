import { BRAND } from '@app/shared';
import { createApp } from './app.ts';
import { configFromEnv } from './config.ts';
import { DEMO_EMAIL, DEMO_PASSWORD, seedDemo } from './demo/seed.ts';

const config = configFromEnv();
const app = createApp(config);
// SEED_DEMO=1 fills an empty database with a sample team.
const seeded = process.env.SEED_DEMO === '1' ? await seedDemo(app.ctx) : false;
const port = await app.listen();

if (!config.quiet) {
  console.log(`${BRAND.name} ${config.version}`);
  console.log(`  open     ${config.publicUrl}`);
  console.log(`  data     ${config.dataDir}`);
  if (!config.webDir) console.log('  web      not built — run "pnpm build", or "pnpm dev" for the dev server');
  if (!app.ctx.team()) console.log('  setup    open the address above to create your workspace');
  if (seeded) console.log(`  demo     sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  if (port !== config.port && config.port !== 0) console.log(`  port     ${port}`);
}

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) process.exit(1);
    closing = true;
    void app.close().then(() => process.exit(0));
  });
}
