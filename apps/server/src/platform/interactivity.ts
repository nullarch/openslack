import type { Block, Message } from '@app/shared';
import type { Kernel } from '../app.ts';
import type { Ctx } from '../ctx.ts';
import { getConv, resolveConv, type ConvRow } from '../core/conversations.ts';
import { ApiError, fail } from '../core/errors.ts';
import { newHex } from '../core/ids.ts';
import { getMessage, messageToApi } from '../core/messages.ts';
import { requireUser } from '../core/users.ts';
import { getApp, type AppRow } from './apps.ts';
import { allowPrivateTargets, OutboundError, post } from './net.ts';
import type { PlatformOptions } from './options.ts';
import type { EphemeralStore, ResponseHooks } from './responses.ts';
import { signedHeaders } from './signing.ts';
import type { SocketHub } from './socket-mode.ts';

type Json = Record<string, unknown>;

/** A `trigger_id` in Slack's three-part form. Nothing consumes it yet (modals are not implemented). */
export function newTriggerId(): string {
  const digits = (): string => String(Math.floor(1e11 + Math.random() * 9e11));
  return `${digits()}.${digits()}.${newHex(16)}`;
}

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

interface Located {
  element: Json;
  blockId: string;
}

/** Slack gives every block an id; blocks stored without one get a stable positional id. */
function withBlockIds(blocks: Block[]): Block[] {
  return blocks.map((block, index) => (typeof block.block_id === 'string' && block.block_id ? block : { ...block, block_id: `b${index}` }));
}

/** Find an interactive element by `action_id`, wherever a block can hold one. */
function locate(blocks: Block[], actionId: string, blockId: string | undefined): Located | undefined {
  for (const block of blocks) {
    const id = block.block_id as string;
    if (blockId !== undefined && blockId !== id) continue;
    const candidates: unknown[] = [];
    if (Array.isArray(block.elements)) candidates.push(...(block.elements as unknown[]));
    if (block.accessory) candidates.push(block.accessory);
    if (block.element) candidates.push(block.element);
    for (const candidate of candidates) {
      if (candidate && typeof candidate === 'object' && (candidate as Json).action_id === actionId) {
        return { element: candidate as Json, blockId: id };
      }
    }
  }
  return undefined;
}

function optionsOf(element: Json): Json[] {
  const options: Json[] = [];
  if (Array.isArray(element.options)) options.push(...(element.options as Json[]));
  if (Array.isArray(element.option_groups)) {
    for (const group of element.option_groups as Json[]) {
      if (Array.isArray(group.options)) options.push(...(group.options as Json[]));
    }
  }
  return options;
}

/** An option the user picked, taken from the element as the app defined it. */
function pickOption(element: Json, chosen: unknown): Json | null {
  if (chosen === null || chosen === undefined) return null;
  const value = typeof chosen === 'object' ? (chosen as Json).value : chosen;
  const known = optionsOf(element).find((option) => option.value === value);
  if (known) return known;
  // Menus with external data sources have no static list to check against.
  if (String(element.type).startsWith('external') || String(element.type).startsWith('multi_external')) {
    return typeof chosen === 'object' ? (chosen as Json) : null;
  }
  return fail('invalid_action_value');
}

/**
 * Build the `actions[]` entry: what the element is comes from the stored
 * message, what the user chose comes from the client and is checked against it.
 */
function buildAction(located: Located, input: Json, actionTs: string): Json {
  const { element, blockId } = located;
  const type = String(element.type);
  const action: Json = { action_id: element.action_id, block_id: blockId, type, action_ts: actionTs };
  switch (type) {
    case 'button':
      if (element.text) action.text = element.text;
      if (element.value !== undefined) action.value = element.value;
      if (element.style !== undefined) action.style = element.style;
      break;
    case 'static_select':
    case 'external_select':
    case 'overflow':
    case 'radio_buttons':
      action.selected_option = pickOption(element, input.selected_option);
      break;
    case 'multi_static_select':
    case 'multi_external_select':
    case 'checkboxes':
      action.selected_options = (Array.isArray(input.selected_options) ? input.selected_options : [])
        .map((chosen) => pickOption(element, chosen))
        .filter((option) => option !== null);
      break;
    case 'datepicker':
      action.selected_date = typeof input.selected_date === 'string' ? input.selected_date : null;
      break;
    case 'timepicker':
      action.selected_time = typeof input.selected_time === 'string' ? input.selected_time : null;
      break;
    case 'datetimepicker':
      action.selected_date_time = typeof input.selected_date_time === 'number' ? input.selected_date_time : null;
      break;
    case 'users_select':
      action.selected_user = typeof input.selected_user === 'string' ? input.selected_user : null;
      break;
    case 'conversations_select':
      action.selected_conversation = typeof input.selected_conversation === 'string' ? input.selected_conversation : null;
      break;
    case 'channels_select':
      action.selected_channel = typeof input.selected_channel === 'string' ? input.selected_channel : null;
      break;
    case 'multi_users_select':
      action.selected_users = Array.isArray(input.selected_users) ? input.selected_users.map(String) : [];
      break;
    case 'multi_conversations_select':
      action.selected_conversations = Array.isArray(input.selected_conversations) ? input.selected_conversations.map(String) : [];
      break;
    case 'multi_channels_select':
      action.selected_channels = Array.isArray(input.selected_channels) ? input.selected_channels.map(String) : [];
      break;
    default:
      // Text-like inputs that dispatch on enter or on each character.
      if (typeof input.value === 'string') action.value = input.value.slice(0, 3000);
  }
  return action;
}

export interface Interactivity extends Transport {
  hooks: ResponseHooks;
  ephemerals: EphemeralStore;
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

    const user = requireUser(ctx, actor.userId);
    const team = ctx.requireTeam();
    const container: Json = {
      type: 'message',
      message_ts: messageTs,
      channel_id: conv.id,
      is_ephemeral: ephemeral !== undefined,
    };
    if (message.thread_ts) container.thread_ts = message.thread_ts;
    const state = args.json<Json>('state');

    const payload: Json = {
      type: 'block_actions',
      user: { id: user.id, username: user.name, name: user.name, team_id: team.id },
      api_app_id: app.id,
      token: app.verification_token,
      container,
      trigger_id: newTriggerId(),
      team: { id: team.id, domain: team.domain },
      enterprise: null,
      is_enterprise_install: false,
      channel: { id: conv.id, name: payloadChannelName(conv) },
      message: { ...message, blocks },
      state: state && typeof state === 'object' && typeof state.values === 'object' ? state : { values: {} },
      response_url: deps.hooks.create({
        app,
        kind: 'actions',
        conversationId: conv.id,
        userId: user.id,
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
