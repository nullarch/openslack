import { useCallback, useEffect, useState } from 'react';
import { attempt, closeModal, go, toast } from '../../lib/actions';
import { call } from '../../lib/api';
import { formatDate } from '../../lib/time';
import { S } from '../../strings';
import { confirmDialog } from '../dialogs/confirm';
import { Button, Field, Spinner } from '../ui';

interface SharedConversation {
  id: string;
  name: string | null;
  is_im: boolean;
  is_host: boolean;
  status: 'active' | 'disconnected';
}

interface Peer {
  id: string;
  url: string;
  team_id: string;
  name: string;
  status: string;
  pending: number;
  last_error: string | null;
  conversations: SharedConversation[];
}

interface Listing {
  enabled: boolean;
  peers: Peer[];
  invites: { id: string; channel: string; channel_name: string | null; created: number; expires: number }[];
}

/**
 * Administration → Shared channels: accept an invitation from another server,
 * see the servers this one shares with (and whether deliveries are waiting),
 * stop sharing, withdraw invitations, and turn the feature off.
 */
export function ConnectionsAdmin() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [link, setLink] = useState('');
  const [name, setName] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    call('client.connect.list')
      .then((result) => setListing(result as unknown as Listing))
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  if (!listing) return <Spinner />;

  const accept = async (): Promise<void> => {
    setBusy(true);
    const result = await attempt(() => call('conversations.acceptSharedInvite', { invite_id: link.trim(), channel_name: name.trim(), is_private: isPrivate }));
    setBusy(false);
    if (!result) return;
    toast(S.connect.accepted);
    setLink('');
    setName('');
    closeModal();
    go({ name: 'conversation', id: String(result.channel_id) });
  };
  const stop = async (conversation: SharedConversation, peer: Peer): Promise<void> => {
    if (!(await confirmDialog(S.connect.confirmStop(conversation.name ?? '', peer.name), S.connect.stop))) return;
    if (await attempt(() => call('client.connect.stop', { channel: conversation.id }))) load();
  };
  const revoke = async (id: string): Promise<void> => {
    if (await attempt(() => call('client.connect.revokeInvite', { invite_id: id }))) load();
  };
  const toggle = async (enabled: boolean): Promise<void> => {
    if (await attempt(() => call('client.admin.setSharedChannels', { enabled }))) setListing({ ...listing, enabled });
  };

  return (
    <div className="connections-admin">
      <section className="compliance-section">
        <h3 className="dialog-sub">{S.connect.title}</h3>
        <p className="field-hint">{S.connect.hint}</p>
        <label className="check-row">
          <input type="checkbox" checked={listing.enabled} onChange={(event) => void toggle(event.target.checked)} />
          <span>{S.connect.enabled}</span>
        </label>
      </section>

      {listing.enabled ? (
        <section className="compliance-section">
          <h3 className="dialog-sub">{S.connect.acceptTitle}</h3>
          <Field label={S.connect.link} hint={S.connect.linkHint}>
            <input value={link} placeholder="https://chat.example.org/connect/I…" spellCheck={false} onChange={(event) => setLink(event.target.value)} />
          </Field>
          <Field label={S.connect.channelName}>
            <input value={name} placeholder="partner-name" onChange={(event) => setName(event.target.value)} />
          </Field>
          <label className="check-row">
            <input type="checkbox" checked={isPrivate} onChange={(event) => setIsPrivate(event.target.checked)} />
            <span>{S.connect.private}</span>
          </label>
          <Button variant="primary" busy={busy} disabled={!link.trim() || !name.trim()} onClick={() => void accept()}>
            {S.connect.accept}
          </Button>
        </section>
      ) : null}

      <section className="compliance-section">
        <h3 className="dialog-sub">{S.connect.servers}</h3>
        {listing.peers.length === 0 ? <p className="muted">{S.connect.none}</p> : null}
        {listing.peers.map((peer) => (
          <div key={peer.id} className="connection">
            <div className="connection-head">
              <strong>{peer.name}</strong> <span className="muted">{peer.url}</span>
            </div>
            {peer.pending > 0 ? <p className="notice">{S.connect.waiting(peer.pending, peer.last_error)}</p> : null}
            <ul className="connection-list">
              {peer.conversations.map((conversation) => (
                <li key={conversation.id}>
                  <span>{conversation.is_im ? S.connect.directMessage : `#${conversation.name ?? ''}`}</span>
                  <span className="muted">{conversation.status === 'active' ? (conversation.is_host ? S.connect.hosted : S.connect.joined) : S.connect.stopped}</span>
                  {conversation.status === 'active' && !conversation.is_im ? (
                    <Button size="sm" variant="danger" onClick={() => void stop(conversation, peer)}>
                      {S.connect.stop}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      {listing.invites.length ? (
        <section className="compliance-section">
          <h3 className="dialog-sub">{S.connect.invites}</h3>
          <ul className="connection-list">
            {listing.invites.map((invite) => (
              <li key={invite.id}>
                <span>#{invite.channel_name ?? invite.channel}</span>
                <span className="muted">{S.connect.expires(formatDate(invite.expires, 'long'))}</span>
                <Button size="sm" onClick={() => void revoke(invite.id)}>
                  {S.connect.revoke}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
