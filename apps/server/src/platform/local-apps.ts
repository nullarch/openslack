import type { Ctx } from '../ctx.ts';
import type { Actor } from '../ctx.ts';
import type { Delivery } from './dispatch.ts';
import type { Json } from './elements.ts';
import type { Views } from './views.ts';

/**
 * Apps built into the server (the workflow builder) use the same surfaces as
 * external apps — shortcuts in the composer, modals — but answer in-process
 * instead of over Socket Mode or HTTP. A built-in app registers here; the
 * platform checks this registry before delivering to an app.
 */
export interface LocalShortcut {
  type: 'global' | 'message';
  name: string;
  callback_id: string;
  description: string;
}

export interface LocalApp {
  appId: string;
  /** Shortcuts this person may use, for the shortcut menus. */
  shortcuts?(actor: Actor): LocalShortcut[];
  /** A shortcut was chosen. `channel` is where the person was, when known. */
  runShortcut?(actor: Actor, callbackId: string, context: { channel?: string }): Promise<void> | void;
  /** A modal of this app was submitted: answer like an app would (nothing, or a `response_action`). */
  submitView?(userId: string, view: Json): Promise<unknown> | unknown;
  /** A modal of this app was closed without submitting. */
  closeView?(userId: string, view: Json): void;
}

const localApps = new WeakMap<Ctx, Map<string, LocalApp>>();

export function registerLocalApp(ctx: Ctx, app: LocalApp): void {
  let apps = localApps.get(ctx);
  if (!apps) localApps.set(ctx, (apps = new Map()));
  apps.set(app.appId, app);
}

export function localApp(ctx: Ctx, appId: string | null | undefined): LocalApp | undefined {
  return appId ? localApps.get(ctx)?.get(appId) : undefined;
}

export function allLocalApps(ctx: Ctx): LocalApp[] {
  return [...(localApps.get(ctx)?.values() ?? [])];
}

/** Platform services other modules need: opening modals for a person, delivering events to apps. */
export interface PlatformServices {
  views: Views;
  delivery: Delivery;
}

const services = new WeakMap<Ctx, PlatformServices>();

export function setPlatformServices(ctx: Ctx, value: PlatformServices): void {
  services.set(ctx, value);
}

export function platformServices(ctx: Ctx): PlatformServices {
  const value = services.get(ctx);
  if (!value) throw new Error('the app platform is not installed');
  return value;
}
