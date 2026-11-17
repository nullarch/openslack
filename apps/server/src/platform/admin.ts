import { DEFAULT_API_RATE_LIMIT, TOKEN_LIMIT_RANGE, workspaceTokenLimit } from '../api/http.ts';
import type { Kernel } from '../app.ts';
import { fail } from '../core/errors.ts';
import { nowSeconds } from '../core/ids.ts';
import { announceBotUser, appConfig, appToApi, createAppRecord, deleteAppRecord, issueToken, listApps, readDomains, readShortcuts, requireApp, readRedirectUrls } from './apps.ts';
import { SUBSCRIBABLE_EVENTS } from './dispatch.ts';
import type { HttpDelivery } from './events-http.ts';
import { isHttpUrl } from './net.ts';
import type { SocketHub } from './socket-mode.ts';

interface UnknownRow {
  name: string;
  calls: number;
  first_seen: number;
  last_seen: number;
}

const MAX_UNKNOWN_NAMES = 2000;

/** An optional URL argument: absent keeps the old value, empty clears it. */
function urlArg(value: string | undefined, current: string | null): string | null {
  if (value === undefined) return current;
  if (value === '') return null;
  if (!isHttpUrl(value) || value.length > 2000) fail('invalid_url');
  return value;
}

/**
 * App management for the web client (`client.apps.*`): what Slack does on
 * api.slack.com/apps. Anyone signed in may see which apps exist; creating,
 * changing and removing them, and seeing credentials, is for admins.
 */
export function installAdmin(kernel: Kernel, sockets: SocketHub, http: HttpDelivery): void {
  const { ctx } = kernel;
  const info = (id: string) => appToApi(ctx, requireApp(ctx, id), sockets.isConnected(id));

  kernel.registry.add('client.apps.list', { auth: 'session' }, () => ({
    apps: listApps(ctx).map((app) => appToApi(ctx, app, sockets.isConnected(app.id))),
  }));

  /** One app with its signing secret, which the admin needs again when configuring HTTP delivery. */
  kernel.registry.add('client.apps.info', { auth: 'admin' }, ({ args }) => {
    const app = requireApp(ctx, args.str('app'));
    return {
      app: info(app.id),
      signing_secret: app.signing_secret,
      client_id: app.client_id,
      client_secret: app.client_secret,
      redirect_urls: appConfig(app).redirect_urls,
      subscribable_events: SUBSCRIBABLE_EVENTS,
    };
  });

  kernel.registry.add('client.apps.create', { auth: 'admin' }, ({ actor, args }) => {
    const { app, bot } = createAppRecord(ctx, {
      name: args.req('name'),
      description: args.str('description'),
      createdBy: actor.userId,
      socketMode: args.has('socket_mode') ? args.bool('socket_mode') : true,
    });
    announceBotUser(ctx, bot.id, 'team_join');
    // Tokens are stored hashed; this response is the only time they are shown.
    const botToken = issueToken(ctx, app, 'bot');
    const appToken = issueToken(ctx, app, 'app');
    // Described after issuing, so `token_hints` already names the tokens above.
    return { app: info(app.id), bot_token: botToken, app_token: appToken, signing_secret: app.signing_secret };
  });

  kernel.registry.add('client.apps.update', { auth: 'admin' }, async ({ args }) => {
    const app = requireApp(ctx, args.str('app'));
    const name = args.has('name') ? args.req('name').trim().slice(0, 80) : app.name;
    if (!name) fail('invalid_name');
    const description = args.str('description')?.trim().slice(0, 500) ?? app.description;
    const socketMode = args.has('socket_mode') ? args.bool('socket_mode') : app.socket_mode === 1;
    const eventsUrl = urlArg(args.str('events_url'), app.events_url);
    const interactivityUrl = urlArg(args.str('interactivity_url'), app.interactivity_url);
    let botEvents = app.bot_events;
    if (args.has('bot_events') || args.str('bot_events') === '') {
      const wanted = args.list('bot_events');
      const unknown = wanted.find((entry) => !SUBSCRIBABLE_EVENTS.includes(entry));
      if (unknown) fail('invalid_event', { event: unknown });
      botEvents = JSON.stringify([...new Set(wanted)]);
    }
    const config = appConfig(app);
    if (args.has('shortcuts')) config.shortcuts = readShortcuts(args.json('shortcuts'));
    if (args.has('unfurl_domains') || args.str('unfurl_domains') === '') config.unfurl_domains = readDomains(args.list('unfurl_domains'));
    if (args.has('redirect_urls') || args.str('redirect_urls') === '') config.redirect_urls = readRedirectUrls(args.list('redirect_urls'));
    // A new request URL must prove it belongs to the app before it receives anything.
    if (eventsUrl && eventsUrl !== app.events_url) await http.verifyUrl(app, eventsUrl);

    ctx.db.run(
      `UPDATE apps SET name = ?, description = ?, socket_mode = ?, events_url = ?, interactivity_url = ?, bot_events = ?, config = ?
       WHERE id = ?`,
      name,
      description,
      socketMode ? 1 : 0,
      eventsUrl,
      interactivityUrl,
      botEvents,
      JSON.stringify(config),
      app.id,
    );
    if (name !== app.name) {
      ctx.db.run('UPDATE users SET real_name = ?, updated = ? WHERE id = ?', name, nowSeconds(), app.bot_user_id);
      announceBotUser(ctx, app.bot_user_id, 'user_change');
    }
    if (!socketMode && app.socket_mode === 1) sockets.disconnectApp(app.id, 'link_disabled');
    return { app: info(app.id) };
  });

  kernel.registry.add('client.apps.delete', { auth: 'admin' }, ({ args }) => {
    const app = requireApp(ctx, args.str('app'));
    deleteAppRecord(ctx, app);
    sockets.disconnectApp(app.id, 'link_disabled');
  });

  kernel.registry.add('client.apps.rotateToken', { auth: 'admin' }, ({ args }) => {
    const app = requireApp(ctx, args.str('app'));
    const kind = args.req('kind');
    if (kind !== 'bot' && kind !== 'app') fail('invalid_arguments', { needed: 'kind' });
    const token = issueToken(ctx, app, kind);
    // Connections opened with the old app-level token must not outlive it.
    if (kind === 'app') sockets.disconnectApp(app.id, 'link_disabled');
    return { token };
  });

  // ── API rate limit for tokens ──────────────────────────────────────────────

  /** The per-token limit apps run under: the workspace's setting, or the built-in default. */
  kernel.registry.add('client.apps.limits', { auth: 'session' }, () => ({
    api_rate_limit_per_minute: workspaceTokenLimit(ctx) ?? null,
    default_per_minute: DEFAULT_API_RATE_LIMIT,
    min: TOKEN_LIMIT_RANGE.min,
    max: TOKEN_LIMIT_RANGE.max,
  }));

  /** Set the per-token limit (calls per minute); 0 or empty goes back to the default. */
  kernel.registry.add('client.apps.setRateLimit', { auth: 'admin' }, ({ args }) => {
    const team = ctx.requireTeam();
    const value = args.int('per_minute', 0);
    if (value === 0) {
      ctx.db.run("UPDATE team SET prefs = json_remove(prefs, '$.api_rate_limit_per_minute') WHERE id = ?", team.id);
    } else {
      if (value < TOKEN_LIMIT_RANGE.min || value > TOKEN_LIMIT_RANGE.max) fail('invalid_limit', { min: TOKEN_LIMIT_RANGE.min, max: TOKEN_LIMIT_RANGE.max });
      ctx.db.run("UPDATE team SET prefs = json_set(prefs, '$.api_rate_limit_per_minute', ?) WHERE id = ?", value, team.id);
    }
    ctx.invalidateTeam();
    return { api_rate_limit_per_minute: workspaceTokenLimit(ctx) ?? null, default_per_minute: DEFAULT_API_RATE_LIMIT };
  });

  // ── Methods that were asked for but do not exist ───────────────────────────

  kernel.registry.onUnknown = (name) => {
    if (!/^[A-Za-z][A-Za-z0-9_.]{0,99}$/.test(name)) return;
    const now = nowSeconds();
    const known = ctx.db.get('SELECT 1 FROM unknown_methods WHERE name = ?', name) !== undefined;
    if (!known) {
      const total = ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM unknown_methods')?.n ?? 0;
      if (total >= MAX_UNKNOWN_NAMES) return;
    }
    ctx.db.run(
      `INSERT INTO unknown_methods (name, calls, first_seen, last_seen) VALUES (?, 1, ?, ?)
       ON CONFLICT (name) DO UPDATE SET calls = calls + 1, last_seen = excluded.last_seen`,
      name,
      now,
      now,
    );
  };

  /** Which missing methods callers asked for, most requested first. */
  kernel.registry.add('client.apps.unknownMethods', { auth: 'admin' }, () => ({
    methods: ctx.db.all<UnknownRow>('SELECT * FROM unknown_methods ORDER BY calls DESC, name LIMIT 500'),
  }));
}
