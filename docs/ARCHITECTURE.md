# Architecture

How the code is organised and the contracts between its parts. `PRD.md` says what the product is; this file says how it is built.

## Layout

```
packages/shared   Types and text helpers used by server, client and tests. Holds the brand module.
apps/server       The server: HTTP API, realtime gateway, app platform, importer. Node, no build step.
apps/web          The web client: React single-page app built with Vite.
compat            Compatibility harness: official Slack SDKs run against a local server.
docs              This file and guides.
```

One process serves everything: the API under `/api/*`, the client WebSocket at `/ws`, uploads and downloads, and the built web client. State is one SQLite file plus a directory of uploaded files, both under `DATA_DIR`.

## Rules

1. **One API.** The web client calls the same `/api/<method>` endpoints as bots. A feature is not done until it is reachable through the API.
2. **Slack's public shapes are the native shapes.** Method names, arguments, response fields, event types, error strings, identifier prefixes and the `ts` format follow Slack's published API. Where Slack has no public method, add one under `client.*`.
3. **The product name lives in `packages/shared/src/brand.ts` only.** Outside the compatibility surface (method names, `xox*-` token prefixes, `X-Slack-*` headers), no identifier, table, environment variable or package name contains the product name or "slack".
4. **Nothing leaves the server unless an admin turned it on.** No telemetry, no third-party fetches by default.
5. **Not visible means not found.** A private conversation or file the caller may not see is reported as `channel_not_found` / `file_not_found`, never as forbidden.

## Server

TypeScript run directly by Node (type stripping), so: no `enum`, no parameter properties, no namespaces; imports carry the `.ts` extension. Storage is the built-in `node:sqlite`.

| Directory | Contents |
|---|---|
| `src/db` | `Db` wrapper and migrations (`PRAGMA user_version`; append, never edit) |
| `src/core` | Domain logic with no HTTP in it: users, auth, conversations, messages, files, search, the event bus, the timestamp clock |
| `src/api` | HTTP server, method registry, and one file per method family under `methods/` |
| `src/realtime` | The client WebSocket gateway and presence |
| `src/platform` | Apps, bot tokens, Events API delivery, Socket Mode, webhooks, interactivity, slash commands, streaming |
| `src/importer` | Slack export import |
| `src/ai` | AI features (summaries, recaps, search answers, translation, writing help, Agents view); off until an admin connects a model |
| `src/mcp` | Model Context Protocol endpoint (`/mcp`) built on the official SDK |
| `src/demo` | Sample workspace used for demos and screenshots (`SEED_DEMO=1`) |

`createApp(config)` in `src/app.ts` wires these together and returns a `Kernel` (`ctx`, `registry`, `router`, `upgrades`, `onClose`) that extension modules plug into: `registry.add()` for API methods, `router.add()` for plain HTTP routes, `upgrades.push()` for WebSocket endpoints, `ctx.bus.subscribe()` for events.

### Data model

- A **message** is identified by `(conversation, ts)`. `Clock.next()` issues `ts` values that are unique and strictly increasing per conversation.
- A message stores `text` (Slack `mrkdwn`), optional `blocks`, `attachments`, file ids, and `plain` (searchable text of all of them).
- A thread parent has `thread_ts = ts` once it has replies; replies carry the parent's `ts`. Replies are excluded from channel history unless broadcast.
- **Read state** is `members.last_read`. Unread and mention counts are computed from it.
- **Search** is an FTS5 table with the trigram tokenizer over `plain`; terms shorter than three characters fall back to a substring scan.

### Events

Every write emits one `BusEvent` on `ctx.bus`: an event body in Slack's vocabulary plus an audience (`conversation`, `users` or `all`). The gateway delivers it to connected clients; the platform delivers it to apps. Events flagged `clientOnly` are never sent to apps.

Events clients receive: `message` (and subtypes `message_changed`, `message_deleted`, `message_replied`, `file_share`, `thread_broadcast`, `channel_join`, …), `reaction_added`, `reaction_removed`, `pin_added`, `pin_removed`, `channel_created`, `channel_rename`, `channel_archive`, `channel_unarchive`, `member_joined_channel`, `member_left_channel`, `team_join`, `user_change`, `emoji_changed`, `file_deleted`, and the client-only `hello`, `channel_joined` (full conversation object: add to sidebar), `channel_left`, `channel_updated`, `channel_marked`, `channel_prefs_changed`, `presence_change`, `user_typing`, `pref_change`, `assistant_thread_status`.

### API conventions

- `GET` or `POST /api/<method>`; arguments from the query string, a form-encoded body or a JSON body. Structured arguments (`blocks`) may be JSON text.
- Credentials: `Authorization: Bearer <token>`, a `token` argument, or the browser session cookie. Cookie-authenticated calls must be same-origin `POST`s.
- Responses are always `{ "ok": true, … }` or `{ "ok": false, "error": "<code>", … }` with HTTP 200, except 429 (`ratelimited`, with `Retry-After`).
- Lists paginate with `limit`, `cursor` and `response_metadata.next_cursor`.
- Token scopes are enforced per method; browser sessions are unrestricted.

Implemented method families: `api.test`, `auth.test`, `team.info`, `bots.info`, `users.*`, `conversations.*`, `chat.*`, `reactions.*`, `pins.*`, `files.*`, `emoji.list`, `search.messages`, plus first-party `client.*` and `admin.emoji.*`.

URLs in API objects are absolute, built from `PUBLIC_URL`. The web client must load them same-origin by keeping only the path and query.

## App platform contract

Server side lives in `src/platform`; the web client builds its screens on these methods.

| Method | Purpose |
|---|---|
| `client.apps.list` | `{ apps: AppInfo[] }`. Open to every member; carries no secrets |
| `client.apps.info { app }` | Admin only: `{ app, signing_secret, subscribable_events }` |
| `client.apps.create { name, description?, socket_mode? }` | Admin only. Creates the app and its bot user. Returns `{ app, bot_token, app_token, signing_secret }`; tokens are shown once |
| `client.apps.update { app, name?, description?, socket_mode?, events_url?, interactivity_url?, bot_events?, shortcuts?, unfurl_domains? }` | `{ app }`. `shortcuts`: `[{ type: "global" \| "message", name, callback_id, description? }]` (up to 10); `unfurl_domains`: up to five host names |
| `client.apps.delete { app }` | Removes the app, deactivates its bot user |
| `client.apps.rotateToken { app, kind: "bot" \| "app" }` | `{ token }` |
| `client.apps.webhooks.create { app, channel }` / `.list` / `.delete` | Incoming webhook URLs |
| `client.apps.commands.set { app, command, description?, usage_hint?, url? }` / `.delete` | Slash commands |
| `client.commands.list` | `{ commands: [{ command, description, usage_hint, app_id, app_name }] }` for composer autocomplete |
| `client.commands.run { channel, command, text, thread_ts? }` | Dispatches a slash command to its app; resolves once the app acknowledged |
| `client.apps.unknownMethods` | Admin only: API methods apps called that this server does not implement, with counts |
| `client.interactions.blockAction { channel, message_ts, action, state? }` | Dispatches a `block_actions` payload to the app that posted the message; resolves once the app acknowledged (at most 3 seconds). `state.values` is rebuilt from the message's elements |
| `client.interactions.suggest { channel, message_ts, action_id, block_id?, value }` | `block_suggestion` for an `external_select` on a message; returns `{ options }` or `{ option_groups }` |
| `client.shortcuts.list` | `{ shortcuts: [{ type, name, callback_id, description, app_id, app_name }] }` |
| `client.shortcuts.run { app, callback_id, channel?, message_ts? }` | A `shortcut` payload, or a `message_action` (with `channel` and `message_ts`) |
| `client.views.stack` | `{ stack: View[] }`: the caller's open modal, bottom view first |
| `client.views.submit { view_id, state }` | `view_submission` for the top view; returns `{ stack, errors? }` after applying the app's `response_action` |
| `client.views.close { view_id, clear? }` | Cancel (back one view) or, with `clear`, the ×; sends `view_closed` when the view asked for it. Returns `{ stack }` |
| `client.views.blockAction { view_id, action, state? }` | `block_actions` from a modal or Home tab (`container: { type: "view" }`) |
| `client.views.suggest { view_id, action_id, block_id?, value }` | `block_suggestion` for an `external_select` in a view |
| `client.apps.home { app }` / `client.apps.homeOpened { app, tab }` | The caller's published Home view; opening sends `app_home_opened` and returns `{ channel, view }` |
| `client.apps.limits` / `client.apps.setRateLimit { per_minute }` | The per-token API limit (workspace setting `api_rate_limit_per_minute`); `0` restores the default |

`AppInfo`: `{ id, name, description, bot_user_id, bot_id, socket_mode, events_url, interactivity_url, bot_events, created, created_by, connected, token_hints: { bot, app }, shortcuts, unfurl_domains }`.

Views (`src/platform/views.ts`, table `app_views`): `views.open` and `views.push` exchange a `trigger_id` (single use, issued per app, valid `TRIGGER_TTL_MS`, 3 s by default); a person has one modal, a stack of at most three views; Home views are one per app and person. Client-only events: `view_stack { stack }` (the caller's modal changed; an empty stack closes it) and `app_home { app_id, view }`. Views sent to the browser omit `private_metadata`.

Slack-compatible surface the platform adds: `apps.connections.open` and the Socket Mode WebSocket (served under `/link/`); Events API delivery with `X-Slack-Signature` signing and retries; incoming webhooks at `/services/<team>/<bot>/<secret>`; `response_url` endpoints; `chat.startStream` / `chat.appendStream` / `chat.stopStream` (a message with `streaming: true` that is updated in place); `assistant.threads.setStatus`, `setTitle` and `setSuggestedPrompts` (client-only events `assistant_thread_status`, `assistant_thread_title`, `assistant_thread_prompts`); `link_shared` and `chat.unfurl` for the domains an app registered (the preview is stored as an attachment with `app_unfurl_url` and `is_app_unfurl`); `search.files` and `search.all`. Generic link previews (`attention/previews.ts`) leave links under an app's registered domains to that app. `app_connection_changed` tells clients when an app's Socket Mode connection comes or goes.

Apps are reached at private or loopback addresses only when this server itself runs on localhost, or when `ALLOW_PRIVATE_APP_URLS=1` is set.

An MCP endpoint at `/mcp` (`src/mcp`) exposes search, read and post tools; each tool calls the API method of the same purpose as the token's owner. It runs on the official SDK v2 and serves both the 2026-07-28 revision and 2025-era clients (statelessly).

## Web client contract

- Boot with `client.status` → (`client.setup` | `client.signin` | `client.signup`) → `client.boot`, then open `ws_url`. After a dropped connection, call `client.boot` again and refetch the open conversation.
- Routes: `/` (the app), `/setup`, `/signin`, `/join/<code>` (invite), `/archives/<conversation>/p<ts without dot>` (message permalink).
- Render a message from `blocks` when present, otherwise from `text` (mrkdwn). `markdown` blocks hold standard Markdown. Treat subtypes `file_share`, `thread_broadcast`, `bot_message` and `me_message` as ordinary visible messages; `channel_join` and similar are system lines; `tombstone` is a deleted-parent placeholder.
- A message with `streaming: true` is still being written; `is_ephemeral: true` messages are shown to this viewer only and are never in history.
- Uploads: `files.getUploadURLExternal` → `POST` the bytes to `upload_url` → `files.completeUploadExternal` with `channel_id` and `initial_comment`.
- Mentions are sent as `<@U…>`, channel links as `<#C…>`, broadcasts as `<!channel>` / `<!here>`.
- Block Kit is drawn on a surface (`lib/surface.ts`): a message, a modal or a Home tab. Elements record what the person entered in the surface's state bag (sent as `state.values`) and ask the surface to deliver actions and load external options. Elements outside `input` blocks act at once; inside one they only collect, unless the block has `dispatch_action`. App modals, Home tabs and shortcut menus live in `components/AppViews.tsx`, their state in `lib/platform.ts`.

## Running

```
pnpm install
pnpm dev                 # server on :3000 (watch) + web dev server on :5173
pnpm test                # all packages, including the Bolt compatibility harness
pnpm typecheck
pnpm --filter @app/web e2e         # browser tests (system Chrome): smoke, files/people/apps, app surfaces with a Bolt app over HTTP
pnpm --filter @app/web e2e:agent   # a real Bolt agent driven from the browser
pnpm release             # bundle the server and the client into packages/cli/dist
SEED_DEMO=1 pnpm start   # sample workspace: maya@example.com / demo-password
```

Environment: `PORT`, `HOST`, `DATA_DIR`, `PUBLIC_URL`, `WEB_DIR`, `MAX_UPLOAD_MB`.
