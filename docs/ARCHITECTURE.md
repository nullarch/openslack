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
| `src/ai` | AI features (summaries, recaps, search answers, translation, writing help, the assistant with memory, Agents view); off until an admin connects a model |
| `src/workflows` | Workflow Builder (triggers, steps, runs) and custom responses |
| `src/mcp` | Model Context Protocol endpoint (`/mcp`) built on the official SDK |
| `src/accounts` | Sign-in (password, mailed code, reset, identity providers, two-factor), invitations and invite requests, workspace settings and permissions, profile fields, user groups, guest rules |
| `src/export` | Slack-format export archive and the zip writer |
| `src/public` | Server-rendered public channel pages, sitemap, robots.txt |
| `src/push` | Web Push (VAPID, aes128gcm) and the web app manifest |
| `src/ops` | `/metrics`, JSON logs, online backup |
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

Implemented method families: `api.test`, `auth.test`, `team.info`, `bots.info`, `users.*`, `conversations.*`, `chat.*`, `reactions.*`, `pins.*`, `files.*`, `emoji.list`, `search.messages`, `canvases.*`, `slackLists.*`, plus first-party `client.*` and `admin.emoji.*`.

URLs in API objects are absolute, built from `PUBLIC_URL`. The web client must load them same-origin by keeping only the path and query.

## App platform contract

Server side lives in `src/platform`; the web client builds its screens on these methods.

| Method | Purpose |
|---|---|
| `client.apps.list` | `{ apps: AppInfo[] }`. Open to every member; carries no secrets |
| `client.apps.info { app }` | Admin only: `{ app, signing_secret, subscribable_events }` |
| `client.apps.create { name, description?, socket_mode? }` | Admin only. Creates the app and its bot user. Returns `{ app, bot_token, app_token, signing_secret }`; tokens are shown once |
| `client.apps.update { app, name?, description?, socket_mode?, events_url?, interactivity_url?, bot_events?, shortcuts?, unfurl_domains?, functions? }` | `{ app }`. `shortcuts`: `[{ type: "global" \| "message", name, callback_id, description? }]` (up to 10); `unfurl_domains`: up to five host names; `functions`: workflow steps the app implements, in Slack's function-definition shape (`callback_id`, `title`, `input_parameters`, `output_parameters`; types `string`, `user_id`, `channel_id`, `number`, `boolean`, with or without `slack#/types/`) |
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
| `client.shortcuts.run { app, callback_id, channel?, message_ts?, context_channel? }` | A `shortcut` payload, or a `message_action` (with `channel` and `message_ts`). `context_channel` is the conversation a global shortcut was started from; only built-in apps (workflows) read it |
| `client.views.stack` | `{ stack: View[] }`: the caller's open modal, bottom view first |
| `client.views.submit { view_id, state }` | `view_submission` for the top view; returns `{ stack, errors? }` after applying the app's `response_action` |
| `client.views.close { view_id, clear? }` | Cancel (back one view) or, with `clear`, the ×; sends `view_closed` when the view asked for it. Returns `{ stack }` |
| `client.views.blockAction { view_id, action, state? }` | `block_actions` from a modal or Home tab (`container: { type: "view" }`) |
| `client.views.suggest { view_id, action_id, block_id?, value }` | `block_suggestion` for an `external_select` in a view |
| `client.apps.home { app }` / `client.apps.homeOpened { app, tab }` | The caller's published Home view; opening sends `app_home_opened` and returns `{ channel, view }` |
| `client.apps.limits` / `client.apps.setRateLimit { per_minute }` | The per-token API limit (workspace setting `api_rate_limit_per_minute`); `0` restores the default |

`AppInfo`: `{ id, name, description, bot_user_id, bot_id, socket_mode, events_url, interactivity_url, bot_events, created, created_by, connected, token_hints: { bot, app }, shortcuts, unfurl_domains, functions }`.

Built-in apps (`src/platform/local-apps.ts`) are apps whose `config.builtin` is set: they answer shortcuts, view submissions and view closes in-process instead of over HTTP or Socket Mode, and are left out of `client.apps.list`. Workflows is the one built-in app; it is created the first time someone saves a workflow.

Views (`src/platform/views.ts`, table `app_views`): `views.open` and `views.push` exchange a `trigger_id` (single use, issued per app, valid `TRIGGER_TTL_MS`, 3 s by default); a person has one modal, a stack of at most three views; Home views are one per app and person. Client-only events: `view_stack { stack }` (the caller's modal changed; an empty stack closes it) and `app_home { app_id, view }`. Views sent to the browser omit `private_metadata`.

Slack-compatible surface the platform adds: `apps.connections.open` and the Socket Mode WebSocket (served under `/link/`); Events API delivery with `X-Slack-Signature` signing and retries; incoming webhooks at `/services/<team>/<bot>/<secret>`; `response_url` endpoints; `chat.startStream` / `chat.appendStream` / `chat.stopStream` (a message with `streaming: true` that is updated in place); `assistant.threads.setStatus`, `setTitle` and `setSuggestedPrompts` (client-only events `assistant_thread_status`, `assistant_thread_title`, `assistant_thread_prompts`); `link_shared` and `chat.unfurl` for the domains an app registered (the preview is stored as an attachment with `app_unfurl_url` and `is_app_unfurl`); `search.files` and `search.all`. Generic link previews (`attention/previews.ts`) leave links under an app's registered domains to that app. `app_connection_changed` tells clients when an app's Socket Mode connection comes or goes.

Apps are reached at private or loopback addresses only when this server itself runs on localhost, or when `ALLOW_PRIVATE_APP_URLS=1` is set.

An MCP endpoint at `/mcp` (`src/mcp`) exposes search, read and post tools; each tool calls the API method of the same purpose as the token's owner. It runs on the official SDK v2 and serves both the 2026-07-28 revision and 2025-era clients (statelessly).

## Workflows

Server side lives in `src/workflows` (tables `workflows`, `workflow_runs`, `custom_responses`). A workflow is one trigger and an ordered list of steps; a person builds it, publishes it, and every run is stored with its variables and a step log.

- **Triggers**: `shortcut` (listed with app shortcuts, so it is in the composer's ⚡ menu), `link` (`/workflow/<code>` opens a start page), `schedule` (`once`, `daily`, `weekly`, `monthly`, wall-clock time in an IANA zone; `next_run` is stored, claimed with a compare-and-set before the run starts, so a restart neither loses nor repeats a due run), `reaction` (one emoji in one channel), `member_joined` (one channel), `webhook` (`POST /hooks/workflows/<id>/<secret>` with a JSON object; chosen keys become `{{webhook.<key>}}`).
- **Steps**: `message` (to a channel, the channel where it started, the reacted message's thread, or a person by DM), `form` (a modal through the built-in app; answers become `{{steps.<id>.<field>}}`, optionally posted), `add_to_channel`, `webhook` (JSON `POST`, same private-address guard as app URLs), `app` (a function an app declared), `list_item` (only when a lists module called `setListItemCreator`), and `branch` (if/else on one variable, one level deep).
- **Variables**: `{{trigger.user}}`, `{{trigger.channel}}`, `{{trigger.time}}`, `{{trigger.message_text}}`, `{{trigger.message_author}}`, `{{trigger.reaction}}`, `{{webhook.*}}`, `{{steps.<id>.*}}`. People and channels render as mentions in messages; text is escaped.
- **Execution**: steps compile to a flat program (branches become jumps), so a run waiting on a form or an app's step resumes at a plain index. Statuses: `running`, `waiting`, `completed`, `failed`, `cancelled` (form closed, workflow deleted).
- **App steps**: the run sends `function_executed` (Events API or Socket Mode) with `function_execution_id`, `inputs` and a `bot_access_token` that lives as long as the step, then waits for `functions.completeSuccess { function_execution_id, outputs }` or `functions.completeError { function_execution_id, error }` from the same app; after 15 minutes the run fails.

**Permissions.** A run acts with the creator's permissions intersected with those of the person who set it off (the *runner*; scheduled and webhook runs have none):

1. A message may go to a public channel; anywhere else both the creator and the runner (if any) must be members. Archived channels are refused.
2. `add_to_channel` only adds active people to public, unarchived channels.
3. Direct messages go only to active, non-bot people.
4. The channels a workflow names (trigger channel, message and form destinations) must be visible to its creator when it is saved and published; a trigger's channel is passed to the run only when the runner can see it.
5. Forms are allowed only with triggers that have a person behind them (`shortcut`, `link`, `reaction`, `member_joined`), and only that person can submit or close the form.
6. A deactivated creator stops every run of their workflows. Only the creator and admins can see, edit, publish or delete a workflow and its run history; turning it off stops its triggers.

| Method | Purpose |
|---|---|
| `client.workflows.list` | `{ workflows }`: the caller's own; admins see all |
| `client.workflows.get { workflow }` | `{ workflow }` with `steps`, `problems`, and `link_url` / `webhook_url` |
| `client.workflows.save { workflow?, name, description?, trigger, steps }` | Create (as a draft) or update. `invalid_workflow` carries `detail` |
| `client.workflows.publish { workflow, published? }` | Publish, or turn off with `published: false`. `cannot_publish` carries `problems` |
| `client.workflows.delete { workflow }` | Deletes it and its run history |
| `client.workflows.runs { workflow }` | The last 50 runs with their step logs |
| `client.workflows.stepTypes` | Steps apps offer, and whether lists exist |
| `client.workflows.linkInfo { link }` / `client.workflows.startByLink { link, channel? }` | The start page of a link trigger |
| `client.responses.list` / `.save { id?, match_type, pattern, reply, channels?, enabled? }` / `.delete { id }` | Admin only. Custom responses: `exact`, `contains` or `regex` (nested repeats, backreferences and lookbehind refused; matching runs under a 50 ms limit). No channels means every public channel; a bot named Responses answers, at most once per rule and channel every 5 seconds |

## Canvases and lists

Server side lives in `src/docs`. Canvases (collaborative documents) and lists (typed trackers) are both rows of `docs` (`kind` `canvas` or `list`), share one access model (`doc_access`) and one trigram index (`docs_fts`, contentless; terms under three characters fall back to a substring scan, as in message search).

- **Access** (`access.ts`): the owner can do everything, including sharing and deleting. Others get `read` or `write` directly, or through a conversation: its members get the granted level, and people who can see a public channel without being in it can read. A canvas created in a channel (`channel_id`) is a tab there and its members can edit. Anything a caller may not open is `canvas_not_found` / `list_not_found`; read-only callers get `access_denied` on edits; owner-only actions give `restricted_action`. The same check runs on every method, on the canvas socket (per message: updates from people who can only read are dropped), on CSV downloads, on link cards and in search.
- **Live canvases** (`hub.ts`): the document is Yjs. Browsers speak the y-websocket protocol at `GET /canvas/<id>` (session cookie, same origin; refused with 404 otherwise): sync step 1/2 and updates carry the document, awareness carries cursors (`user: { id, name, color }`). Each update is stored in `canvas_updates` as it arrives; after more than 200 they are merged into one. After a burst of edits (600 ms) the server refreshes the searchable text, tells newly mentioned people (Activity `canvas_mention`, once per person), records uploaded images the canvas shows (`doc_files`, so its readers can load them; only files every editor of that burst could already read), keeps a version at most every `CANVAS_VERSION_EVERY_S` (300) seconds of editing, and emits `doc_changed`. Sockets are closed with 4403 when access is removed and 4404 when the canvas is deleted; y-websocket does not retry 44xx closes.
- **Content model** (`markdown.ts`): a `Y.XmlFragment` named `default` in the shape TipTap's collaboration binding writes. Block nodes: `paragraph`, `heading` (`level` 1–3), `bulletList` / `orderedList` > `listItem`, `taskList` > `taskItem` (`checked`), `blockquote`, `codeBlock` (`language`), `horizontalRule`, `image` (`src`, `alt`), `table` > `tableRow` > `tableHeader` / `tableCell`. Text is `Y.XmlText` with marks as attributes (`bold`, `italic`, `strike`, `code`, `link { href }`); mentions are inline `mention` elements (`id`, `label`, `mentionSuggestionChar` `@` or `#`). The API speaks Markdown in Slack's canvas dialect (`![](@U…)`, `![](#C…)`); section ids (`temp:C:…`) are a hash of a top-level block's kind and text, so they stay stable while that block is unchanged.
- **Lists** (`lists.ts`): the schema (`extra.schema`) is an array of columns `{ id, key, name, type, is_primary_column, options }` with types `text`, `number`, `select` (`options.format: 'multi_select'` for several), `user`, `date` (`YYYY-MM-DD`), `checkbox`, `link`, `rating` (`options.max`), `email`, `phone`, `channel`. Items (`list_items`) keep values keyed by column id; the API returns Slack's field shape `{ column_id, key, <type key>: value }` (`rich_text`, `number`, `select`, `user`, …; text fields also carry plain `text`). Adding someone to a people column (unless `notify_users: false`) puts the item in their Activity (`list_assigned`); a due sweep every 30 minutes does the same for items due today that are not checked done (`list_due`, once per item and date).
- **Templates** (`templates.ts`): built in (`TPLmeeting` meeting notes, `TPLbrief` project brief, `TPLbugs` bug tracker, `TPLonboarding` onboarding checklist) plus `doc_templates` saved by anyone for the whole workspace.

**For other modules.** `createListItem(ctx, actor, listId, fields, { parentId? })` (exported from `src/docs/index.ts`) adds an item as `actor`, who must be able to edit the list, with the same validation and notifications as `slackLists.items.create`, and returns the item in API shape. `fields` is either Slack-shaped (`[{ column_id, select: ['done'] }]`) or a plain object keyed by column key, id or name (`{ title: 'Fix login', Status: 'In progress', owner: '<@U123>' }`); plain strings may hold several people or channels (`'U1, U2'`) and comma-separated options for multi-select columns. `installDocs` registers it with the workflow engine (`setListItemCreator`), which is how `list_item` workflow steps run. Activity rows of the doc kinds are resolved through `activityResolvers` in `attention/activity.ts` (`conversation_id` holds the document id, `ts` an item id), and canvas images through `fileAccessHooks` in `core/files.ts`.

| Method | Purpose |
|---|---|
| `canvases.create { title?, document_content?, channel_id? }` / `conversations.canvases.create { channel_id, document_content?, title? }` | Slack's shapes. `document_content` is `{ type: 'markdown', markdown }`. A channel gets one channel canvas (`channel_canvas_already_exists`) |
| `canvases.edit { canvas_id, changes }` | `insert_at_start`, `insert_at_end`, `insert_before` / `insert_after` / `delete` (`section_id`), `replace` (with or without `section_id`), `rename` (`title_content`). All changes are checked before any is applied (`canvas_editing_failed`) |
| `canvases.delete`, `canvases.access.set { access_level, channel_ids \| user_ids }`, `canvases.access.delete`, `canvases.sections.lookup { criteria: { section_types?, contains_text? } }` | Slack's shapes; `failed_to_update_channel_ids` / `failed_to_update_user_ids` for entries that could not be changed |
| `canvases.getContent { canvas_id, content_type? }` | `{ content }`: the canvas as Markdown (default) or HTML |
| `client.canvases.info` / `.rename` | `{ canvas: { id, title, owner, access_level, open_comments, access? } , viewers }` |
| `client.canvases.versions.list` / `.get { version_id }` / `.save { label? }` / `.restore { version_id }` | Versions; `get` returns Markdown and the Yjs `state` (base64). A restore first saves "Before restore" |
| `client.canvases.comments.list` / `.add { text, quote?, anchor?, root_id? }` / `.resolve { comment_id, resolved? }` / `.delete` | Comments on a selection. `anchor` is opaque to the server (the client stores Yjs relative positions). Readers can comment; the thread's author or editors resolve |
| `slackLists.create { name, schema?, todo_mode?, copy_from_list_id?, include_copied_list_records?, description_blocks?, channel_id? }`, `slackLists.update`, `slackLists.items.create { list_id, initial_fields?, parent_item_id?, duplicated_item_id? }`, `.items.update { list_id, cells: [{ row_id, column_id, <type key> }] }`, `.items.delete`, `.items.deleteMultiple`, `.items.info`, `.items.list { limit?, cursor?, archived? }`, `slackLists.access.set` / `.delete`, `slackLists.download.start` / `.get` | Slack's shapes. `download.get` returns a short-lived `download_url` for CSV |
| `client.lists.info { list_id }` | `{ list, items }` with `comment_count` per item |
| `client.lists.columns.set { list_id, schema }` / `.items.move { id, after_id? }` / `.items.archive { id, archived? }` / `.comments.list` / `.comments.add { item_id, text }` / `client.lists.delete` | Editing a list beyond Slack's methods |
| `GET /lists-export/<id>.csv` | CSV (UTF-8 with BOM) for a session that can open the list, or with a `key` from `download.get`; `?archived=1` includes archived items |
| `client.docs.list { kind?, channel? }` / `.create { kind, title?, template_id?, channel? }` / `.search { query, kind?, count? }` / `.card { id }` | Browsing, creating (blank or from a template), permission-bound search, what a link shows |
| `client.docs.templates.list { kind? }` / `.save { doc_id, title?, description?, include_items? }` / `.delete { template_id }` | Templates; saved ones are deleted by whoever saved them or an admin |

Events: `doc_changed { kind, id, conversation_id, change }` (`created`, `content`, `renamed`, `access`, `comments`, `items`, `schema`, `meta`, `deleted`) goes to everyone with access; clients refetch. Tables: `docs`, `docs_fts`, `doc_access`, `doc_files`, `canvas_updates`, `canvas_versions`, `canvas_comments`, `canvas_mentions`, `list_items`, `list_comments`, `list_due_sent`, `doc_templates`.

The web client keeps the always-loaded part small (`lib/docs.ts`, `components/docs/index.tsx`: conversation tabs, link cards, Activity rows, the search tab); the document page and list views (`DocPage`, `ListView`) and the editor (`CanvasEditor`: TipTap, ProseMirror, Yjs, y-websocket) are lazy chunks.

## Accounts contract

Registered by `installAccounts(kernel)`, last in `createApp`.

| Method or route | Purpose |
|---|---|
| `client.status` | Adds `mail_enabled`, `identity_providers: [{ id, label }]`, `two_factor_setup_required` |
| `client.boot` | Adds `permissions`, `usergroups`, `profile_fields`, `vapid_public_key`, `signup_domains`, `mail_enabled`, and `web_public` on channels open to the web. Guests receive only the people they can see |
| `client.signin`, `client.signin.withCode`, `client.account.resetPassword` | Answer `{ user_id }`, or `{ two_factor_required: true }` with an HttpOnly `tfa` cookie; then `client.signin.twoFactor { code }` |
| `client.signin.sendCode { email }`, `client.account.sendPasswordReset { email }` | Mail a code or link; the same answer whether or not the address exists |
| `client.security.twoFactor.status / begin / enable / disable / regenerateBackupCodes` | Authenticator setup and backup codes |
| `GET /auth/<provider>/start?invite=` → `/auth/<provider>/callback` | Sign in with `oidc`, `google` or `github`; redirects to `/` or `/signin?error=<code>` / `/signin?step=two-factor` |
| `client.invites.create { email?, guest?, channels?, guest_expires_in_days? }` | Answers `{ invite, email_sent }` |
| `client.inviteRequests.create`, `client.admin.inviteRequests.list / approve / deny` | Requests when only admins invite; admins hear `invite_requests_changed` |
| `client.admin.settings`, `client.admin.updateSettings` | `who_can_*` (`everyone` / `admins`), `signup_domains`, `default_channels`, `require_2fa`, `public_invite_code`, `public_file_links`; tabs hear `team_prefs_changed` and refetch `client.permissions` |
| `client.admin.setTeamIcon { file_id? }`, `client.admin.setProfileFields { fields }`, `client.admin.setAccountType { user, type }`, `client.admin.setChannelWeb { channel, web_public, web_files }`, `admin.conversations.convertToPrivate { channel_id }` | Administration |
| `team.profile.get`, `users.profile.set { profile: { fields } }`, `usergroups.*` | Slack's shapes |
| `client.push.status / subscribe / unsubscribe` | Web Push for this device |
| `GET /admin/export.zip` | Owners: everything as a Slack-format archive |
| `GET /public/<channel>/<name>`, `/public`, `/sitemap.xml`, `/robots.txt` | Public channel pages |
| `GET /metrics` | Prometheus text, with `METRICS_TOKEN` |

Policies the core enforces through hooks rather than per method: `registry.guards` (run on every authenticated call, MCP included: expired guests, pending two-factor setup, channel and emoji creation rights) and `contentChecks` in `core/messages.ts` (who may use @channel). Guest visibility lives in `core/guests.ts` and `canSee()`.

## Web client contract

- Boot with `client.status` → (`client.setup` | `client.signin` | `client.signup`) → `client.boot`, then open `ws_url`. After a dropped connection, call `client.boot` again and refetch the open conversation.
- Routes: `/` (the app), `/setup`, `/signin`, `/join/<code>` (invite), `/archives/<conversation>/p<ts without dot>` (message permalink), `/workflows`, `/workflows/<id>`, `/workflow/<code>` (start a link-triggered workflow), `/canvases`, `/lists`, `/docs/<team>/<id>` (a canvas), `/lists/<team>/<id>` (a list); the team part is optional.
- Render a message from `blocks` when present, otherwise from `text` (mrkdwn). `markdown` blocks hold standard Markdown. Treat subtypes `file_share`, `thread_broadcast`, `bot_message` and `me_message` as ordinary visible messages; `channel_join` and similar are system lines; `tombstone` is a deleted-parent placeholder.
- A message with `streaming: true` is still being written; `is_ephemeral: true` messages are shown to this viewer only and are never in history.
- Uploads: `files.getUploadURLExternal` → `POST` the bytes to `upload_url` → `files.completeUploadExternal` with `channel_id` and `initial_comment`.
- Mentions are sent as `<@U…>`, channel links as `<#C…>`, broadcasts as `<!channel>` / `<!here>`.
- Block Kit is drawn on a surface (`lib/surface.ts`): a message, a modal or a Home tab. Elements record what the person entered in the surface's state bag (sent as `state.values`) and ask the surface to deliver actions and load external options. Elements outside `input` blocks act at once; inside one they only collect, unless the block has `dispatch_action`. App modals, Home tabs and shortcut menus live in `components/AppViews.tsx`, their state in `lib/platform.ts`.
- Languages: every interface string is in `apps/web/src/strings.ts` (English, the source) and has a translation of exactly the same type (`Strings`) in `strings.ko.ts` (Korean, split across `src/i18n/ko-*.ts`); the canvas and list screens keep theirs in `components/docs/text.ts` the same way. A key added to English without a translation is a type error. `S` is chosen once per page load (`lib/locale.ts`: the `language` preference, else the browser's languages); dates, times and numbers go through `lib/time.ts` with that locale and the `time_format` preference (`auto`, `12h`, `24h`). Changing either reloads the page. System lines the server writes in English (`channel_join`, `channel_topic`, …) are reworded from their subtype (`systemText` in `components/Message.tsx`). `e2e/i18n.mjs` fails on English left in the main screens.
- Display preferences live in the person's `prefs` (`client.prefs.set`): `theme`, `language`, `time_format`, `sidebar_theme` (a preset or `custom`) with `sidebar_color`, `notify_level` (`all`, `mentions`, `nothing`; a conversation's own level wins), `notify_thread_replies`, `notify_preview`, `notify_sound`, `email_notifications`. Sidebar text colors are derived from the background to at least 4.5:1 (`lib/sidebar-colors.ts`).

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
