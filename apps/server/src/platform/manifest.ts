import type { IncomingMessage } from 'node:http';
import { isSameOrigin } from '../api/http.ts';
import type { Args } from '../api/registry.ts';
import type { Kernel } from '../app.ts';
import { actorForUser } from '../core/auth.ts';
import { ApiError, fail } from '../core/errors.ts';
import { newSecret, nowSeconds, sha256 } from '../core/ids.ts';
import { getUser, isAdmin, uniqueHandle, type UserRow } from '../core/users.ts';
import type { Actor } from '../ctx.ts';
import { announceBotUser, appConfig, createAppRecord, deleteAppRecord, getApp, parseList, readDomains, readFunctions, type AppFunction, type AppRow, type Shortcut } from './apps.ts';
import type { HttpDelivery } from './events-http.ts';
import { isHttpUrl } from './net.ts';
import { BOT_SCOPES, USER_SCOPES } from './oauth.ts';
import { newRefreshToken, redeemRefreshToken, ROTATING_TOKEN_TTL, sweepExpiredTokens } from './rotation.ts';
import type { SocketHub } from './socket-mode.ts';

/**
 * App manifests (`apps.manifest.*`), so an app's whole configuration can be
 * created, checked, changed and exported as one JSON document, the way Slack
 * apps are set up with a manifest. The methods take an app configuration
 * token (`xoxe.xoxp-…`, twelve hours, made by an admin under Administration →
 * Apps and renewed with `tooling.tokens.rotate`); the web client may call them
 * with an admin's session.
 *
 * Reference: docs.slack.dev/reference/app-manifest
 */

export interface ManifestError {
  message: string;
  pointer: string;
}

interface ManifestCommand {
  command: string;
  description: string;
  url: string | null;
  usage_hint: string;
}

export interface ParsedManifest {
  name: string;
  description: string;
  botName: string | null;
  commands: ManifestCommand[];
  shortcuts: Shortcut[];
  unfurlDomains: string[];
  redirectUrls: string[];
  botScopes: string[];
  userScopes: string[];
  eventsUrl: string | null;
  botEvents: string[];
  interactivityUrl: string | null;
  socketMode: boolean;
  tokenRotation: boolean;
  /** Custom workflow steps the app runs itself (`function_runtime: remote`). */
  functions: AppFunction[];
  raw: Record<string, unknown>;
}

/** Parts of a manifest that describe Slack-hosted workflow apps; nothing here runs them. */
const UNSUPPORTED_KEYS = ['workflows', 'datastores', 'types', 'outgoing_domains', 'events', 'external_auth_providers'];

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Check a manifest against the schema and what this server can run; collect every problem, as Slack does. */
export function readManifest(input: unknown): { manifest: ParsedManifest | null; errors: ManifestError[] } {
  const errors: ManifestError[] = [];
  const problem = (pointer: string, message: string): void => {
    errors.push({ message, pointer });
  };
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      return { manifest: null, errors: [{ message: 'The manifest is not valid JSON.', pointer: '/' }] };
    }
  }
  if (!isObject(raw)) return { manifest: null, errors: [{ message: 'The manifest must be a JSON object.', pointer: '/' }] };

  const section = (parent: Json, key: string, pointer: string, required = false): Json | null => {
    const value = parent[key];
    if (value === undefined || value === null) {
      if (required) problem(pointer, `Required field \`${key}\` is missing.`);
      return null;
    }
    if (!isObject(value)) {
      problem(pointer, `\`${key}\` must be an object.`);
      return null;
    }
    return value;
  };
  const text = (parent: Json | null, key: string, pointer: string, rules: { required?: boolean; max: number; min?: number }): string | null => {
    const value = parent?.[key];
    if (value === undefined || value === null || value === '') {
      if (rules.required) problem(pointer, `Required field \`${key}\` is missing.`);
      return null;
    }
    if (typeof value !== 'string') {
      problem(pointer, `\`${key}\` must be a string.`);
      return null;
    }
    if (value.length > rules.max) problem(pointer, `\`${key}\` must be at most ${rules.max} characters.`);
    if (rules.min && value.length < rules.min) problem(pointer, `\`${key}\` must be at least ${rules.min} characters.`);
    return value;
  };
  const flag = (parent: Json | null, key: string, pointer: string, required = false): boolean => {
    const value = parent?.[key];
    if (value === undefined || value === null) {
      if (required) problem(pointer, `Required field \`${key}\` is missing.`);
      return false;
    }
    if (typeof value !== 'boolean') problem(pointer, `\`${key}\` must be true or false.`);
    return value === true;
  };
  const list = (parent: Json | null, key: string, pointer: string, max: number): unknown[] => {
    const value = parent?.[key];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      problem(pointer, `\`${key}\` must be a list.`);
      return [];
    }
    if (value.length > max) problem(pointer, `\`${key}\` may have at most ${max} entries.`);
    return value;
  };
  const strings = (parent: Json | null, key: string, pointer: string, max: number, itemMax: number): string[] =>
    list(parent, key, pointer, max).flatMap((item, index) => {
      if (typeof item !== 'string' || !item || item.length > itemMax) {
        problem(`${pointer}/${index}`, `Each entry of \`${key}\` must be a string of at most ${itemMax} characters.`);
        return [];
      }
      return [item];
    });
  const url = (parent: Json | null, key: string, pointer: string): string | null => {
    const value = text(parent, key, pointer, { max: 3500 });
    if (value !== null && !isHttpUrl(value)) problem(pointer, `\`${key}\` must be an http(s) URL.`);
    return value;
  };

  for (const key of UNSUPPORTED_KEYS) {
    if (raw[key] !== undefined) problem(`/${key}`, `\`${key}\` describe apps that run on Slack's own platform; this server does not run them.`);
  }

  const display = section(raw, 'display_information', '/display_information', true);
  const name = text(display, 'name', '/display_information/name', { required: true, max: 35 });
  const description = text(display, 'description', '/display_information/description', { max: 140 }) ?? '';
  text(display, 'long_description', '/display_information/long_description', { max: 4000, min: 175 });
  const color = text(display, 'background_color', '/display_information/background_color', { max: 7 });
  if (color !== null && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) problem('/display_information/background_color', '`background_color` must be a hex color such as #4A154B.');

  const features = section(raw, 'features', '/features');
  const botUser = features ? section(features, 'bot_user', '/features/bot_user') : null;
  const botName = botUser ? text(botUser, 'display_name', '/features/bot_user/display_name', { required: true, max: 80 }) : null;
  if (botUser) flag(botUser, 'always_online', '/features/bot_user/always_online');
  const appHome = features ? section(features, 'app_home', '/features/app_home') : null;
  for (const key of ['home_tab_enabled', 'messages_tab_enabled', 'messages_tab_read_only_enabled']) flag(appHome, key, `/features/app_home/${key}`);
  for (const view of ['assistant_view', 'agent_view']) {
    const value = features ? section(features, view, `/features/${view}`) : null;
    if (value) text(value, view === 'assistant_view' ? 'assistant_description' : 'agent_description', `/features/${view}`, { required: true, max: 300 });
  }
  // Code channels: where an agent's channel commands go when the app uses HTTP (read back from the stored manifest).
  const codeChannels = features ? section(features, 'code_channels', '/features/code_channels') : null;
  if (codeChannels) {
    flag(codeChannels, 'enabled', '/features/code_channels/enabled');
    const commandUrl = text(codeChannels, 'slash_command_url', '/features/code_channels/slash_command_url', { max: 3000 });
    if (commandUrl !== null && !isHttpUrl(commandUrl)) problem('/features/code_channels/slash_command_url', '`slash_command_url` must be an http(s) URL.');
  }

  const settings = section(raw, 'settings', '/settings');
  const socketMode = flag(settings, 'socket_mode_enabled', '/settings/socket_mode_enabled');
  const tokenRotation = flag(settings, 'token_rotation_enabled', '/settings/token_rotation_enabled');
  flag(settings, 'org_deploy_enabled', '/settings/org_deploy_enabled');
  if (settings?.function_runtime === 'slack' || settings?.is_hosted === true) problem('/settings', 'Apps hosted by Slack cannot run on this server; use a remote runtime with Socket Mode or a request URL.');

  const commands: ManifestCommand[] = [];
  const seenCommands = new Set<string>();
  list(features, 'slash_commands', '/features/slash_commands', 50).forEach((entry, index) => {
    const pointer = `/features/slash_commands/${index}`;
    if (!isObject(entry)) return problem(pointer, 'Each slash command must be an object.');
    const command = text(entry, 'command', `${pointer}/command`, { required: true, max: 32 });
    const commandDescription = text(entry, 'description', `${pointer}/description`, { required: true, max: 2000 });
    const commandUrl = url(entry, 'url', `${pointer}/url`);
    const hint = text(entry, 'usage_hint', `${pointer}/usage_hint`, { max: 1000 }) ?? '';
    flag(entry, 'should_escape', `${pointer}/should_escape`);
    if (command === null || commandDescription === null) return;
    const normalized = command.toLowerCase();
    if (!/^\/[a-z0-9][a-z0-9_-]{0,31}$/.test(normalized)) return problem(`${pointer}/command`, 'A command is a slash followed by letters, digits, - or _.');
    if (seenCommands.has(normalized)) return problem(`${pointer}/command`, `${normalized} is listed twice.`);
    seenCommands.add(normalized);
    if (!commandUrl && !socketMode) problem(`${pointer}/url`, 'A slash command needs a URL unless Socket Mode is enabled.');
    commands.push({ command: normalized, description: commandDescription, url: commandUrl, usage_hint: hint });
  });

  const shortcuts: Shortcut[] = [];
  const shortcutEntries = list(features, 'shortcuts', '/features/shortcuts', 10);
  const seenCallbacks = new Set<string>();
  shortcutEntries.forEach((entry, index) => {
    const pointer = `/features/shortcuts/${index}`;
    if (!isObject(entry)) return problem(pointer, 'Each shortcut must be an object.');
    const shortcutName = text(entry, 'name', `${pointer}/name`, { required: true, max: 24 });
    const callbackId = text(entry, 'callback_id', `${pointer}/callback_id`, { required: true, max: 255 });
    const shortcutDescription = text(entry, 'description', `${pointer}/description`, { required: true, max: 150 });
    const type = entry.type;
    if (type !== 'global' && type !== 'message') return problem(`${pointer}/type`, '`type` must be "global" or "message".');
    if (shortcutName === null || callbackId === null || shortcutDescription === null) return;
    if (seenCallbacks.has(callbackId)) return problem(`${pointer}/callback_id`, `callback_id ${callbackId} is used twice.`);
    seenCallbacks.add(callbackId);
    shortcuts.push({ type, name: shortcutName, callback_id: callbackId, description: shortcutDescription });
  });
  for (const type of ['global', 'message'] as const) {
    if (shortcuts.filter((item) => item.type === type).length > 5) problem('/features/shortcuts', `At most five ${type} shortcuts.`);
  }

  let unfurlDomains: string[] = [];
  const domains = strings(features, 'unfurl_domains', '/features/unfurl_domains', 5, 255);
  try {
    unfurlDomains = readDomains(domains);
  } catch {
    problem('/features/unfurl_domains', 'Each unfurl domain must be a host name such as example.com.');
  }

  const oauth = section(raw, 'oauth_config', '/oauth_config');
  const redirectUrls = strings(oauth, 'redirect_urls', '/oauth_config/redirect_urls', 1000, 2500);
  redirectUrls.forEach((value, index) => {
    if (!isHttpUrl(value) || value.includes('#')) problem(`/oauth_config/redirect_urls/${index}`, 'A redirect URL must be an http(s) URL without a fragment.');
  });
  const scopes = oauth ? section(oauth, 'scopes', '/oauth_config/scopes') : null;
  const botScopes = strings(scopes, 'bot', '/oauth_config/scopes/bot', 255, 100);
  const userScopes = strings(scopes, 'user', '/oauth_config/scopes/user', 255, 100);
  botScopes.forEach((scope, index) => {
    if (!BOT_SCOPES.has(scope)) problem(`/oauth_config/scopes/bot/${index}`, `\`${scope}\` is not a bot scope this server grants.`);
  });
  userScopes.forEach((scope, index) => {
    if (!USER_SCOPES.has(scope)) problem(`/oauth_config/scopes/user/${index}`, `\`${scope}\` is not a user scope this server grants.`);
  });
  for (const [optional, base] of [['bot_optional', botScopes], ['user_optional', userScopes]] as const) {
    strings(scopes, optional, `/oauth_config/scopes/${optional}`, 255, 100).forEach((scope, index) => {
      if (!base.includes(scope)) problem(`/oauth_config/scopes/${optional}/${index}`, `\`${scope}\` must also be listed in \`${optional.replace('_optional', '')}\`.`);
    });
  }
  if (botScopes.length && !botUser) problem('/features/bot_user', 'Bot scopes need a bot user (`features.bot_user`).');

  const subscriptions = settings ? section(settings, 'event_subscriptions', '/settings/event_subscriptions') : null;
  const eventsUrl = url(subscriptions, 'request_url', '/settings/event_subscriptions/request_url');
  const botEvents = strings(subscriptions, 'bot_events', '/settings/event_subscriptions/bot_events', 100, 100);
  strings(subscriptions, 'user_events', '/settings/event_subscriptions/user_events', 100, 100);
  if (subscriptions && !eventsUrl && !socketMode) problem('/settings/event_subscriptions', 'Event Subscription requires either Request URL or Socket Mode Enabled');

  const interactivity = settings ? section(settings, 'interactivity', '/settings/interactivity') : null;
  const interactive = interactivity ? flag(interactivity, 'is_enabled', '/settings/interactivity/is_enabled', true) : false;
  const interactivityUrl = url(interactivity, 'request_url', '/settings/interactivity/request_url');
  url(interactivity, 'message_menu_options_url', '/settings/interactivity/message_menu_options_url');
  if (interactive && !interactivityUrl && !socketMode) problem('/settings/interactivity', 'Interactivity requires a Request URL');

  // Custom steps: Slack's `functions` object (keyed by callback id, parameters as JSON-schema-like
  // `properties` and `required`) becomes the list the workflow engine reads.
  let functions: AppFunction[] = [];
  if (raw.functions !== undefined) {
    if (!isObject(raw.functions)) problem('/functions', '`functions` must be an object keyed by callback id.');
    else {
      if (settings?.function_runtime !== 'remote') problem('/settings/function_runtime', 'Functions need `function_runtime: "remote"`: the app runs them over Socket Mode or a request URL.');
      const parameters = (value: unknown): Json[] => {
        if (!isObject(value) || !isObject(value.properties)) return [];
        const required = Array.isArray(value.required) ? value.required.map(String) : [];
        return Object.entries(value.properties).map(([key, spec]) => ({
          name: key,
          type: isObject(spec) ? spec.type : undefined,
          title: isObject(spec) ? spec.title ?? key : key,
          required: required.includes(key) || (isObject(spec) && spec.is_required === true),
        }));
      };
      try {
        functions = readFunctions(
          Object.entries(raw.functions).map(([callbackId, spec]) => ({
            callback_id: callbackId,
            title: isObject(spec) ? spec.title : callbackId,
            description: isObject(spec) ? spec.description : '',
            input_parameters: parameters(isObject(spec) ? spec.input_parameters : undefined),
            output_parameters: parameters(isObject(spec) ? spec.output_parameters : undefined),
          })),
        );
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        const detail = typeof error.extra.detail === 'string' ? `: ${error.extra.detail}` : '';
        problem('/functions', `A function is not valid${detail}. Parameter types may be string, user_id, channel_id, number or boolean.`);
      }
    }
  }

  if (errors.length || name === null) return { manifest: null, errors };
  return {
    manifest: {
      name,
      description,
      botName,
      commands,
      shortcuts,
      unfurlDomains,
      redirectUrls,
      botScopes,
      userScopes,
      eventsUrl,
      botEvents: [...new Set(botEvents)],
      interactivityUrl: interactive ? interactivityUrl : null,
      socketMode,
      tokenRotation,
      functions,
      raw,
    },
    errors,
  };
}

interface CommandRow {
  command: string;
  app_id: string;
  url: string | null;
  description: string;
  usage_hint: string;
}

/** The app as a manifest: what was last applied, brought up to date with any change made since. */
export function exportManifest(kernel: Kernel, app: AppRow): Json {
  const { ctx } = kernel;
  const config = appConfig(app);
  const base = structuredClone(config.manifest ?? {}) as Json;
  const pick = (value: unknown): Json => (isObject(value) ? value : {});
  const bot = getUser(ctx, app.bot_user_id);
  const commands = ctx.db.all<CommandRow>('SELECT * FROM commands WHERE app_id = ? ORDER BY command', app.id);
  const previousCommands = new Map(
    (Array.isArray(pick(base.features).slash_commands) ? (pick(base.features).slash_commands as unknown[]) : []).filter(isObject).map((entry) => [String(entry.command ?? '').toLowerCase(), entry]),
  );

  const display: Json = { ...pick(base.display_information), name: app.name };
  if (app.description) display.description = app.description;
  else delete display.description;

  const features: Json = { ...pick(base.features) };
  features.bot_user = { ...pick(features.bot_user), display_name: bot?.real_name || app.name, always_online: pick(features.bot_user).always_online === true };
  if (commands.length) {
    features.slash_commands = commands.map((row) => ({
      command: row.command,
      description: row.description,
      ...(row.url ? { url: row.url } : {}),
      ...(row.usage_hint ? { usage_hint: row.usage_hint } : {}),
      should_escape: previousCommands.get(row.command)?.should_escape === true,
    }));
  } else delete features.slash_commands;
  if (config.shortcuts.length) features.shortcuts = config.shortcuts;
  else delete features.shortcuts;
  if (config.unfurl_domains.length) features.unfurl_domains = config.unfurl_domains;
  else delete features.unfurl_domains;

  const oauth: Json = { ...pick(base.oauth_config) };
  if (config.redirect_urls.length) oauth.redirect_urls = config.redirect_urls;
  else delete oauth.redirect_urls;
  oauth.scopes = { ...pick(oauth.scopes), bot: parseList(app.bot_scopes) };

  const settings: Json = { ...pick(base.settings) };
  const requestUrl = app.events_url ?? config.pending_events_url ?? null;
  const botEvents = parseList(app.bot_events);
  const subscriptions: Json = { ...pick(settings.event_subscriptions) };
  if (requestUrl) subscriptions.request_url = requestUrl;
  else delete subscriptions.request_url;
  if (botEvents.length) subscriptions.bot_events = botEvents;
  else delete subscriptions.bot_events;
  if (Object.keys(subscriptions).length) settings.event_subscriptions = subscriptions;
  else delete settings.event_subscriptions;
  const interactivity: Json = { ...pick(settings.interactivity) };
  if (app.interactivity_url) Object.assign(interactivity, { is_enabled: true, request_url: app.interactivity_url });
  else {
    delete interactivity.request_url;
    interactivity.is_enabled = app.socket_mode === 1 && interactivity.is_enabled !== false;
  }
  settings.interactivity = interactivity;
  settings.org_deploy_enabled = settings.org_deploy_enabled === true;
  settings.socket_mode_enabled = app.socket_mode === 1;
  settings.is_hosted = false;
  settings.token_rotation_enabled = config.token_rotation_enabled;
  if (config.functions.length) settings.function_runtime = 'remote';

  const parameters = (list: AppFunction['input_parameters']): Json => ({
    properties: Object.fromEntries(list.map((item) => [item.name, { type: item.type === 'user_id' || item.type === 'channel_id' ? `slack#/types/${item.type}` : item.type, title: item.title }])),
    required: list.filter((item) => item.required).map((item) => item.name),
  });
  if (config.functions.length) {
    base.functions = Object.fromEntries(
      config.functions.map((fn) => [fn.callback_id, { title: fn.title, description: fn.description, input_parameters: parameters(fn.input_parameters), output_parameters: parameters(fn.output_parameters) }]),
    );
  } else delete base.functions;

  const rest = Object.fromEntries(Object.entries(base).filter(([key]) => !['_metadata', 'display_information', 'features', 'oauth_config', 'settings'].includes(key)));
  return {
    _metadata: isObject(base._metadata) ? base._metadata : { major_version: 1, minor_version: 1 },
    display_information: display,
    features,
    oauth_config: oauth,
    settings,
    ...rest,
  };
}

function authorizeUrl(kernel: Kernel, app: AppRow, manifest: ParsedManifest): string {
  const params = new URLSearchParams({ client_id: app.client_id });
  if (manifest.botScopes.length) params.set('scope', manifest.botScopes.join(','));
  if (manifest.userScopes.length) params.set('user_scope', manifest.userScopes.join(','));
  return `${kernel.ctx.config.publicUrl}/oauth/v2/authorize?${params}`;
}

export function installManifest(kernel: Kernel, sockets: SocketHub, http: HttpDelivery): void {
  const { ctx } = kernel;

  const sweeper = setInterval(() => {
    if (ctx.instances.isLeader()) sweepExpiredTokens(ctx);
  }, 3_600_000);
  sweeper.unref();
  kernel.onClose.push(() => clearInterval(sweeper));

  // ── App configuration tokens ────────────────────────────────────────────

  const issueConfigToken = (user: UserRow): Json => {
    const token = `xoxe.xoxp-1-${newSecret(36).replace(/[-_]/g, 'x')}`;
    const iat = nowSeconds();
    const exp = iat + ROTATING_TOKEN_TTL;
    ctx.db.run('INSERT INTO config_tokens (token_hash, user_id, hint, created, expires) VALUES (?, ?, ?, ?, ?)', sha256(token), user.id, `${token.slice(0, 12)}…${token.slice(-4)}`, iat, exp);
    const refresh = newRefreshToken(ctx, { kind: 'config', appId: null, userId: user.id, scopes: [] });
    return { token, refresh_token: refresh, team_id: ctx.requireTeam().id, user_id: user.id, iat, exp };
  };

  /** An admin makes a configuration token for `apps.manifest.*` (shown once). */
  kernel.registry.add('client.apps.configToken', { auth: 'admin' }, ({ actor }) => issueConfigToken(getUser(ctx, actor.userId)!));

  kernel.registry.addPublic('tooling.tokens.rotate', ({ args }) => {
    const spent = redeemRefreshToken(ctx, args.str('refresh_token'), { kind: 'config' });
    const user = getUser(ctx, spent.user_id);
    if (!user || user.deleted === 1 || !isAdmin(actorForUser(user, 'session', null))) fail('invalid_refresh_token');
    return issueConfigToken(user);
  });

  /** The admin behind a configuration token, or behind the web client's session. */
  const configUser = (req: IncomingMessage, args: Args, actor: Actor | null): UserRow => {
    const header = String(req.headers.authorization ?? '');
    const token = (/^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '') || args.str('token');
    if (!token) {
      if (actor?.kind !== 'session') fail('not_authed');
      if (req.method !== 'POST' || !isSameOrigin(req)) fail('invalid_auth');
      if (!isAdmin(actor)) fail('no_permission');
      return getUser(ctx, actor.userId)!;
    }
    const row = ctx.db.get<{ user_id: string; expires: number }>('SELECT user_id, expires FROM config_tokens WHERE token_hash = ?', sha256(token));
    if (!row) fail(ctx.db.get('SELECT 1 FROM tokens WHERE token_hash = ?', sha256(token)) ? 'not_allowed_token_type' : 'invalid_auth');
    if (row.expires <= nowSeconds()) fail('token_expired');
    const user = getUser(ctx, row.user_id);
    if (!user || user.deleted === 1) fail('invalid_auth');
    if (!isAdmin(actorForUser(user, 'session', null))) fail('no_permission');
    return user;
  };

  // A JSON string, as Slack takes it; a JSON request body may also carry the object itself.
  const manifestArg = (args: Args): unknown => {
    const value = args.raw.manifest;
    if (value === undefined || value === null || value === '') fail('invalid_arguments', { arg: 'manifest' });
    return value;
  };
  const parse = (args: Args): ParsedManifest => {
    const value = manifestArg(args);
    const { manifest, errors } = readManifest(value);
    if (!manifest) fail('invalid_manifest', { errors });
    return manifest;
  };
  const appArg = (args: Args): AppRow => {
    const id = args.str('app_id');
    if (!id) fail('invalid_app_id');
    return getApp(ctx, id) ?? fail('app_not_found');
  };

  /** Write a checked manifest onto an app: everything the manifest names is replaced. */
  const apply = async (app: AppRow, manifest: ParsedManifest): Promise<{ permissionsUpdated: boolean }> => {
    const config = appConfig(app);
    if (config.token_rotation_enabled && !manifest.tokenRotation) {
      fail('invalid_manifest', { errors: [{ message: 'Token rotation cannot be turned off once it is on.', pointer: '/settings/token_rotation_enabled' }] });
    }
    const taken = manifest.commands.flatMap((command, index) => {
      const owner = ctx.db.get<{ app_id: string }>('SELECT app_id FROM commands WHERE command = ?', command.command);
      return owner && owner.app_id !== app.id ? [{ message: `${command.command} is already used by another app.`, pointer: `/features/slash_commands/${index}/command` }] : [];
    });
    if (taken.length) fail('invalid_manifest', { errors: taken });

    // A new request URL takes over once it answers the verification handshake; until then it waits.
    let eventsUrl = manifest.eventsUrl === null ? null : app.events_url;
    let pending: string | null = null;
    if (manifest.eventsUrl && manifest.eventsUrl !== app.events_url) {
      try {
        await http.verifyUrl(app, manifest.eventsUrl);
        eventsUrl = manifest.eventsUrl;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        pending = manifest.eventsUrl;
      }
    }

    const previousBot = parseList(app.bot_scopes).sort().join(',');
    const previousUser = (() => {
      const scopes = isObject(config.manifest?.oauth_config) && isObject(config.manifest.oauth_config.scopes) ? config.manifest.oauth_config.scopes.user : [];
      return (Array.isArray(scopes) ? scopes.map(String) : []).sort().join(',');
    })();
    const permissionsUpdated = previousBot !== [...manifest.botScopes].sort().join(',') || previousUser !== [...manifest.userScopes].sort().join(',');
    const bot = getUser(ctx, app.bot_user_id);
    const botName = (manifest.botName ?? manifest.name).trim().slice(0, 80);

    ctx.db.tx(() => {
      ctx.db.run(
        `UPDATE apps SET name = ?, description = ?, socket_mode = ?, events_url = ?, interactivity_url = ?, bot_events = ?, bot_scopes = ?, config = ? WHERE id = ?`,
        manifest.name,
        manifest.description,
        manifest.socketMode ? 1 : 0,
        eventsUrl,
        manifest.interactivityUrl,
        JSON.stringify(manifest.botEvents),
        JSON.stringify(manifest.botScopes),
        JSON.stringify({
          ...config,
          shortcuts: manifest.shortcuts,
          unfurl_domains: manifest.unfurlDomains,
          redirect_urls: manifest.redirectUrls,
          token_rotation_enabled: manifest.tokenRotation,
          functions: manifest.functions,
          manifest: manifest.raw,
          pending_events_url: pending,
        }),
        app.id,
      );
      const keep = manifest.commands.map((command) => command.command);
      ctx.db.run(`DELETE FROM commands WHERE app_id = ? AND command NOT IN (${keep.map(() => '?').join(', ') || "''"})`, app.id, ...keep);
      for (const command of manifest.commands) {
        ctx.db.run(
          `INSERT INTO commands (command, app_id, url, description, usage_hint) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (command) DO UPDATE SET url = excluded.url, description = excluded.description, usage_hint = excluded.usage_hint`,
          command.command,
          app.id,
          command.url,
          command.description,
          command.usage_hint,
        );
      }
      if (bot && bot.real_name !== botName) ctx.db.run('UPDATE users SET real_name = ?, updated = ? WHERE id = ?', botName, nowSeconds(), bot.id);
    });
    if (bot && bot.real_name !== botName) announceBotUser(ctx, bot.id, 'user_change');
    if (!manifest.socketMode && app.socket_mode === 1) sockets.disconnectApp(app.id, 'link_disabled');
    return { permissionsUpdated };
  };

  kernel.registry.addPublic('apps.manifest.validate', ({ args, req, actor }) => {
    configUser(req, args, actor);
    const value = manifestArg(args);
    if (args.str('app_id') && !getApp(ctx, args.str('app_id')!)) fail('invalid_app_id');
    const { errors } = readManifest(value);
    if (errors.length) fail('invalid_manifest', { errors });
    return { errors: [] };
  });

  kernel.registry.addPublic('apps.manifest.create', async ({ args, req, actor }) => {
    const user = configUser(req, args, actor);
    const manifest = parse(args);
    const taken = manifest.commands.flatMap((command, index) =>
      ctx.db.get('SELECT 1 FROM commands WHERE command = ?', command.command) ? [{ message: `${command.command} is already used by another app.`, pointer: `/features/slash_commands/${index}/command` }] : [],
    );
    if (taken.length) fail('invalid_manifest', { errors: taken });
    const handleSeed = (manifest.botName ?? manifest.name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 21) || 'app';
    const { app, bot } = createAppRecord(ctx, {
      name: manifest.name,
      description: manifest.description,
      createdBy: user.id,
      handle: uniqueHandle(ctx, handleSeed),
      socketMode: manifest.socketMode,
    });
    announceBotUser(ctx, bot.id, 'team_join');
    try {
      await apply(app, manifest);
    } catch (error) {
      deleteAppRecord(ctx, getApp(ctx, app.id)!);
      throw error;
    }
    const created = getApp(ctx, app.id)!;
    return {
      app_id: created.id,
      credentials: {
        client_id: created.client_id,
        client_secret: created.client_secret,
        verification_token: created.verification_token,
        signing_secret: created.signing_secret,
      },
      oauth_authorize_url: authorizeUrl(kernel, created, manifest),
    };
  });

  kernel.registry.addPublic('apps.manifest.update', async ({ args, req, actor }) => {
    configUser(req, args, actor);
    const app = appArg(args);
    const manifest = parse(args);
    const { permissionsUpdated } = await apply(app, manifest);
    return { app_id: app.id, permissions_updated: permissionsUpdated };
  });

  kernel.registry.addPublic('apps.manifest.export', ({ args, req, actor }) => {
    configUser(req, args, actor);
    return { manifest: exportManifest(kernel, appArg(args)) };
  });

  kernel.registry.addPublic('apps.manifest.delete', ({ args, req, actor }) => {
    configUser(req, args, actor);
    const app = appArg(args);
    deleteAppRecord(ctx, app);
    sockets.disconnectApp(app.id, 'link_disabled');
  });
}
