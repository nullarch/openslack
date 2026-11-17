import { createHash, randomBytes, randomInt } from 'node:crypto';

const ID_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Slack-shaped identifier: a type prefix followed by uppercase alphanumerics. */
export function newId(prefix: string, length = 10): string {
  let out = prefix;
  for (let i = 0; i < length; i += 1) out += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return out;
}

export function newSecret(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function newHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

const TOKEN_PREFIX = { bot: 'xoxb', user: 'xoxp', app: 'xapp' } as const;

/**
 * API tokens keep Slack's prefixes because SDKs and tooling recognise them. An
 * app-level token carries its app's id (`xapp-1-<app id>-…`) the way Slack's do;
 * some clients read it from the token and compare it with `auth.test`.
 */
export function newToken(kind: keyof typeof TOKEN_PREFIX, appId?: string | null): string {
  const digits = (): string => String(randomInt(1_000_000_000, 9_999_999_999));
  if (kind === 'app') return `xapp-1-${appId ?? newId('A', 10)}-${digits()}-${newHex(32)}`;
  return `${TOKEN_PREFIX[kind]}-${digits()}-${digits()}-${newSecret(18).replace(/[-_]/g, 'x')}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
