import type { Message } from '@app/shared';
import type { Kernel } from '../app.ts';
import { resolveConv } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { getMessage, messageToApi } from '../core/messages.ts';
import { appConfig, getApp, listApps, requireApp } from './apps.ts';
import { locate, withBlockIds, type Json } from './elements.ts';
import { deliverInteractive, payloadChannelName, payloadUser, type Interactivity } from './interactivity.ts';
import { allLocalApps, localApp } from './local-apps.ts';
import { readOptions } from './views.ts';

/**
 * Shortcuts and menus that load their options from the app:
 * - global shortcuts (`shortcut` payloads), started from the composer or the quick switcher;
 * - message shortcuts (`message_action` payloads), started from a message's menu;
 * - `block_suggestion` for `external_select` menus in messages (views have their own).
 */
export function installShortcuts(kernel: Kernel, deps: Interactivity): void {
  const { ctx } = deps;

  /** Every shortcut of every app, for the shortcut menus. */
  kernel.registry.add('client.shortcuts.list', { auth: 'session' }, ({ actor }) => ({
    shortcuts: [
      ...listApps(ctx).flatMap((app) => appConfig(app).shortcuts.map((shortcut) => ({ ...shortcut, app_id: app.id, app_name: app.name }))),
      // Built-in apps offer shortcuts per person (published workflows).
      ...allLocalApps(ctx).flatMap((local) => {
        const app = getApp(ctx, local.appId);
        return app ? (local.shortcuts?.(actor) ?? []).map((shortcut) => ({ ...shortcut, app_id: app.id, app_name: app.name })) : [];
      }),
    ],
  }));

  kernel.registry.add('client.shortcuts.run', { auth: 'session' }, async ({ actor, args }) => {
    const app = requireApp(ctx, args.str('app'));
    const callbackId = args.req('callback_id');
    const local = localApp(ctx, app.id);
    if (local?.runShortcut) {
      await local.runShortcut(actor, callbackId, { channel: args.str('context_channel') });
      return {};
    }
    const shortcut = appConfig(app).shortcuts.find((entry) => entry.callback_id === callbackId);
    if (!shortcut) fail('shortcut_not_found');
    const team = ctx.requireTeam();
    const base: Json = {
      callback_id: callbackId,
      trigger_id: deps.triggers.issue(app.id, actor.userId, args.str('context_channel') ?? null),
      user: payloadUser(ctx, actor.userId),
      team: { id: team.id, domain: team.domain },
      token: app.verification_token,
      action_ts: ctx.clock.eventTs(),
      is_enterprise_install: false,
      enterprise: null,
    };

    let payload: Json;
    if (shortcut.type === 'global') {
      payload = { type: 'shortcut', ...base };
    } else {
      const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
      const ts = args.reqTs('message_ts');
      const row = getMessage(ctx, conv.id, ts);
      if (!row) fail('message_not_found');
      payload = {
        type: 'message_action',
        ...base,
        channel: { id: conv.id, name: payloadChannelName(conv) },
        message_ts: ts,
        message: messageToApi(ctx, row),
        // Answers go to the conversation, privately to the person unless the app asks for `in_channel`.
        response_url: deps.hooks.create({ app, kind: 'commands', conversationId: conv.id, userId: actor.userId }),
      };
    }
    await deliverInteractive(deps, app, 'interactive', payload, app.interactivity_url);
    return {};
  });

  /** Options for an `external_select` on a message. */
  kernel.registry.add('client.interactions.suggest', { auth: 'session' }, async ({ actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const ts = args.reqTs('message_ts');
    const row = getMessage(ctx, conv.id, ts);
    const ephemeral = row ? undefined : deps.ephemerals.get(conv.id, ts);
    if (!row && (!ephemeral || ephemeral.userId !== actor.userId)) fail('message_not_found');
    const message: Message = row ? messageToApi(ctx, row) : ephemeral!.message;
    const appId = row ? row.app_id : ephemeral!.appId;
    const app = appId ? getApp(ctx, appId) : undefined;
    if (!app) fail('app_not_found');
    const blocks = withBlockIds(message.blocks ?? []);
    const located = locate(blocks, args.req('action_id'), args.str('block_id'));
    if (!located || !String(located.element.type).includes('external_select')) fail('action_not_found');
    const team = ctx.requireTeam();
    const payload: Json = {
      type: 'block_suggestion',
      user: payloadUser(ctx, actor.userId),
      container: { type: 'message', message_ts: ts, channel_id: conv.id, is_ephemeral: ephemeral !== undefined },
      api_app_id: app.id,
      token: app.verification_token,
      action_id: located.element.action_id,
      block_id: located.blockId,
      value: (args.str('value') ?? '').slice(0, 1000),
      team: { id: team.id, domain: team.domain },
      channel: { id: conv.id, name: payloadChannelName(conv) },
      message: { ...message, blocks },
      enterprise: null,
      is_enterprise_install: false,
    };
    return readOptions(await deliverInteractive(deps, app, 'interactive', payload, app.interactivity_url));
  });
}
