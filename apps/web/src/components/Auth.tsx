import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { boot, errorText } from '../lib/actions';
import { useAccounts } from '../lib/accounts';
import { ApiError, call } from '../lib/api';
import { pushRoute } from '../lib/router';
import { set, useStore } from '../lib/store';
import { S } from '../strings';
import { TwoFactorSetup } from './accounts/TwoFactor';
import { Button, Field, Mark, Spinner } from './ui';

function AuthLayout({ title, lead, children, foot }: { title: ReactNode; lead?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <main className="auth">
      <div className="auth-brand">
        <Mark size={34} />
        <span>{S.brand}</span>
      </div>
      <div className="auth-card">
        <h1>{title}</h1>
        {lead ? <p className="auth-lead">{lead}</p> : null}
        {children}
      </div>
      <p className="auth-foot">{foot ?? S.auth.tagline}</p>
    </main>
  );
}

function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

/** After signing in, the app starts for real. */
async function enter(): Promise<void> {
  set({ phase: 'loading' });
  await boot();
}

function useSubmit(action: () => Promise<void>): { busy: boolean; error: string | null; submit: (event: FormEvent) => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    action()
      .then(enter)
      .catch((failure: unknown) => {
        setError(errorText(failure));
        setBusy(false);
      });
  };
  return { busy, error, submit };
}

export function Setup() {
  const [teamName, setTeamName] = useState('');
  const [realName, setRealName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    await call('client.setup', { team_name: teamName.trim(), real_name: realName.trim(), email: email.trim(), password, tz: timeZone() });
  });
  return (
    <AuthLayout title={S.auth.setupTitle} lead={S.auth.setupBody}>
      <form onSubmit={submit}>
        <Field label={S.auth.teamName}>
          <input value={teamName} placeholder={S.auth.teamNamePlaceholder} maxLength={80} required autoFocus onChange={(event) => setTeamName(event.target.value)} />
        </Field>
        <Field label={S.auth.yourName}>
          <input value={realName} maxLength={80} required autoComplete="name" onChange={(event) => setRealName(event.target.value)} />
        </Field>
        <Field label={S.auth.email}>
          <input type="email" value={email} required autoComplete="email" onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Field label={S.auth.password} hint={S.auth.passwordHint}>
          <input type="password" value={password} minLength={8} required autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} />
        </Field>
        {error ? <p className="auth-error" role="alert">{error}</p> : null}
        <Button type="submit" variant="brand" busy={busy} className="auth-submit">
          {S.auth.createWorkspace}
        </Button>
      </form>
    </AuthLayout>
  );
}

/** Sign-in buttons for the identity providers the server offers. */
function ProviderButtons({ invite }: { invite?: string }) {
  const providers = useAccounts((state) => state.providers);
  if (providers.length === 0) return null;
  return (
    <div className="auth-providers">
      {providers.map((provider) => (
        <a
          key={provider.id}
          className="btn btn-default btn-md auth-provider"
          href={`/auth/${provider.id}/start${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`}
        >
          <span className="btn-label">{S.accounts.continueWith(provider.label)}</span>
        </a>
      ))}
      <div className="auth-or">
        <span>{S.accounts.or}</span>
      </div>
    </div>
  );
}

/** A provider sign-in that came back with an error puts it in the address. */
function errorFromAddress(): string | null {
  const code = new URLSearchParams(window.location.search).get('error');
  return code ? errorText(new ApiError(code)) : null;
}

type SignInMode = 'password' | 'code' | 'code-sent' | 'reset' | 'reset-sent' | 'two-factor';

export function SignIn() {
  const team = useStore((state) => state.publicTeam);
  const mailEnabled = useAccounts((state) => state.mailEnabled);
  const [mode, setMode] = useState<SignInMode>(() =>
    new URLSearchParams(window.location.search).get('step') === 'two-factor' ? 'two-factor' : 'password',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(errorFromAddress);

  const run = (action: () => Promise<void>) => (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    action()
      .catch((failure: unknown) => setError(errorText(failure)))
      .finally(() => setBusy(false));
  };
  /** A sign-in step answered: either the session started, or the second factor is next. */
  const after = async (result: { two_factor_required?: boolean }): Promise<void> => {
    if (result.two_factor_required) {
      setCode('');
      setMode('two-factor');
      return;
    }
    await enter();
  };
  const go = (next: SignInMode): void => {
    setError(null);
    setCode('');
    setMode(next);
  };

  if (mode === 'two-factor') {
    return (
      <AuthLayout title={S.accounts.twoFactorTitle} lead={S.accounts.twoFactorBody}>
        <form onSubmit={run(async () => after(await call('client.signin.twoFactor', { code: code.trim() })))}>
          <Field label={S.accounts.twoFactorCode}>
            <input value={code} required autoFocus autoComplete="one-time-code" maxLength={11} onChange={(event) => setCode(event.target.value)} />
          </Field>
          {error ? <p className="auth-error" role="alert">{error}</p> : null}
          <Button type="submit" variant="brand" busy={busy} className="auth-submit">
            {S.accounts.twoFactorSubmit}
          </Button>
        </form>
        <button type="button" className="link-btn auth-switch" onClick={() => go('password')}>
          {S.accounts.backToSignin}
        </button>
      </AuthLayout>
    );
  }

  if (mode === 'reset' || mode === 'reset-sent') {
    return (
      <AuthLayout title={mode === 'reset' ? S.accounts.resetTitle : S.accounts.resetSentTitle} lead={mode === 'reset' ? S.accounts.resetBody : S.accounts.resetSentBody}>
        {mode === 'reset' ? (
          <form
            onSubmit={run(async () => {
              await call('client.account.sendPasswordReset', { email: email.trim() });
              setMode('reset-sent');
            })}
          >
            <Field label={S.auth.email}>
              <input type="email" value={email} required autoFocus autoComplete="email" onChange={(event) => setEmail(event.target.value)} />
            </Field>
            {error ? <p className="auth-error" role="alert">{error}</p> : null}
            <Button type="submit" variant="brand" busy={busy} className="auth-submit">
              {S.accounts.resetSend}
            </Button>
          </form>
        ) : null}
        <button type="button" className="link-btn auth-switch" onClick={() => go('password')}>
          {S.accounts.backToSignin}
        </button>
      </AuthLayout>
    );
  }

  if (mode === 'code' || mode === 'code-sent') {
    return (
      <AuthLayout
        title={mode === 'code' ? S.auth.signinTitle(team?.name ?? S.brand) : S.accounts.codeSentTitle}
        lead={mode === 'code-sent' ? S.accounts.codeSentBody(email) : undefined}
      >
        {mode === 'code' ? (
          <form
            onSubmit={run(async () => {
              await call('client.signin.sendCode', { email: email.trim() });
              setMode('code-sent');
            })}
          >
            <Field label={S.auth.email}>
              <input type="email" value={email} required autoFocus autoComplete="email" onChange={(event) => setEmail(event.target.value)} />
            </Field>
            {error ? <p className="auth-error" role="alert">{error}</p> : null}
            <Button type="submit" variant="brand" busy={busy} className="auth-submit">
              {S.accounts.emailCode}
            </Button>
          </form>
        ) : (
          <form onSubmit={run(async () => after(await call('client.signin.withCode', { email: email.trim(), code: code.trim() })))}>
            <Field label={S.accounts.code}>
              <input
                value={code}
                required
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              />
            </Field>
            {error ? <p className="auth-error" role="alert">{error}</p> : null}
            <Button type="submit" variant="brand" busy={busy} className="auth-submit">
              {S.accounts.codeSubmit}
            </Button>
          </form>
        )}
        <button type="button" className="link-btn auth-switch" onClick={() => go('password')}>
          {S.accounts.usePassword}
        </button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={S.auth.signinTitle(team?.name ?? S.brand)} foot={S.auth.signinHelp}>
      <ProviderButtons />
      <form onSubmit={run(async () => after(await call('client.signin', { email: email.trim(), password })))}>
        <Field label={S.auth.email}>
          <input type="email" value={email} required autoFocus autoComplete="email" onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Field label={S.auth.password}>
          <input type="password" value={password} required autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} />
        </Field>
        {error ? <p className="auth-error" role="alert">{error}</p> : null}
        <Button type="submit" variant="brand" busy={busy} className="auth-submit">
          {S.auth.signin}
        </Button>
      </form>
      {mailEnabled ? (
        <div className="auth-links">
          <button type="button" className="link-btn" onClick={() => go('code')}>
            {S.accounts.emailCode}
          </button>
          <button type="button" className="link-btn" onClick={() => go('reset')}>
            {S.accounts.forgot}
          </button>
        </div>
      ) : null}
    </AuthLayout>
  );
}

/** `/reset/<token>`: choose a new password from a mailed link. */
export function ResetPassword({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    call('client.account.resetPassword', { token, password })
      .then(async (result) => {
        if (result.two_factor_required) {
          window.location.assign('/signin?step=two-factor');
          return;
        }
        window.history.replaceState(null, '', '/');
        await enter();
      })
      .catch((failure: unknown) => {
        setError(errorText(failure));
        setBusy(false);
      });
  };
  return (
    <AuthLayout title={S.accounts.newPasswordTitle}>
      <form onSubmit={submit}>
        <Field label={S.accounts.newPassword} hint={S.auth.passwordHint}>
          <input type="password" value={password} minLength={8} required autoFocus autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} />
        </Field>
        {error ? <p className="auth-error" role="alert">{error}</p> : null}
        <Button type="submit" variant="brand" busy={busy} className="auth-submit">
          {S.accounts.newPasswordSubmit}
        </Button>
      </form>
    </AuthLayout>
  );
}

/** The workspace requires two-factor sign-in and this person has not set it up yet. */
export function TwoFactorRequired() {
  return (
    <AuthLayout title={S.accounts.setupRequiredTitle} lead={S.accounts.setupRequiredBody}>
      <TwoFactorSetup onDone={() => void enter()} />
    </AuthLayout>
  );
}

interface InviteInfo {
  valid: boolean;
  team?: { name: string };
  inviter_name?: string;
  email?: string | null;
  guest?: string | null;
  signup_domains?: string[];
}

export function Join({ code }: { code: string }) {
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [providerError] = useState<string | null>(errorFromAddress);
  const [realName, setRealName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    await call('client.signup', { code, real_name: realName.trim(), email: email.trim(), password, tz: timeZone() });
  });

  useEffect(() => {
    call('client.invites.info', { code })
      .then((result) => {
        setInfo(result as InviteInfo);
        if (result.email) setEmail(String(result.email));
      })
      .catch(() => setInfo({ valid: false }));
  }, [code]);

  if (!info) {
    return (
      <main className="auth">
        <Spinner label={S.loading} />
      </main>
    );
  }
  if (!info.valid) {
    return (
      <AuthLayout title={S.auth.inviteInvalidTitle} lead={S.auth.inviteInvalidBody}>
        <Button
          variant="brand"
          className="auth-submit"
          onClick={() => {
            pushRoute({ name: 'signin' });
            set({ route: { name: 'signin' }, phase: 'signin' });
          }}
        >
          {S.auth.goToSignin}
        </Button>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title={S.auth.joinTitle(info.team?.name ?? S.brand)} lead={S.auth.joinBody(info.inviter_name ?? '')}>
      <ProviderButtons invite={code} />
      {providerError ? <p className="auth-error" role="alert">{providerError}</p> : null}
      <form onSubmit={submit}>
        <Field label={S.auth.yourName}>
          <input value={realName} maxLength={80} required autoFocus autoComplete="name" onChange={(event) => setRealName(event.target.value)} />
        </Field>
        <Field label={S.auth.email} hint={info.signup_domains?.length ? `${S.accounts.domains}: ${info.signup_domains.join(', ')}` : undefined}>
          <input type="email" value={email} required readOnly={Boolean(info.email)} autoComplete="email" onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Field label={S.auth.password} hint={S.auth.passwordHint}>
          <input type="password" value={password} minLength={8} required autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} />
        </Field>
        {error ? <p className="auth-error" role="alert">{error}</p> : null}
        <Button type="submit" variant="brand" busy={busy} className="auth-submit">
          {S.auth.join}
        </Button>
      </form>
    </AuthLayout>
  );
}
