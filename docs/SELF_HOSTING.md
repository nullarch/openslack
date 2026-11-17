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
| `SMTP_URL` | none | Outgoing mail, e.g. `smtps://user:pass@smtp.example.com:465`. Turns on mailed invitations, sign-in codes and password resets |
| `MAIL_FROM` | `<workspace> <no-reply@<host>>` | Sender of that mail |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_NAME` | none | Single sign-on with any OpenID Connect provider |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | none | Sign in with Google |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | none | Sign in with GitHub |
| `METRICS_TOKEN` | none | Serves Prometheus metrics at `/metrics` to this bearer token |
| `LOG_FORMAT` | text | `json` writes one JSON object per log line |

Set `PUBLIC_URL` whenever the server is reached at anything other than `localhost`: links, file URLs handed to bots and invite links are built from it. When it starts with `https://`, the session cookie is marked `Secure`.

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
- **Google, GitHub:** link to the account with the same verified address. They create accounts only with `GOOGLE_CREATE_ACCOUNTS=1` / `GITHUB_CREATE_ACCOUNTS=1` *and* approved domains set in Administration → Workspace, because anyone can have a Google or GitHub account. An invite link always lets the invited person sign up with a provider.

Two-factor sign-in (authenticator app, with backup codes) works with every sign-in method. An admin who has it turned on can require it for everyone.

## Monitoring

- `/healthz` answers `{"ok":true}` while the server runs.
- With `METRICS_TOKEN` set, `/metrics` serves Prometheus metrics (accounts, conversations, messages, file bytes, pending app deliveries, connected people, API calls by method and outcome, memory, event-loop delay) to `Authorization: Bearer <token>`.
- `LOG_FORMAT=json` for log collectors.

## Backup and restore

The data directory is the whole backup: `app.db` (SQLite, with `app.db-wal` and `app.db-shm` beside it while the server runs) and `files/`.

- While the server runs: `openslack backup /backups/2026-11-17` (or `node apps/server/src/main.ts backup …` from source, with the same `DATA_DIR`). It takes a consistent snapshot through SQLite's backup API, then copies the files. Needs Node.js 22.16 or newer.
- Or stop the server, copy the directory, start the server.

To restore, point `DATA_DIR` at the copy (or put it back in place) and start the server. `node scripts/backup-restore-test.mjs` runs the whole cycle against a live server and checks the restored one.

Owners can also download everything from Administration → Workspace as a Slack-format export (`/admin/export.zip`), which this server's importer, or any tool that reads Slack exports, takes back.

## Upgrading

Replace the package or image and restart. Schema migrations run automatically at start. Take a backup first; migrations only move forward.

## Importing from Slack

See the README. Run the import while the server is stopped, or restart the server afterwards so connected clients pick up the imported history.

## Size

A single process is meant for teams of up to a few hundred people.

Measured on an Apple-silicon laptop (2026-11-16, Node 24): about 140 MB of memory at rest; about 750 bytes of database per message for a 110-character message, search index included; about 6,000 messages written per second through the same code path the API uses.

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

