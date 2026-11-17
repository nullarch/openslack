import { extractBlockMentions, extractMentions } from '@app/shared';
import type { Ctx } from '../ctx.ts';
import type { BusEvent } from '../core/bus.ts';
import { getConv, getMember, type ConvRow } from '../core/conversations.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import { listApps, parseList, type AppRow } from './apps.ts';
import type { HttpDelivery } from './events-http.ts';
import type { SocketHub } from './socket-mode.ts';

type EventBody = BusEvent['event'];

/** Subscription name for message events, by conversation type. */
const MESSAGE_SUBSCRIPTION: Record<ConvRow['kind'], string> = {
  public: 'message.channels',
  private: 'message.groups',
  im: 'message.im',
  mpim: 'message.mpim',
};

/**
 * Event subscriptions an app can list in `bot_events`. An app that lists none
 * receives all of them: on a self-hosted server there is no reason to make
 * every bot author tick boxes before the first event arrives.
 */
export const SUBSCRIBABLE_EVENTS = [
  'app_mention',
  'message.channels',
  'message.groups',
  'message.im',
  'message.mpim',
  'message.session',
  'reaction_added',
  'reaction_removed',
  'pin_added',
  'pin_removed',
  'member_joined_channel',
  'member_left_channel',
  'channel_created',
  'channel_rename',
  'channel_archive',
  'channel_unarchive',
  'team_join',
  'user_change',
  'emoji_changed',
  'file_deleted',
  'team_rename',
  'app_home_opened',
  'agent_session_stopped',
  'agent_session_title_changed',
  'code_channel_action',
  'link_shared',
  'function_executed',
  'subteam_created',
  'subteam_updated',
  'subteam_members_changed',
  'team_profile_change',
];

/** Message subtypes that are ordinary posts, where a mention should notify the app. */
const MENTIONABLE_SUBTYPES = new Set(['thread_broadcast', 'file_share', 'bot_message', 'me_message']);

function mentions(event: EventBody, userId: string): boolean {
  if (typeof event.text === 'string' && extractMentions(event.text).users.includes(userId)) return true;
  return event.blocks !== undefined && extractBlockMentions(event.blocks).users.includes(userId);
}

interface Selected {
  subscription: string;
  event: EventBody;
}

/**
 * Decide what one app receives for one bus event. An app sees a conversation's
 * events only when its bot user is a member; workspace-wide events go to every
 * app. The one exception is `app_mention` in a public channel, which reaches
 * the app whether or not it has joined.
 */
export function selectEvents(ctx: Ctx, app: AppRow, busEvent: BusEvent): Selected[] {
  const { event, audience } = busEvent;
  const bot = app.bot_user_id;
  const isMember = (conversationId: unknown): boolean =>
    typeof conversationId === 'string' && getMember(ctx, conversationId, bot) !== undefined;

  if (event.type === 'message') {
    const conv = typeof event.channel === 'string' ? getConv(ctx, event.channel) : undefined;
    if (!conv) return [];
    const member = isMember(conv.id);
    const selected: Selected[] = [];
    if (member) {
      // An app subscribed to `message.session` hears code channels through it, once (not also as message.channels).
      const session =
        (conv.kind === 'public' || conv.kind === 'private') &&
        parseList(app.bot_events).includes('message.session') &&
        ctx.db.get('SELECT 1 FROM agent_channels WHERE conversation_id = ?', conv.id) !== undefined;
      selected.push({ subscription: session ? 'message.session' : MESSAGE_SUBSCRIPTION[conv.kind], event });
    }
    const subtype = typeof event.subtype === 'string' ? event.subtype : undefined;
    const plainPost = subtype === undefined || MENTIONABLE_SUBTYPES.has(subtype);
    if (plainPost && conv.kind !== 'im' && event.user !== bot && (member || conv.kind === 'public') && mentions(event, bot)) {
      const mention: EventBody = {
        type: 'app_mention',
        user: event.user,
        text: event.text,
        ts: event.ts,
        channel: conv.id,
        event_ts: event.ts,
        team: event.team,
      };
      for (const key of ['thread_ts', 'blocks', 'client_msg_id', 'files', 'attachments', 'bot_id', 'subtype']) {
        if (event[key] !== undefined) mention[key] = event[key];
      }
      selected.push({ subscription: 'app_mention', event: mention });
    }
    return selected;
  }

  let visible: boolean;
  if (event.type === 'reaction_added' || event.type === 'reaction_removed') {
    visible = isMember((event.item as { channel?: unknown } | undefined)?.channel);
  } else if (event.type === 'pin_added' || event.type === 'pin_removed') {
    visible = isMember(event.channel_id);
  } else if (event.type === 'member_joined_channel' || event.type === 'member_left_channel') {
    // The membership row is already gone when the bot itself leaves.
    visible = isMember(event.channel) || event.user === bot;
  } else if ('all' in audience) {
    visible = true;
  } else if ('users' in audience) {
    visible = audience.users.includes(bot);
  } else {
    visible = isMember(audience.conversation);
  }
  return visible ? [{ subscription: event.type, event }] : [];
}

/** Wrap an event in the Events API callback envelope. */
export function eventCallback(ctx: Ctx, app: AppRow, event: EventBody): Record<string, unknown> {
  const team = ctx.requireTeam();
  const context = Buffer.from(JSON.stringify({ et: event.type, tid: team.id, aid: app.id })).toString('base64url');
  return {
    token: app.verification_token,
    team_id: team.id,
    context_team_id: team.id,
    context_enterprise_id: null,
    api_app_id: app.id,
    event,
    type: 'event_callback',
    event_id: `Ev${newId('', 10)}`,
    event_time: nowSeconds(),
    authorizations: [
      { enterprise_id: null, team_id: team.id, user_id: app.bot_user_id, is_bot: true, is_enterprise_install: false },
    ],
    is_ext_shared_channel: false,
    event_context: `4-${context}`,
  };
}

export interface Delivery {
  ctx: Ctx;
  sockets: SocketHub;
  http: HttpDelivery;
}

/**
 * Send one event to one app, over Socket Mode or to its events URL, unless the
 * app subscribed to a list of events that does not include it.
 */
export function sendToApp(delivery: Delivery, app: AppRow, subscription: string, event: EventBody): void {
  const wanted = parseList(app.bot_events);
  if (wanted.length > 0 && !wanted.includes(subscription)) return;
  const envelope = eventCallback(delivery.ctx, app, event);
  if (app.socket_mode === 1) delivery.sockets.sendEvent(app.id, envelope);
  else if (app.events_url) delivery.http.enqueue(app, JSON.stringify(envelope));
}

/** Send every non-client-only bus event to the apps entitled to it. */
export function installDispatch(ctx: Ctx, sockets: SocketHub, http: HttpDelivery): () => void {
  const delivery: Delivery = { ctx, sockets, http };
  return ctx.bus.subscribe((busEvent) => {
    if (busEvent.clientOnly) return;
    for (const app of listApps(ctx)) {
      for (const { subscription, event } of selectEvents(ctx, app, busEvent)) sendToApp(delivery, app, subscription, event);
    }
  });
}
