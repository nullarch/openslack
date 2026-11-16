import type { Kernel } from '../app.ts';
import { getMember, resolveConv } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { requireUser } from '../core/users.ts';
import { getApp, requireApp } from './apps.ts';
import {
  deliverInteractive,
  liveConv,
  newTriggerId,
  payloadChannelName,
  type Interactivity,
} from './interactivity.ts';
import { isHttpUrl } from './net.ts';
import { hasContent, readResponseContent } from './responses.ts';

interface CommandRow {
  command: string;
  app_id: string;
  url: string | null;
  description: string;
  usage_hint: string;
}

/** Slash command names: a slash, then lowercase letters, digits, `-` or `_`. */
function normalizeCommand(input: string): string {
  const name = `/${input.trim().toLowerCase().replace(/^\/+/, '')}`;
  if (!/^\/[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) fail('invalid_command');
  return name;
}

function commandToApi(row: CommandRow, appName: string): Record<string, unknown> {
  return {
    command: row.command,
    description: row.description,
    usage_hint: row.usage_hint,
    url: row.url,
    app_id: row.app_id,
    app_name: appName,
  };
}

export function installCommands(kernel: Kernel, deps: Interactivity): void {
  const { ctx } = deps;

  /** Define or change a slash command of an app. `url` is only needed for apps not using Socket Mode. */
  kernel.registry.add('client.apps.commands.set', { auth: 'admin' }, ({ args }) => {
    const app = requireApp(ctx, args.str('app'));
    const command = normalizeCommand(args.req('command'));
    const existing = ctx.db.get<CommandRow>('SELECT * FROM commands WHERE command = ?', command);
    if (existing && existing.app_id !== app.id) fail('command_taken');
    const url = args.has('url') ? args.req('url') : (existing?.url ?? null);
    if (url !== null && !isHttpUrl(url)) fail('invalid_url');
    ctx.db.run(
      `INSERT INTO commands (command, app_id, url, description, usage_hint) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (command) DO UPDATE SET url = excluded.url, description = excluded.description, usage_hint = excluded.usage_hint`,
      command,
      app.id,
      url,
      (args.str('description') ?? existing?.description ?? '').slice(0, 200),
      (args.str('usage_hint') ?? existing?.usage_hint ?? '').slice(0, 200),
    );
    const row = ctx.db.get<CommandRow>('SELECT * FROM commands WHERE command = ?', command)!;
    return { command: commandToApi(row, app.name) };
  });

  kernel.registry.add('client.apps.commands.delete', { auth: 'admin' }, ({ args }) => {
    const app = requireApp(ctx, args.str('app'));
    const result = ctx.db.run('DELETE FROM commands WHERE command = ? AND app_id = ?', normalizeCommand(args.req('command')), app.id);
    if (result.changes === 0) fail('command_not_found');
  });

  /** Every slash command, for the composer's autocomplete. */
  kernel.registry.add('client.commands.list', { auth: 'session' }, () => {
    const rows = ctx.db.all<CommandRow>('SELECT * FROM commands ORDER BY command');
    return { commands: rows.map((row) => commandToApi(row, getApp(ctx, row.app_id)?.name ?? '')) };
  });

  /**
   * A person ran a slash command. The command payload goes to its app; an
   * immediate response in the acknowledgement is shown to that person only,
   * or posted to the conversation when the app asks for `in_channel`.
   */
  kernel.registry.add('client.commands.run', { auth: 'session' }, async ({ actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    if (!getMember(ctx, conv.id, actor.userId)) fail('not_in_channel');
    const command = normalizeCommand(args.req('command'));
    const row = ctx.db.get<CommandRow>('SELECT * FROM commands WHERE command = ?', command);
    const app = row ? getApp(ctx, row.app_id) : undefined;
    if (!row || !app) fail('command_not_found');

    const user = requireUser(ctx, actor.userId);
    const team = ctx.requireTeam();
    const payload = {
      token: app.verification_token,
      team_id: team.id,
      team_domain: team.domain,
      channel_id: conv.id,
      channel_name: payloadChannelName(conv),
      user_id: user.id,
      user_name: user.name,
      command,
      text: args.str('text') ?? '',
      api_app_id: app.id,
      is_enterprise_install: 'false',
      response_url: deps.hooks.create({ app, kind: 'commands', conversationId: conv.id, userId: user.id }),
      trigger_id: newTriggerId(),
    };
    // Slack has no commands inside threads; when the client runs one there, answer there.
    const threadTs = args.ts('thread_ts');
    const answer = await deliverInteractive(deps, app, 'slash_commands', payload, row.url);
    if (answer && typeof answer === 'object') {
      const body = { ...(answer as Record<string, unknown>) };
      if (threadTs && body.thread_ts === undefined) body.thread_ts = threadTs;
      const content = readResponseContent(body);
      if (hasContent(content)) deps.hooks.publish(liveConv(ctx, conv.id), app, user.id, body, content);
    }
    return {};
  });
}
