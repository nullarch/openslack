import type { AgentSessionView, Block, Conversation } from '@app/shared';
import { create } from 'zustand';
import { errorText, loadCommands, toast } from './actions';
import { call, isUnsupported, type Json } from './api';
import type { SlashCommand } from './store';
import { S } from '../strings';

/**
 * Code channels: channels an agent made for one piece of work
 * (`agents.conversations.*`). Their session, context bar and view tabs come
 * with the conversation (`properties`); a view's content is fetched when its
 * tab opens, and again when the agent changes it (`content_version`).
 */

export interface ViewDetail extends AgentSessionView {
  app_id: string;
  bot_user_id: string | null;
  content?: string;
  blocks?: Block[];
  pr_url?: string;
  access_level?: 'read' | 'write' | 'comment';
  base_branch?: string;
  head_branch?: string;
  csp?: { resource_domains: string[] };
}

interface State {
  /** The view tab open in each code channel (absent: messages or a canvas). */
  tab: Record<string, string>;
}

export const useCodeChannels = create<State>(() => ({ tab: {} }));

export function isCodeChannel(conv: Conversation | null | undefined): boolean {
  return conv?.properties?.record_channel?.record_type === 'agent_channel';
}

export function setViewTab(channel: string, viewId: string | null): void {
  useCodeChannels.setState((state) => {
    const tab = { ...state.tab };
    if (viewId) tab[channel] = viewId;
    else delete tab[channel];
    return { tab };
  });
}

export async function loadView(channel: string, viewId: string): Promise<ViewDetail> {
  const result = await call('client.codeChannels.view', { channel, view_id: viewId });
  return result.view as ViewDetail;
}

/** A person clicked an action item of the context bar; the agent hears `code_channel_action`. */
export async function runContextAction(channel: string, key: string): Promise<boolean> {
  try {
    await call('client.codeChannels.action', { channel, key });
    return true;
  } catch (error) {
    toast(isUnsupported(error) ? S.platform.unsupported : errorText(error), 'error');
    return false;
  }
}

export async function viewBlockAction(channel: string, viewId: string, action: Json, state: Json): Promise<void> {
  try {
    await call('client.codeChannels.blockAction', { channel, view_id: viewId, action, state });
  } catch (error) {
    toast(isUnsupported(error) ? S.platform.unsupported : errorText(error), 'error');
  }
}

export async function viewSuggest(channel: string, viewId: string, actionId: string, blockId: string, value: string): Promise<Json> {
  try {
    return await call('client.codeChannels.suggest', { channel, view_id: viewId, action_id: actionId, block_id: blockId, value });
  } catch {
    return { options: [] };
  }
}

/**
 * The slash commands that work in `channel`: those its agents offer there
 * first, then the apps' commands they do not shadow. Agents' commands of other
 * channels are left out.
 */
export function commandsIn(commands: SlashCommand[], channel: string): SlashCommand[] {
  const here = commands.filter((command) => command.channel_id === channel);
  const taken = new Set(here.map((command) => command.command));
  const unique = here.filter((command, index) => here.findIndex((other) => other.command === command.command) === index);
  return [...unique, ...commands.filter((command) => !command.channel_id && !taken.has(command.command))];
}

/** Realtime: an agent changed its commands in a channel. Returns true when handled. */
export function handleCodeChannelEvent(event: Json): boolean {
  if (event.type !== 'commands_changed') return false;
  void loadCommands();
  return true;
}
