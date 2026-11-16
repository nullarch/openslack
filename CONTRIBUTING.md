# Contributing

Thanks for helping. This project aims to be a team chat that existing Slack apps can run against unchanged, with nothing held back behind a paid edition.

## Getting started

```
pnpm install
pnpm dev                 # server on :3000, web dev server on :5173
SEED_DEMO=1 pnpm start   # a sample workspace: maya@example.com / demo-password
pnpm test && pnpm typecheck
```

Node.js 22.18 or newer and pnpm are the only requirements. There is no database to install.

Read `docs/ARCHITECTURE.md` before a larger change; it explains the layout and the contracts between the server, the web client and apps.

## What makes a change easy to accept

- **It matches Slack's published API.** Method names, arguments, response fields and error strings come from `docs.slack.dev`. Link the page in your pull request.
- **It has a test that goes through HTTP** (`apps/server/test`), or for the client, a step in `apps/web/e2e`.
- **It is reachable through the API.** The web client uses the same endpoints as bots; a feature that only the client can use is unfinished.
- **It adds no feature gate.** There is no license key and no enterprise directory.
- **It keeps self-hosting simple.** A new required service or runtime dependency needs a strong reason.

## Compatibility reports

If a Slack app does not work against this server, open an issue with the SDK and version, the method or event involved, and what Slack returns versus what this server returns. `docs/COMPATIBILITY.md` lists what is supported today.

## Conduct

Be kind and assume good intent. Harassment or personal attacks are not tolerated; maintainers may remove comments and block accounts.

## License

By contributing you agree that your contribution is licensed under Apache-2.0, the license of this repository.
