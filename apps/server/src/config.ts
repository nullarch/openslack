import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '@app/shared';
import type { Config } from './ctx.ts';

// Both are replaced with constants when the release bundle is built.
export const VERSION = process.env.APP_VERSION ?? '0.1.0-dev';
const BUNDLED = process.env.APP_BUNDLED === '1';

/** The built web client, when it exists next to this checkout. */
function defaultWebDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '../../web/dist'), join(here, '../web'), join(here, 'web')]) {
    if (existsSync(join(candidate, 'index.html'))) return resolve(candidate);
  }
  return null;
}

/**
 * Configuration comes from environment variables only:
 * PORT, HOST, DATA_DIR, PUBLIC_URL, WEB_DIR, MAX_UPLOAD_MB.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = (env.PUBLIC_URL ?? '').replace(/\/+$/, '');
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    // The installed command keeps its data in the home directory; a source checkout keeps it alongside.
    dataDir: resolve(env.DATA_DIR ?? (BUNDLED ? join(homedir(), `.${BRAND.slug}`) : './data')),
    publicUrl,
    webDir: env.WEB_DIR ? resolve(env.WEB_DIR) : defaultWebDir(),
    maxUploadBytes: Number(env.MAX_UPLOAD_MB ?? 100) * 1024 * 1024,
    cookieSecure: publicUrl.startsWith('https://'),
    version: VERSION,
    quiet: env.QUIET === '1',
    linkPreviews: env.LINK_PREVIEWS !== '0',
  };
}
