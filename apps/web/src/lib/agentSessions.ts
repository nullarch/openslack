import { create } from 'zustand';
import { call, type Json } from './api';

/**
 * What agents report about their work (agents.sessions.*), kept per session:
 * a thread, or a whole code channel (`thread_ts` null, kept under '').
 */
export interface AgentSession {
  channel: string;
  thread_ts: string | null;
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

/** The store key of a session: `channel:thread_ts`, or `channel:` for a code channel. */
export const sessionKey = (channel: string, threadTs: string | null): string => `${channel}:${threadTs ?? ''}`;

function remember(session: AgentSession): void {
  set((state) => ({ byThread: { ...state.byThread, [sessionKey(session.channel, session.thread_ts)]: session } }));
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

/** Stop a thread's agents, or (`threadTs` empty) a code channel's. */
export function stopSession(channel: string, threadTs: string): Promise<Json> {
  return call('client.agents.stop', threadTs ? { channel, thread_ts: threadTs } : { channel });
}

export function renameSession(channel: string, threadTs: string, title: string): Promise<Json> {
  return call('client.agents.rename', threadTs ? { channel, thread_ts: threadTs, title } : { channel, title });
}

/** Realtime events for agent sessions. Returns true when it handled one. */
export function handleAgentSessionEvent(event: Json): boolean {
  if (event.type !== 'agent_session') return false;
  if (event.session && typeof event.session === 'object') remember(event.session as AgentSession);
  return true;
}
