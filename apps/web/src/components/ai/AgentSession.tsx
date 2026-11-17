import { Bot, Pencil, Square } from 'lucide-react';
import { useEffect } from 'react';
import { attempt, toast } from '../../lib/actions';
import { loadSessions, renameSession, sessionKey, stopSession, useAgentSessions } from '../../lib/agentSessions';
import { S } from '../../strings';
import { promptDialog } from '../dialogs/confirm';
import { Button, IconButton } from '../ui';

/** The state of the agents working in a thread (or, with `threadTs` empty, a code channel), its title, and Stop while they work. */
export function AgentSessionBar({ channel, threadTs }: { channel: string; threadTs: string }) {
  const session = useAgentSessions((state) => state.byThread[sessionKey(channel, threadTs)]);
  useEffect(() => {
    void loadSessions(channel);
  }, [channel]);
  if (!session) return null;
  const names = session.agents.filter((agent) => agent.status !== 'closed').map((agent) => agent.name).join(', ');
  const rename = async (): Promise<void> => {
    const title = await promptDialog({ title: S.ai.session.rename, label: S.ai.session.renameLabel, initial: session.title, confirmLabel: S.save });
    if (title?.trim()) await attempt(() => renameSession(channel, threadTs, title.trim()));
  };
  return (
    <div className={`agent-session is-${session.status}`} data-agent-session={session.status}>
      <Bot size={16} aria-hidden="true" />
      <div className="agent-session-main">
        <span className="agent-session-title">{session.title || S.ai.session.untitled}</span>
        <span className="agent-session-meta" role="status">
          <span className="agent-session-dot" aria-hidden="true" />
          {S.ai.session.status[session.status]}
          {names ? ` · ${names}` : ''}
        </span>
      </div>
      <IconButton label={S.ai.session.rename} onClick={() => void rename()}>
        <Pencil size={14} />
      </IconButton>
      {session.status === 'processing' ? (
        <Button
          size="sm"
          onClick={() =>
            void attempt(() => stopSession(channel, threadTs)).then((result) => {
              if (result) toast(S.ai.session.stopped);
            })
          }
          data-agent-stop
        >
          <Square size={12} />
          {S.ai.session.stop}
        </Button>
      ) : null}
    </div>
  );
}
