# OpenSlack — Product Requirements

Status: draft 1 · 2026-11-16 · nothing is built yet
Repository: `nullarch/openslack`, private until 0.1 runs

## 1. Summary

OpenSlack is an open-source, self-hosted team chat that a team already on Slack can move to in an afternoon.

It makes three promises:

1. **Familiar on day one.** Channels, threads, DMs, search and huddles work the way Slack users expect. Nobody needs retraining.
2. **Drop-in.** A Slack export imports with history intact, and existing Slack apps and bots run against OpenSlack by changing one base URL, because OpenSlack speaks the Slack Web API, Events API, Socket Mode and Block Kit.
3. **No gates.** Every feature lives in this repository under a permissive license: no user cap, no history limit, no paid edition holding back SSO or search.

A fourth property follows from the second: OpenSlack is **agent-native**. AI agents get the same API as people do, without throttling, plus a built-in MCP server.

This document does two jobs. [§7](#7-slack-system-inventory-and-openslack-scope) is an inventory of what Slack consists of today, system by system. The rest states which parts OpenSlack builds, in what order, and how.

## 2. Why now

### What Slack customers run into

- **History and seat pricing.** The Free plan keeps 90 days of messages, allows 10 integrations and limits huddles to two people. Paid plans are priced per active user per month (Pro lists at about $8.75 monthly).
- **Tighter API access.** Since 2025-05-29, commercially distributed apps that are not in the Slack Marketplace read `conversations.history` and `conversations.replies` at one request per minute, 15 messages per request. Internal custom apps keep the old limits, but any agent product a team buys rather than builds is affected.
- **Data location.** Messages live on Slack's servers. Teams with residency, air-gap or audit requirements pay for the Enterprise tier or cannot use Slack at all.

### What the open-source alternatives leave open

| Project | License | Gap OpenSlack targets |
|---|---|---|
| Mattermost | Open core (AGPL source, compiled Team Edition, paid Enterprise) | v11 lowered the compiled Team Edition cap from 1,000 to 250 users and removed GitLab SSO and Playbooks from it. Slack compatibility stops at incoming webhooks and slash commands. |
| Rocket.Chat | Open core (MIT Community edition, paid plans) | The free Starter plan stops at 50 users; the MIT Community edition has only basic capabilities. Runs on MongoDB. |
| Zulip | Apache-2.0, fully open | A different conversation model (every message belongs to a topic). Excellent, but not a drop-in for a team that thinks in Slack channels and threads. |
| Matrix / Element | AGPL (Synapse), Apache-2.0 (clients) | A federated messaging protocol first; operating it and matching Slack's workspace UX takes real effort. |

None of them lets a team keep its existing Slack bots. That is the opening: **full Slack API compatibility plus a faithful import**, under a license with nothing held back.

## 3. Goals, non-goals, measures

### Goals

- A team of 5–500 can self-host OpenSlack and use it as its only chat tool.
- Migration from Slack is a documented, repeatable procedure: export, import, repoint the bots.
- The first-party client uses the same public API that bots use, so API compatibility is a property of the design rather than a translation layer.
- One `docker compose up` produces a working workspace. PostgreSQL is the only required dependency.

### Non-goals

- **Salesforce features**: Salesforce channels, CRM record previews, Agentforce, Sales Elevate.
- **A marketplace business**: app review, listings, billing.
- **Compliance certifications** (FedRAMP, HIPAA attestation, GovSlack equivalents). Self-hosters own their compliance; OpenSlack supplies the controls (audit log, retention, export).
- **Slack's hosted function runtime** (the Deno "run on Slack" platform and its datastores). Apps run on the app author's own infrastructure.
- **Pixel-identical cloning.** The layout is familiar; the visual identity, icons, sounds and copy are OpenSlack's own.
- **Billing** of any kind in the 0.x line.

### Measures

| Measure | Target for 0.1 |
|---|---|
| Time from `docker compose up` to first message sent | Under 5 minutes on a fresh machine |
| Official Bolt sample apps (JS and Python) passing unmodified except the base URL | All apps that use only Tier A methods ([§8](#8-slack-compatibility)) |
| Slack export import fidelity | 100% of users, channels, messages, threads and reactions from a standard export; mismatches reported per item |
| Message delivery latency, sender to other clients | p95 under 200 ms at 1,000 concurrent connections on 2 vCPU / 2 GB |
| Search | Returns correct results for Korean, Japanese and Chinese text, not only space-delimited languages |

Adoption targets (stars, installs) are the owner's to set and are not fixed here.

## 4. Users

| User | What they need |
|---|---|
| **Team member** | To find the conversation, read what changed, reply, and not be interrupted by what does not concern them. Expects Slack muscle memory to carry over. |
| **Workspace admin** | To install, upgrade and back up without a dedicated operator; to invite, deactivate and assign roles; to bring the Slack history along. |
| **App and bot developer** | To run existing Bolt code unchanged, and to find out exactly which methods and events are supported. |
| **AI agent** (and the person operating it) | To read history and search without rate-limit workarounds, post and stream replies, and act with a specific person's permissions. |
| **Compliance owner** (later) | Retention rules, audit log, export, and proof that private data stays on the organisation's own machines. |

## 5. Principles

1. **Slack's public data model is the native model.** Conversations, messages, `ts` identifiers, `rich_text` blocks, event names and scopes follow Slack's published shapes. Where Slack's public API has no method (read cursors in bulk, client boot), OpenSlack adds one under its own namespace.
2. **One API.** The web client, bots and agents call the same endpoints and receive the same events. A feature is not done until it is reachable through the API.
3. **Nothing held back.** No feature flags tied to a license key. Limits (file size, rate limits) are configuration the admin owns.
4. **Boring to operate.** One application process, PostgreSQL, a directory or bucket for files. Everything else (calls, external search, object storage, mail) is optional and off by default.
5. **Off by default for anything that leaves the server.** AI features, link previews to third parties and telemetry do nothing until an admin turns them on. There is no phone-home.
6. **Familiar layout, own identity.** Reuse the interaction patterns people know; do not reuse Slack's brand assets, sounds, illustrations or documentation text.

## 6. Release phases

Every row in the inventory below carries one of these labels.

| Label | Meaning |
|---|---|
| **0.1** | First public release. A team can run its daily chat on it, import from Slack and connect a bot. |
| **0.2** | Fast follow in the weeks after 0.1: what early adopters ask for first. |
| **Later** | After 0.2. Ordered by demand, not listed in sequence here. |
| **No** | Out of scope ([§3](#non-goals)). |

`TODO.html` maps these to its three groups: 0.1 → launch must-have, 0.2 → after launch, Later → after that.

## 7. Slack system inventory and OpenSlack scope

Each table lists what Slack has in one area, a one-line description, and the phase in which OpenSlack builds it.

### 7.1 Organisation, identity and access

| Slack capability | What it is | Phase |
|---|---|---|
| Workspace | The unit that owns members, channels, settings and a URL | 0.1 |
| Setup flow | Name the workspace, create the first channel, invite teammates | 0.1 |
| Roles | Primary Owner, Owner, Admin, Member | 0.1 |
| Sign-in with password or emailed code | Email plus password, or a 6-digit code sent by email | 0.1 |
| Invitations | Email invites, shareable links with expiry and use count, sign-up limited to approved email domains, invite requests that an admin approves | 0.1 (requests: 0.2) |
| Profile | Full name, display name, photo, title, time zone, phone, pronouns, custom fields | 0.1 (custom fields: 0.2) |
| Status and presence | Emoji and text with an expiry; active/away derived from activity or set by hand | 0.1 |
| Deactivation | Remove access while keeping the person's messages | 0.1 |
| Sign in with Google / Apple / GitHub | OAuth sign-in | 0.2 |
| Two-factor authentication | TOTP codes, backup codes, workspace-wide enforcement | 0.2 |
| Single sign-on | OIDC first, then SAML 2.0; just-in-time account creation | 0.2 (SAML: Later) |
| Guests | Multi-channel and single-channel guests with an optional expiry date | 0.2 |
| User groups | `@handle` mentions that reach a set of people, with default channels for new members of the group | 0.2 |
| Session management | Session length, sign out everywhere, forced re-authentication | Later |
| SCIM provisioning | Create, update and deactivate accounts from an identity provider; map IdP groups to user groups | Later |
| Enterprise organisation | Several workspaces under one organisation, org-wide channels and policies, custom admin roles | Later |
| Domain claiming, device management | Force accounts on a company domain into the org; require managed devices | Later |

### 7.2 Conversations

| Slack capability | What it is | Phase |
|---|---|---|
| Public channels | Open to every member; browse, join, leave | 0.1 |
| Private channels | Invite-only; invisible to non-members, including in search | 0.1 |
| Direct messages | One-to-one, group DMs of up to 9 people, and a DM with yourself | 0.1 |
| Channel lifecycle | Create, rename, archive, unarchive, delete, convert public to private | 0.1 |
| Channel details | Topic, description, member list, add and remove people | 0.1 |
| Default channels | Channels every new member joins; one general channel nobody can leave | 0.1 |
| Channel browser | Search and filter all channels a person may join | 0.1 |
| Pins | Messages pinned to a conversation | 0.1 |
| Stars | Mark conversations as favourites, shown at the top of the sidebar | 0.1 |
| Read state | Per-person, per-conversation last-read position, unread and mention counts, mark as read or unread | 0.1 |
| Bookmarks and tabs | Links, folders and tabs (canvas, list, files, pins) at the top of a channel | 0.2 (links only) |
| Sidebar sections | Personal, collapsible groupings of conversations with sort and filter options | 0.2 |
| Posting permissions | Limit who may post, reply or use `@channel`; announcement-only channels | 0.2 |
| Channel managers | Per-channel role that may change settings and remove members | 0.2 |
| Convert group DM to private channel | Keeps the history | Later |
| Channel templates | Pre-built channels with canvases, lists and workflows | Later |
| Email into a channel | A per-channel address that turns emails into messages | Later |
| Multi-workspace and org-wide channels | One channel present in several workspaces of an organisation | Later |

### 7.3 Messaging

| Slack capability | What it is | Phase |
|---|---|---|
| Rich text composer | Bold, italic, strikethrough, inline code, code blocks, quotes, ordered and bulleted lists, links; a toolbar and Markdown-style shortcuts | 0.1 |
| Mentions | `@person`, `@here`, `@channel`, `@everyone`, `#channel` links, with autocomplete | 0.1 |
| Emoji | Shortcodes, picker, skin tones, custom emoji and aliases | 0.1 |
| Edit and delete | With an "edited" marker; optimistic send and retry on failure | 0.1 |
| Reactions | Emoji reactions with who reacted | 0.1 |
| Threads | Replies in a side panel, "also send to channel", following a thread, a Threads view across all conversations | 0.1 |
| Sharing | Copy a permanent link, forward a message to another conversation with a quoted preview | 0.1 |
| Link previews | Title, description and image fetched from a URL | 0.1 |
| System messages | Joins, leaves, topic changes, pins, renames | 0.1 |
| Typing indicators | "Several people are typing" | 0.1 |
| History view | Infinite scroll in both directions, date dividers, the new-messages line, jump to a message | 0.1 |
| Drafts | Unsent text kept per conversation; synced across devices with a "Drafts & sent" view | 0.1 local, 0.2 synced |
| Ephemeral messages | Visible to one person only, used by apps | 0.2 |
| Scheduled send | Pick a time; view and edit scheduled messages | 0.2 |
| Later and reminders | Save a message for later with in-progress, archived and completed states; `/remind` | 0.2 |
| Built-in slash commands | `/status`, `/dnd`, `/invite`, `/topic`, `/me`, `/shrug`, `/remind` and the rest | 0.2 |
| Snippets | Code or text snippets with syntax highlighting | 0.2 |
| Edit and delete policy | Who may edit or delete, and within how long | 0.2 |
| Clips | Recorded audio, video or screen messages with transcripts | Later |
| Translation | Translate a message in place | Later |
| Retention | Delete messages and files after a period, per workspace and per channel | Later |

### 7.4 Files

| Slack capability | What it is | Phase |
|---|---|---|
| Upload | Drag and drop, paste, multiple files per message, progress, size limits | 0.1 |
| Previews | Images with thumbnails, video, audio, PDF, text and code | 0.1 |
| File browser | All files in a conversation or the workspace, filter by type and person | 0.1 |
| Download and delete | By the uploader or an admin | 0.1 |
| Share to another conversation | One file, several places, access follows the conversations | 0.2 |
| External links | A public URL for a file that can be revoked | Later |
| Office document previews | Word, Excel, PowerPoint rendering | Later |
| Third-party file providers | Google Drive, OneDrive, Box, Dropbox pickers and previews | Later |
| Scanning hooks | Antivirus and DLP checks on upload | Later |

### 7.5 Search and navigation

| Slack capability | What it is | Phase |
|---|---|---|
| Message and file search | Full text across everything the person may see | 0.1 |
| Modifiers | `in:`, `from:`, `to:`, `before:`, `after:`, `on:`, `during:`, `has:`, `is:`, `with:`, quoted phrases, exclusion with `-` | 0.1 (core set) |
| Result views | Tabs for messages, files, channels and people; filters; view in context | 0.1 |
| Quick switcher | `Cmd/Ctrl+K` jumps to a conversation or person by fuzzy match | 0.1 |
| Search inside one conversation | `Cmd/Ctrl+F` | 0.1 |
| Recent searches and suggestions | As you type | 0.2 |
| File content search | Text inside PDFs and documents | Later |
| AI answers | A written answer with citations above the result list | Later |
| Enterprise search | One search across connected systems (Drive, GitHub, mail) | Later |

### 7.6 Notifications and attention

| Slack capability | What it is | Phase |
|---|---|---|
| Badges | Unread dots and mention counts on conversations and the app icon | 0.1 |
| Activity view | Mentions, thread replies, reactions and invitations in one list | 0.1 |
| Desktop notifications | System notifications with sound | 0.1 (browser) |
| Per-conversation level | All messages, mentions only, nothing; mute | 0.1 |
| Pause notifications | Do Not Disturb for a period, with an urgent override for the sender | 0.2 |
| Notification schedule | Quiet hours by weekday | 0.2 |
| Keywords | Notify on words of your choosing | 0.2 |
| Thread and user-group triggers | Notify on replies to followed threads and on `@group` mentions | 0.1 threads, 0.2 groups |
| All Unreads view | Read every unread conversation in one scroll | 0.2 |
| Email notifications | A digest of missed mentions and DMs | 0.2 |
| Mobile push | Delivered when the desktop is idle, after a configurable delay | 0.2 (Web Push), Later (native) |

### 7.7 Calls and recorded media

| Slack capability | What it is | Phase |
|---|---|---|
| Huddles | Audio-first calls started inside a channel or DM, joinable by anyone in it | 0.2 |
| Video and screen sharing | Several people can share at once; drawing on a shared screen | 0.2 (drawing: Later) |
| Huddle thread | Messages and links from the call saved to a thread afterwards | 0.2 |
| Reactions, effects, backgrounds | In-call emoji and video backgrounds | Later |
| Live captions and notes | Captions during the call; an AI summary afterwards | Later |
| Clips | See [§7.3](#73-messaging) | Later |
| Third-party call providers | Zoom, Meet, Teams started from Slack | Later |

### 7.8 Knowledge and work tracking

| Slack capability | What it is | Phase |
|---|---|---|
| Canvases | Collaborative documents: standalone, attached to a channel as a tab, or to a DM. Headings, checklists, embeds, mentions, comments, version history, view/edit sharing | Later |
| Lists | Trackers with typed fields (person, date, select, status, number, and more), table and board views, filters, a comment thread per item, assignment and due-date notifications | Later |
| Templates | Starting points for canvases, lists and whole channels | Later |

### 7.9 Automation

| Slack capability | What it is | Phase |
|---|---|---|
| Slackbot custom responses | A phrase triggers a canned reply | Later |
| Workflow Builder | No-code automations. Triggers: a link, a schedule, an emoji reaction, a person joining a channel, a webhook, a list change. Steps: send a message, collect a form, add someone to a channel, create or update a canvas or list item | Later |
| Branching and connectors | If/then paths; steps that call third-party services | Later |
| Custom steps | Steps supplied by apps | Later |
| Hosted functions and datastores | Slack-run Deno functions | No |

### 7.10 Developer platform

| Slack capability | What it is | Phase |
|---|---|---|
| Apps and bot users | An app identity with bot, user and app-level tokens and granular scopes | 0.1 |
| Web API | Roughly 200 methods across `chat`, `conversations`, `users`, `files`, `reactions`, `pins`, `search`, `views` and others | 0.1 (Tier A), 0.2 (Tier B), Later (Tier C) — see [§8](#8-slack-compatibility) |
| Incoming webhooks | A URL that posts a message to one channel | 0.1 |
| Events API | Signed HTTP delivery of events with retries | 0.1 |
| Socket Mode | The same events over a WebSocket the app opens | 0.1 |
| Block Kit | Layout blocks, interactive elements, legacy attachments | 0.1 display blocks, 0.2 interactive |
| Slash commands | App-defined commands with a `response_url` | 0.2 |
| Interactivity | Buttons, menus, global and message shortcuts | 0.2 |
| Modals and App Home | `views.open`, `views.update`, `views.push`, `views.publish` | 0.2 |
| OAuth install and manifests | The v2 install flow, app manifests, an app management screen with admin approval | 0.2 |
| AI app surfaces | Assistant threads, suggested prompts, status text, streamed messages | 0.2 |
| App unfurls | Apps supply previews for their own links | Later |
| Sign in with Slack | The workspace as an OpenID Connect provider for other sites | Later |
| Admin, SCIM, audit and discovery APIs | Programmatic administration and compliance access | Later |
| Legacy surfaces | RTM, `files.upload` v1, outgoing webhooks | Later, only on demand |
| App directory | A public marketplace | No |

### 7.11 External collaboration

| Slack capability | What it is | Phase |
|---|---|---|
| Slack Connect channels | A channel shared between organisations, each side approving and keeping its own policies | Later, as federation between OpenSlack servers |
| Slack Connect DMs | Direct messages with someone in another organisation | Later |
| Bridges | Mirroring a channel to Slack or another chat system during a migration | Later |

### 7.12 Administration, security and compliance

| Slack capability | What it is | Phase |
|---|---|---|
| Workspace settings | Name, icon, default channels, who may create channels, invite, add emoji, use `@channel` | 0.1 |
| Member management | Invite, change role, deactivate, see last activity | 0.1 |
| Custom emoji management | Add, alias, remove | 0.1 |
| Import | From a Slack export and from other tools | 0.1 (Slack), Later (others) |
| Export | All data in a documented format, including private conversations for an owner | 0.2 |
| App management | Approve, restrict and remove apps | 0.2 |
| Analytics | Active members, messages, channel activity | Later |
| Audit log | Who changed what, queryable and exportable | Later |
| Retention policies | See [§7.3](#73-messaging) | Later |
| Legal hold and e-discovery | Preserve and search content regardless of deletion | Later |
| Data loss prevention | Rules that flag or block sensitive content | Later |
| Encryption key management | Customer-held keys for stored data | Later |
| Information barriers, IP allow lists | Restrict who may talk to whom and from where | Later |
| Moderation | Flag a message, hide a person | Later |
| Billing | Plans, seats, invoices | No |

### 7.13 AI

All AI features are off until an admin connects a model (Claude API, any OpenAI-compatible endpoint, or a local model). Every answer is restricted to what the asking person may read.

| Slack capability | What it is | Phase |
|---|---|---|
| Built-in MCP server | Search, read and post as tools for any MCP client, with the caller's permissions | 0.1 |
| Unthrottled history access for agents | Generous default rate limits the admin controls | 0.1 |
| Thread and conversation summaries | Summarise a thread or a date range | 0.2 |
| Channel recaps | A daily digest of chosen channels | Later |
| Search answers | See [§7.5](#75-search-and-navigation) | Later |
| Huddle notes, translation, writing help | Per feature above | Later |
| Agents view | One place listing each agent, its sessions and their state | Later |
| Slackbot as a personal agent with memory | A built-in assistant that remembers context | Later |
| Agentforce and Salesforce agents | — | No |

### 7.14 Clients and experience

| Slack capability | What it is | Phase |
|---|---|---|
| Web app | Rail, sidebar, message pane, secondary pane for threads and profiles | 0.1 |
| Themes | Light, dark, follow system | 0.1 (custom sidebar themes: Later) |
| Keyboard shortcuts | Quick switcher, edit last message, mark read, navigate unreads, shortcut list | 0.1 (core set) |
| Preferences | Notifications, appearance, message display, language, time format | 0.1 |
| Languages | Interface in about a dozen languages | 0.1 (English, Korean), more by contribution |
| Reconnect and catch-up | Recover missed events after a dropped connection | 0.1 |
| Accessibility | Full keyboard operation, screen-reader labels, contrast, reduced motion | 0.2 |
| Mobile web and PWA | Responsive layout, installable, Web Push | 0.2 |
| Desktop app | macOS, Windows, Linux: notifications, badge, deep links, auto-update, several servers | 0.2 |
| Native mobile apps | iOS and Android with push, share sheet and offline cache | Later |

## 8. Slack compatibility

### 8.1 API tiers

Compatibility is delivered in three tiers. A method is "supported" when the official Slack SDKs can call it unchanged and the response validates against the published shape.

| Tier | Phase | Contents |
|---|---|---|
| **A** | 0.1 | `auth.test`; `chat.postMessage`, `chat.update`, `chat.delete`, `chat.getPermalink`; `conversations.*` (list, info, history, replies, members, create, join, leave, invite, kick, open, close, archive, rename, setTopic, setPurpose, mark); `users.list`, `users.info`, `users.lookupByEmail`, `users.profile.get/set`, `users.getPresence`; `reactions.*`; `pins.*`; `emoji.list`; `files.getUploadURLExternal`, `files.completeUploadExternal`, `files.info`, `files.list`, `files.delete`; `team.info`; `bots.info`; incoming webhooks; Events API; Socket Mode (`apps.connections.open`) |
| **B** | 0.2 | Slash commands and `response_url`; `chat.postEphemeral`, `chat.scheduleMessage` and friends; `views.*`; interactivity payloads (`block_actions`, `view_submission`, shortcuts, external select options); App Home; `oauth.v2.access` and the install flow; app manifests; `usergroups.*`; `reminders.*`; `bookmarks.*`; `dnd.*`; `search.messages`, `search.files`; message metadata; `assistant.threads.*` and streamed messages |
| **C** | Later | `chat.unfurl` and `link_shared`; `canvases.*`; Lists methods; `admin.*`; SCIM; audit logs; workflow custom steps; legacy surfaces |

Wire details follow Slack where SDKs depend on them: token prefixes (`xoxb-`, `xoxp-`, `xapp-`), identifier prefixes (`U`, `C`, `D`, `T`, `B`, `A`, `F`), the `ts` format, the `X-Slack-Signature` request signing scheme, the three-second acknowledgement window and the retry schedule, and the `ok` / `error` response envelope with Slack's error strings.

Rate limits exist but default to generous values, are admin-configurable, and return `Retry-After` in the same way.

### 8.2 Compatibility harness

A test suite runs the official Bolt sample apps (JavaScript and Python) against a local OpenSlack with only the base URL changed. Its output is a generated table of every Slack Web API method and event marked supported, partial or missing. That table is published in the docs, and it is the definition of "compatible"; no claim is made beyond it.

### 8.3 Import

- **0.1:** the standard Slack export archive: users, public channels, messages, threads, reactions, pins, custom emoji, and files when a token that can download them is provided. The importer is re-runnable and reports every item it could not map.
- **0.2:** exports that include private channels and DMs; an OpenSlack export in the same archive format, so leaving is as easy as arriving.
- **Later:** Mattermost and Discord sources; a live bridge that mirrors channels during a gradual move.

## 9. Architecture (proposed)

This section is a recommendation awaiting the owner's sign-off, not a settled design.

### 9.1 Stack

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript throughout | One set of types for the API, events, Block Kit and the message format shared by server, client, importer and tests; the largest contributor pool for a web product |
| Server | Node.js LTS, one process: HTTP API + WebSocket gateway + background jobs | Fewest moving parts to self-host |
| Database | PostgreSQL 16+ | The single required dependency: relational data, full-text and trigram search, job queue, and `LISTEN/NOTIFY` for multi-process fan-out |
| Files | Local directory by default; any S3-compatible bucket by configuration | Zero-setup default |
| Web client | React single-page app built with Vite | Long-lived stateful UI; no server rendering needed |
| Message editor | A ProseMirror-based editor producing `rich_text` blocks | Slack's own message shape as the document model |
| Calls | LiveKit as an optional service | Open-source SFU; chat works without it |
| Desktop | A thin shell around the web client | Notifications, badge, deep links |
| Mobile | PWA with Web Push first; native apps later | Push without app stores or a relay service |

Alternative considered: a Rust server (axum + sqlx), which would give a single static binary and a smaller footprint. It is set aside because shared types across server, client and compatibility tests matter more here than raw efficiency at the target size of 5–500 people.

### 9.2 Data model

- Identifiers are Slack-shaped strings with type prefixes.
- A message is identified by `(conversation, ts)`. `ts` is a per-conversation, strictly increasing timestamp string with microsecond precision, issued by the server.
- The stored message body is a `blocks` array with a `rich_text` block, plus a derived plain `text` used for fallback, notifications and search. Text sent as Slack `mrkdwn` is parsed into blocks on write.
- Read state is one row per person per conversation: last-read `ts`, mention count.
- Every write produces one event in Slack's event vocabulary. The same event is delivered to connected clients, queued for Events API subscribers and Socket Mode connections, and fed to the search index.

### 9.3 Real-time

- Clients hold one WebSocket. On connect they call a boot endpoint that returns conversations, read state and the people they need, then receive events.
- After a dropped connection the client sends the last event position it saw and receives what it missed; when the gap is too large it re-boots.
- A single process fans out in memory. Several processes fan out through PostgreSQL notifications; a dedicated broker is a later option, not a requirement.
- Typing and presence are transient and never stored.

### 9.4 Search

PostgreSQL full-text search for space-delimited languages combined with trigram matching so Korean, Japanese and Chinese text is searchable from the first release. Results are always filtered by the searcher's membership. The search backend sits behind an interface so an external engine can replace it later.

### 9.5 Security baseline (0.1)

Argon2id password hashing; signed, expiring file URLs; server-side fetching of link previews with private-network addresses blocked; HTML never rendered from message content; login and API rate limiting; least-privilege scopes enforced on every token.

## 10. Self-hosting requirements

- **Install:** `docker compose up` starts the app and PostgreSQL; a first-run page creates the workspace and its owner.
- **Configuration:** environment variables only. Mail is optional — without SMTP, invite links are shown on screen for the admin to pass on.
- **Upgrades:** migrations run automatically on start; a release never requires manual SQL.
- **Backup:** a database dump plus the files directory is a complete backup; restore is documented and tested.
- **Footprint:** a 50-person team fits on 1 vCPU / 1 GB.
- **Observability:** a health endpoint, structured logs and Prometheus metrics.
- **Later:** a Helm chart, multi-node deployment, external search and object storage guides.

## 11. License and sustainability

- **Recommended license: Apache-2.0** (permissive, with a patent grant). MIT and AGPL-3.0 are the alternatives; the choice is the owner's.
- Everything is in this repository. There is no enterprise directory and no license key.
- How the project sustains itself (hosted service, support, sponsorship) is deliberately undecided for the 0.x line.

## 12. Risks and open decisions

### Decided (owner, 2026-11-16)

- **Name:** `openslack`. "Slack" is a registered trademark, so a rename request remains possible; the first risk below keeps a rename cheap. The GitHub account name `OpenSlack` belongs to someone else (registered 2023).
- **Repository:** `nullarch/openslack`, private now, made public when 0.1 runs.

### Open decisions (owner)

| Decision | Recommendation | Why it matters now |
|---|---|---|
| **License** | Apache-2.0 | Hard to change after outside contributions arrive. |
| **Stack** | TypeScript + PostgreSQL ([§9](#9-architecture-proposed)) | Blocks all code. |
| **Public demo instance** | — | A try-before-install demo needs a long-running server and therefore a hosting cost. |

### Risks

| Risk | Mitigation |
|---|---|
| A rename is forced after launch | Keep brand strings in one module. Outside the compatibility layer, no identifier, table, environment variable or package name contains the product name or "slack". |
| The compatibility surface is very large | Tiers, the generated support table, and Bolt sample apps as the acceptance test. Unsupported methods return Slack's `unknown_method` error and are logged so demand is visible. |
| Slack changes its API | The harness pins SDK versions and runs against new ones in CI; drift shows up as failing rows. |
| A crowded field (Mattermost, Rocket.Chat, Zulip) | Compete on the two things they do not offer: running existing Slack apps and a faithful import. |
| Using Slack's API during import | 0.1 imports from export archives only. Any live-API import or bridge waits for a review of Slack's API terms. |
| Scope creep toward "all of Slack" | Phases in [§6](#6-release-phases); 0.1 ships without canvases, lists, workflows and calls. |
| Mobile push for native apps needs a relay tied to the published app | PWA Web Push first; a relay is designed only when native apps are built. |

## 13. References

Checked on 2026-11-16.

- Slack feature announcements — <https://slack.com/innovations>, <https://slack.com/blog/news/slack-feature-drop-august2026>
- Slack API rate-limit change for non-Marketplace apps — <https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps>
- Slack API rate limits — <https://docs.slack.dev/apis/web-api/rate-limits>
- Slack file upload methods — <https://docs.slack.dev/changelog/2024-04-a-better-way-to-upload-files-is-here-to-stay>
- Mattermost v11 free-edition changes — <https://forum.mattermost.com/t/mattermost-v11-changes-in-free-offerings/25126>
- Rocket.Chat plans and seats — <https://docs.rocket.chat/our-plans>, <https://docs.rocket.chat/docs/seats-faq>
- Slack plan limits are taken from third-party summaries that disagree in places (<https://pumble.com/slack-pricing>, <https://www.costbench.com/software/communication/slack/free-plan/>); confirm against <https://slack.com/pricing> before quoting them publicly.

OpenSlack is not affiliated with, endorsed by or sponsored by Slack Technologies or Salesforce.
