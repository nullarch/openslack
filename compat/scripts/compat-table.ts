import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '@app/server/src/app.ts';
import { SUBSCRIBABLE_EVENTS } from '@app/server/src/platform/dispatch.ts';
import { BRAND } from '@app/shared';
import { loadExercised } from '../test/harness.ts';

/**
 * Writes docs/COMPATIBILITY.md: every Web API method the official SDK knows,
 * marked by whether this server implements it and what verified it. The file
 * is the definition of "compatible"; nothing is claimed beyond it.
 *
 *   pnpm --filter ./compat test    # runs the SDK apps, records what they exercised
 *   pnpm --filter ./compat table   # regenerates the document
 */

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const sdkDir = dirname(require.resolve('@slack/web-api'));
const sdkVersion = (JSON.parse(readFileSync(join(sdkDir, '..', 'package.json'), 'utf8')) as { version: string }).version;

/** Every method name bound in the SDK's method table. */
function sdkMethods(): string[] {
  const source = readFileSync(join(sdkDir, 'methods.js'), 'utf8');
  const names = new Set<string>();
  for (const match of source.matchAll(/bind\w*\(this, '([^']+)'\)/g)) names.add(match[1]!);
  return [...names].sort();
}

/** Every method this server registers. */
async function serverMethods(): Promise<string[]> {
  const dataDir = mkdtempSync(join(tmpdir(), 'compat-table-'));
  const app = createApp({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    publicUrl: '',
    webDir: null,
    maxUploadBytes: 1024 * 1024,
    cookieSecure: false,
    version: 'table',
    quiet: true,
  });
  const names = app.registry.names();
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  return names;
}

/** The server's own HTTP tests, as text: a name quoted in them is a name they exercise. */
function serverTestSource(): string {
  const dir = join(root, 'apps/server/test');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.test.ts'))
    .map((file) => readFileSync(join(dir, file), 'utf8'))
    .join('\n');
}

/** Where a supported method knowingly differs from Slack. */
const NOTES: Record<string, string> = {
  'files.upload': 'The one-request upload Slack has retired; kept so existing scripts (`curl -F file=@…`) keep working. Multipart or `content`.',
  'rtm.start': 'Returns the URL plus people and the caller\'s conversations in a reduced form.',
  'admin.emoji.add': 'Takes `file_id` of an uploaded image instead of `url`. Browser session only.',
  'admin.emoji.addAlias': 'Browser session only.',
  'admin.emoji.remove': 'Browser session only.',
  'apps.connections.open': 'A bot token gets `missing_scope` rather than `not_allowed_token_type`.',
  'assistant.threads.setStatus': 'Shown to connected clients; cleared by the app’s next message in the thread or after two minutes.',
  'assistant.threads.setSuggestedPrompts': 'Delivered to connected clients; not stored.',
  'assistant.threads.setTitle': 'Delivered to connected clients; not stored.',
  'chat.postMessage': 'A bot may post to any public channel without joining (as with `chat:write.public`).',
  'chat.startStream': 'Streams may also start outside a thread; recipient ids are accepted but not required.',
  'chat.stopStream': '`session_status` is accepted and ignored.',
  'files.list': 'Cursor pagination only; `page` is ignored.',
  'search.messages': 'Bot tokens may search (Slack: user tokens only): public channels plus the bot’s conversations.',
  'users.setPhoto': 'Takes `file_id` of an uploaded image instead of image bytes.',
  'views.open': 'A person has one modal at a time: opening a new one replaces any modal they already had open.',
  'views.publish': 'Any app may publish a Home tab; there is no Home tab switch to enable first.',
  'chat.unfurl': 'Links are offered once a message is posted; `source: composer` is not supported. The app must have registered the link’s domain.',
  'search.files': 'Matches file names and titles, not contents. Bot tokens may search (public channels plus the bot’s conversations).',
  'search.all': '`posts` is always empty.',
  'dnd.info': 'Also allowed with `users:read`, so apps with the default bot scopes can check before notifying.',
  'dnd.teamInfo': 'Also allowed with `users:read`. Without `users`, reports everyone in the workspace.',
};

/** Interaction payload types, which are not Events API subscriptions. */
const PAYLOADS: [string, boolean, string][] = [
  ['block_actions', true, 'Buttons, menus and other elements on messages, including ephemeral ones'],
  ['slash_commands', true, 'Custom slash commands'],
  ['view_submission', true, 'Modal submissions, with `response_action` `errors`, `update`, `push` or `clear`'],
  ['view_closed', true, 'Sent when the view asked for `notify_on_close`; `is_cleared` when the whole modal was closed'],
  ['shortcut', true, 'Global shortcuts, which an admin declares on the app'],
  ['message_action', true, 'Message shortcuts, with a `response_url` into the conversation'],
  ['block_suggestion', true, 'Options for `external_select` menus in messages, modals and Home tabs'],
];

const mark = (value: boolean): string => (value ? '✓' : '');

async function main(): Promise<void> {
  const slack = sdkMethods();
  const ours = await serverMethods();
  const testSource = serverTestSource();
  const tested = { has: (name: string): boolean => testSource.includes(`'${name}'`) };
  const runs = loadExercised();
  const runKeys = Object.keys(runs);
  if (runKeys.length === 0) throw new Error('No harness results. Run "pnpm --filter ./compat test" first.');

  const supported = slack.filter((name) => ours.includes(name));
  const missing = slack.filter((name) => !ours.includes(name));
  const firstParty = ours.filter((name) => !slack.includes(name));
  const bySdk = (name: string): boolean => runKeys.some((key) => runs[key]!.methods.includes(name));
  const deliveredTo = (name: string): boolean => runKeys.some((key) => runs[key]!.events.includes(name));

  const lines: string[] = [];
  const add = (...text: string[]): void => void lines.push(...text);

  add(
    '# Compatibility',
    '',
    '<!-- Generated by `pnpm --filter ./compat table`. Do not edit by hand. -->',
    '',
    `What "${BRAND.name} speaks the Slack API" means, exactly. An app written for Slack runs here when everything it uses is marked supported below. Nothing beyond this table is claimed.`,
    '',
    '## How this is verified',
    '',
    'The harness in `compat/` starts a server and runs apps built with the official SDKs against it. The apps are ordinary Bolt apps; the only setting that differs from running on Slack is the API base URL.',
    '',
    '| Run | SDK | Web API methods called | Payload types received |',
    '|---|---|---|---|',
  );
  for (const key of runKeys) {
    const run = runs[key]!;
    add(`| \`${key}\` | ${run.sdk} | ${run.methods.length} | ${run.events.length} |`);
  }
  add(
    '',
    '"SDK" in the tables below means at least one of these runs called the method, or received the payload, through an official SDK. "Server tests" means the server’s own tests exercise it over HTTP. A supported method with neither mark is implemented but not yet covered here.',
    '',
    'To point an app at this server:',
    '',
    '```js',
    "new App({ token, appToken, socketMode: true, clientOptions: { slackApiUrl: 'http://localhost:3000/api/' } });",
    '```',
    '',
    '```python',
    'App(client=WebClient(token=bot_token, base_url="http://localhost:3000/api/"))',
    '```',
    '',
    '## Transports',
    '',
    '| Transport | Status | Verified by |',
    '|---|---|---|',
    `| Socket Mode (\`apps.connections.open\`, envelopes, acknowledgements, redelivery) | Supported | ${runKeys.filter((key) => key.includes('socket')).map((key) => `\`${key}\``).join(', ')}, server tests |`,
    `| Events API over HTTP (URL verification, \`X-Slack-Signature\`, retries with \`X-Slack-Retry-Num\` / \`X-Slack-Retry-Reason\`) | Supported | ${runKeys.filter((key) => key.includes('http')).map((key) => `\`${key}\``).join(', ')}, server tests |`,
    '| Interactivity and slash commands over HTTP (signed, form-encoded) | Supported | SDK, server tests |',
    '| `response_url` (five uses within thirty minutes) | Supported | SDK, server tests |',
    '| Incoming webhooks (`/services/<team>/<bot>/<secret>`) | Supported | Server tests |',
    `| OAuth v2 installation flow (\`/oauth/v2/authorize\`, \`oauth.v2.access\`; bot and user scopes) | Supported; installs with a bot need an admin's approval. No token rotation | ${runKeys.filter((key) => key.includes('oauth')).map((key) => `\`${key}\``).join(', ')}, server tests |`,
    `| RTM (\`rtm.connect\`, \`rtm.start\`; \`message\`, \`typing\`, \`ping\`, \`presence_sub\` over the socket) | Supported, for older bots | ${runKeys.filter((key) => key.startsWith('rtm')).map((key) => `\`${key}\``).join(', ')}, server tests |`,
    '| Outgoing webhooks | Not supported | Use the Events API |',
    '',
    '## Events',
    '',
    'An app receives events for conversations its bot user belongs to, and workspace-wide events. An app that lists no `bot_events` receives every type below.',
    '',
    '| Event subscription | SDK | Server tests |',
    '|---|---|---|',
  );
  // Message subscriptions are tested through the `channel_type` they carry.
  const channelType: Record<string, string> = { 'message.channels': 'channel', 'message.groups': 'group', 'message.im': 'im', 'message.mpim': 'mpim' };
  for (const name of SUBSCRIBABLE_EVENTS) {
    const inTests = name in channelType ? testSource.includes(`channel_type, '${channelType[name]}'`) : tested.has(name);
    add(`| \`${name}\` | ${mark(deliveredTo(name))} | ${mark(inTests)} |`);
  }
  add('', 'Message events carry their subtypes (`message_changed`, `message_deleted`, `file_share`, `thread_broadcast`, `channel_join` and so on).', '');
  add('| Interaction payload | Status | SDK | Notes |', '|---|---|---|---|');
  for (const [name, ok, note] of PAYLOADS) {
    add(`| \`${name}\` | ${ok ? 'Supported' : 'Not supported'} | ${mark(deliveredTo(name))} | ${note} |`);
  }

  add(
    '',
    '## Web API methods',
    '',
    `Compared with the ${slack.length} methods in \`@slack/web-api\` ${sdkVersion}: **${supported.length} supported**, ${missing.length} not. A method that does not exist answers \`unknown_method\`, and the call is counted so admins can see what apps ask for.`,
    '',
    '| Method | SDK | Server tests | Differs from Slack |',
    '|---|---|---|---|',
  );
  for (const name of supported) add(`| \`${name}\` | ${mark(bySdk(name))} | ${mark(tested.has(name))} | ${NOTES[name] ?? ''} |`);
  add('', '`files.uploadV2` in the SDKs is a helper over `files.getUploadURLExternal` and `files.completeUploadExternal`; it works and is exercised by every run.', '');

  add('### Not supported', '');
  const families = new Map<string, string[]>();
  for (const name of missing) {
    const family = name.split('.')[0]!;
    families.set(family, [...(families.get(family) ?? []), name]);
  }
  add('| Family | Count | Methods |', '|---|---|---|');
  for (const [family, names] of [...families].sort(([a], [b]) => a.localeCompare(b))) {
    add(`| \`${family}\` | ${names.length} | ${names.map((name) => `\`${name}\``).join(', ')} |`);
  }

  add(
    '',
    '## Known differences in behaviour',
    '',
    '- **Mentions in public channels.** An `app_mention` reaches the app even when its bot has not joined the channel. Slack asks the person whether to invite the app first.',
    '- **Default subscriptions.** With no `bot_events` configured an app receives every event type it is entitled to. On Slack it receives none until events are subscribed.',
    '- **Socket Mode is the default** for a new app. Events over HTTP start once Socket Mode is switched off and a request URL passes verification.',
    '- **Scopes.** A new app’s bot token gets a broad fixed set of scopes; there is no per-app scope selection yet.',
    '- **`response_url` after an interaction on a message** replaces that message unless `replace_original` is `false`. This follows Slack’s documentation for message interactions; `response_url` state is kept in memory and does not survive a restart.',
    '- **Request URLs at private addresses** are refused unless the server itself runs on localhost or `ALLOW_PRIVATE_APP_URLS=1` is set.',
    '- **Streamed messages** are capped at 12,000 characters and ten minutes as on Slack. Connected clients see at most ten updates a second; apps receive the message when it starts and when it is final.',
    '- **Block ids.** Blocks posted without a `block_id` are reported in interaction payloads with a positional id (`b0`, `b1`, …) rather than a random one, and are stored as posted.',
    '- **Rate limits** exist (HTTP 429 with `Retry-After`) but are far more generous than Slack’s tiers.',
    '',
    '## First-party methods',
    '',
    `The web client uses the same API as apps, plus ${firstParty.length} methods Slack has no public equivalent for. They live under \`client.*\` and are not part of the compatibility surface.`,
    '',
  );

  writeFileSync(join(root, 'docs/COMPATIBILITY.md'), `${lines.join('\n')}\n`);
  console.log(`docs/COMPATIBILITY.md: ${supported.length} of ${slack.length} methods supported, ${firstParty.length} first-party`);
}

await main();
