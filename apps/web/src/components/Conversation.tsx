import type { Conversation } from '@app/shared';
import { Hash, Info, Lock, Menu, Star, Users } from 'lucide-react';
import { attempt, joinChannel, setConversationPrefs, setPanel } from '../lib/actions';
import { call } from '../lib/api';
import { conversation, conversationName, set, useStore } from '../lib/store';
import { S } from '../strings';
import { Composer } from './Composer';
import { promptDialog } from './dialogs/confirm';
import { MessageList } from './MessageList';
import { Emoji, Mrkdwn } from './text';
import { Avatar, Button, IconButton, Spinner } from './ui';

export async function editTopic(conv: Conversation): Promise<void> {
  const topic = await promptDialog({ title: S.details.topic, label: S.details.topic, initial: conv.topic?.value ?? '' });
  if (topic === null) return;
  await attempt(() => call('conversations.setTopic', { channel: conv.id, topic: topic.trim() }));
}

function Header({ conv, isMember }: { conv: Conversation; isMember: boolean }) {
  const name = useStore((state) => conversationName(state, conv));
  const other = useStore((state) => (conv.is_im ? state.users[conv.user ?? ''] : undefined));
  const isSelf = useStore((state) => conv.is_im && conv.user === state.self?.id);
  const direct = conv.is_im || conv.is_mpim;

  const openDetails = (tab: 'about' | 'members'): void => {
    if (conv.is_im && other) setPanel({ kind: 'profile', user: other.id });
    else setPanel({ kind: 'details', channel: conv.id, tab });
  };

  return (
    <header className="conv-head">
      <IconButton className="only-narrow" label={S.sidebar.openSidebar} onClick={() => set({ drawer: true })}>
        <Menu size={19} />
      </IconButton>
      <button type="button" className="conv-title" onClick={() => openDetails('about')}>
        {conv.is_im ? (
          <Avatar user={other} size={24} presence />
        ) : conv.is_mpim ? (
          <Users size={18} />
        ) : conv.is_private ? (
          <Lock size={17} />
        ) : (
          <Hash size={18} />
        )}
        <span className="conv-name">{name}</span>
        {isSelf ? <span className="conv-you">{S.sidebar.you}</span> : null}
        {other?.profile.status_emoji ? <Emoji name={other.profile.status_emoji.replace(/:/g, '')} /> : null}
      </button>
      {isMember ? (
        <IconButton
          className={`star-btn ${conv.is_starred ? 'is-on' : ''}`}
          label={conv.is_starred ? S.header.unstar : S.header.star}
          onClick={() => void setConversationPrefs(conv.id, { starred: !conv.is_starred })}
        >
          <Star size={16} fill={conv.is_starred ? 'currentColor' : 'none'} />
        </IconButton>
      ) : null}
      {conv.is_archived ? <span className="tag">{S.header.archived}</span> : null}
      <div className="conv-topic">
        {direct ? (
          other?.profile.status_text ? (
            <span>{other.profile.status_text}</span>
          ) : other?.profile.title ? (
            <span>{other.profile.title}</span>
          ) : null
        ) : conv.topic?.value ? (
          <button type="button" className="topic-btn" onClick={() => void (isMember ? editTopic(conv) : undefined)} title={conv.topic.value}>
            <Mrkdwn text={conv.topic.value} inline />
          </button>
        ) : isMember && !conv.is_archived ? (
          <button type="button" className="topic-btn is-empty" onClick={() => void editTopic(conv)}>
            {S.header.addTopic}
          </button>
        ) : null}
      </div>
      {!conv.is_im ? (
        <button type="button" className="members-btn" onClick={() => openDetails('members')} title={S.header.members(conv.num_members ?? conv.members?.length ?? 0)}>
          <Users size={16} />
          <span>{conv.num_members ?? conv.members?.length ?? ''}</span>
        </button>
      ) : null}
      <IconButton label={S.header.details} onClick={() => openDetails('about')}>
        <Info size={18} />
      </IconButton>
    </header>
  );
}

export function ConversationView({ channel }: { channel: string }) {
  const conv = useStore((state) => conversation(state, channel));
  const isMember = useStore((state) => state.channels[channel] !== undefined);
  const name = useStore((state) => conversationName(state, conv));

  if (!conv) {
    return (
      <section className="conversation">
        <div className="list-loading">
          <Spinner />
        </div>
      </section>
    );
  }

  const placeholder = conv.is_channel ? S.composer.placeholderChannel(name) : S.composer.placeholderDm(name);
  return (
    <section className="conversation" data-drop-scope data-drop-label={S.composer.dropHere}>
      <Header conv={conv} isMember={isMember} />
      <MessageList key={`list:${channel}`} channel={channel} />
      {conv.is_archived ? (
        <div className="notice-bar">{S.header.archivedNotice}</div>
      ) : !isMember ? (
        <div className="join-bar">
          <span>{S.header.notMember(name)}</span>
          <Button variant="primary" onClick={() => void joinChannel(channel)}>
            {S.header.join}
          </Button>
        </div>
      ) : (
        <Composer key={`composer:${channel}`} channel={channel} placeholder={placeholder} autoFocus />
      )}
    </section>
  );
}
