import { Phone, PhoneOff } from 'lucide-react';
import { useEffect } from 'react';
import { loadCall, usePlatform, type CallUser } from '../lib/platform';
import { useStore } from '../lib/store';
import { S } from '../strings';
import { Avatar } from './ui';

function lasted(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return S.calls.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  return S.calls.hours(hours, minutes % 60);
}

function Participant({ user }: { user: CallUser }) {
  const person = useStore((state) => (user.slack_id ? state.users[user.slack_id] : undefined));
  if (person) return <Avatar user={person} size={24} />;
  const name = user.display_name ?? user.external_id ?? '';
  return user.avatar_url ? (
    <img className="call-external" src={user.avatar_url} alt={name} title={name} width={24} height={24} />
  ) : (
    <span className="call-external is-initial" title={name}>
      {name.slice(0, 1).toUpperCase() || '?'}
    </span>
  );
}

/** A `call` block: a call running elsewhere (an app registered it with calls.add), live. */
export function CallCard({ callId }: { callId: string }) {
  const info = usePlatform((state) => state.calls[callId]);
  useEffect(() => loadCall(callId), [callId]);
  if (info === undefined) return <div className="call-card is-loading" aria-busy="true" />;
  if (info === null) return <div className="call-card is-missing">{S.calls.unavailable}</div>;
  const people = info.users.slice(0, 8);
  return (
    <div className={`call-card ${info.is_active ? 'is-active' : 'is-ended'}`}>
      <span className="call-icon" aria-hidden="true">
        {info.is_active ? <Phone size={18} /> : <PhoneOff size={18} />}
      </span>
      <div className="call-main">
        <div className="call-title">{info.title || S.calls.untitled}</div>
        <div className="call-meta">
          {info.is_active ? S.calls.live(info.app_name) : S.calls.ended(lasted(info.duration ?? 0))}
          {info.external_display_id ? <span className="call-id"> · {info.external_display_id}</span> : null}
        </div>
        {people.length ? (
          <div className="call-people" aria-label={S.calls.people(info.users.length)}>
            {people.map((user, index) => (
              <Participant key={user.slack_id ?? user.external_id ?? index} user={user} />
            ))}
            {info.users.length > people.length ? <span className="call-more">+{info.users.length - people.length}</span> : null}
          </div>
        ) : null}
      </div>
      {info.is_active ? (
        <a className="btn btn-primary btn-sm call-join" href={info.join_url} target="_blank" rel="noopener noreferrer">
          {S.calls.join}
        </a>
      ) : null}
    </div>
  );
}
