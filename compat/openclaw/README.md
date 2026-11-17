# OpenClaw against this server

[OpenClaw](https://github.com/openclaw/openclaw) talks to Slack through its official `@openclaw/slack` plugin, which is built on `@slack/bolt`. The plugin reads `SLACK_API_URL`, so it can be pointed at this server without changing any OpenClaw code.

## Result

Checked by hand on 2026-11-17 with `openclaw` 2026.11.4 and `@openclaw/slack` 2026.11.4, Socket Mode, on macOS:

| Step | Result |
|---|---|
| `auth.test`, `apps.connections.open`, Socket Mode `hello` | The gateway logs `socket mode connected` |
| A person mentions the bot in a channel | The gateway logs `Inbound app_mention … -> bot:U…` |
| The plugin's "working on it" reactions | `eyes` and `hourglass_flowing_sand` appear on the message |
| The agent's reply | Posted to the channel; the gateway logs `delivered reply` |

The model behind the agent was a stand-in (`mock-llm.mjs`, an OpenAI-compatible server that always answers with one sentence), so the check covers the Slack side only.

Found and fixed along the way: app-level tokens did not carry their app's id. The plugin reads the id from `xapp-1-<app id>-…` and warns when it differs from `auth.test`.

Not checked: HTTP mode, slash commands (`/openclaw`), App Home, the Agents surfaces, files.

## Reproduce

OpenClaw needs Node.js 24.16 or newer. Use a separate state directory so an OpenClaw you already run is not touched, and a gateway port other than the default 18789.

1. Start this server, sign in, create an app on the Apps screen, invite its bot to a channel. Keep the `xoxb-` and `xapp-` tokens.
2. Start the stand-in model: `node mock-llm.mjs` (port 28000).
3. Install and configure OpenClaw in a throwaway home:

   ```bash
   export OPENCLAW_HOME=/tmp/oc-home HOME=/tmp/oc-home OPENCLAW_STATE_DIR=/tmp/oc-home/.openclaw
   npm install -g openclaw
   openclaw plugins install @openclaw/slack
   VLLM_API_KEY=local openclaw onboard --non-interactive --accept-risk --skip-health --mode local \
     --auth-choice vllm --custom-base-url http://127.0.0.1:28000/v1 --custom-api-key local --custom-model-id mock
   openclaw config patch --file slack.patch.json5
   ```

4. Start the gateway pointed at this server:

   ```bash
   SLACK_API_URL=http://localhost:3000/api/ SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… \
     VLLM_API_KEY=local openclaw gateway --port 28791
   ```

5. Mention the bot in the channel. With a real model configured instead of the stand-in, the reply is the model's.
