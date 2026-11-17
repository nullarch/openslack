# Self-hosting

Everything runs in one process and keeps its state in one directory.

## Start

```bash
npx openslack                                   # data in ~/.openslack
docker run -p 3000:3000 -v openslack:/data ghcr.io/nullarch/openslack
docker compose up -d                            # from a checkout of this repository
```

Open the address it prints and create your workspace. The first person to do so becomes the primary owner.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Address to bind. Use `127.0.0.1` when a reverse proxy is in front |
| `DATA_DIR` | `~/.openslack`, or `/data` in the container | Database and uploaded files |
| `PUBLIC_URL` | `http://localhost:PORT` | The address people and bots use to reach the server |
| `MAX_UPLOAD_MB` | `100` | Largest accepted upload |
| `LINK_PREVIEWS` | on | `0` turns off link previews, which make the server fetch linked pages (see below) |
| `SMTP_URL` | none | Outgoing mail, e.g. `smtps://user:pass@smtp.example.com:465`. Turns on mailed invitations, sign-in codes and password resets |
| `MAIL_FROM` | `<workspace> <no-reply@<host>>` | Sender of that mail |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_NAME` | none | Single sign-on with any OpenID Connect provider |
| `SAML_IDP_METADATA_URL`, or `SAML_IDP_SSO_URL` and `SAML_IDP_CERT`; `SAML_NAME` | none | Single sign-on with a SAML 2.0 identity provider |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | none | Sign in with Google |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | none | Sign in with GitHub |
| `METRICS_TOKEN` | none | Serves Prometheus metrics at `/metrics` to this bearer token |
| `LOG_FORMAT` | text | `json` writes one JSON object per log line |
| `WORKERS` | one process | Serve from this many processes on one port (see "Several processes") |
| `CLUSTER` | off | `1` lets processes you start yourself share the data directory |
| `PUSH_RELAY_URL` | none | The push relay that delivers notifications to the native apps (see "Mobile apps") |

Set `PUBLIC_URL` whenever the server is reached at anything other than `localhost`: links, file URLs handed to bots and invite links are built from it. When it starts with `https://`, the session cookie is marked `Secure`.

## Link previews

Link previews are on by default. When a person posts a message with links in it, the server itself fetches up to three of those links and attaches a preview: the page's title, description, site name and image, read from its Open Graph or Twitter tags or its `<title>`.

- **What leaves the server.** A plain `GET` of each linked page from the server's own address, identifying itself as `openslack-preview/1.0`, and then a `GET` of the image the page names. No cookies, no credentials, nothing about who posted the link. Redirects are followed up to three times. Each request stops after 5 seconds, a page after 512 KB, an image after 3 MB.
- **What is not fetched.** Links in messages from bots and apps; links in messages that already carry attachments; links to this server; and links under a domain an app registered for unfurling, which that app previews itself through `chat.unfurl`.
- **Private addresses.** Pages at private, loopback or link-local addresses are refused, checked again after every redirect and DNS answer, unless the server itself runs on `localhost` (or `ALLOW_PRIVATE_APP_URLS=1` is set, the same switch apps use).
- **Where it is kept.** Previews are cached in the database for a day (an unreachable page is retried after an hour). The image is stored with the uploaded files (in `DATA_DIR/files`, or the bucket) and served from this server to signed-in people, so readers' browsers never contact the linked site.
- **Turning it off.** Set `LINK_PREVIEWS=0` and restart. Nothing is fetched from then on; previews already attached to messages stay until their authors remove them.

Anyone can remove a preview from their own message, and admins from any message.

## Files in a bucket

Uploaded files go to `DATA_DIR/files` unless an S3-compatible bucket is configured; then they go to the bucket and the data directory holds only the database.

| Variable | Meaning |
|---|---|
| `S3_BUCKET` | Bucket name. Setting it switches storage to the bucket |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Credentials (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` also work) |
| `S3_REGION` | Default `us-east-1` |
| `S3_ENDPOINT` | Service address for anything other than AWS, e.g. `https://<account>.r2.cloudflarestorage.com` or `http://minio:9000` |
| `S3_PATH_STYLE` | `1` to address the bucket as `endpoint/bucket`; on by default when `S3_ENDPOINT` is set |
| `S3_PREFIX` | Prefix for every object key, e.g. `chat/` |

Requests are signed with AWS Signature Version 4; the signing is tested against botocore's output. It has not yet been run against a real AWS, R2 or MinIO bucket. Moving existing files from the directory to a bucket is not automated: copy `files/<xx>/<key>` to `<prefix><key>` in the bucket.

## Huddles

Huddles (audio, video and screen sharing inside a conversation) need a [LiveKit](https://github.com/livekit/livekit) media server, which is open source (Apache-2.0) and runs as one more process. Without it the huddle button is simply not shown.

| Variable | Meaning |
|---|---|
| `LIVEKIT_URL` | The address browsers connect to, e.g. `wss://media.example.com`. Setting it turns huddles on |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | A key pair from LiveKit's `keys:` section; the secret should be at least 32 characters |
| `LIVEKIT_API_URL` | Optional: where this server reaches LiveKit's API if not at `LIVEKIT_URL` (e.g. `http://livekit:7880` on an internal network) |

Next to the app in `compose.yaml`:

```yaml
services:
  app:
    # … as above, plus:
    environment:
      LIVEKIT_URL: wss://media.example.com
      LIVEKIT_API_URL: http://127.0.0.1:7880
      LIVEKIT_API_KEY: chat
      LIVEKIT_API_SECRET: change-me-to-at-least-32-random-characters
  livekit:
    image: livekit/livekit-server:v1.13.11
    command: --config /etc/livekit.yaml
    # Media travels over UDP on many ports; host networking is the simple way to expose them.
    network_mode: host
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml:ro
    restart: unless-stopped
```

`livekit.yaml`:

```yaml
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
keys:
  chat: change-me-to-at-least-32-random-characters
webhook:
  api_key: chat
  urls:
    - http://127.0.0.1:3000/livekit/webhook
```

Open TCP 7881 and UDP 50000–60000 in the firewall, and serve port 7880 over HTTPS at the `LIVEKIT_URL` host (browsers only allow microphones and cameras on secure pages, and a secure page can only open `wss://`). With Caddy:

```
media.example.com {
    reverse_proxy 127.0.0.1:7880
}
```

The webhook tells this server at once when someone's tab disappears without leaving. It is optional: the server also compares its participant list with LiveKit's every 20 seconds and drops anyone who has been gone for 30 seconds. Its requests are signed with the API secret and checked.

Tokens for the media server are issued only to members of the conversation, for that conversation's room only, and expire after 10 minutes. LiveKit checks a token when someone connects and refreshes it for calls in progress.

Checked: the server and the web client against LiveKit 1.13.11 run directly (`livekit-server --config-body …`), with two browsers exchanging audio, camera video, a screen share and reactions, and the webhook and the periodic comparison each removing someone who vanished. Not checked: the compose file above, calls longer than a few minutes, more than two people, and networks with NAT between browser and LiveKit.

### Backgrounds and drawing

People can blur their camera background or put a picture behind themselves (huddle settings → Background). The person is separated from the background in their own browser by MediaPipe's selfie segmenter through LiveKit's track processors; the model and the WebAssembly are served by this server (`/effects/`, about 10 MB, loaded only when someone picks a background), so nothing is fetched from a third party and offline installs work. Anyone can draw on a shared screen (the pencil on the screen's tile): marks appear on that screen for everyone in the huddle, the person sharing included, fade after a few seconds, travel over the call's data channel and are never stored. Marks show on the shared picture in the huddle, not on the sharer's actual desktop.

### Captions and huddle notes

Anyone in a huddle can turn on captions. Speech becomes text in that person's own browser, through the Web Speech API, for their own microphone only and only while it is not muted; the server never receives audio. Browsers differ in where they do this: Safari and some versions of Chrome recognise speech on the device, others send the audio to their maker's speech service. Browsers without the API (Firefox today) show the captions of others but cannot caption their own speech.

Finished lines go to everyone in the huddle and are kept while it runs. When it ends they become a text file, *Huddle transcript YYYY-MM-DD.txt*, posted by the built-in Huddles bot in the huddle's thread, and, when a model is connected and *Notes after a huddle* is on in the AI settings, a summary with decisions and action items alongside it. The kept lines are then deleted; the file is an ordinary file under retention and legal hold. An admin can turn transcripts off under **Administration → Compliance**: captions are then live only.

## Clips

The composer's clip button records an audio clip, a video clip or the screen (with the microphone), up to five minutes, in the browser (MediaRecorder); nothing is sent until the person adds it to a message. Captions are made while recording, in the same way as huddle captions: by the browser's speech recognition, from the microphone. They are attached to the file as WebVTT (`client.files.setTranscript`, uploader only), shown on the video and as a transcript under the player, and searchable in **Files**. Sensitive-information rules apply to what was said. Chrome writes WebM files without a duration, so the player shows it only once played through.

## Search with Meilisearch

Search runs on the built-in SQLite index, which handles Korean, Japanese and Chinese and needs nothing else. For ranking by relevance, typo tolerance or a very large history, connect [Meilisearch](https://www.meilisearch.com) (open source, one binary):

| Variable | Meaning |
|---|---|
| `MEILISEARCH_URL` | e.g. `http://127.0.0.1:7700` |
| `MEILISEARCH_KEY` | its master key or an API key allowed to manage the index |
| `MEILISEARCH_INDEX` | index name, default `messages` |

On first start every message is copied over; from then on, changes are queued in the database by triggers and sent every second, so nothing is lost while either side is down (imports run from the command line included). Until the copy has caught up, and whenever Meilisearch cannot answer, searches use the built-in index. Every search is limited to the conversations the person may read, and the results are re-read from the database and checked again. `search.messages` with `sort=score` ranks by relevance; otherwise newest first. Searches for `has:pin` and `has:reaction` use the built-in index. Removing `MEILISEARCH_URL` stops the queue; connecting again copies everything afresh. Checked against Meilisearch 1.56.

## AI features

Summaries, daily recaps, answers above search results, translation, writing help, a built-in assistant with memory, notes after a huddle, and the Agents view. **They are off until an admin connects a model** under **Workspace menu → AI settings**; until then every AI request is refused and the server makes no outbound request for them. There is no telemetry either way.

| Setting | Meaning |
|---|---|
| Provider | **Claude API** (through Anthropic's official SDK) or **OpenAI-compatible** (any server that speaks the OpenAI chat API: vLLM, Ollama, LM Studio, LiteLLM, …) |
| Model | Defaults to `claude-opus-5-5` for the Claude API |
| Base URL | Optional for the Claude API (a gateway or proxy); required for OpenAI-compatible endpoints, e.g. `http://localhost:11434/v1` |
| API key | Stored in the database on this server and never sent back to any browser, admins included. For the Claude API without a key here, the SDK falls back to `ANTHROPIC_API_KEY` or an `ant auth login` profile in the server's environment |
| Features | Each feature can be switched off on its own |

What leaves the server, and only when a person asks:

- **Summaries** (a thread, or a channel's unread messages or today) and **search answers** send the messages being summarised, or the messages that person's own search found. Everything goes through the same visibility checks as the API: someone who cannot read a private channel or DM can never get it into a summary, an answer or a recap. The answer streams to that person only and is not stored.
- **Translation** sends the one message being translated, plus the viewer's language. **Help me write** sends the draft being edited; the result goes back into the composer and is never sent on its own.
- **Daily recaps** run on the server at each person's chosen local time and send the new messages from the channels they picked, checked against what they can read at that moment. The recap arrives as a direct message from a built-in "Recaps" bot. The schedule is stored in the database, so a restart only delays a recap until the server is back.
- **The assistant** (sidebar → Assistant) is a built-in bot each person talks to in a direct message. Each reply sends that person's message, the last twenty turns of the conversation, what they asked it to remember, and the workspace messages their own search finds for the key words of the message. It streams into the conversation and cites messages as links. It never keeps anything on its own: the model may only propose a fact, shown under the reply with **Remember** and **Not now**, so a message quoted from the workspace cannot plant a memory. People see, add and delete their memories under **Preferences → What the assistant remembers**; nobody else can read them, admins included (the API has no method for it).

Requests to the Claude API ask for the API's server-side fallback (`fallbacks: "default"`): if the model declines a request, the API retries it on another model within the same call.

The Agents view (workspace menu → Agents) needs no model. It lists apps acting as agents — connected over Socket Mode, or using assistant status, titles or streamed replies — with their recent threads and current status, limited to threads the viewer can read.

## Mobile apps

The iOS and Android apps (`apps/mobile`) keep a list of servers and show each server's own web client, so they work with any version of the server. People add your server by its address, or by a link `<app scheme>://open?server=https://chat.example.com`.

Notifications on phones go through a push relay: Apple and Google accept them only with the credentials of whoever published the app. Set `PUSH_RELAY_URL` to the relay of the build your people install; the server signs what it sends with its own key, and the relay keeps nothing (`apps/push-relay`). Without a relay the apps still work, and show messages while open. The relay sees each notification's title and text on the way through, as Apple and Google do.

The apps are not in the stores yet: see `apps/mobile/README.md` for what is left.

## Shared channels with other servers

Two organisations that each run their own server can share a channel, as Slack Connect does between workspaces:

1. An admin opens the channel's details and chooses **Share with another organisation**. This makes an invitation link, which works once, for seven days.
2. An admin of the other server pastes the link under **Administration → Shared channels**, picks the channel's name there, and accepts.

Each server keeps its own copy of the channel. Messages, thread replies, edits, deletions, reactions, people joining and leaving, the topic and description, and the names and titles of the people in it are passed between the two servers. People from the other organisation show with their organisation's name; they cannot sign in to your server and do not count as your members. Once two servers share a channel, their people can also send each other direct messages.

Either admin can stop sharing. Both sides keep the messages so far; the other organisation's people leave your copy.

Requirements and limits:

- Both servers must reach each other at their `PUBLIC_URL` over HTTPS. The servers sign every request with a key each makes on first use and pins the other's key when the invitation is accepted.
- A channel is shared between two servers, not more.
- Files are not passed on yet: the other side sees the file's name.
- Undelivered changes wait in a queue and are retried for as long as the connection exists; **Administration → Shared channels** shows how many are waiting.
- Turn the feature off for the whole workspace there too.

## Sign in with this workspace

Other tools can let people sign in with their account here (OpenID Connect, the same flow as Slack's Sign in with Slack). Create an app under **Administration → Apps**, add the tool's callback address as a redirect URL, and give the tool:

| Setting | Value |
|---|---|
| Issuer / discovery | `https://chat.example.com` (`/.well-known/openid-configuration`) |
| Client ID and secret | the app's, from its page under Administration → Apps |
| Scopes | `openid profile email` |

Tools that support Sign in with Slack can instead be pointed at `https://chat.example.com/openid/connect/authorize` and `https://chat.example.com/api/`. The signing key is created on first use as `oidc-signing-key.pem` in the data directory; keep it with your backups, or tools will have to fetch the new key after a restore.

## Provisioning accounts from an identity provider (SCIM)

Okta, Microsoft Entra ID, OneLogin and other identity providers can create, update and deactivate accounts here with SCIM 2.0. An admin makes a token with the `client.admin.scimToken` API method (it acts with that admin's authority, can do nothing but provisioning, and a new one replaces the old), then in the identity provider's generic SCIM app:

| Setting | Value |
|---|---|
| SCIM base URL | `https://chat.example.com/scim/v2` |
| Authentication | Bearer token (the one above) |
| Unique identifier | `userName` (an email address works) |

Supported: listing and filtering users (`userName`, `externalId`, `emails`), create, replace, patch (including the forms Okta and Entra send) and delete, which deactivates the account and keeps its history; people created this way join the default channels. Groups (`/Groups`) become user groups with an `@handle` made from the group's name; membership and renames follow the identity provider, and deleting a group disables it (provisioning it again brings it back). Changes are recorded in the audit log as the admin who made the token.

## Email notifications

With `SMTP_URL` set, people who are away get an email about mentions and direct messages they have not read: at most every 15 minutes by default, or hourly, or never (their choice in Preferences → Notifications). Messages are mailed once, only after they have gone unread for two minutes, and never while the person is online.

## Email to a channel

A channel can get its own address, so mail sent there (alerts, forms, a shared inbox) shows up in it. Mail reaches the server through your mail provider's inbound route, as the raw message:

| Variable | Meaning |
|---|---|
| `INBOUND_EMAIL_DOMAIN` | The domain the provider receives for, e.g. `in.chat.example.com`. Addresses look like `alerts.k3x9q2@in.chat.example.com` |
| `INBOUND_EMAIL_SECRET` | A long random string the provider sends with each message (`x-inbound-key` header or `?key=`) |

With Cloudflare Email Routing, route the domain to a Worker:

```js
export default {
  async email(message, env) {
    await fetch(`https://chat.example.com/inbound/email?to=${encodeURIComponent(message.to)}`, {
      method: 'POST',
      headers: { 'x-inbound-key': env.INBOUND_EMAIL_SECRET, 'content-type': 'message/rfc822' },
      body: message.raw,
    });
  },
};
```

SendGrid Inbound Parse works with "POST the raw, full MIME message" on and `https://chat.example.com/inbound/email?key=…`; Mailgun with a route forwarding to `https://chat.example.com/inbound/email?key=…&format=mime`. Members make or replace a channel's address in its details. The built-in Email bot posts each message with its sender, subject, text and attachments (subject to virus scanning when that is on). Mail to an unknown or replaced address is accepted and dropped.

## Encryption at rest

Set `STORAGE_ENCRYPTION_KEYS` to one or more 32-byte keys (`openssl rand -base64 32`, comma-separated) and uploaded files, thumbnails and link-preview images are stored encrypted (AES-256-GCM in 64 KiB chunks, so video seeking and image previews still read only what they need) on disk or in the bucket. The first key encrypts; every key listed decrypts, so to change keys put the new one first, then run `openslack encrypt-files`, which also encrypts files stored before encryption was turned on. Keep the keys somewhere other than the data folder: without them the files cannot be read. The database itself is not encrypted by this; put the data folder on an encrypted volume for that.

## Virus scanning

Set `CLAMAV_URL=tcp://clamav:3310` to have every upload checked by a ClamAV daemon (for example the `clamav/clamav-debian` container, which also runs on ARM) before anyone can see it. An infected file is deleted and the upload fails with `file_infected`. If the daemon cannot be reached the upload is refused (`scan_unavailable`); `CLAMAV_FAIL_OPEN=1` accepts it unscanned instead. Files larger than `CLAMAV_MAX_MB` (25, clamd's default stream limit) are not scanned; raise both together if you need to.

## Automating administration

Tools that manage a Slack workspace through its admin API work here too: `admin.users.*` (list, roles, invite, remove, session reset), `admin.conversations.*` (search, rename, archive, delete, posting rules) and `admin.teams.settings.*`. They need an admin's user token with the `admin.*` scopes, from an OAuth install that only an admin can approve; the token can never do more than that admin could in the web client, and everything it does is in the audit log.

## IP allowlist

Owners can limit where the workspace may be used from: a list of address ranges (`client.admin.setIpAllowlist {"cidrs": ["203.0.113.0/24", "2001:db8::/32"]}`). Browsers, sign-in and the live connection from other addresses are refused with `access_denied`; API tokens too when `applies_to_tokens` is set. A list that would shut out the owner setting it is refused, and `IP_ALLOWLIST_DISABLED=1` lifts it if you lock yourself out anyway. Behind a reverse proxy, set `TRUST_PROXY` to the number of proxies in front of the server so the client's own address (from `X-Forwarded-For`) is used here, in sessions and in the audit log.

## Information barriers

Admins can keep user groups from messaging or calling each other directly (Slack's `admin.barriers.*`): members of the primary group cannot open direct or group messages, or calls, with members of the groups it is barriered from, and direct conversations they already had are closed to writing. Group membership is read when it matters, so moving someone between groups takes effect at once. Shared channels are not affected, as on Slack.

## Audit log

Changes to people, roles, apps, channels and workspace settings, and every sign-in (including failed ones), are recorded with who, when, from which address and with what browser or tool. Admins read it with `client.admin.audit.list`; for a SIEM or a script, make a token with `client.admin.auditToken` and read `GET /audit/v1/logs` (the shape of Slack's Audit Logs API: `limit`, `cursor`, `oldest`, `latest`, `action`, `actor`, `entity`). Arguments are reduced to identifiers; passwords and tokens are never written to it.

## Sensitive information

Admins can refuse messages that contain payment card numbers (Luhn-checked), Korean resident registration numbers, US Social Security numbers, or API keys, tokens and private keys, plus patterns of their own (`client.admin.dlp.set`, preview with `client.admin.dlp.test`). Posts and edits from people and apps are checked, Block Kit text included, and so is the text inside uploaded documents, PDFs and code files; a refused message fails with `sensitive_information` and the attempt is written to the audit log without its text. Off until turned on.

## Legal hold and eDiscovery

Owners can place people or conversations under a legal hold (`client.admin.holds.create`, `.list`, `.release`). While a hold is active nothing it covers is lost: retention skips it, and the earlier versions of edited or deleted messages and the bytes of deleted files are kept out of sight. `GET /admin/discovery.zip?users=U…&channels=C…&oldest=…&latest=…` (owners, signed in) downloads the matching messages as NDJSON, with the kept versions and the files, and a manifest of the criteria. Holds and exports are in the audit log.

## Retention

By default everything is kept. Workspace owners can set how many days messages in channels, direct messages and files are kept with the `client.admin.setRetention` API method (`{"retention": {"messages_days": 365, "dm_days": 90, "files_days": 365}}`; `0` keeps forever, `dm_days: null` follows channels). `client.admin.retention` shows the policy and, with `preview`, how much a policy would delete. Deletion starts when the policy is saved and then runs hourly; it cannot be undone. A thread whose first message is past the limit but has newer replies keeps a "deleted" placeholder so the replies stay reachable.

## Kubernetes

A Helm chart is in `deploy/helm/chat`. It runs one replica (every process using the database file must be on one machine) with its data on a persistent volume; to use more cores in that pod, set `WORKERS` through `env`:

```bash
helm install team deploy/helm/chat \
  --set publicUrl=https://chat.example.com \
  --set ingress.enabled=true --set ingress.host=chat.example.com --set ingress.tlsSecret=chat-tls
```

`env` sets any variable from the table above; `envFromSecret` names an existing Secret for keys (S3, LiveKit, mail). The ingress annotations keep WebSockets open and allow 100 MB uploads on ingress-nginx; other controllers need their own equivalents. The chart passes `helm lint` and renders; it has not yet been installed on a real cluster.

## Behind a reverse proxy

Terminate HTTPS at the proxy and forward everything, including WebSocket upgrades, to the server.

Caddy:

```
chat.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

nginx:

```
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    client_max_body_size 100m;
}
```

Keep the `Host` header intact: the server compares it with the browser's `Origin` to reject cross-site requests.

## Mail

Without mail, nothing breaks: invite links are shown on screen to copy, and people sign in with a password. With `SMTP_URL` set:

- invitations to an address are mailed;
- the sign-in page offers "Email me a code" (six digits, ten minutes, five tries);
- "Forgot your password?" mails a one-hour reset link, and resetting signs out every other session.

Any SMTP service works (Postmark, SES, Mailgun, your own). Links in mail use the address the request came from, falling back to `PUBLIC_URL`.

## Sign in with an identity provider

Each provider turns on when both its client id and secret are set. Register this redirect URI with the provider:

```
<PUBLIC_URL>/auth/<provider>/callback      # provider is oidc, google or github
```

- **Single sign-on (OIDC):** `OIDC_ISSUER` is the provider's issuer URL (discovery at `/.well-known/openid-configuration`). Accounts are created on first sign-in, within the workspace's approved domains; set `OIDC_CREATE_ACCOUNTS=0` to only link existing accounts.
- **Single sign-on (SAML 2.0):** for Okta, Microsoft Entra ID, Google Workspace, OneLogin, JumpCloud, ADFS, Keycloak and others. Give the identity provider this server's metadata, `<PUBLIC_URL>/auth/saml/metadata` (entity id `<PUBLIC_URL>/auth/saml/metadata` unless `SAML_SP_ENTITY_ID` says otherwise, reply address `<PUBLIC_URL>/auth/saml/callback`), and set either `SAML_IDP_METADATA_URL` (read again hourly, so certificate rollovers are picked up) or `SAML_IDP_SSO_URL` with `SAML_IDP_CERT` (PEM or its base64 body; several separated by commas). The provider must sign assertions and send the address as an `email`/`mail` attribute (or the Entra claim, or an email-format NameID). Sign-in starts from the button here; answers the server did not ask for, or asked for more than ten minutes ago, are refused, and each answer is accepted once. Accounts are created as for OIDC; `SAML_CREATE_ACCOUNTS=0` only links existing ones. Checked against SimpleSAMLphp as a real identity provider in a browser.
- **Google, GitHub:** link to the account with the same verified address. They create accounts only with `GOOGLE_CREATE_ACCOUNTS=1` / `GITHUB_CREATE_ACCOUNTS=1` *and* approved domains set in Administration → Workspace, because anyone can have a Google or GitHub account. An invite link always lets the invited person sign up with a provider.

Two-factor sign-in (authenticator app, with backup codes) works with every sign-in method. An admin who has it turned on can require it for everyone.

## Monitoring

- `/healthz` answers `{"ok":true}` while the server runs.
- With `METRICS_TOKEN` set, `/metrics` serves Prometheus metrics (accounts, conversations, messages, file bytes, pending app deliveries, connected people, API calls by method and outcome, memory, event-loop delay) to `Authorization: Bearer <token>`.
- `LOG_FORMAT=json` for log collectors.

## Backup and restore

The data directory is the whole backup: `app.db` (SQLite, with `app.db-wal` and `app.db-shm` beside it while the server runs) and `files/`. With a bucket configured, back up the bucket as well.

- While the server runs: `openslack backup /backups/2026-11-17` (or `node apps/server/src/main.ts backup …` from source, with the same `DATA_DIR`). It takes a consistent snapshot through SQLite's backup API, then copies the files; with files in a bucket it copies only the database. Needs Node.js 22.16 or newer.
- Or stop the server, copy the directory, start the server.

To restore, point `DATA_DIR` at the copy (or put it back in place) and start the server. `node scripts/backup-restore-test.mjs` runs the whole cycle against a live server and checks the restored one.

Owners can also download everything from Administration → Workspace as a Slack-format export (`/admin/export.zip`), which this server's importer, or any tool that reads Slack exports, takes back.

## Upgrading

Replace the package or image and restart. Schema migrations run automatically at start. Take a backup first; migrations only move forward.

## Importing from Slack

See the README. Run the import while the server is stopped, or restart the server afterwards so connected clients pick up the imported history.

## Size

A single process is meant for teams of up to a few hundred people. To use more processor cores, see "Several processes" below.

Measured on an Apple-silicon laptop (Node 24, client and server on the same machine):

| Measure | Result |
|---|---|
| Memory at rest | about 140 MB |
| Database per message (110 characters, search index included) | about 750 bytes |
| Messages written per second, through the same code path the API uses | about 6,000 |
| Delivery latency, 1,000 open connections (250 people), post to receipt | p95 11 ms, p99 12 ms |
| Delivery latency, 5,000 open connections (1,000 people) | p95 54 ms, p99 61 ms; 254 MB memory |

Reproduce the last two with `node apps/server/scripts/load-test.mjs [connections] [people] [messages]` (raise `ulimit -n` first).

## Several processes

One Node.js process uses one processor core. To use more, start several processes that share the data directory:

```bash
WORKERS=4 openslack          # four workers on one port; restarted if one dies
```

or, to run processes yourself (one per port behind a reverse proxy), start each with `CLUSTER=1` and the same `DATA_DIR`. Every process must run on the same machine with the data directory on a local disk: SQLite's locking does not work over a network file system. A process started without `CLUSTER=1` (or `WORKERS`) refuses to start while another one is using the directory.

What changes:

- One process at a time runs the periodic work (scheduled messages, reminders, digests, retention, recaps); if it stops, another takes over within seconds and catches up.
- Events reach browsers and bots connected to any process, in the same order everywhere, a few milliseconds later than within one process; Socket Mode apps may connect to any of them.
- API rate limits and `/metrics` counters are per process.

Measured on the same laptop (18 cores), 64 clients alternating `conversations.history` and `search.messages` over 2,000 messages (`WORKERS=N node apps/server/scripts/api-load-test.mjs`):

| Processes | Requests per second | p95 |
|---|---|---|
| 1 | about 1,650 | 43 ms |
| 2 | about 2,960 | 30 ms |
| 4 | about 3,400 | 31 ms |
| 8 | about 1,540 | 76 ms |

Two to four workers help API-heavy use; eight were slower than one, so do not add more than you have measured to help. Delivery to open WebSockets stays about the same: with 5,000 connections the p95 was 27 ms with one process and 28 ms with four (`WORKERS=4 node apps/server/scripts/load-test.mjs 5000 1000 60`).

## Deploy to a hosting service

The repository carries ready configurations. Each runs **one** instance with a persistent volume at `/data`: the database is a file there, so a second instance or a disk-less plan would lose data. None of these has been tried on the real service yet; they follow each provider's documented format.

**Render** — `render.yaml` is a Blueprint (paid instance type, because disks need one). After the repository is public:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/nullarch/openslack)

Set `PUBLIC_URL` to the service's address when Render asks.

**Fly.io** — `fly.toml`:

```bash
fly launch --no-deploy --copy-config
fly volumes create data --size 5
fly secrets set PUBLIC_URL=https://<app>.fly.dev
fly deploy
```

**Railway** — New project → Deploy from GitHub repo (it builds the `Dockerfile`). Then add a Volume mounted at `/data`, set `DATA_DIR=/data` and `PUBLIC_URL` to the generated domain, and generate a domain under Networking.

**Any VPS** — `docker compose up -d` with `compose.yaml`, behind the reverse proxy above.

