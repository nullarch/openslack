# CLAUDE.md

Open-source, self-hosted team chat that speaks the Slack API. Private repository `nullarch/openslack` until 0.1 runs.

Read first: `PROGRESS.md` (where things stand), `docs/ARCHITECTURE.md` (structure and contracts), `PRD.md` (scope and phases). `TODO.html` is the owner's task board.

## Commands

```
pnpm install
pnpm dev                 # server :3000 (watch) + web dev server :5173
pnpm test                # node:test, all packages
pnpm typecheck
pnpm build               # web client → apps/web/dist, served by the server
SEED_DEMO=1 pnpm start   # sample workspace: maya@example.com / demo-password
```

Run one server test file: `cd apps/server && node --test test/core.test.ts`.

## Conventions

- All code, comments and documentation in English.
- The server runs TypeScript directly on Node (type stripping): no `enum`, no parameter properties, no namespaces; relative imports end in `.ts`.
- The product name appears only in `packages/shared/src/brand.ts`. Do not put it, or "slack", in identifiers, table names, environment variables or package names. The compatibility surface is the exception: API method names, `xox*-` token prefixes, `X-Slack-*` headers.
- Follow Slack's published API shapes exactly: method names, arguments, fields, error strings. Check `docs.slack.dev` rather than guessing. Methods Slack does not have go under `client.*`.
- Anything a caller may not see is "not found", never "forbidden".
- Every server behaviour change comes with a test in `apps/server/test` that goes through HTTP.
- Migrations are append-only (`apps/server/src/db/schema.ts`).
- No new runtime dependency on the server without a reason written in the commit message; the zero-install promise depends on it.
