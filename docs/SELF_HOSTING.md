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

## Backup and restore

The data directory is the whole backup: `app.db` (SQLite, with `app.db-wal` and `app.db-shm` beside it while the server runs) and `files/`.

- Simplest: stop the server, copy the directory, start the server.
- Without stopping: `sqlite3 "$DATA_DIR/app.db" ".backup '/backups/app.db'"`, then copy `files/`.

To restore, put the directory back and start the server.

## Upgrading

Replace the package or image and restart. Schema migrations run automatically at start. Take a backup first; migrations only move forward.

## Importing from Slack

See the README. Run the import while the server is stopped, or restart the server afterwards so connected clients pick up the imported history.

## Size

A single process is meant for teams of up to a few hundred people.

Measured on an Apple-silicon laptop (2026-11-16, Node 24): about 140 MB of memory at rest; about 750 bytes of database per message for a 110-character message, search index included; about 6,000 messages written per second through the same code path the API uses.
