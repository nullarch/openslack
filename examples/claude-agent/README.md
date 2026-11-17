# claude-agent

A teammate backed by Claude, written with the official `@slack/bolt` and `@anthropic-ai/sdk` packages. Mention it in a channel, or message it directly: it reads the thread (or the channel's recent history), asks Claude, and streams a Markdown answer into the thread. The only setting that differs from running it on Slack is `API_URL`.

1. Open **Apps → New app** in the web client and copy the bot token (`xoxb-…`) and the app token (`xapp-…`). Invite the bot to a channel.
2. Make Claude credentials available: `ANTHROPIC_API_KEY`, or `ant auth login`.
3. Run it:

   ```bash
   pnpm install
   BOT_TOKEN=xoxb-… APP_TOKEN=xapp-… node app.mjs
   # API_URL defaults to http://localhost:3000/api/; MODEL defaults to claude-opus-5-5
   ```

The request uses the API's server-side fallback (`fallbacks: "default"`): if Claude declines a request, the API retries it on another model within the same call. Remove `betas` and `fallbacks` from `app.mjs` to turn that off.

`node smoke.mjs` checks the wiring end to end against a local server and a stand-in for the Claude API, so it costs nothing; it does not exercise a real model.
