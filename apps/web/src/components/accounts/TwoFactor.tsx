import { useEffect, useMemo, useState } from 'react';
import { encode } from 'uqr';
import { errorText } from '../../lib/actions';
import { call } from '../../lib/api';
import { S } from '../../strings';
import { Button, CopyField, Field, Spinner } from '../ui';

/** A QR code drawn as one SVG path, so it scales crisply and follows no external style. */
export function QrCode({ text, size = 168 }: { text: string; size?: number }) {
  const path = useMemo(() => {
    const { data } = encode(text, { ecc: 'M', border: 2 });
    let d = '';
    data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { d, cells: data.length };
  }, [text]);
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${path.cells} ${path.cells}`} role="img" aria-label={S.accounts.setupScan}>
      <rect width={path.cells} height={path.cells} fill="#fff" />
      <path d={path.d} fill="#111" />
    </svg>
  );
}

export function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="twofactor-backup">
      <h3 className="dialog-sub">{S.accounts.backupTitle}</h3>
      <p className="muted">{S.accounts.backupBody}</p>
      <ol className="backup-codes">
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ol>
      <CopyField value={codes.join('\n')} />
      <Button variant="primary" onClick={onDone}>
        {S.accounts.backupDone}
      </Button>
    </div>
  );
}

/** Start two-factor sign-in: scan, confirm with a code, keep the backup codes. */
export function TwoFactorSetup({ onDone }: { onDone: () => void }) {
  const [secret, setSecret] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call('client.security.twoFactor.begin')
      .then((result) => setSecret({ secret: result.secret, otpauth_url: result.otpauth_url }))
      .catch((failure: unknown) => setError(errorText(failure)));
  }, []);

  if (codes) return <BackupCodes codes={codes} onDone={onDone} />;
  if (!secret) return error ? <p className="auth-error">{error}</p> : <Spinner label={S.loading} />;

  const enable = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await call('client.security.twoFactor.enable', { code: code.trim() });
      setCodes(result.backup_codes as string[]);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="twofactor-setup"
      onSubmit={(event) => {
        event.preventDefault();
        void enable();
      }}
    >
      <p className="muted">{S.accounts.setupScan}</p>
      <div className="twofactor-qr">
        <QrCode text={secret.otpauth_url} />
        <div className="twofactor-key">
          <span className="field-label">{S.accounts.setupKey}</span>
          <code data-testid="totp-secret">{secret.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
        </div>
      </div>
      <Field label={S.accounts.setupConfirm} error={error}>
        <input
          value={code}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="123456"
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          autoFocus
        />
      </Field>
      <Button type="submit" variant="primary" busy={busy} disabled={code.length !== 6}>
        {S.accounts.setupEnable}
      </Button>
    </form>
  );
}
