# hello-agent

A 90-line agent written with the official `@slack/bolt` SDK. The only setting that differs from running it on Slack is the API address.

1. In the web client open **Apps → New app**, and copy the bot token (`xoxb-…`) and the app token (`xapp-…`).
2. Invite the app's bot to a channel.
3. Run it:

   ```bash
   pnpm install
   BOT_TOKEN=xoxb-… APP_TOKEN=xapp-… node app.mjs
   # API_URL defaults to http://localhost:3000/api/
   ```

4. Mention the bot in that channel. It sets a status, reads recent messages, streams a Markdown reply into the thread and ends with two buttons.
