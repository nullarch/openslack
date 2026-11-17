import { Bot, Hash, Lock, Menu, MessageSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { go } from '../../lib/actions';
import { call, type Json } from '../../lib/api';
import { set, useStore } from '../../lib/store';
import { S } from '../../strings';
import { Avatar, IconButton, Spinner } from '../ui';
import '../../styles/ai.css';
import { agoText } from '../../lib/time';

interface AgentThread {
  channel: string;
  channel_name: string | null;
  is_im: boolean;
  thread_ts: string;
  title: string;
  status: string;
  streaming: boolean;
  last_activity: number;
}

interface Agent {
  app_id: string;
  name: string;
  description: string;
  bot_user_id: string;
  connected: boolean;
  state: 'replying' | 'working' | 'idle' | 'offline';
  activity: string | null;
  threads: AgentThread[];
}

const REFRESH_MS = 4000;

const ago = agoText;

function AgentCard({ agent }: { agent: Agent }) {
  const user = useStore((state) => state.users[agent.bot_user_id]);
  return (
    <article className={`agent-card is-${agent.state}`}>
      <header>
        <Avatar user={user} size={36} />
        <div className="agent-name">
          <strong>{agent.name}</strong>
          {agent.description ? <span>{agent.description}</span> : null}
        </div>
        <span className={`agent-state is-${agent.state}`}>
          <i aria-hidden="true" />
          {S.ai.agents.state[agent.state]}
        </span>
      </header>
      {agent.activity ? <p className="agent-activity">{agent.activity}</p> : null}
      {agent.threads.length === 0 ? (
        <p className="agent-empty">{S.ai.agents.noThreads}</p>
      ) : (
        <ul className="agent-threads">
          {agent.threads.map((thread) => (
            <li key={`${thread.channel}:${thread.thread_ts}`}>
              <button
                type="button"
                onClick={() => go({ name: 'conversation', id: thread.channel, thread: thread.thread_ts })}
              >
                <span className="agent-thread-where">
                  {thread.is_im ? <MessageSquare size={13} /> : thread.channel_name ? <Hash size={13} /> : <Lock size={13} />}
                  {thread.is_im ? S.ai.agents.inDm : (thread.channel_name ?? '')}
                </span>
                <span className="agent-thread-title">{thread.title || S.ai.agents.untitled}</span>
                <span className="agent-thread-meta">
                  {thread.streaming ? S.ai.agents.state.replying : thread.status || ago(thread.last_activity)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/** Apps acting as agents, what they are doing, and where. */
export function AgentsView() {
  const [agents, setAgents] = useState<Agent[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      call('client.agents.list')
        .then((result: Json) => {
          if (alive) setAgents(result.agents);
        })
        .catch(() => {
          if (alive) setAgents((current) => current ?? []);
        });
    };
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <section className="conversation agents-view">
      <header className="conv-head">
        <IconButton className="only-narrow" label={S.sidebar.openSidebar} onClick={() => set({ drawer: true })}>
          <Menu size={19} />
        </IconButton>
        <span className="conv-title">
          <Bot size={18} />
          <span className="conv-name">{S.ai.agents.title}</span>
        </span>
      </header>
      <div className="agents-scroll">
        <p className="agents-intro">{S.ai.agents.intro}</p>
        {agents === null ? <Spinner /> : null}
        {agents?.length === 0 ? <p className="agent-empty">{S.ai.agents.none}</p> : null}
        <div className="agents-grid">
          {agents?.map((agent) => <AgentCard key={agent.app_id} agent={agent} />)}
        </div>
      </div>
    </section>
  );
}
