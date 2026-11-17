import type { Message } from '@app/shared';
import type { Kernel } from '../app.ts';
import type { Ctx } from '../ctx.ts';
import { getConv, resolveConv, type ConvRow } from '../core/conversations.ts';
import { ApiError, fail } from '../core/errors.ts';
import { getMessage, messageToApi } from '../core/messages.ts';
import { requireUser } from '../core/users.ts';
import { getApp, type AppRow } from './apps.ts';
import { elementValue, locate, sanitizeState, withBlockIds, type Located } from './elements.ts';
import { allowPrivateTargets, OutboundError, post } from './net.ts';
import type { PlatformOptions } from './options.ts';
import type { EphemeralStore, ResponseHooks } from './responses.ts';
import { signedHeaders } from './signing.ts';
import type { SocketHub } from './socket-mode.ts';
import type { Triggers } from './triggers.ts';

type Json = Record<string, unknown>;

/** The name Slack reports for a conversation in interaction payloads. */
export function payloadChannelName(conv: ConvRow): string {
  if (conv.kind === 'im') return 'directmessage';
  if (conv.kind === 'mpim') return 'mpdm';
  return conv.kind === 'private' ? 'privategroup' : (conv.name ?? '');
}

export interface Transport {
  ctx: Ctx;
  options: PlatformOptions;
  sockets: SocketHub;
}

/**
 * Deliver an interaction or slash command to its app and return the app's
 * immediate response, if it sent one. Over Socket Mode that is the
 * acknowledgement payload; over HTTP it is the response body of a signed,
 * form-encoded POST. Fails with `app_unreachable` or `app_timeout`.
 */
export async function deliverInteractive(
  transport: Transport,
  app: AppRow,
  kind: 'interactive' | 'slash_commands',
  payload: Json,
  url: string | null,
): Promise<unknown> {
  if (app.socket_mode === 1) return transport.sockets.request(app.id, kind, payload);
  if (!url) throw new ApiError('app_unreachable', { detail: 'no_request_url' });

  const form = new URLSearchParams();
  if (kind === 'interactive') {
    form.set('payload', JSON.stringify(payload));
  } else {
    for (const [key, value] of Object.entries(payload)) form.set(key, String(value));
  }
  const body = form.toString();
  let response;
  try {
    response = await post(url, {
      // Exactly this content type: Bolt compares the header for equality.
      headers: signedHeaders(app.signing_secret, body, 'application/x-www-form-urlencoded'),
      body,
      timeoutMs: transport.options.ackTimeoutMs,
      allowPrivate: allowPrivateTargets(transport.ctx),
    });
  } catch (error) {
    if (error instanceof OutboundError) {
      throw new ApiError(error.reason === 'http_timeout' ? 'app_timeout' : 'app_unreachable', { detail: error.reason });
    }
    throw error;
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ApiError('app_unreachable', { detail: `http_status_${response.status}` });
  }
  const text = response.body.trim();
  if (!text) return null;
  if (String(response.headers['content-type'] ?? '').includes('application/json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
  return { text };
}

// ── block_actions ───────────────────────────────────────────────────────────

/**
 * Build the `actions[]` entry: what the element is comes from the stored
 * message or view, what the person chose comes from the client and is checked against it.
 */
export function buildAction(located: Located, input: Json, actionTs: string): Json {
  const { element, blockId } = located;
  const type = String(element.type);
  const action: Json = { action_id: element.action_id, block_id: blockId, type, action_ts: actionTs };
  if (type === 'button' || type === 'workflow_button') {
    if (element.text) action.text = element.text;
    if (element.value !== undefined) action.value = element.value;
    if (element.style !== undefined) action.style = element.style;
    return action;
  }
  return { ...action, ...elementValue(element, input) };
}

/** The `user` object of interaction payloads. */
export function payloadUser(ctx: Ctx, userId: string): Json {
  const user = requireUser(ctx, userId);
  return { id: user.id, username: user.name, name: user.name, team_id: ctx.requireTeam().id };
}

export interface Interactivity extends Transport {
  hooks: ResponseHooks;
  ephemerals: EphemeralStore;
  triggers: Triggers;
}

export function installInteractivity(kernel: Kernel, deps: Interactivity): void {
  const { ctx } = deps;

  /**
   * A person used an interactive element on a message. Builds the
   * `block_actions` payload and delivers it to the app that posted the message.
   * Resolves once the app acknowledged it.
   */
  kernel.registry.add('client.interactions.blockAction', { auth: 'session' }, async ({ actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    const messageTs = args.reqTs('message_ts');
    const input = args.json<Json>('action');
    if (!input || typeof input !== 'object' || typeof input.action_id !== 'string') {
      fail('invalid_arguments', { needed: 'action' });
    }

    const stored = getMessage(ctx, conv.id, messageTs);
    const ephemeral = stored ? undefined : deps.ephemerals.get(conv.id, messageTs);
    if (!stored && (!ephemeral || ephemeral.userId !== actor.userId)) fail('message_not_found');
    const message: Message = stored ? messageToApi(ctx, stored) : ephemeral!.message;
    const appId = stored ? stored.app_id : ephemeral!.appId;
    const app = appId ? getApp(ctx, appId) : undefined;
    if (!app) fail('app_not_found');

    const blocks = withBlockIds(message.blocks ?? []);
    const located = locate(blocks, input.action_id, typeof input.block_id === 'string' ? input.block_id : undefined);
    if (!located) fail('action_not_found');

    const team = ctx.requireTeam();
    const container: Json = {
      type: 'message',
      message_ts: messageTs,
      channel_id: conv.id,
      is_ephemeral: ephemeral !== undefined,
    };
    if (message.thread_ts) container.thread_ts = message.thread_ts;
    const sentState = args.json<Json>('state');

    const payload: Json = {
      type: 'block_actions',
      user: payloadUser(ctx, actor.userId),
      api_app_id: app.id,
      token: app.verification_token,
      container,
      trigger_id: deps.triggers.issue(app.id, actor.userId, conv.id),
      team: { id: team.id, domain: team.domain },
      enterprise: null,
      is_enterprise_install: false,
      channel: { id: conv.id, name: payloadChannelName(conv) },
      message: { ...message, blocks },
      state: { values: sanitizeState(blocks, sentState && typeof sentState === 'object' ? sentState.values : undefined) },
      response_url: deps.hooks.create({
        app,
        kind: 'actions',
        conversationId: conv.id,
        userId: actor.userId,
        sourceTs: messageTs,
        sourceEphemeral: ephemeral !== undefined,
      }),
      actions: [buildAction(located, input, ctx.clock.eventTs())],
    };
    await deliverInteractive(deps, app, 'interactive', payload, app.interactivity_url);
    return {};
  });
}

/** Re-read a conversation that may have been deleted while an app was thinking. */
export function liveConv(ctx: Ctx, id: string): ConvRow {
  return getConv(ctx, id) ?? fail('channel_not_found');
}
