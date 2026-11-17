import { BRAND } from '@app/shared';
import { createApp } from './app.ts';
import { configFromEnv } from './config.ts';
import { DEMO_EMAIL, DEMO_PASSWORD, seedDemo } from './demo/seed.ts';
import { importSlackExport } from './importer/slack-export.ts';
import { backupDataDir } from './ops/backup.ts';
import { useJsonLogs } from './ops/logging.ts';

const USAGE = `${BRAND.name} — ${BRAND.tagline}

Usage:
  ${BRAND.slug} [serve]                      Start the server (default)
  ${BRAND.slug} import-slack <export> [...]  Import a Slack export (.zip or unpacked folder)
      --download-files                     Also fetch files from the URLs in the export
      --token <token>                      Bearer token for those downloads, if needed
  ${BRAND.slug} backup <directory>          Copy the data directory while the server runs
  ${BRAND.slug} help

Environment:
  PORT (3000)   HOST (0.0.0.0)   DATA_DIR (./data)   PUBLIC_URL   MAX_UPLOAD_MB (100)
  SEED_DEMO=1   Fill an empty database with a sample team
  SMTP_URL, MAIL_FROM            Send invitations, sign-in codes and password resets by mail
  OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET, GOOGLE_CLIENT_ID / …, GITHUB_CLIENT_ID / …
                                 Sign in with an identity provider
  METRICS_TOKEN                  Serve Prometheus metrics at /metrics to this bearer token
  LOG_FORMAT=json                One JSON object per log line
`;

if (process.env.LOG_FORMAT === 'json') useJsonLogs();

async function serve(): Promise<void> {
  const config = configFromEnv();
  const app = createApp(config);
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

  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandled rejection', reason);
  });

  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (closing) process.exit(1);
      closing = true;
      void app.close().then(() => process.exit(0));
    });
  }
}

async function importSlack(args: string[]): Promise<void> {
  const path = args.find((arg) => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--token');
  if (!path) {
    console.error(USAGE);
    process.exit(2);
  }
  const tokenAt = args.indexOf('--token');
  const app = createApp({ ...configFromEnv(), quiet: true });
  try {
    const report = await importSlackExport(app.ctx, path, {
      downloadFiles: args.includes('--download-files'),
      token: tokenAt >= 0 ? args[tokenAt + 1] : undefined,
      log: (line) => console.log(`  ${line}`),
    });
    console.log('\nImport finished');
    console.log(`  people         ${report.users.created} created, ${report.users.matched} matched`);
    console.log(`  channels       ${report.channels.created} created, ${report.channels.merged} merged into existing`);
    console.log(`  direct         ${report.directs.created} created, ${report.directs.matched} matched`);
    console.log(
      `  messages       ${report.messages.imported} imported, ${report.messages.alreadyPresent} already present, ${report.messages.failed} failed`,
    );
    console.log(`  reactions      ${report.reactions}`);
    console.log(`  pins           ${report.pins}`);
    console.log(`  files          ${report.files.stored} stored, ${report.files.linked} linked, ${report.files.failed} failed`);
    if (report.problemCount > 0) {
      console.log(`\n${report.problemCount} item(s) could not be carried over exactly:`);
      for (const line of report.problems) console.log(`  - ${line}`);
      if (report.problemCount > report.problems.length) console.log(`  … and ${report.problemCount - report.problems.length} more`);
    }
    console.log('\nPeople from the export sign in by accepting an invite with the same email address; their history is kept.');
  } finally {
    await app.close();
  }
}

const [command = 'serve', ...rest] = process.argv.slice(2);
try {
  if (command === 'serve') await serve();
  else if (command === 'import-slack') await importSlack(rest);
  else if (command === 'backup') {
    if (!rest[0]) {
      console.error(USAGE);
      process.exit(2);
    }
    const result = await backupDataDir(configFromEnv().dataDir, rest[0]);
    console.log(`Backed up ${result.database}${result.files ? ' and the uploaded files' : ''}.`);
  }
  else {
    console.log(USAGE);
    process.exit(command === 'help' || command === '--help' || command === '-h' ? 0 : 2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
