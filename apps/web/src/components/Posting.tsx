import type { Conversation } from '@app/shared';
import { useState } from 'react';
import { adoptChannel, attempt } from '../lib/actions';
import { call } from '../lib/api';
import { displayName, useStore } from '../lib/store';
import { S } from '../strings';
import { Avatar } from './ui';

type Rule = 'post' | 'threads' | 'mentions';

/** Who may post, reply and use @channel here; and the channel's managers. */
export function PostingPermissions({ conv, canManage }: { conv: Conversation; canManage: boolean }) {
  const users = useStore((state) => state.users);
  const [adding, setAdding] = useState('');
  const props = conv.properties ?? {};
  const current: Record<Rule, 'everyone' | 'admins'> = {
    post: props.posting_restrictions ? 'admins' : 'everyone',
    threads: props.threads_restrictions ? 'admins' : 'everyone',
    mentions: props.at_channel_restricted ? 'admins' : 'everyone',
  };
  const managers = conv.managers ?? [];
  const set = async (rule: Rule, value: string): Promise<void> => {
    const result = await attempt(() => call('client.conversations.setPostingPolicy', { channel: conv.id, [rule]: value }));
    if (result) adoptChannel(result.channel);
  };
  const changeManagers = async (args: { add?: string[]; remove?: string[] }): Promise<void> => {
    const result = await attempt(() => call('client.conversations.setManagers', { channel: conv.id, ...args }));
    if (result) adoptChannel({ ...conv, managers: result.managers });
  };
  const rows: [Rule, string][] = [
    ['post', S.att.posting.post],
    ['threads', S.att.posting.threads],
    ['mentions', S.att.posting.mentions],
  ];
  const candidates = Object.values(users)
    .filter((user) => !user.deleted && !user.is_bot && !managers.includes(user.id))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));

  return (
    <section className="about-item posting">
      <div className="about-head">
        <h4>{S.att.posting.title}</h4>
      </div>
      {rows.map(([rule, label]) => (
        <label key={rule} className="posting-row">
          <span>{label}</span>
          {canManage ? (
            <select value={current[rule]} onChange={(event) => void set(rule, event.target.value)} aria-label={label}>
              <option value="everyone">{S.att.posting.everyone}</option>
              <option value="admins">{S.att.posting.admins}</option>
            </select>
          ) : (
            <strong>{current[rule] === 'everyone' ? S.att.posting.everyone : S.att.posting.admins}</strong>
          )}
        </label>
      ))}
      <div className="about-head posting-managers-head">
        <h4>{S.att.posting.managers}</h4>
      </div>
      {managers.length === 0 ? <p className="muted">{S.att.posting.noManagers}</p> : null}
      <ul className="posting-managers">
        {managers.map((id) => (
          <li key={id}>
            <Avatar user={users[id]} size={22} />
            <span>{displayName(users[id])}</span>
            {canManage ? (
              <button type="button" className="link-btn" onClick={() => void changeManagers({ remove: [id] })}>
                {S.att.posting.removeManager}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {canManage ? (
        <div className="posting-add">
          <select value={adding} onChange={(event) => setAdding(event.target.value)} aria-label={S.att.posting.addManager}>
            <option value="">{S.att.posting.addManager}</option>
            {candidates.map((user) => (
              <option key={user.id} value={user.id}>
                {displayName(user)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-default btn-sm"
            disabled={!adding}
            onClick={() => {
              void changeManagers({ add: [adding] });
              setAdding('');
            }}
          >
            {S.att.posting.addManager}
          </button>
        </div>
      ) : null}
    </section>
  );
}
