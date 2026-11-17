# Desktop app

The server's own web client in a window of its own (Electron), with what a browser tab does not do well:

- a dock / taskbar badge with the unread count,
- several servers side by side (Servers menu, ⌘⇧1…9), each with its own cookies,
- a link scheme named after the product (`<scheme>://chat.example.com/archives/C…/p…` opens that message),
- links to other sites opening in the default browser,
- spell checking, and closing the window on macOS hides it instead of quitting.

Notifications are the web client's own browser notifications, shown natively by the operating system.

```bash
pnpm --filter @app/desktop start          # run from source (build the web client first if you run your own server)
pnpm --filter @app/desktop e2e            # drive the real app against a seeded server
pnpm --filter @app/desktop package:dir    # an unpacked app in apps/desktop/release
pnpm --filter @app/desktop package        # installers: dmg/zip (macOS), nsis (Windows), AppImage/deb (Linux)
```

`APP_SERVER_URL` (or a URL argument) adds a server on start; `APP_USER_DATA` points the profile elsewhere.

## Not done yet

- **Code signing and notarisation.** Unsigned builds trigger Gatekeeper / SmartScreen warnings. Signing needs an Apple Developer ID and a Windows code-signing certificate.
- **Automatic updates.** `electron-updater` needs published, signed releases to update from.
- **An icon.** The default Electron icon is used.
- Only the unpacked macOS (Apple silicon) build has been made and launched; Windows and Linux installers have not been built.
