// Capacitor 8 shells for iOS and Android. The app ships only a small page
// (www/) that keeps a list of servers; choosing one loads that server's own
// web client in the app, which finds the native plugins on `window.Capacitor`
// (apps/web/src/lib/native.ts).
//
// Loaded by the Capacitor CLI through Node's TypeScript stripping: imports
// carry `.ts` and only erasable syntax is used.

import type { CapacitorConfig } from '@capacitor/cli';
import { BRAND } from '../../packages/shared/src/brand.ts';

const BG = '#0f2a33';

const config: CapacitorConfig = {
  // PLACEHOLDER: the owner confirms the bundle id before the first store upload; it is permanent once published.
  appId: `dev.${BRAND.slug}.mobile`,
  appName: BRAND.name,
  webDir: 'www',
  backgroundColor: BG,
  loggingBehavior: 'debug',
  server: {
    // Each person's own server, whatever its address: the app navigates there.
    allowNavigation: ['*'],
    // Servers on a home or office network are often plain http; iOS allows local
    // addresses only (NSAllowsLocalNetworking), Android needs cleartext allowed.
    cleartext: true,
  },
  ios: {
    backgroundColor: BG,
    contentInset: 'never',
  },
  android: {
    backgroundColor: BG,
    allowMixedContent: false,
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
