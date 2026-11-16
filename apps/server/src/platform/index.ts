import type { Kernel } from '../app.ts';

/**
 * The app platform: apps and bot users, Events API delivery, Socket Mode,
 * incoming webhooks, interactivity and slash commands. Installed onto the
 * kernel at start-up.
 */
export function installPlatform(_kernel: Kernel): void {
  // Filled in by the platform modules.
}
