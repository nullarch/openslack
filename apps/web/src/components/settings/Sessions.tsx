import { useEffect, useState } from 'react';
import { attempt, toast } from '../../lib/actions';
import { call } from '../../lib/api';
import { HOUR12, INTL_LOCALE } from '../../lib/locale';
import { S } from '../../strings';
import { confirmDialog } from '../dialogs/confirm';
import { Button, Spinner } from '../ui';

interface SessionInfo {
  id: string;
  device: string;
  ip: string | null;
  created: number;
  last_seen: number;
  current: boolean;
}

const when = new Intl.DateTimeFormat(INTL_LOCALE, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: HOUR12 });

/** Where I am signed in, with a way to sign out of the others (client.sessions.*). */
export function SessionsSection() {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const load = (): void => {
    call('client.sessions.list')
      .then((result) => setSessions(result.sessions as SessionInfo[]))
      .catch(() => setSessions([]));
  };
  useEffect(load, []);
  if (sessions === null) return <Spinner />;
  const others = sessions.filter((session) => !session.current);
  return (
    <section className="sessions-section">
      <h3 className="dialog-sub">{S.sessions.title}</h3>
      <ul className="admin-list sessions-list">
        {sessions.map((session) => (
          <li key={session.id}>
            <span className="admin-meta">
              <span className="admin-name">
                {session.device}
                {session.current ? <span className="tag">{S.sessions.thisDevice}</span> : null}
              </span>
              <span className="muted">
                {S.sessions.lastActive(when.format(new Date(session.last_seen * 1000)))}
                {session.ip ? ` · ${session.ip}` : ''}
              </span>
            </span>
            {session.current ? null : (
              <Button
                size="sm"
                onClick={() =>
                  void attempt(() => call('client.sessions.revoke', { id: session.id })).then((done) => {
                    if (done) {
                      toast(S.sessions.signedOut);
                      load();
                    }
                  })
                }
              >
                {S.sessions.signOut}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {others.length ? (
        <Button
          onClick={() =>
            void confirmDialog(S.sessions.confirmOthers(others.length), S.sessions.signOutOthers).then(async (ok) => {
              if (!ok) return;
              const result = await attempt(() => call('client.sessions.revokeOthers'));
              if (result) {
                toast(S.sessions.signedOutOthers(Number(result.revoked)));
                load();
              }
            })
          }
        >
          {S.sessions.signOutOthers}
        </Button>
      ) : null}
    </section>
  );
}
