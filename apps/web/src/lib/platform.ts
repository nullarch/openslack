import { create } from 'zustand';
import { ApiError, call, type Json } from './api';
import { errorText, toast } from './actions';
import { S } from '../strings';

/**
 * App surfaces in the client: the modal an app opened (a stack of up to three
 * views), App Home tabs, and the shortcuts apps offer. Kept apart from the
 * main store; the realtime module forwards the events that concern them.
 */

export interface AppView {
  id: string;
  type: 'modal' | 'home';
  app_id: string;
  bot_id: string;
  title: Json;
  submit: Json | null;
  close: Json | null;
  blocks: Json[];
  callback_id: string;
  state: { values: Record<string, Record<string, Json>> };
  hash: string;
  root_view_id: string;
  previous_view_id: string | null;
  submit_disabled?: boolean;
}

export interface AppShortcut {
  type: 'global' | 'message';
  name: string;
  callback_id: string;
  description: string;
  app_id: string;
  app_name: string;
}

interface PlatformState {
  /** The open modal, bottom view first. Empty when none is open. */
  stack: AppView[];
  /** Errors the app returned for the top view, by block id. */
  errors: Record<string, string>;
  /** Published Home tabs, by app id (undefined: not loaded yet). */
  homes: Record<string, AppView | null>;
  /** Which tab of an app's conversation is showing. */
  appTab: Record<string, 'home' | 'messages'>;
  shortcuts: AppShortcut[] | null;
}

export const usePlatform = create<PlatformState>(() => ({ stack: [], errors: {}, homes: {}, appTab: {}, shortcuts: null }));

function setStack(stack: AppView[], errors: Record<string, string> = {}): void {
  usePlatform.setState({ stack, errors });
}

/** Events from the server that concern app surfaces. Returns true when handled. */
export function handlePlatformEvent(event: Json): boolean {
  switch (event.type) {
    case 'view_stack':
      setStack(Array.isArray(event.stack) ? event.stack : []);
      return true;
    case 'app_home':
      if (event.app_id && event.view) usePlatform.setState((state) => ({ homes: { ...state.homes, [event.app_id]: event.view } }));
      return true;
    default:
      return false;
  }
}

/** After (re)connecting: pick up a modal opened while this tab was away. */
export async function restoreViews(): Promise<void> {
  try {
    const result = await call('client.views.stack');
    setStack(result.stack ?? []);
  } catch {
    // An older server has no modals.
  }
}

function unsupported(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'unknown_method';
}

export async function submitView(view: AppView, state: Json): Promise<void> {
  try {
    const result = await call('client.views.submit', { view_id: view.id, state });
    setStack(result.stack ?? [], result.errors ?? {});
    if (result.app_error) toast(S.platform.appAnswerRejected, 'error');
  } catch (error) {
    toast(unsupported(error) ? S.platform.unsupported : errorText(error), 'error');
  }
}

/** Cancel (`clear` false) goes back one view; the × (`clear` true) closes the modal. */
export async function closeView(view: AppView, clear: boolean): Promise<void> {
  // Close at once; the server's answer confirms what remains.
  setStack(clear ? [] : usePlatform.getState().stack.filter((entry) => entry.id !== view.id));
  try {
    const result = await call('client.views.close', { view_id: view.id, clear });
    setStack(result.stack ?? []);
  } catch {
    // Already closed on the server.
  }
}

export async function viewAction(view: AppView, action: Json, state: Json): Promise<void> {
  try {
    await call('client.views.blockAction', { view_id: view.id, action, state });
  } catch (error) {
    toast(unsupported(error) ? S.platform.unsupported : errorText(error), 'error');
  }
}

export async function viewSuggest(view: AppView, actionId: string, blockId: string, value: string): Promise<Json> {
  try {
    return await call('client.views.suggest', { view_id: view.id, action_id: actionId, block_id: blockId, value });
  } catch {
    return { options: [] };
  }
}

// ── App Home ────────────────────────────────────────────────────────────────

export function setAppTab(appId: string, tab: 'home' | 'messages'): void {
  usePlatform.setState((state) => ({ appTab: { ...state.appTab, [appId]: tab } }));
  void call('client.apps.homeOpened', { app: appId, tab })
    .then((result) => usePlatform.setState((state) => ({ homes: { ...state.homes, [appId]: result.view ?? state.homes[appId] ?? null } })))
    .catch(() => undefined);
}

export async function loadHome(appId: string): Promise<void> {
  try {
    const result = await call('client.apps.home', { app: appId });
    usePlatform.setState((state) => ({ homes: { ...state.homes, [appId]: result.view ?? null } }));
  } catch {
    usePlatform.setState((state) => ({ homes: { ...state.homes, [appId]: null } }));
  }
}

// ── Shortcuts ───────────────────────────────────────────────────────────────

export async function loadShortcuts(): Promise<void> {
  try {
    const result = await call('client.shortcuts.list');
    usePlatform.setState({ shortcuts: result.shortcuts ?? [] });
  } catch {
    usePlatform.setState({ shortcuts: [] });
  }
}

export async function runShortcut(shortcut: AppShortcut, where?: { channel: string; message_ts: string }): Promise<void> {
  try {
    await call('client.shortcuts.run', { app: shortcut.app_id, callback_id: shortcut.callback_id, ...where });
  } catch (error) {
    toast(unsupported(error) ? S.platform.unsupported : errorText(error), 'error');
  }
}
