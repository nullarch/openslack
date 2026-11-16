import type { Role } from '@app/shared';
import type { Bus } from './core/bus.ts';
import type { Clock } from './core/clock.ts';
import type { Storage } from './core/storage.ts';
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
  cookieSecure: boolean;
  version: string;
  quiet: boolean;
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
