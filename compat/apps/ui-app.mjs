// An ordinary Bolt app that uses the app surfaces a person sees: menus on a
// message, a global shortcut that opens a modal (with every kind of input), a
// message shortcut, an App Home tab and link unfurls. The browser test
// (apps/web/e2e/platform.mjs) drives it through the web client.
//
//   BOT_TOKEN=xoxb-… SIGNING_SECRET=… PORT=4000 API_URL=http://127.0.0.1:3000/api/ CHANNEL=C… node compat/apps/ui-app.mjs
//
// With APP_TOKEN set it uses Socket Mode instead of serving HTTP on PORT.
import bolt from '@slack/bolt';

const { App, LogLevel } = bolt;

const http = !process.env.APP_TOKEN;
const app = new App({
  token: process.env.BOT_TOKEN,
  ...(http ? { signingSecret: process.env.SIGNING_SECRET } : { appToken: process.env.APP_TOKEN, socketMode: true }),
  clientOptions: { slackApiUrl: process.env.API_URL },
  logLevel: LogLevel.ERROR,
});

const option = (value) => ({ text: { type: 'plain_text', text: value }, value });
const COMPONENTS = ['search', 'sessions', 'billing', 'exports'];

app.event('app_mention', async ({ event, client }) => {
  if (!/menu/.test(event.text)) return;
  await client.chat.postMessage({
    channel: event.channel,
    text: 'Deploy settings',
    blocks: [
      {
        type: 'section',
        block_id: 'env',
        text: { type: 'mrkdwn', text: '*Deploy settings*\nWhere should build 1482 go?' },
        accessory: { type: 'static_select', action_id: 'pick_env', placeholder: { type: 'plain_text', text: 'Environment' }, options: ['staging', 'production'].map(option) },
      },
      {
        type: 'actions',
        block_id: 'more',
        elements: [
          {
            type: 'overflow',
            action_id: 'more_actions',
            options: ['archive', 'snooze'].map(option),
            confirm: {
              title: { type: 'plain_text', text: 'Are you sure?' },
              text: { type: 'plain_text', text: 'This changes the message for everyone.' },
              confirm: { type: 'plain_text', text: 'Go ahead' },
              deny: { type: 'plain_text', text: 'Stop' },
            },
          },
        ],
      },
    ],
  });
});

app.action('pick_env', async ({ ack, action, respond }) => {
  await ack();
  await respond({ response_type: 'in_channel', replace_original: false, text: `Environment set to ${action.selected_option.value}` });
});

app.action('more_actions', async ({ ack, action, respond }) => {
  await ack();
  await respond({ replace_original: true, text: `Deploy settings: ${action.selected_option.value}d` });
});

app.shortcut('file_bug', async ({ ack, shortcut, client }) => {
  await ack();
  await client.views.open({
    trigger_id: shortcut.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'bug_form',
      private_metadata: process.env.CHANNEL ?? '',
      title: { type: 'plain_text', text: 'File a bug' },
      submit: { type: 'plain_text', text: 'File' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'input', block_id: 'title', label: { type: 'plain_text', text: 'Title' }, element: { type: 'plain_text_input', action_id: 'value', placeholder: { type: 'plain_text', text: 'What went wrong?' } } },
        { type: 'input', block_id: 'severity', label: { type: 'plain_text', text: 'Severity' }, element: { type: 'static_select', action_id: 'choice', options: ['low', 'high'].map(option) } },
        { type: 'input', block_id: 'due', label: { type: 'plain_text', text: 'Fix by' }, element: { type: 'datepicker', action_id: 'date', initial_date: '2026-12-01' } },
        { type: 'input', block_id: 'component', label: { type: 'plain_text', text: 'Component' }, element: { type: 'external_select', action_id: 'pick', min_query_length: 1, placeholder: { type: 'plain_text', text: 'Find a component' } } },
        { type: 'input', block_id: 'owner', optional: true, label: { type: 'plain_text', text: 'Owner' }, element: { type: 'users_select', action_id: 'user' } },
        {
          type: 'input',
          block_id: 'flags',
          optional: true,
          label: { type: 'plain_text', text: 'Flags' },
          hint: { type: 'plain_text', text: 'Anything that raises the priority.' },
          element: { type: 'checkboxes', action_id: 'checks', options: ['regression', 'customer'].map(option) },
        },
        { type: 'actions', block_id: 'more', elements: [{ type: 'button', action_id: 'add_details', text: { type: 'plain_text', text: 'Add steps' } }] },
      ],
    },
  });
});

app.options('pick', async ({ ack, options }) => {
  await ack({ options: COMPONENTS.filter((name) => name.startsWith(options.value)).map(option) });
});

app.action('add_details', async ({ ack, body, client }) => {
  await ack();
  await client.views.push({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'bug_steps',
      title: { type: 'plain_text', text: 'Steps' },
      submit: { type: 'plain_text', text: 'Add' },
      blocks: [{ type: 'input', block_id: 'steps', label: { type: 'plain_text', text: 'How to reproduce' }, element: { type: 'plain_text_input', action_id: 'value', multiline: true } }],
    },
  });
});

app.view('bug_steps', async ({ ack }) => {
  await ack();
});

app.view('bug_form', async ({ ack, view, body, client }) => {
  const values = view.state.values;
  const title = values.title.value.value ?? '';
  if (title.length < 5) {
    await ack({ response_action: 'errors', errors: { title: 'Use at least five characters' } });
    return;
  }
  await ack({ response_action: 'clear' });
  const owner = values.owner.user.selected_user;
  const flags = (values.flags.checks.selected_options ?? []).map((entry) => entry.value).join(', ') || 'none';
  await client.chat.postMessage({
    channel: view.private_metadata,
    text: `Bug filed by <@${body.user.id}>: ${title} · ${values.severity.choice.selected_option.value} · fix by ${values.due.date.selected_date} · ${values.component.pick.selected_option.value} · flags: ${flags}${owner ? ` · owner <@${owner}>` : ''}`,
  });
});

app.shortcut('quote_message', async ({ ack, shortcut, respond }) => {
  await ack();
  await respond({ text: `Filed from the message: “${shortcut.message.text}”` });
});

function home(count) {
  return {
    type: 'home',
    private_metadata: String(count),
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Tracker' } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Open bugs:* 3 · refreshed ${count} times` } },
      { type: 'actions', block_id: 'home', elements: [{ type: 'button', action_id: 'home_refresh', style: 'primary', text: { type: 'plain_text', text: 'Refresh' } }] },
    ],
  };
}

app.event('app_home_opened', async ({ event, client }) => {
  if (event.tab !== 'home') return;
  await client.views.publish({ user_id: event.user, view: home(0) });
});

app.action('home_refresh', async ({ ack, body, client }) => {
  await ack();
  await client.views.publish({ user_id: body.user.id, hash: body.view.hash, view: home(Number(body.view.private_metadata) + 1) });
});

app.event('link_shared', async ({ event, client }) => {
  const unfurls = {};
  for (const link of event.links) {
    const id = link.url.split('/').pop();
    unfurls[link.url] = {
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*${id}* · Search is slow\nOpen · high · owner Daniel` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Tracker' }] },
      ],
    };
  }
  await client.chat.unfurl({ channel: event.channel, ts: event.message_ts, unfurls });
});

await app.start(http ? Number(process.env.PORT) : undefined);
console.log('READY');
