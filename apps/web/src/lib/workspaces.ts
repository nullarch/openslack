import type { Conversation, WorkspaceInfo } from '@app/shared';
import { useStore, type AppState } from './store';

/**
 * An organisation with several workspaces: which one the sidebar shows. The
 * choice is kept per browser; with one workspace nothing here shows.
 */

const key = (): string => `workspace:${useStore.getState().team?.id ?? ''}`;

export function applyWorkspaces(workspaces: WorkspaceInfo[]): void {
  let chosen: string | null = null;
  try {
    chosen = localStorage.getItem(key());
  } catch {
    // Without storage the sidebar starts on all workspaces.
  }
  const known = workspaces.length > 1 && workspaces.some((entry) => entry.id === chosen);
  useStore.setState({ workspaces, workspace: known ? chosen : null });
}

export function chooseWorkspace(id: string | null): void {
  useStore.setState({ workspace: id });
  try {
    if (id) localStorage.setItem(key(), id);
    else localStorage.removeItem(key());
  } catch {
    // Kept for this page only.
  }
}

/** Whether a conversation belongs in the sidebar for the chosen workspace (conversations with people always do). */
export function inChosenWorkspace(state: Pick<AppState, 'workspace' | 'team'>, conv: Conversation): boolean {
  if (!state.workspace || !conv.is_channel) return true;
  if (conv.is_org_shared) return true;
  return (conv.context_team_id || state.team?.id) === state.workspace;
}

/** The workspace a new channel goes into: the chosen one, unless it is the organisation's own. */
export function workspaceForNewChannel(): string | undefined {
  const { workspace, workspaces } = useStore.getState();
  const entry = workspaces.find((item) => item.id === workspace);
  return entry && !entry.first ? entry.id : undefined;
}

export function chosenWorkspace(state: Pick<AppState, 'workspace' | 'workspaces'>): WorkspaceInfo | undefined {
  return state.workspaces.find((entry) => entry.id === state.workspace);
}
