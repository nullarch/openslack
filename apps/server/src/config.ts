import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '@app/shared';
import type { S3Config } from './core/storage.ts';
import type { Config } from './ctx.ts';
import { liveKitFromEnv } from './huddles/livekit.ts';

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
 * A bucket is used when `S3_BUCKET` is set: S3_ENDPOINT (default AWS in S3_REGION),
 * S3_REGION (us-east-1), S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_PREFIX,
 * S3_PATH_STYLE (default on for a custom endpoint).
 */
function s3FromEnv(env: NodeJS.ProcessEnv): S3Config | null {
  const bucket = env.S3_BUCKET?.trim();
  if (!bucket) return null;
  const region = env.S3_REGION?.trim() || 'us-east-1';
  const endpoint = env.S3_ENDPOINT?.trim() || `https://s3.${region}.amazonaws.com`;
  const accessKeyId = env.S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID ?? '';
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY ?? '';
  if (!accessKeyId || !secretAccessKey) throw new Error('S3_BUCKET is set but S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are missing');
  return {
    endpoint,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    prefix: env.S3_PREFIX ?? '',
    pathStyle: env.S3_PATH_STYLE ? env.S3_PATH_STYLE === '1' || env.S3_PATH_STYLE === 'true' : Boolean(env.S3_ENDPOINT),
  };
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
    s3: s3FromEnv(env),
    livekit: liveKitFromEnv(env),
    cookieSecure: publicUrl.startsWith('https://'),
    version: VERSION,
    quiet: env.QUIET === '1',
  };
}
