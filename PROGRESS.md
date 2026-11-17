# Progress

Read this first. It says what exists, how it was verified, and what is next. The task board is `TODO.html`; scope and phases are in `PRD.md`.

## State on 2026-11-17

Everything in the 0.1 and 0.2 lists of `PRD.md` runs end to end on one machine (macOS, Node 24), and most of the 0.3 administration and compliance list too. Nothing is published: the repository is private and nothing is on npm or a container registry. Owner decisions that block a release are listed under *Next*.

### What exists

| Area | What works |
|---|---|
| Messaging | Channels (public, private, archived, converted either way, created from templates, with their own email address), DMs and group DMs (a group DM can become a private channel), threads, reactions, pins, edits, scheduled send, reminders, drafts, bookmarks, saved items, sidebar sections, link previews, Block Kit and Markdown, a composer that edits what you see (lists, quotes, code, links, mention chips; sent as mrkdwn plus a `rich_text` block, as Slack's client does) or markup by preference, `@here`/`@channel` and user-group mentions, posting permissions |
| Attention | Activity, Threads, All unreads, Later views; mention counts; DND and notification schedules; desktop notifications; email digests of missed mentions and DMs; Web Push from the PWA (server side verified, browser delivery not) |
| Files | Uploads with thumbnails the browser makes, audio/video/PDF in place, clips (audio, video, screen) recorded in the composer with captions, public links, S3-compatible storage, encryption at rest with keys you hold, ClamAV scanning, sensitive-information checks, search inside files (text, code, Word, Excel, PowerPoint, PDF), Office documents previewed as text, documents apps keep elsewhere (`files.remote.*`) shown as cards |
| Search | Messages and files with Slack's modifiers, FTS5 trigram (Korean, Japanese, Chinese included), optionally Meilisearch for relevance and typo tolerance, search tabs, AI answers when a model is connected |
| Canvases and lists | Real-time co-editing (Yjs), comments, versions, sharing; lists with twelve column types, table and board views, CSV export; templates; `canvases.*`, `slackLists.*` |
| Calls | Huddles with audio, video, screen sharing, reactions and live captions through LiveKit, with a transcript and AI notes in the thread afterwards; calls from other services (Zoom, Meet, …) as live cards through Slack's Calls API |
| AI (off until a model is connected) | Channel and thread summaries, daily recaps, search answers, translation, writing help, a built-in assistant in a direct message that remembers only what each person approves, an Agents view; Claude by default |
| Workflows | Builder with six triggers (shortcut, link, schedule, reaction, channel join, webhook), steps (message, form, add to channel, list item, webhook, branch, app-provided steps), run history, custom responses |
| Accounts | Email and password, mailed sign-in codes, password reset, Google and GitHub sign-in, OpenID Connect and SAML 2.0 single sign-on with accounts created on first use, two-factor (TOTP) that a workspace can require, guests (multi- and single-channel, expiry), user groups, invite requests, allowed email domains, profile fields |
| Administration | Members, roles, deactivation; workspace settings and permissions; custom emoji; apps; analytics; audit log (also at `/audit/v1/logs`); message reports and hiding a person; retention; legal hold and eDiscovery export; sensitive-information rules; information barriers; IP allowlist; sign-in length and session management; export of the whole workspace; SCIM 2.0 users and groups; Slack's `admin.*` API |
| Slack-compatible app platform | 177 of the 297 Web API methods in `@slack/web-api` (`docs/COMPATIBILITY.md` is generated). Events API over HTTP and Socket Mode, RTM, interactivity, modals, App Home, shortcuts, slash commands, unfurls, streaming, assistant threads, incoming webhooks, OAuth v2 installs, token rotation, app manifests (`apps.manifest.*`), "Sign in with this workspace" (OpenID Connect, Slack's claim names) |
| MCP | `/mcp` endpoint on the official SDK v2 (protocol 2026-07-28 and 2025 clients), tools that respect each token's permissions |
| Import | Slack export (zip or folder), Mattermost bulk export, Discord (DiscordChatExporter JSON). Re-runnable |
| Clients | Web client in English and Korean (light and dark, sidebar themes, 12/24-hour clock, phone layout, installable PWA), public read-only channel pages, desktop app (Electron: badge, several servers, deep links, automatic updates; installers built for macOS, Windows and Linux in CI) |
| Operations | One process with built-in SQLite; `/metrics` (Prometheus) and JSON logs; backup and restore test script; Docker image, Helm chart, Render and Fly files; docs site (VitePress) |

### How it was verified

Run these to reproduce.

| Check | Command | Result on 2026-11-17 |
|---|---|---|
| Types, brand rule | `pnpm typecheck`, `pnpm check:brand` | clean |
| Unit and integration tests | `pnpm test` | server 356, compat 64, shared 22, web 25, all passing |
| Official SDKs unmodified | `pnpm --filter ./compat test` | Bolt for JavaScript (Socket Mode, HTTP, OAuth installs with token rotation refreshed by Bolt's own installer, `app.function`), Bolt for Python, `@slack/web-api` for manifests, canvases, lists, remote files and the smaller methods (reactions.list, stars, team preferences, event authorizations, apps.uninstall), `@slack/rtm-api`, and `openid-client` (a certified OpenID Connect client) for sign-in |
| Browser tests | `pnpm --filter @app/web e2e` | sixteen files in system Chrome: smoke, the composer (formatting as you type, shortcuts, chips, paste, links, editing, drafts, the markup preference, phone width), files and people, platform (with manifests, OpenID Connect sign-in and call cards), attention, huddles (real LiveKit, with captions), AI (with the assistant), workflows, canvases, clips (fake camera and microphone), documents (remote files, Office previews), accounts, administration, Korean, accessibility (axe on 108 screens, keyboard-only paths, screen-reader names, reduced motion, forced colours), agent round trip. Several also run in Playwright's WebKit and Firefox |
| Desktop | `pnpm --filter @app/desktop e2e`; the Desktop workflow in CI | the real Electron app against a server; installers built on macOS, Windows and Linux runners |
| Upload scanning | real `clamd` (`clamav/clamav-debian` container) | clean file accepted, EICAR refused, 3 MB file scanned |
| Search inside PDFs | a PDF printed by Chrome in English and Korean | text extracted on one line per baseline, ligatures folded |
| SAML single sign-on | SimpleSAMLphp (`kristophjunge/test-saml-idp`) as the identity provider, real Chrome | button → identity provider's login → signed answer → signed in with the account created |
| Meilisearch | Meilisearch 1.56 binary (`MEILISEARCH_TEST_URL=… node --test test/meilisearch.test.ts`) | a typo the built-in index misses is found; private messages stay private; edits and deletions arrive |
| Installed package | the Install smoke test workflow | packed, installed into an empty folder and run with `npx` on Windows, macOS and Linux with Node 22 and 24: starts, serves the client, sets up a workspace, finds a Korean message |

### Not verified

- A real Slack export, Mattermost export or Discord export (formats followed from their sources; hand-made fixtures).
- Real Google, GitHub or third-party OpenID Connect sign-in (a fake identity provider in tests); real SMTP delivery (a fake mail server); browser push delivery.
- SCIM against a real Okta or Entra ID tenant (their request shapes are reproduced in tests).
- The Helm chart on a real cluster; Render and Fly deployments; the release workflow (needs `NPM_TOKEN`).
- Inbound email through a real provider; Calls from a real Zoom or Meet app.
- Real phones and Safari as an app (Playwright's WebKit only).
- Load beyond one machine: the server is one process by design (`TODO.html` t030 covers sharing it).

## Decisions taken while building

- **SQLite instead of PostgreSQL.** A required database server would break the one-command install. Data access stays inside the server's modules.
- **Migrations are positional.** Branches built in parallel each appended one; merging puts them in a fixed order (10 workflows … 17 accounts, then 18 email digests, 19 calls, 20 sessions, 21 channel email, 22 legal hold, 23 barriers, 24 assistant memory, 25 huddle captions, 26 clip transcripts, 27 remote files, 28 search queue and settings). A migration's SQL never depends on its number.
- **The audit log wraps API methods** rather than every module calling it: `installAudit` must stay the last install in `app.ts`, and new admin methods named `client.admin.*` (or `client.account.*`, `client.security.*`) are covered without further work.
- **Slack's names where Slack has them**, `client.*` for the rest. Claim names in ID tokens, the audit log shape and the manifest schema follow Slack's so tools written for Slack work.
- **Where the platform differs from Slack on purpose:** a bot hears mentions in public channels it has not joined; Socket Mode is the default for a new app; a manifest's request URL is used only once it passes the verification handshake; scopes this server does not grant are refused in manifests rather than ignored. `docs/COMPATIBILITY.md` has the full list.
- **No new runtime dependency without a reason in the commit:** the server added `yjs`/`y-protocols`/`lib0` (co-editing), `nodemailer` (SMTP) and `@node-saml/node-saml` (SAML: XML signature checking is too easy to get wrong by hand); scanning, PDF/Office text, SCIM, OIDC signing and the manifest validator use Node built-ins only.

## Traps found

- A test that computes "N days ago" from `Date.now()` in two places fails when a second ticks over between them; take the time once per file.
- Chrome has both `SpeechRecognition` and `webkitSpeechRecognition`; a stand-in for tests must replace both.
- The Anthropic SDK retries a 429 by itself: a test that wants a model failure must use a status it does not retry (401).
- Hook lists in core (`messageGuards`, `contentChecks`, `beforeMessageChange`, `keepFileBytes`, `uploadChecks`) are shared by every server in the process. A hook must use the context it is called with, never one captured at install time: a restarted test server once ran a hook against the closed database of the first.
- A repository pre-commit hook refuses files containing private-key headers; tests build such strings from pieces.

- A WebSocket upgrade with `Origin: null` crashed the process. Keep `isSameOrigin()` as the only place that parses `Origin`.
- `git add -A` in the repository root once staged agent worktrees under `.claude/`. `.claude/` is ignored.
- Never extract files into a project directory to inspect them: pulling `package.json` out of the packaged desktop app overwrote the real one, and it was deleted in a commit (restored in e5ed825).
- VitePress reads `{{…}}` in inline code as a Vue expression; inline code is rendered `v-pre` in `docs/.vitepress/config.mts`.
- Playwright's WebKit has no push service: `pushManager.getSubscription()` throws `IndexSizeError` and freezes the page. Only ask for a subscription once notification permission is granted.
- A browser test whose page froze never exited (`browser.close()` hung). `e2e/lib.mjs` now bounds the failure screenshot and the close.
- pnpm lockfile conflicts on every branch merge: take either side and run `pnpm install`.
- The timestamp clock once went backwards; `Clock.now()` is the only source and strictly increases.
- Driving every screen in a real browser keeps finding bugs that API tests miss. Treat a path no test drives as broken.
- TipTap's `autofocus` focuses on a timer after mount, and the browser runs queued keys first: a fast burst of typing then select-all had its selection collapsed by that timer. The composer focuses in a layout effect instead. ProseMirror learns of a selection made outside it from `selectionchange`, which can arrive after the next key (Playwright's `fill('')` selects through the DOM, then presses Delete); `RichInput` reads the browser's selection before handling a key. ProseMirror also swallows Escape (its default is prevented), so a thread panel would not close from the composer; `RichInput` lets Escape through unless it closes the suggestions or an edit.

## Next

In order. Details and owners are in `TODO.html`.

1. Owner decisions: public demo server, when to make the repository public, npm publishing (needs `NPM_TOKEN`), signing certificates for the desktop app.
2. Run against real exports and real identity providers; try real third-party agents and document only what works.
3. A real screen reader pass (VoiceOver, NVDA); more interface languages; server-side speech recognition for browsers without it.
4. Then the larger items: several processes sharing one database, shared channels between servers, native mobile apps.
