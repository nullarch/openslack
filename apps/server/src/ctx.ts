import type { ScannerConfig } from './core/scanner.ts';
import type { Role } from '@app/shared';
import type { Bus } from './core/bus.ts';
import type { Clock } from './core/clock.ts';
import type { S3Config, Storage } from './core/storage.ts';
import type { LiveKitConfig } from './huddles/livekit.ts';
import type { Db } from './db/db.ts';

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
  /** Sender address for outgoing mail. */
  mailFrom?: string;
  /** External sign-in providers configured by the operator. */
  identityProviders?: IdentityProviderConfig[];
  /** Bearer token that unlocks `/metrics`; null or absent hides it. */
  metricsToken?: string | null;
}

/** One external sign-in provider. Endpoints are discovered for OIDC providers. */
export interface IdentityProviderConfig {
  /** Path segment and stored provider name: `google`, `github` or `oidc`. */
  id: string;
  /** Button label. */
  label: string;
  kind: 'oidc' | 'github';
  clientId: string;
  clientSecret: string;
  /** OIDC issuer (discovery at `<issuer>/.well-known/openid-configuration`). */
  issuer?: string;
  /** GitHub web and API origins (overridable for GitHub Enterprise and tests). */
  webUrl?: string;
  apiUrl?: string;
  /** Create an account on first sign-in, within the workspace's approved domains. */
  createAccounts: boolean;
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
  /** The workspace row, or undefined before first-run setup. */
  team(): TeamRow | undefined;
  requireTeam(): TeamRow;
  /** Drop the cached workspace row after it changes. */
  invalidateTeam(): void;
}
