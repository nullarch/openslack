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

The data directory is the whole backup: `app.db` (SQLite, with `app.db-wal` and `app.db-shm` beside it while the server runs) and `files/`. With a bucket configured, back up the bucket as well.

- Simplest: stop the server, copy the directory, start the server.
- Without stopping: `sqlite3 "$DATA_DIR/app.db" ".backup '/backups/app.db'"`, then copy `files/`.

To restore, put the directory back and start the server.

## Upgrading

Replace the package or image and restart. Schema migrations run automatically at start. Take a backup first; migrations only move forward.

## Importing from Slack

See the README. Run the import while the server is stopped, or restart the server afterwards so connected clients pick up the imported history.

## Size

A single process is meant for teams of up to a few hundred people.

Measured on an Apple-silicon laptop (Node 24, client and server on the same machine):

| Measure | Result |
|---|---|
| Memory at rest | about 140 MB |
| Database per message (110 characters, search index included) | about 750 bytes |
| Messages written per second, through the same code path the API uses | about 6,000 |
| Delivery latency, 1,000 open connections (250 people), post to receipt | p95 11 ms, p99 12 ms |
| Delivery latency, 5,000 open connections (1,000 people) | p95 54 ms, p99 61 ms; 254 MB memory |

Reproduce the last two with `node apps/server/scripts/load-test.mjs [connections] [people] [messages]` (raise `ulimit -n` first).
