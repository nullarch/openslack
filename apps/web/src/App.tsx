import { BRAND } from '@app/shared';
import { useEffect } from 'react';
import { Join, ResetPassword, Setup, SignIn, TwoFactorRequired } from './components/Auth';
import { DialogHost } from './components/dialogs/confirm';
import { Shell } from './components/Shell';
import { Button, Mark, Spinner, Toasts } from './components/ui';
import { useStore } from './lib/store';
import { S } from './strings';

function Screen() {
  const phase = useStore((state) => state.phase);
  const route = useStore((state) => state.route);
  const fatal = useStore((state) => state.fatal);
  const team = useStore((state) => state.publicTeam);

  useEffect(() => {
    if (phase !== 'ready') document.title = [team?.name, BRAND.name].filter(Boolean).join(' | ');
  }, [phase, team]);

  switch (phase) {
    case 'loading':
      return (
        <main className="splash">
          <Mark size={44} />
          <Spinner />
        </main>
      );
    case 'fatal':
      return (
        <main className="splash">
          <Mark size={44} />
          <h1>{S.fatal.title}</h1>
          <p>{fatal ?? S.fatal.body}</p>
          <Button variant="brand" onClick={() => window.location.reload()}>
            {S.fatal.reload}
          </Button>
        </main>
      );
    case 'setup':
      return <Setup />;
    case 'signin':
      return <SignIn />;
    case 'join':
      return <Join code={route.name === 'join' ? route.code : ''} />;
    case 'reset':
      return <ResetPassword token={route.name === 'reset' ? route.token : ''} />;
    case 'twofactor':
      return <TwoFactorRequired />;
    case 'ready':
      return <Shell />;
  }
}

export function App() {
  return (
    <>
      <Screen />
      <DialogHost />
      <Toasts />
    </>
  );
}
