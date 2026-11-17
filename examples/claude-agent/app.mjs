// A teammate backed by Claude, written with the official Bolt and Anthropic SDKs.
// Mention it in a channel (or message it directly) and it reads the
// conversation, then streams a Markdown answer into the thread.
//
//   BOT_TOKEN=xoxb-… APP_TOKEN=xapp-… node app.mjs
//
// Claude credentials are resolved by the Anthropic SDK: ANTHROPIC_API_KEY,
// ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile. API_URL is the only
// setting that points the app at this server instead of Slack.
import Anthropic from '@anthropic-ai/sdk';
import bolt from '@slack/bolt';

const { App } = bolt;
const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/';
const MODEL = process.env.MODEL ?? 'claude-opus-5-5';
const HISTORY_LIMIT = 40;

const SYSTEM = `You are a helpful teammate in a team chat workspace.
People mention you in channels and threads, or message you directly.
You see the recent conversation as a transcript; the last line is the request addressed to you.
Answer the request directly, in the language it was written in, using Markdown.
Keep answers as short as the request allows: a sentence or a few bullet points for most questions, more only when someone asks for detail.
When you refer to something said earlier, name who said it.
If the transcript does not contain what you need, say what is missing rather than guessing.`;

const app = new App({
  token: process.env.BOT_TOKEN,
  appToken: process.env.APP_TOKEN,
  socketMode: true,
  clientOptions: { slackApiUrl: API_URL },
});
const claude = new Anthropic();

/** Display names, looked up once per person. */
const names = new Map();
async function nameOf(client, userId) {
  if (!userId) return 'someone';
  if (!names.has(userId)) {
    try {
      const { user } = await client.users.info({ user: userId });
      names.set(userId, user?.profile?.display_name || user?.real_name || user?.name || userId);
    } catch {
      names.set(userId, userId);
    }
  }
  return names.get(userId);
}

/** Replace <@U…> mentions with readable names. */
async function readable(client, text) {
  const ids = [...new Set([...(text ?? '').matchAll(/<@([A-Z0-9]+)>/g)].map((match) => match[1]))];
  let out = text ?? '';
  for (const id of ids) out = out.replaceAll(`<@${id}>`, `@${await nameOf(client, id)}`);
  return out;
}

/** The conversation the request belongs to: the thread if there is one, otherwise recent channel history. */
async function transcript(client, channel, threadTs) {
  const result = threadTs
    ? await client.conversations.replies({ channel, ts: threadTs, limit: HISTORY_LIMIT })
    : await client.conversations.history({ channel, limit: HISTORY_LIMIT });
  const messages = (result.messages ?? []).filter((message) => !message.subtype || message.subtype === 'bot_message');
  if (!threadTs) messages.reverse(); // history comes newest first
  const lines = [];
  for (const message of messages) {
    const who = message.bot_id && message.user === botUserId ? 'you' : await nameOf(client, message.user);
    lines.push(`${who}: ${await readable(client, message.text)}`);
  }
  return lines.join('\n');
}

let botUserId = '';

async function answer({ client, channel, threadTs, replyTo, user, team }) {
  const thread_ts = threadTs ?? replyTo;
  await client.assistant.threads.setStatus({ channel_id: channel, thread_ts, status: 'is thinking…' }).catch(() => undefined);

  const context = await transcript(client, channel, threadTs);
  const streamer = client.chatStream({ channel, thread_ts, recipient_team_id: team, recipient_user_id: user });

  try {
    // Server-side fallback: if a request is declined, the API retries it on
    // another model inside the same call instead of returning a refusal.
    const stream = claude.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content: `Conversation so far:\n\n${context}` }],
    });

    // Send text as it arrives, in small batches so the reply grows smoothly.
    let pending = '';
    let lastFlush = Date.now();
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        pending += event.delta.text;
        if (Date.now() - lastFlush > 150 && pending) {
          await streamer.append({ markdown_text: pending });
          pending = '';
          lastFlush = Date.now();
        }
      }
    }
    if (pending) await streamer.append({ markdown_text: pending });

    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') {
      await streamer.append({ markdown_text: "\n\nI can't help with that one." });
    } else if (message.stop_reason === 'max_tokens') {
      await streamer.append({ markdown_text: '\n\n_(The answer was cut off at the length limit.)_' });
    }
    await streamer.stop();
  } catch (error) {
    const reason =
      error instanceof Anthropic.AuthenticationError
        ? 'no valid Claude credentials are configured'
        : error instanceof Anthropic.RateLimitError
          ? 'the Claude API is rate limiting this app; try again shortly'
          : error instanceof Anthropic.APIError
            ? `the Claude API returned ${error.status}`
            : 'something went wrong';
    console.error(error);
    await streamer.append({ markdown_text: `Sorry, I could not answer: ${reason}.` }).catch(() => undefined);
    await streamer.stop().catch(() => undefined);
  }
}

app.event('app_mention', async ({ event, client }) => {
  await answer({ client, channel: event.channel, threadTs: event.thread_ts, replyTo: event.ts, user: event.user, team: event.team });
});

// Direct messages need no mention.
app.message(async ({ message, client }) => {
  if (message.channel_type !== 'im' || message.subtype || message.bot_id) return;
  await answer({ client, channel: message.channel, threadTs: message.thread_ts, replyTo: message.ts, user: message.user, team: message.team });
});

await app.start();
botUserId = (await app.client.auth.test()).user_id ?? '';
console.log(`claude-agent is connected to ${API_URL} (model ${MODEL})`);
