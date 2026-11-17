import { create } from 'zustand';
import { call, type Json } from './api';

/** What agents report about their work in a thread (agents.sessions.*), kept per thread. */
export interface AgentSession {
  channel: string;
  thread_ts: string;
  status: 'active' | 'processing' | 'suspended' | 'closed';
  title: string;
  agents: { app_id: string; bot_user_id: string | null; name: string; status: string }[];
}

interface State {
  byThread: Record<string, AgentSession>;
  loaded: Record<string, boolean>;
}

export const useAgentSessions = create<State>(() => ({ byThread: {}, loaded: {} }));
const set = useAgentSessions.setState;
const get = useAgentSessions.getState;

const key = (channel: string, threadTs: string): string => `${channel}:${threadTs}`;

function remember(session: AgentSession): void {
  set((state) => ({ byThread: { ...state.byThread, [key(session.channel, session.thread_ts)]: session } }));
}

export async function loadSessions(channel: string): Promise<void> {
  if (get().loaded[channel]) return;
  set((state) => ({ loaded: { ...state.loaded, [channel]: true } }));
  try {
    const result = await call('client.agents.sessions', { channel });
    for (const session of result.sessions as AgentSession[]) remember(session);
  } catch {
    set((state) => ({ loaded: { ...state.loaded, [channel]: false } }));
  }
}

export function stopSession(channel: string, threadTs: string): Promise<Json> {
  return call('client.agents.stop', { channel, thread_ts: threadTs });
}

export function renameSession(channel: string, threadTs: string, title: string): Promise<Json> {
  return call('client.agents.rename', { channel, thread_ts: threadTs, title });
}

/** Realtime events for agent sessions. Returns true when it handled one. */
export function handleAgentSessionEvent(event: Json): boolean {
  if (event.type !== 'agent_session') return false;
  if (event.session && typeof event.session === 'object') remember(event.session as AgentSession);
  return true;
}
