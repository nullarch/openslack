// A small agent built with the official Bolt SDK. Nothing here is specific to
// this server except API_URL: point it at Slack instead and it runs there too.
//
//   BOT_TOKEN=xoxb-… APP_TOKEN=xapp-… node app.mjs
//
// Mention the bot in a channel it belongs to. It shows a status, reads recent
// messages, streams a Markdown answer into the thread and ends with buttons.
// It also answers the /hello slash command, once that command is registered
// for the app.
import bolt from '@slack/bolt';

const { App } = bolt;
const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/';

const app = new App({
  token: process.env.BOT_TOKEN,
  appToken: process.env.APP_TOKEN,
  socketMode: true,
  clientOptions: { slackApiUrl: API_URL },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.event('app_mention', async ({ event, client }) => {
  const thread_ts = event.thread_ts ?? event.ts;
  await client.assistant.threads.setStatus({ channel_id: event.channel, thread_ts, status: 'is reading the channel…' });

  const history = await client.conversations.history({ channel: event.channel, limit: 50 });
  const messages = (history.messages ?? []).filter((message) => !message.subtype);
  const people = new Set(messages.map((message) => message.user).filter(Boolean));
  await sleep(700);

  const minutesAgo = Math.max(0, Math.round((Date.now() / 1000 - Number(messages[0]?.ts ?? 0)) / 60));
  const answer = [
    'Here is what I can see.\n\n',
    '**Recent activity**\n\n',
    `- ${messages.length} messages from ${people.size} people in the last 50 entries\n`,
    `- the newest one was posted ${minutesAgo} minute${minutesAgo === 1 ? '' : 's'} ago\n\n`,
    '**How this works**\n\n',
    '1. An ordinary Bolt app received an `app_mention` event over Socket Mode.\n',
    '2. It called `conversations.history`, then streamed this reply with `chat.startStream`.\n',
    '3. The buttons below arrive back as a `block_actions` payload.\n\n',
    '```js\nclientOptions: { slackApiUrl: "' + API_URL + '" }\n```\n',
  ].join('');

  const streamer = client.chatStream({
    channel: event.channel,
    thread_ts,
    recipient_team_id: event.team,
    recipient_user_id: event.user,
  });
  // Stream word by word, the way a model's output arrives.
  for (const piece of answer.match(/\S+\s*|\s+/g) ?? []) {
    await streamer.append({ markdown_text: piece });
    await sleep(25);
  }
  await streamer.stop({
    blocks: [
      {
        type: 'actions',
        block_id: 'next_step',
        elements: [
          { type: 'button', action_id: 'approve', style: 'primary', text: { type: 'plain_text', text: 'Looks right' }, value: 'approve' },
          { type: 'button', action_id: 'dismiss', text: { type: 'plain_text', text: 'Dismiss' }, value: 'dismiss' },
        ],
      },
    ],
  });
});

app.action('approve', async ({ ack, body, client }) => {
  await ack();
  await client.chat.postMessage({
    channel: body.channel.id,
    thread_ts: body.message.thread_ts ?? body.message.ts,
    text: `:white_check_mark: Confirmed by <@${body.user.id}>.`,
  });
});

app.action('dismiss', async ({ ack, respond }) => {
  await ack();
  await respond({ delete_original: true });
});

// A slash command: acknowledge to the person who ran it (only they see that),
// then answer in the channel through the command's response URL.
app.command('/hello', async ({ command, ack, respond }) => {
  await ack(`On it, <@${command.user_id}>.`);
  const about = command.text ? ` about “${command.text}”` : '';
  await respond({ response_type: 'in_channel', text: `:wave: Hello from the agent${about}. <@${command.user_id}> asked.` });
});

await app.start();
console.log(`hello-agent is connected to ${API_URL}`);
