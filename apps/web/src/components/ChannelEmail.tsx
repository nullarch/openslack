import { useEffect, useState } from 'react';
import { attempt, toast } from '../lib/actions';
import { call } from '../lib/api';
import { S } from '../strings';
import { confirmDialog } from './dialogs/confirm';
import { Button, CopyField } from './ui';

/** The channel's own email address (client.conversations.email.*), when the server receives mail. */
export function ChannelEmail({ channel }: { channel: string }) {
  const [state, setState] = useState<{ enabled: boolean; address: string | null } | null>(null);
  useEffect(() => {
    call('client.conversations.email.get', { channel })
      .then((result) => setState({ enabled: Boolean(result.enabled), address: (result.address as string | null) ?? null }))
      .catch(() => setState(null));
  }, [channel]);
  if (!state?.enabled) return null;
  const create = async (): Promise<void> => {
    if (state.address && !(await confirmDialog(S.channelEmail.confirmReplace, S.channelEmail.replace))) return;
    const result = await attempt(() => call('client.conversations.email.create', { channel }));
    if (result) setState({ ...state, address: String(result.address) });
  };
  const remove = async (): Promise<void> => {
    if (!(await confirmDialog(S.channelEmail.confirmRemove, S.channelEmail.remove))) return;
    const result = await attempt(() => call('client.conversations.email.delete', { channel }));
    if (result) {
      setState({ ...state, address: null });
      toast(S.channelEmail.removed);
    }
  };
  return (
    <section className="about-item channel-email">
      <div className="about-head">
        <h4>{S.channelEmail.title}</h4>
      </div>
      <p className="muted">{S.channelEmail.hint}</p>
      {state.address ? (
        <>
          <CopyField value={state.address} label={S.channelEmail.address} />
          <div className="row-actions">
            <Button size="sm" onClick={() => void create()}>
              {S.channelEmail.replace}
            </Button>
            <Button size="sm" variant="danger" onClick={() => void remove()}>
              {S.channelEmail.remove}
            </Button>
          </div>
        </>
      ) : (
        <Button size="sm" onClick={() => void create()}>
          {S.channelEmail.create}
        </Button>
      )}
    </section>
  );
}
