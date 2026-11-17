import type { ExternalSearch, MeiliConfig } from './search/meilisearch.ts';
import type { StorageKey } from './core/encrypted-storage.ts';
import type { ScannerConfig } from './core/scanner.ts';
import type { Role } from '@app/shared';
import type { Bus } from './core/bus.ts';
import type { Clock } from './core/clock.ts';
import type { S3Config, Storage } from './core/storage.ts';
import type { LiveKitConfig } from './huddles/livekit.ts';
import type { Db } from './db/db.ts';
import type { Instances } from './core/instances.ts';
import type { Transient } from './core/transient.ts';

export interface Config {
  port: number;
  host: string;
  /** Directory holding the database and uploaded files. */
  dataDir: string;
  /** Origin used in URLs handed to API clients, without a trailing slash. */
  publicUrl: string;
  /** Built web client to serve, or null when the client is served elsewhere (dev). */
  webDir: string | null;
  maxUploadBytes: number;
  /** Keep uploaded files in an S3-compatible bucket instead of `dataDir/files`. */
  s3?: S3Config | null;
  /** Media server for huddles; huddles are off without it. */
  livekit?: LiveKitConfig | null;
  /** ClamAV daemon that checks every upload; uploads are not scanned without it. */
  scanner?: ScannerConfig | null;
  cookieSecure: boolean;
  version: string;
  quiet: boolean;
  /** Fetch titles and images for links in messages. Off unless set (`LINK_PREVIEWS=0` turns it off when run from the environment). */
  linkPreviews?: boolean;
  /** Outgoing mail (`smtp://` or `smtps://` URL); null or absent turns mail off. */
  smtpUrl?: string | null;
  /** Domain whose mail is routed to POST /inbound/email (email to a channel); off when unset. */
  inboundEmailDomain?: string | null;
  /** Shared secret the mail provider sends with each inbound message. */
  inboundEmailSecret?: string | null;
  /** How many reverse proxies add an X-Forwarded-For entry in front of the server (0: none, use the socket address). */
  trustProxy?: number;
  /** Meilisearch for message search (MEILISEARCH_URL); the built-in index otherwise. */
  meilisearch?: MeiliConfig | null;
  /** Keys that encrypt uploaded files at rest (the first writes, all read). */
  storageKeys?: StorageKey[];
  /** Ignore the workspace's IP allowlist (recovery after locking yourself out). */
  ipAllowlistDisabled?: boolean;
  /** Sender address for outgoing mail. */
  mailFrom?: string;
  /** External sign-in providers configured by the operator. */
  identityProviders?: IdentityProviderConfig[];
  /** Bearer token that unlocks `/metrics`; null or absent hides it. */
  metricsToken?: string | null;
  /** The push relay for the native apps (PUSH_RELAY_URL); no native push without it. */
  pushRelayUrl?: string | null;
  /** Share the database with other server processes on this machine (CLUSTER=1, or each worker under WORKERS). */
  cluster?: boolean;
  /** Heartbeat, death and polling intervals between processes (tests shorten them). */
  instanceTimings?: { heartbeatMs?: number; deadAfterMs?: number; pollMs?: number };
}

/** One external sign-in provider. Endpoints are discovered for OIDC providers. */
export interface IdentityProviderConfig {
  /** Path segment and stored provider name: `google`, `github` or `oidc`. */
  id: string;
  /** Button label. */
  label: string;
  kind: 'oidc' | 'github' | 'saml';
  clientId: string;
  clientSecret: string;
  /** OIDC issuer (discovery at `<issuer>/.well-known/openid-configuration`). */
  issuer?: string;
  /** GitHub web and API origins (overridable for GitHub Enterprise and tests). */
  webUrl?: string;
  apiUrl?: string;
  /** Create an account on first sign-in, within the workspace's approved domains. */
  createAccounts: boolean;
  /** SAML 2.0: the identity provider's metadata address, or its sign-in address and certificates; this server's entity id. */
  saml?: { metadataUrl: string | null; entryPoint: string | null; certs: string[]; entityId: string | null };
}

export interface TeamRow {
  id: string;
  name: string;
  domain: string;
  icon_key: string | null;
  prefs: string;
  created: number;
}

/** The caller of an API method, after authentication. */
export interface Actor {
  userId: string;
  /** How the caller authenticated: browser session, user token, bot token or app-level token. */
  kind: 'session' | 'user' | 'bot' | 'app';
  role: Role;
  isBot: boolean;
  appId: string | null;
  botId: string | null;
  /** Granted scopes; null means unrestricted (first-party session). */
  scopes: Set<string> | null;
}

export interface Presence {
  isOnline(userId: string): boolean;
  onlineUsers(): string[];
}

/** Shared services handed to every module. */
export interface Ctx {
  config: Config;
  db: Db;
  bus: Bus;
  clock: Clock;
  storage: Storage;
  presence: Presence;
  /** The server processes sharing the database: leader lease, messages between them. */
  instances: Instances;
  /** Short-lived values any process may be asked about (response URLs, trigger ids, one-time codes). */
  transient: Transient;
  /** The workspace row, or undefined before first-run setup. */
  team(): TeamRow | undefined;
  requireTeam(): TeamRow;
  /** Drop the cached workspace row after it changes. */
  invalidateTeam(): void;
  /** Message search through an external engine (Meilisearch), when one is connected. */
  externalSearch?: ExternalSearch;
}
