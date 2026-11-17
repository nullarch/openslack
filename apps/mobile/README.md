# Mobile apps (iOS and Android)

Capacitor 8 shells. The app ships one small page (`www/`): the list of servers this person uses. Choosing a server loads that server's own web client in the app, so the app never needs updating when a server does. The web client finds the native bridge on `window.Capacitor` (`apps/web/src/lib/native.ts`) and then:

- registers the phone for notifications (`client.push.registerDevice`) instead of Web Push, when the server has a push relay (`PUSH_RELAY_URL`, see `apps/push-relay`);
- opens the message a tapped notification is about, or that notification's server;
- offers **Switch server** in the workspace menu, back to the list;
- does not focus the composer on its own, so the keyboard does not come up whenever a conversation opens.

A link `<slug>://open?server=https://chat.example.com` opens (and adds) a server; `<slug>` is the brand's slug, written into the native projects by `scripts/native-config.mjs`.

## Build

```bash
pnpm install
cd apps/mobile
pnpm sync                    # copies www/ and writes the URL scheme
# iOS simulator
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator -destination 'name=iPhone 17 Pro' build CODE_SIGNING_ALLOWED=NO
# Android debug APK (JDK 17 or 21)
cd android && ./gradlew assembleDebug
```

## Before a store release (owner)

- The bundle id (`capacitor.config.ts`, now `dev.<slug>.mobile`) is permanent once published.
- Icons and splash screens are still Capacitor's placeholders.
- iOS: an Apple Developer team, signing, the Push Notifications capability (`aps-environment`), and an APNs key for the relay.
- Android: a Firebase project for the app; its `google-services.json` goes in `android/app/` (without it the app runs but cannot register for notifications), and its service account goes to the relay.
- The relay must run somewhere reachable by every server, at an address the apps' users' servers are told (`PUSH_RELAY_URL`).

## What was checked

On the iOS 26.3 simulator: the server list, opening a server from a link, signing in, the web client inside the app (safe areas, status bar, no keyboard on open), and that the web client on the server's own page reaches the native plugins (the debug console shows `PushNotifications addListener` from that page). A push token cannot be obtained in an unsigned simulator build; the path server → relay → Apple is covered by tests (`apps/server/test/native-push.test.ts`). The Android project builds; it has not been run on an emulator or a phone. Not yet: receiving shares from other apps (the share sheet) and keeping conversations for offline reading.

The simulator's WebKit draws Korean and Japanese as boxes under `system-ui` and cannot draw emoji at all; the web client names CJK fonts for CJK ranges first (`apps/web/src/styles/tokens.css`), and the emoji boxes are the simulator's alone.
