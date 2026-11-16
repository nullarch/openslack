import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { boot, errorText } from '../lib/actions';
import { call } from '../lib/api';
import { pushRoute } from '../lib/router';
import { set, useStore } from '../lib/store';
import { S } from '../strings';
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

export function SignIn() {
  const team = useStore((state) => state.publicTeam);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    await call('client.signin', { email: email.trim(), password });
  });
  return (
    <AuthLayout title={S.auth.signinTitle(team?.name ?? S.brand)} foot={S.auth.signinHelp}>
      <form onSubmit={submit}>
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
    </AuthLayout>
  );
}

interface InviteInfo {
  valid: boolean;
  team?: { name: string };
  inviter_name?: string;
  email?: string | null;
}

export function Join({ code }: { code: string }) {
  const [info, setInfo] = useState<InviteInfo | null>(null);
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
      <form onSubmit={submit}>
        <Field label={S.auth.yourName}>
          <input value={realName} maxLength={80} required autoFocus autoComplete="name" onChange={(event) => setRealName(event.target.value)} />
        </Field>
        <Field label={S.auth.email}>
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
