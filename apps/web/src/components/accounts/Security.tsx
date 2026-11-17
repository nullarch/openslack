import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { attempt, errorText } from '../../lib/actions';
import { closeAccountsModal, useAccounts } from '../../lib/accounts';
import { call, type Json } from '../../lib/api';
import { disablePush, enablePush, pushState, type PushState } from '../../lib/push';
import { S } from '../../strings';
import { promptDialog } from '../dialogs/confirm';
import { Button, Modal, Spinner } from '../ui';
import { BackupCodes, TwoFactorSetup } from './TwoFactor';

function PushSection() {
  const vapidKey = useAccounts((state) => state.vapidKey);
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void pushState().then(setState);
  }, []);
  const toggle = async (): Promise<void> => {
    setBusy(true);
    try {
      setState(state === 'on' ? await disablePush() : await enablePush(vapidKey ?? ''));
    } catch {
      setState(await pushState());
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset className="pref-group">
      <legend>{S.accounts.pushTitle}</legend>
      <p className="muted">{S.accounts.pushBody}</p>
      {state === null ? (
        <Spinner />
      ) : state === 'unsupported' ? (
        <p>{S.accounts.pushUnsupported}</p>
      ) : state === 'blocked' ? (
        <p>{S.accounts.pushBlocked}</p>
      ) : (
        <div className="pref-row">
          {state === 'on' ? <span>{S.accounts.pushOn}</span> : null}
          <Button variant={state === 'on' ? 'default' : 'primary'} busy={busy} disabled={!vapidKey} onClick={() => void toggle()}>
            {state === 'on' ? S.accounts.pushDisable : S.accounts.pushEnable}
          </Button>
        </div>
      )}
    </fieldset>
  );
}

function TwoFactorSection() {
  const [status, setStatus] = useState<Json | null>(null);
  const [setting, setSetting] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const refresh = (): void => {
    call('client.twoFactor.status')
      .then(setStatus)
      .catch(() => setStatus({ enabled: false }));
  };
  useEffect(refresh, []);

  const ask = async (title: string): Promise<string | null> => {
    const code = await promptDialog({ title, label: S.accounts.twoFactorCode });
    return code?.trim() || null;
  };
  const disable = async (): Promise<void> => {
    const code = await ask(S.accounts.twoFactorDisablePrompt);
    if (code && (await attempt(() => call('client.twoFactor.disable', { code })))) refresh();
  };
  const regenerate = async (): Promise<void> => {
    const code = await ask(S.accounts.backupNew);
    const result = code ? await attempt(() => call('client.twoFactor.regenerateBackupCodes', { code })) : undefined;
    if (result) setCodes(result.backup_codes as string[]);
  };

  if (codes) {
    return (
      <fieldset className="pref-group">
        <legend>{S.accounts.twoFactorTitle}</legend>
        <BackupCodes
          codes={codes}
          onDone={() => {
            setCodes(null);
            refresh();
          }}
        />
      </fieldset>
    );
  }
  return (
    <fieldset className="pref-group">
      <legend>{S.accounts.twoFactorTitle}</legend>
      {status === null ? (
        <Spinner />
      ) : setting ? (
        <TwoFactorSetup
          onDone={() => {
            setSetting(false);
            refresh();
          }}
        />
      ) : status.enabled ? (
        <>
          <p className="security-on">
            <ShieldCheck size={16} /> {S.accounts.twoFactorOn} {status.required ? S.accounts.twoFactorRequired : ''}
          </p>
          <p className="muted">{S.accounts.backupLeft(status.backup_codes_left ?? 0)}</p>
          <div className="pref-row">
            <Button onClick={() => void regenerate()}>{S.accounts.backupNew}</Button>
            {!status.required ? (
              <Button variant="ghost" onClick={() => void disable()}>
                {S.accounts.twoFactorDisable}
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <p className="muted">{S.accounts.twoFactorOff}</p>
          <Button variant="primary" onClick={() => setSetting(true)}>
            {S.accounts.twoFactorStart}
          </Button>
        </>
      )}
    </fieldset>
  );
}

export function SecurityDialog() {
  return (
    <Modal title={S.accounts.securityTitle} onClose={closeAccountsModal} width={520}>
      <TwoFactorSection />
      <PushSection />
    </Modal>
  );
}

export function RequestInviteDialog() {
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const send = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await call('client.inviteRequests.create', { email: email.trim(), reason: reason.trim() });
      setSent(true);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={S.accounts.requestTitle} onClose={closeAccountsModal} width={480}>
      {sent ? (
        <p>{S.accounts.requestSent}</p>
      ) : (
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <p className="dialog-lead">{S.accounts.requestBody}</p>
          <label className="field">
            <span className="field-label">{S.auth.email}</span>
            <input type="email" value={email} required autoFocus onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">
              {S.accounts.requestReason} ({S.optional})
            </span>
            <input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
          </label>
          {error ? <p className="auth-error" role="alert">{error}</p> : null}
          <Button type="submit" variant="primary" busy={busy} disabled={!email.trim()}>
            {S.accounts.requestSend}
          </Button>
        </form>
      )}
    </Modal>
  );
}
