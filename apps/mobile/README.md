# Mobile apps (iOS and Android)

Capacitor 8 shells. The app ships one small page (`www/`): the list of servers this person uses. Choosing a server loads that server's own web client in the app, so the app never needs updating when a server does. The web client finds the native bridge on `window.Capacitor` (`apps/web/src/lib/native.ts`) and then:

- registers the phone for notifications (`client.push.registerDevice`) instead of Web Push, when the server has a push relay (`PUSH_RELAY_URL`, see `apps/push-relay`);
- opens the message a tapped notification is about, or that notification's server;
- offers **Switch server** in the workspace menu, back to the list;
- does not focus the composer on its own, so the keyboard does not come up whenever a conversation opens;
- keeps the last messages of the ten conversations looked at most recently in the app's own storage (`@capacitor/preferences`). When the server cannot be reached the app shows its own page (`www/offline.html`, Capacitor's `errorPath`) with a way to try again, the server list, and those messages to read: an iOS web view cannot open a server's page without the network;
- on Android, receives text, links and files shared from other apps (the share sheet: `ShareTargetPlugin.java`, `ACTION_SEND`) and asks where to send them.

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

On the iOS 26.3 simulator: the server list, opening a server from a link, signing in, the web client inside the app (safe areas, status bar, no keyboard on open), that the web client on the server's own page reaches the native plugins (the debug console shows `PushNotifications addListener` from that page), and offline reading (the server stopped: the app's page lists the saved messages). A push token cannot be obtained in an unsigned simulator build; the path server → relay → Apple is covered by tests (`apps/server/test/native-push.test.ts`). The Android project builds, share sheet included; it has not been run: the Android emulator installed on this Mac is the x86_64 build, which cannot run there. Not yet: the share sheet on iOS (it needs a Share Extension target and an App Group).

Open: in the simulator, after signing in with its hardware keyboard, the web view's top safe-area inset stayed zero (the workspace ran under the status bar) until the app was restarted; it did not happen after a restart, with or without the Keyboard plugin. Check on a phone.

The simulator's WebKit draws Korean and Japanese as boxes under `system-ui` and cannot draw emoji at all; the web client names CJK fonts for CJK ranges first (`apps/web/src/styles/tokens.css`), and the emoji boxes are the simulator's alone.
