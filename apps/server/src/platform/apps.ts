import type { Ctx } from '../ctx.ts';
import { createToken } from '../core/auth.ts';
import { fail } from '../core/errors.ts';
import { newHex, newId, newSecret, nowSeconds } from '../core/ids.ts';
import { createUser, getUser, userToApi, type UserRow } from '../core/users.ts';

export interface AppRow {
  id: string;
  name: string;
  description: string;
  created_by: string;
  bot_user_id: string;
  bot_id: string;
  signing_secret: string;
  client_id: string;
  client_secret: string;
  verification_token: string;
  socket_mode: number;
  events_url: string | null;
  interactivity_url: string | null;
  bot_events: string;
  bot_scopes: string;
  config: string;
  created: number;
}

/** What the web client and admins see. No secrets. */
export interface AppInfo {
  id: string;
  name: string;
  description: string;
  bot_user_id: string;
  bot_id: string;
  socket_mode: boolean;
  events_url: string | null;
  interactivity_url: string | null;
  bot_events: string[];
  created: number;
  created_by: string;
  /** A Socket Mode connection is open right now. */
  connected: boolean;
  token_hints: { bot: string | null; app: string | null };
  /** Global and message shortcuts the app offers. */
  shortcuts: Shortcut[];
  /** Domains whose links the app unfurls (`link_shared`, `chat.unfurl`). */
  unfurl_domains: string[];
}

export interface Shortcut {
  type: 'global' | 'message';
  name: string;
  callback_id: string;
  description: string;
}

/** Settings kept in the `config` column: shortcuts and unfurl domains. */
export interface AppConfig {
  shortcuts: Shortcut[];
  unfurl_domains: string[];
}

export function appConfig(app: AppRow): AppConfig {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(app.config);
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    // An unreadable config is an empty one.
  }
  const shortcuts = Array.isArray(raw.shortcuts) ? (raw.shortcuts as Shortcut[]) : [];
  const domains = Array.isArray(raw.unfurl_domains) ? raw.unfurl_domains.filter((entry): entry is string => typeof entry === 'string') : [];
  return { shortcuts, unfurl_domains: domains };
}

/** Check shortcuts sent by an admin: a known type, a name, a unique callback id. */
export function readShortcuts(value: unknown): Shortcut[] {
  if (!Array.isArray(value) || value.length > 10) fail('invalid_shortcuts');
  const seen = new Set<string>();
  return value.map((entry) => {
    const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const type = item.type === 'message' ? 'message' : item.type === 'global' ? 'global' : fail('invalid_shortcuts');
    const name = String(item.name ?? '').trim().slice(0, 30);
    const callbackId = String(item.callback_id ?? '').trim();
    if (!name || !/^[A-Za-z0-9_.-]{1,255}$/.test(callbackId) || seen.has(callbackId)) fail('invalid_shortcuts');
    seen.add(callbackId);
    return { type, name, callback_id: callbackId, description: String(item.description ?? '').trim().slice(0, 100) };
  });
}

/** Unfurl domains: host names without scheme or path, at most five. */
export function readDomains(values: string[]): string[] {
  if (values.length > 5) fail('invalid_unfurl_domains');
  return [
    ...new Set(
      values.map((value) => {
        const domain = value.trim().toLowerCase().replace(/^\*\./, '');
        if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) fail('invalid_unfurl_domains');
        return domain;
      }),
    ),
  ];
}

/**
 * Scopes a new app's bot token gets. Deliberately broad: on a self-hosted
 * server the admin who creates the app is the one who would approve the scopes.
 */
export const DEFAULT_BOT_SCOPES = [
  'app_mentions:read',
  'assistant:write',
  'channels:history',
  'channels:join',
  'channels:manage',
  'channels:read',
  'chat:write',
  'chat:write.customize',
  'chat:write.public',
  'commands',
  'emoji:read',
  'files:read',
  'files:write',
  'groups:history',
  'groups:read',
  'groups:write',
  'im:history',
  'im:read',
  'im:write',
  'incoming-webhook',
  'links:read',
  'links:write',
  'mpim:history',
  'mpim:read',
  'mpim:write',
  'pins:read',
  'pins:write',
  'reactions:read',
  'reactions:write',
  'search:read',
  'team:read',
  'users.profile:read',
  'users:read',
  'users:read.email',
  'users:write',
];

/** The only thing an app-level token may do is open Socket Mode connections. */
export const APP_TOKEN_SCOPES = ['connections:write'];

export function getApp(ctx: Ctx, id: string): AppRow | undefined {
  return ctx.db.get<AppRow>('SELECT * FROM apps WHERE id = ?', id);
}

export function requireApp(ctx: Ctx, id: string | undefined): AppRow {
  return (id ? getApp(ctx, id) : undefined) ?? fail('app_not_found');
}

export function listApps(ctx: Ctx): AppRow[] {
  return ctx.db.all<AppRow>('SELECT * FROM apps ORDER BY created, id');
}

export function parseList(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export interface NewApp {
  name: string;
  description?: string;
  createdBy: string;
  /** Handle for the bot user; derived from the name when omitted. */
  handle?: string;
  /** Deliver over Socket Mode (the default) rather than to HTTP request URLs. */
  socketMode?: boolean;
}

/**
 * Create an app and its bot user. Tokens are issued separately with
 * `issueToken`, so seeded apps can exist without any credential.
 */
export function createAppRecord(ctx: Ctx, input: NewApp): { app: AppRow; bot: UserRow } {
  const name = input.name.trim().slice(0, 80);
  if (!name) fail('invalid_name');
  const appId = newId('A');
  const botId = newId('B');
  return ctx.db.tx(() => {
    const bot = createUser(ctx, { realName: name, isBot: true, botId, appId, handle: input.handle });
    ctx.db.run(
      `INSERT INTO apps (id, name, description, created_by, bot_user_id, bot_id, signing_secret, client_id, client_secret,
         verification_token, socket_mode, bot_scopes, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      appId,
      name,
      (input.description ?? '').trim().slice(0, 500),
      input.createdBy,
      bot.id,
      botId,
      newHex(16),
      `${newId('', 11)}.${newId('', 13)}`,
      newHex(16),
      newSecret(18).replace(/[-_]/g, 'x'),
      input.socketMode === false ? 0 : 1,
      JSON.stringify(DEFAULT_BOT_SCOPES),
      nowSeconds(),
    );
    return { app: getApp(ctx, appId)!, bot };
  });
}

/** Replace the app's token of one kind and return the new value (shown once). */
export function issueToken(ctx: Ctx, app: AppRow, kind: 'bot' | 'app'): string {
  ctx.db.run('DELETE FROM tokens WHERE app_id = ? AND kind = ?', app.id, kind);
  return createToken(ctx, {
    kind,
    userId: app.bot_user_id,
    appId: app.id,
    scopes: kind === 'bot' ? parseList(app.bot_scopes) : APP_TOKEN_SCOPES,
  });
}

function tokenHint(ctx: Ctx, appId: string, kind: 'bot' | 'app'): string | null {
  return (
    ctx.db.get<{ hint: string }>('SELECT hint FROM tokens WHERE app_id = ? AND kind = ? ORDER BY created DESC', appId, kind)
      ?.hint ?? null
  );
}

export function appToApi(ctx: Ctx, app: AppRow, connected: boolean): AppInfo {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    bot_user_id: app.bot_user_id,
    bot_id: app.bot_id,
    socket_mode: app.socket_mode === 1,
    events_url: app.events_url,
    interactivity_url: app.interactivity_url,
    bot_events: parseList(app.bot_events),
    created: app.created,
    created_by: app.created_by,
    connected,
    token_hints: { bot: tokenHint(ctx, app.id, 'bot'), app: tokenHint(ctx, app.id, 'app') },
    ...appConfig(app),
  };
}

/** Tell clients (and apps) that a bot user appeared or changed. */
export function announceBotUser(ctx: Ctx, userId: string, type: 'team_join' | 'user_change'): void {
  const row = getUser(ctx, userId);
  if (!row) return;
  ctx.bus.emit({
    event: { type, user: userToApi(ctx, row), event_ts: ctx.clock.eventTs() },
    audience: { all: true },
  });
}

/** Remove an app: its tokens, commands, webhooks and queued deliveries go; its bot user is deactivated. */
export function deleteAppRecord(ctx: Ctx, app: AppRow): void {
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM tokens WHERE app_id = ?', app.id);
    ctx.db.run('DELETE FROM outbox WHERE app_id = ?', app.id);
    ctx.db.run('DELETE FROM apps WHERE id = ?', app.id);
    ctx.db.run('UPDATE users SET deleted = 1, updated = ? WHERE id = ?', nowSeconds(), app.bot_user_id);
  });
  announceBotUser(ctx, app.bot_user_id, 'user_change');
}
