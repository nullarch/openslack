import type { Kernel } from '../app.ts';
import { installAdmin } from './admin.ts';
import { installAgentSessions } from './agent-sessions.ts';
import { AssistantThreads } from './assistant.ts';
import { installCommands } from './commands.ts';
import { installDispatch, type Delivery } from './dispatch.ts';
import { HttpDelivery } from './events-http.ts';
import { installInteractivity } from './interactivity.ts';
import { setPlatformServices } from './local-apps.ts';
import { installManifest } from './manifest.ts';
import { platformOptions } from './options.ts';
import { installOauth } from './oauth.ts';
import { installOpenId } from './openid.ts';
import { RtmHub } from './rtm.ts';
import { EphemeralStore, ResponseHooks } from './responses.ts';
import { installShortcuts } from './shortcuts.ts';
import { SocketHub } from './socket-mode.ts';
import { Streams } from './streaming.ts';
import { Triggers } from './triggers.ts';
import { Unfurls } from './unfurls.ts';
import { Views } from './views.ts';
import { installWebhooks } from './webhooks.ts';

export { createAppRecord, issueToken } from './apps.ts';

/**
 * The app platform: apps and bot users, Events API delivery over HTTP and
 * Socket Mode, incoming webhooks, interactivity, slash commands, shortcuts,
 * modals and App Home, unfurls and streamed messages. Installed onto the
 * kernel at start-up.
 */
export function installPlatform(kernel: Kernel): void {
  const { ctx } = kernel;
  const options = platformOptions();

  const sockets = new SocketHub(ctx, options);
  sockets.install(kernel);

  const http = new HttpDelivery(ctx, options);
  http.start();
  kernel.onClose.push(() => http.stop());

  kernel.onClose.push(installDispatch(ctx, sockets, http));

  const ephemerals = new EphemeralStore(ctx);
  ephemerals.install(kernel);
  const hooks = new ResponseHooks(ctx, ephemerals);
  hooks.install(kernel);

  const delivery: Delivery = { ctx, sockets, http };
  const interactivity = { ctx, options, sockets, hooks, ephemerals, triggers: new Triggers(options.triggerTtlMs) };
  installInteractivity(kernel, interactivity);
  installCommands(kernel, interactivity);
  installShortcuts(kernel, interactivity);
  const views = new Views(interactivity, delivery);
  views.install(kernel);
  setPlatformServices(ctx, { views, delivery });
  new Unfurls(delivery).install(kernel);
  installWebhooks(kernel);
  new Streams(ctx, options).install(kernel);
  new AssistantThreads(ctx, options).install(kernel);
  installAgentSessions(kernel, delivery);
  installAdmin(kernel, sockets, http);
  installManifest(kernel, sockets, http);
  new RtmHub(ctx).install(kernel);
  installOauth(kernel);
  installOpenId(kernel);
}
