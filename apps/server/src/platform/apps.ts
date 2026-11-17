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
  /** Where the OAuth install flow may send people back to (exact match). */
  redirect_urls: string[];
  /** Workflow steps the app implements (`function_executed`, `functions.completeSuccess`). */
  functions: AppFunction[];
  /** Set on apps that are part of the server itself, e.g. `workflows`. */
  builtin?: string;
  /** OAuth installs hand out twelve-hour tokens with refresh tokens; cannot be turned off again. */
  token_rotation_enabled: boolean;
  /** The last manifest applied to the app, kept so an export gives back what was put in. */
  manifest?: Record<string, unknown>;
  /** A request URL from a manifest that has not answered the verification handshake yet. */
  pending_events_url?: string | null;
}

export interface FunctionParameter {
  name: string;
  title: string;
  /** `string`, `user_id`, `channel_id`, `number`, `boolean` (Slack's names, without the `slack#/types/` prefix). */
  type: string;
  required: boolean;
}

/** A custom step, as an app declares it (Slack's manifest `functions` entry). */
export interface AppFunction {
  callback_id: string;
  title: string;
  description: string;
  input_parameters: FunctionParameter[];
  output_parameters: FunctionParameter[];
}

const PARAMETER_TYPES = new Set(['string', 'user_id', 'channel_id', 'number', 'boolean']);

function readParameters(value: unknown, where: string): FunctionParameter[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) fail('invalid_functions', { detail: where });
  const seen = new Set<string>();
  return value.map((entry) => {
    const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const name = String(item.name ?? '').trim();
    if (!/^[a-z0-9_]{1,50}$/i.test(name) || seen.has(name)) fail('invalid_functions', { detail: `${where}: ${name || 'a parameter without a name'}` });
    seen.add(name);
    const type = String(item.type ?? 'string').replace(/^slack#\/types\//, '');
    if (!PARAMETER_TYPES.has(type)) fail('invalid_functions', { detail: `${where}: unknown type ${type}` });
    return { name, title: String(item.title ?? name).slice(0, 80), type, required: item.required === true || item.is_required === true };
  });
}

/** Check custom steps sent by an admin. */
export function readFunctions(value: unknown): AppFunction[] {
  if (!Array.isArray(value) || value.length > 20) fail('invalid_functions');
  const seen = new Set<string>();
  return value.map((entry) => {
    const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const callbackId = String(item.callback_id ?? '').trim();
    if (!/^[a-z0-9_-]{1,100}$/i.test(callbackId) || seen.has(callbackId)) fail('invalid_functions', { detail: callbackId || 'a step without a callback_id' });
    seen.add(callbackId);
    return {
      callback_id: callbackId,
      title: String(item.title ?? callbackId).slice(0, 80) || callbackId,
      description: String(item.description ?? '').slice(0, 300),
      input_parameters: readParameters(item.input_parameters, callbackId),
      output_parameters: readParameters(item.output_parameters, callbackId),
    };
  });
}

export function isBuiltinApp(app: AppRow): boolean {
  return Boolean(appConfig(app).builtin);
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
  const redirects = Array.isArray(raw.redirect_urls) ? raw.redirect_urls.filter((entry): entry is string => typeof entry === 'string') : [];
  const functions = Array.isArray(raw.functions) ? (raw.functions as AppFunction[]) : [];
  const manifest = raw.manifest && typeof raw.manifest === 'object' ? (raw.manifest as Record<string, unknown>) : undefined;
  const pending = typeof raw.pending_events_url === 'string' ? raw.pending_events_url : null;
  const config: AppConfig = {
    shortcuts,
    unfurl_domains: domains,
    redirect_urls: redirects,
    functions,
    token_rotation_enabled: raw.token_rotation_enabled === true,
    manifest,
    pending_events_url: pending,
  };
  if (typeof raw.builtin === 'string') config.builtin = raw.builtin;
  return config;
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
/** Check OAuth redirect URLs sent by an admin: absolute http(s) URLs, at most ten. */
export function readRedirectUrls(values: string[]): string[] {
  if (values.length > 10) fail('invalid_redirect_urls');
  return [...new Set(values)].map((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      fail('invalid_redirect_urls', { detail: value });
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') fail('invalid_redirect_urls', { detail: value });
    if (url.hash) fail('invalid_redirect_urls', { detail: value });
    return url.href;
  });
}

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
  'calls:read',
  'calls:write',
  'canvases:read',
  'canvases:write',
  'channels:history',
  'channels:join',
  'channels:manage',
  'channels:read',
  'chat:write',
  'chat:write.customize',
  'chat:write.public',
  'code_channels:manage',
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
  'lists:read',
  'lists:write',
  'mpim:history',
  'mpim:read',
  'mpim:write',
  'pins:read',
  'pins:write',
  'reactions:read',
  'reactions:write',
  'remote_files:read',
  'remote_files:share',
  'remote_files:write',
  'search:read',
  'team.preferences:read',
  'team:read',
  'tokens.basic',
  'users.profile:read',
  'users:read',
  'users:read.email',
  'users:write',
];

/** The only thing an app-level token may do is open Socket Mode connections. */
export const APP_TOKEN_SCOPES = ['authorizations:read', 'connections:write'];

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
