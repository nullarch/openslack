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

Installers: `pnpm --filter @app/desktop package` on each system, or the **Desktop** workflow in CI, which builds macOS (dmg, zip), Windows (nsis) and Linux (AppImage, deb) and, on a `v*` tag, puts them in a draft GitHub release with the update feed. Installed copies check that feed at start and every six hours (`electron-updater`); `APP_NO_UPDATES=1` turns it off. The icon is `build/icon.png`, made from the web client's favicon with `pnpm --filter @app/desktop icon`.

## Not done yet

- **Code signing and notarisation.** Unsigned builds trigger Gatekeeper / SmartScreen warnings, and macOS applies automatic updates only to signed apps. Signing needs an Apple Developer ID and a Windows code-signing certificate.
- **Updates from a private repository.** The update feed is read from the GitHub releases of the repository in the brand module; while it is private, installed copies cannot read it.
