import type { Kernel } from '../app.ts';
import { installAdmin } from './admin.ts';
import { AssistantThreads } from './assistant.ts';
import { installCommands } from './commands.ts';
import { installDispatch } from './dispatch.ts';
import { HttpDelivery } from './events-http.ts';
import { installInteractivity } from './interactivity.ts';
import { platformOptions } from './options.ts';
import { EphemeralStore, ResponseHooks } from './responses.ts';
import { SocketHub } from './socket-mode.ts';
import { Streams } from './streaming.ts';
import { installWebhooks } from './webhooks.ts';

export { createAppRecord, issueToken } from './apps.ts';

/**
 * The app platform: apps and bot users, Events API delivery over HTTP and
 * Socket Mode, incoming webhooks, interactivity, slash commands and streamed
 * messages. Installed onto the kernel at start-up.
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

  const interactivity = { ctx, options, sockets, hooks, ephemerals };
  installInteractivity(kernel, interactivity);
  installCommands(kernel, interactivity);
  installWebhooks(kernel);
  new Streams(ctx, options).install(kernel);
  new AssistantThreads(ctx, options).install(kernel);
  installAdmin(kernel, sockets, http);
}
