# Push relay

Passes notifications from self-hosted servers to Apple (APNs) and Google (FCM) for the published native apps. A phone's push token works only with the credentials of whoever published the app, which a self-hosted server does not have; the project runs one relay that every server may use, or an organisation that publishes its own build of the apps runs its own.

- **Who may send.** A server signs each request with its own Ed25519 key, the same key and headers it uses towards other servers (`X-Federation-Server`, `X-Federation-Date`, `X-Federation-Signature`). The relay fetches that server's key from `<server>/federation/v1/server`, keeps it for an hour, and looks again once when a signature does not match (a new key). Servers on private addresses are refused unless `ALLOW_PRIVATE_SERVERS=1`; `ALLOWED_SERVERS` limits it to a list.
- **How much.** `RATE_LIMIT_PER_MINUTE` notifications per server (600 by default); at most 100 per request.
- **What it keeps.** Nothing. Notifications pass through; the answer tells the server which tokens Apple or Google no longer know (`unregistered`), and the server forgets them.

`POST /v1/push` with `{ "notifications": [{ "platform": "ios" | "android", "token", "title", "body", "collapse_id"?, "data"?: { "url", "server" } }] }` answers `{ "ok": true, "results": [{ "token", "ok", "error"? }] }`. `GET /healthz` says which transports are configured.

## Run

```bash
PORT=8080 \
APNS_KEY_ID=… APNS_TEAM_ID=… APNS_KEY_FILE=AuthKey.p8 APNS_TOPIC=<bundle id> \
FCM_SERVICE_ACCOUNT_FILE=service-account.json \
node src/main.ts
```

`APNS_ORIGIN` is `https://api.push.apple.com` by default (use `https://api.sandbox.push.apple.com` for development builds). No dependencies beyond Node 24.

Servers point at it with `PUSH_RELAY_URL=https://relay.example.org`.

## Tests

`pnpm test`: a signed request reaches stand-ins for Apple (HTTP/2, an ES256 bearer token Apple's check accepts) and Google (OAuth token, then FCM v1), unknown tokens come back `unregistered`, and unsigned, badly signed, malformed, too many and private-address requests are refused. `apps/server/test/native-push.test.ts` runs a real server through this relay.
