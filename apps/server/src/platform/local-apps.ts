import type { Ctx } from '../ctx.ts';
import type { Actor } from '../ctx.ts';
import type { Delivery } from './dispatch.ts';
import type { Json } from './elements.ts';
import type { Interactivity } from './interactivity.ts';
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
const finders = new WeakMap<Ctx, (() => void)[]>();

export function registerLocalApp(ctx: Ctx, app: LocalApp): void {
  let apps = localApps.get(ctx);
  if (!apps) localApps.set(ctx, (apps = new Map()));
  apps.set(app.appId, app);
}

/**
 * A built-in app created on demand (the Workflows app, when the first workflow
 * is built) is registered by the process that created it. Another process
 * sharing the database learns of it here: `find` registers the app if its row
 * exists by now, and runs before every lookup.
 */
export function findLocalAppWith(ctx: Ctx, find: () => void): void {
  const list = finders.get(ctx) ?? [];
  list.push(find);
  finders.set(ctx, list);
}

function findAll(ctx: Ctx): void {
  for (const find of finders.get(ctx) ?? []) find();
}

export function localApp(ctx: Ctx, appId: string | null | undefined): LocalApp | undefined {
  if (!appId) return undefined;
  if (!localApps.get(ctx)?.has(appId)) findAll(ctx);
  return localApps.get(ctx)?.get(appId);
}

export function allLocalApps(ctx: Ctx): LocalApp[] {
  findAll(ctx);
  return [...(localApps.get(ctx)?.values() ?? [])];
}

/** Platform services other modules need: opening modals for a person, delivering events and interactions to apps. */
export interface PlatformServices {
  views: Views;
  delivery: Delivery;
  interactivity: Interactivity;
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
