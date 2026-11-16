# Progress

Read this first. It says what exists, how it was verified, and what is next. The task board is `TODO.html`; scope and phases are in `PRD.md`.

## State on 2026-11-16

0.1 is feature-complete for the launch demo and runs end to end on one machine (macOS, Node 24). It is not published anywhere: the repository is private, nothing is on npm or a container registry.

Everything below was built on 2026-11-16.

### What exists

| Area | What works |
|---|---|
| Server (`apps/server`) | One Node process, built-in SQLite. Workspaces, sessions, invites, roles; channels, private channels, DMs, group DMs; messages, threads, reactions, pins, files; read state and mention counts; search (FTS5 trigram, Korean/Japanese/Chinese included); client WebSocket with presence and typing |
| Slack-compatible API | 61 of the 297 Web API methods in `@slack/web-api` (`docs/COMPATIBILITY.md` is generated). Same endpoints serve the web client and bots |
| App platform (`src/platform`) | Apps and tokens, Events API over HTTP (signing, retries), Socket Mode, `block_actions`, `response_url`, slash commands, incoming webhooks, streamed messages (`chat.startStream` family), assistant thread status |
| Web client (`apps/web`) | Setup, sign-in, invite sign-up; sidebar, conversation, thread and profile panels; composer with formatting, autocomplete and uploads; Block Kit and Markdown rendering; reactions, pins, permalinks; search and quick switcher; admin screens for members, emoji and apps; light and dark themes; phone layout |
| Import (`src/importer`) | Slack export zip or folder: users, channels, DMs, messages, threads, reactions, pins, optional file download. Keeps original ids. Re-runnable |
| MCP (`src/mcp`) | `/mcp` endpoint with seven tools, authorised by API tokens |
| Packaging | `pnpm release` bundles the server into one file plus the web client (`packages/cli`, 3 MB). `Dockerfile`, `compose.yaml` |
| Example | `examples/hello-agent`: a Bolt agent that streams a reply and handles a button |

### How it was verified

Run these to reproduce.

| Check | Command | Result |
|---|---|---|
| Types | `pnpm typecheck` | clean in all packages |
| Unit and integration tests | `pnpm test` | 109 pass: shared 12, web 9, server 62, compatibility harness 26 |
| Official SDKs unmodified | `pnpm --filter ./compat test` | Bolt for JavaScript over Socket Mode and over HTTP, Bolt for Python over Socket Mode |
| Browser smoke test | `pnpm --filter @app/web e2e` | 23 steps, two browsers, system Chrome |
| Agent round trip in the UI | `pnpm --filter @app/web e2e:agent` | A real Bolt agent: mention in the browser → streamed reply → button click answered |
| Published package | `npm pack` in `packages/cli`, install the tarball in an empty folder, `npx openslack` | Starts, serves the client, no dependencies installed. Also run in a `node:24-slim` container (Linux arm64): setup, a message, a Korean search |
| Docker image | `docker build .`, then `docker run -p 3000:3000 -e SEED_DEMO=1 …` | 170 MB image, runs as a non-root user, serves the client and the API |
| Brand rule | `pnpm check:brand` | The product name appears only in `packages/shared/src/brand.ts` |

Measured on an Apple-silicon laptop: about 140 MB of memory at rest, about 750 bytes of database per message including the search index, about 6,000 messages written per second.

### Not verified

- Windows and x64 Linux. Everything ran on macOS and in Linux arm64 containers on the same machine.
- The release workflow (`.github/workflows/release.yml`) has never run.
- Bolt for Python over HTTP.
- A real Slack export. The importer is tested against a hand-written export that follows the documented format, including a zip made with the system `zip`.
- Which third-party agents (OpenClaw, Codex, Claude Code's Slack integration) can be repointed. Only apps we wrote with Bolt have been run.
- In the web client: video, audio and PDF previews, paste upload, profile photo upload, role change and deactivation screens, webhook and token-rotation screens. They are implemented; no test drives them.
- Load: nothing has been run with many concurrent connections.

## Decisions taken while building

- **SQLite instead of PostgreSQL.** A required database server would break the one-command install. Data access stays inside `src/core`.
- **Text area composer** that writes Slack `mrkdwn`, not a WYSIWYG editor.
- **MCP through the official SDK** (`@modelcontextprotocol/sdk` 1.x, protocol versions up to 2025-11-25). The 2026-07-28 revision of the protocol is not handled yet.
- **Where the platform differs from Slack on purpose:** a bot is told about a mention in a public channel even when it has not joined; an app with no event subscriptions receives every event type; Socket Mode is the default for a new app; a new bot token gets a broad fixed scope set. `docs/COMPATIBILITY.md` and the platform fork's notes in the merge commit have the full list.

## Traps found

- A WebSocket upgrade with `Origin: null` crashed the process (URL parsing threw inside the upgrade handler). Fixed and tested; keep `isSameOrigin()` as the only place that parses `Origin`.
- `git add -A` in the repository root once staged agent worktrees under `.claude/`. `.claude/` is now ignored.
- Node prints an "experimental" warning for `node:sqlite`. The published command filters it; from source it is visible and harmless.
- pnpm lockfile conflicts on every branch merge: take either side and run `pnpm install`.
- Channel mention badges include mentions made inside threads, whose timestamps are later than the channel's newest message. `conversations.mark` clears them when the reader is caught up.

## Next

In order. Details and owners are in `TODO.html`.

1. Owner decisions: public demo server, when to make the repository public, npm publishing.
2. Verify on a clean Linux machine: `npx`, `docker run`, a real Slack export.
3. Try real third-party agents against it and document only what works.
4. Record the 30-second demo.
5. Then the 0.2 list: modals, link previews, Activity and Threads views, mail, Korean strings, public web-readable channels.
