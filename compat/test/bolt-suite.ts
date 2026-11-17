import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, describe, test } from 'node:test';
import {
  addMember,
  Session,
  setupWorkspace,
  startApp,
  type Json,
  type Stream,
  type TestApp,
} from '@app/server/test/helpers.ts';
import { createPlatformApp, type TestAppCredentials } from '@app/server/test/platform-helpers.ts';
import bolt from '@slack/bolt';
import { freePort, recordTokenCalls, saveExercised } from './harness.ts';

const { App, LogLevel } = bolt;
type BoltApp = InstanceType<typeof App>;

const require = createRequire(import.meta.url);
const version = (name: string): string => (require(`${name}/package.json`) as { version: string }).version;
const SDK = `@slack/bolt ${version('@slack/bolt')}, @slack/web-api ${version('@slack/web-api')}`;

const CHANNEL_TYPE_EVENT: Record<string, string> = {
  channel: 'message.channels',
  group: 'message.groups',
  im: 'message.im',
  mpim: 'message.mpim',
};

/**
 * An ordinary Bolt app, written the way the Bolt documentation writes them.
 * Nothing in it knows it is not talking to Slack.
 */
function registerListeners(app: BoltApp, delivered: Set<string>): void {
  // Note what reaches the app, for the compatibility table.
  app.use(async ({ body, next }) => {
    const payload = body as Json;
    if (payload.event) delivered.add(payload.event.type === 'message' ? CHANNEL_TYPE_EVENT[payload.event.channel_type]! : payload.event.type);
    else if (payload.command) delivered.add('slash_commands');
    else if (payload.type) delivered.add(payload.type);
    await next();
  });

  app.message('hello', async ({ message, say }) => {
    const sender = (message as Json).user;
    await say({ text: `Hey there <@${sender}>!`, thread_ts: message.ts });
  });

  app.event('app_mention', async ({ event, client }) => {
    await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'eyes' });
    const info = await client.users.info({ user: event.user! });
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `Deploy requested by ${info.user?.real_name}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*${info.user?.real_name}* asked for a deploy.` } },
        {
          type: 'actions',
          block_id: 'deploy',
          elements: [
            { type: 'button', action_id: 'approve', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, value: 'build-12' },
            { type: 'button', action_id: 'reject', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, value: 'build-12' },
          ],
        },
      ],
    });
  });

  app.action('approve', async ({ ack, respond, body, action }) => {
    await ack();
    await respond({ text: `Approved ${(action as Json).value} — thanks <@${body.user.id}>`, replace_original: true });
  });

  app.action('reject', async ({ ack, client, body }) => {
    await ack();
    const source = body as Json;
    await client.chat.update({ channel: source.channel.id, ts: source.message.ts, text: 'Rejected.', blocks: [] });
  });

  app.command('/echo', async ({ command, ack, respond }) => {
    await ack(`Echo: ${command.text}`);
    await respond({ response_type: 'in_channel', text: `<@${command.user_id}> said: ${command.text}` });
  });

  app.message(/report/, async ({ message, client }) => {
    await client.files.uploadV2({
      channel_id: message.channel,
      thread_ts: message.ts,
      filename: 'report.txt',
      title: 'Nightly report',
      content: 'All 1,205 tests passed.\n',
      initial_comment: 'Here is the report.',
    });
  });

  app.message(/summarise/, async ({ message, client, sayStream, setStatus }) => {
    await setStatus('is reading the channel…');
    const history = await client.conversations.history({ channel: message.channel, limit: 3 });
    const streamer = sayStream();
    await streamer.append({ markdown_text: `I read the last **${history.messages?.length}** messages. ` });
    await streamer.append({ markdown_text: 'Nothing is on fire.' });
    await streamer.stop();
  });

  app.event('reaction_added', async ({ event, client }) => {
    if (event.reaction !== 'question') return;
    await client.chat.postEphemeral({ channel: event.item.channel, user: event.user, text: 'Need a hand with that message?' });
  });

  // ── Modals, shortcuts, menus with external options, App Home, unfurls ──────

  app.shortcut('file_bug', async ({ ack, shortcut, client }) => {
    await ack();
    await client.views.open({ trigger_id: shortcut.trigger_id, view: bugModal() });
  });

  app.options('pick', async ({ ack, options }) => {
    const all = ['search', 'sessions', 'billing'];
    await ack({
      options: all
        .filter((name) => name.startsWith(String(options.value)))
        .map((name) => ({ text: { type: 'plain_text' as const, text: name }, value: name })),
    });
  });

  app.action({ action_id: 'add_details', type: 'block_actions' }, async ({ ack, body, client }) => {
    await ack();
    await client.views.push({
      trigger_id: (body as Json).trigger_id,
      view: {
        type: 'modal',
        callback_id: 'bug_details',
        title: { type: 'plain_text', text: 'Details' },
        submit: { type: 'plain_text', text: 'Add' },
        blocks: [{ type: 'input', block_id: 'steps', label: { type: 'plain_text', text: 'Steps' }, element: { type: 'plain_text_input', action_id: 'value', multiline: true } }],
      },
    });
  });

  app.view('bug_details', async ({ ack }) => {
    // A plain acknowledgement closes the pushed view and goes back to the form.
    await ack();
  });

  app.view('bug_form', async ({ ack, view, body, client }) => {
    const values = view.state.values;
    const title = values.title?.value?.value ?? '';
    if (title.length < 5) {
      await ack({ response_action: 'errors', errors: { title: 'Use at least five characters' } });
      return;
    }
    await ack({ response_action: 'clear' });
    const severity = values.severity?.choice?.selected_option?.value;
    const due = values.due?.date?.selected_date;
    const component = values.component?.pick?.selected_option?.value;
    const flags = (values.flags?.checks?.selected_options ?? []).map((option) => option.value).join('+');
    await client.chat.postMessage({
      channel: view.private_metadata,
      text: `Bug filed by <@${body.user.id}>: ${title} (${severity}, due ${due}, ${component}, ${flags})`,
    });
  });

  app.shortcut('quote_message', async ({ ack, shortcut, respond }) => {
    await ack();
    await respond({ text: `Quoted: ${(shortcut as Json).message.text}` });
  });

  app.action('pick_day', async ({ ack, action, respond }) => {
    await ack();
    await respond({ text: `Meeting moved to ${(action as Json).selected_date}`, replace_original: true });
  });

  app.event('app_home_opened', async ({ event, client }) => {
    if (event.tab !== 'home') return;
    await client.views.publish({ user_id: event.user, view: homeView(0) });
  });

  app.action('home_refresh', async ({ ack, body, client }) => {
    await ack();
    const view = (body as Json).view;
    const count = Number(view.private_metadata) + 1;
    await client.views.publish({ user_id: body.user.id, hash: view.hash, view: homeView(count) });
  });

  app.event('link_shared', async ({ event, client }) => {
    const unfurls: Record<string, Json> = {};
    for (const link of event.links) {
      unfurls[link.url] = { blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*${link.url.split('/').pop()}*: Search is slow` } }] };
    }
    await client.chat.unfurl({ channel: event.channel, ts: event.message_ts, unfurls });
  });
}

/** The channel bugs are filed into, carried in the modal's private metadata. */
let bugChannel = '';

function bugModal(): Json {
  return {
    type: 'modal',
    callback_id: 'bug_form',
    private_metadata: bugChannel,
    title: { type: 'plain_text', text: 'File a bug' },
    submit: { type: 'plain_text', text: 'File' },
    blocks: [
      { type: 'input', block_id: 'title', label: { type: 'plain_text', text: 'Title' }, element: { type: 'plain_text_input', action_id: 'value' } },
      {
        type: 'input',
        block_id: 'severity',
        label: { type: 'plain_text', text: 'Severity' },
        element: {
          type: 'static_select',
          action_id: 'choice',
          options: ['low', 'high'].map((value) => ({ text: { type: 'plain_text', text: value }, value })),
        },
      },
      { type: 'input', block_id: 'due', label: { type: 'plain_text', text: 'Due' }, element: { type: 'datepicker', action_id: 'date' } },
      { type: 'input', block_id: 'component', label: { type: 'plain_text', text: 'Component' }, element: { type: 'external_select', action_id: 'pick', min_query_length: 1 } },
      {
        type: 'input',
        block_id: 'flags',
        optional: true,
        label: { type: 'plain_text', text: 'Flags' },
        element: {
          type: 'checkboxes',
          action_id: 'checks',
          options: ['regression', 'customer'].map((value) => ({ text: { type: 'plain_text', text: value }, value })),
        },
      },
      { type: 'actions', block_id: 'more', elements: [{ type: 'button', action_id: 'add_details', text: { type: 'plain_text', text: 'Add details' } }] },
    ],
  };
}

function homeView(count: number): Json {
  return {
    type: 'home',
    private_metadata: String(count),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*Open bugs* — refreshed ${count} times` } },
      { type: 'actions', block_id: 'home', elements: [{ type: 'button', action_id: 'home_refresh', text: { type: 'plain_text', text: 'Refresh' } }] },
    ],
  };
}

/** Run the same Bolt app against a local server over Socket Mode or over HTTP. */
export function defineBoltSuite(transport: 'socket' | 'http'): void {
  describe(`an official Bolt for JavaScript app over ${transport === 'socket' ? 'Socket Mode' : 'HTTP'}`, () => {
    let t: TestApp;
    let owner: Session;
    let member: Session;
    let general: string;
    let creds: TestAppCredentials;
    let app: BoltApp;
    let stream: Stream;
    let called: Set<string>;
    const delivered = new Set<string>();

    before(async () => {
      t = await startApp();
      owner = await setupWorkspace(t);
      member = await addMember(t, owner, 'Mina Member');
      general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
      creds = await createPlatformApp(owner, 'Bolt Bot', { socket_mode: transport === 'socket' });
      await owner.ok('conversations.invite', { channel: general, users: creds.botUserId });
      bugChannel = general;
      await owner.ok('client.apps.update', {
        app: creds.id,
        shortcuts: [
          { type: 'global', name: 'File a bug', callback_id: 'file_bug' },
          { type: 'message', name: 'Quote', callback_id: 'quote_message' },
        ],
        unfurl_domains: 'tracker.example',
      });
      called = recordTokenCalls(t);

      // The only thing that differs from an app written for Slack: where the API lives.
      const clientOptions = { slackApiUrl: `${t.base}/api/` };
      if (transport === 'socket') {
        app = new App({ token: creds.botToken, appToken: creds.appToken, socketMode: true, clientOptions, logLevel: LogLevel.ERROR });
        registerListeners(app, delivered);
        await app.start();
        await owner.ok('client.apps.commands.set', { app: creds.id, command: '/echo', description: 'Say it back' });
      } else {
        app = new App({ token: creds.botToken, signingSecret: creds.signingSecret, clientOptions, logLevel: LogLevel.ERROR });
        registerListeners(app, delivered);
        const port = await freePort();
        await app.start(port);
        const url = `http://localhost:${port}/slack/events`;
        // Saving the URL performs the verification handshake against Bolt's receiver.
        await owner.ok('client.apps.update', { app: creds.id, events_url: url, interactivity_url: url });
        await owner.ok('client.apps.commands.set', { app: creds.id, command: '/echo', description: 'Say it back', url });
      }
      stream = await member.connect();
    });

    after(async () => {
      stream?.close();
      await app?.stop();
      // stop() does not wait for the WebSocket close handshake; give it a moment before the server goes away.
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (called) saveExercised(`bolt-js-${transport}`, SDK, called, delivered);
      await t?.close();
    });

    const fromBot = (match: (event: Json) => boolean): Promise<Json> =>
      stream.next((event) => event.type === 'message' && event.user === creds.botUserId && match(event), 5000);

    test('app.message with say(): a greeting is answered in a thread', async () => {
      const { ts } = await member.ok('chat.postMessage', { channel: general, text: 'hello bolt' });
      const reply = await fromBot((event) => event.thread_ts === ts);
      assert.equal(reply.text, `Hey there <@${member.userId}>!`);
      assert.equal(reply.bot_id, creds.botId);
    });

    test('a direct message reaches app.message as message.im', async () => {
      const { ts, channel } = await member.ok('chat.postMessage', { channel: creds.botUserId, text: 'hello in private' });
      const reply = await fromBot((event) => event.thread_ts === ts);
      assert.equal(reply.channel, channel);
      assert.equal(reply.channel_type, 'im');
    });

    let deployMessage = '';

    test('app.event(app_mention): reactions.add, users.info and chat.postMessage with blocks', async () => {
      const { ts } = await member.ok('chat.postMessage', { channel: general, text: `<@${creds.botUserId}> please deploy` });
      const reaction = await stream.next((event) => event.type === 'reaction_added' && event.item.ts === ts, 5000);
      assert.equal(reaction.user, creds.botUserId);
      assert.equal(reaction.reaction, 'eyes');
      const posted = await fromBot((event) => event.thread_ts === ts && Array.isArray(event.blocks));
      assert.equal(posted.text, 'Deploy requested by Mina Member');
      assert.equal(posted.blocks[1].elements[0].action_id, 'approve');
      deployMessage = posted.ts;
    });

    test('app.action with ack() and respond(): a click replaces the message', async () => {
      const clicked = await member.call('client.interactions.blockAction', {
        channel: general,
        message_ts: deployMessage,
        action: { action_id: 'approve', block_id: 'deploy' },
      });
      assert.deepEqual(clicked, { ok: true });
      const changed = await stream.next((event) => event.subtype === 'message_changed' && event.message.ts === deployMessage, 5000);
      assert.equal(changed.message.text, `Approved build-12 — thanks <@${member.userId}>`);
      assert.equal(changed.message.blocks, undefined);
    });

    test('app.action with chat.update: the other common way to answer a click', async () => {
      const { ts } = await member.ok('chat.postMessage', { channel: general, text: `<@${creds.botUserId}> deploy once more` });
      const posted = await fromBot((event) => event.thread_ts === ts && Array.isArray(event.blocks));
      await member.ok('client.interactions.blockAction', { channel: general, message_ts: posted.ts, action: { action_id: 'reject' } });
      const changed = await stream.next((event) => event.subtype === 'message_changed' && event.message.ts === posted.ts, 5000);
      assert.equal(changed.message.text, 'Rejected.');
    });

    test('app.command: ack(text) answers the person, respond() posts to the channel', async () => {
      assert.deepEqual(await member.call('client.commands.run', { channel: general, command: '/echo', text: 'ship it' }), { ok: true });
      const immediate = await stream.next((event) => event.is_ephemeral === true && event.text === 'Echo: ship it', 5000);
      assert.equal(immediate.user, creds.botUserId);
      const shared = await fromBot((event) => event.text === `<@${member.userId}> said: ship it`);
      assert.equal(shared.is_ephemeral, undefined);
    });

    test('client.files.uploadV2: the three-step upload ends as a message with a file', async () => {
      const { ts } = await member.ok('chat.postMessage', { channel: general, text: 'send the nightly report' });
      const shared = await fromBot((event) => event.thread_ts === ts && Array.isArray(event.files));
      assert.equal(shared.text, 'Here is the report.');
      const file = shared.files[0];
      assert.equal(file.name, 'report.txt');
      assert.equal(file.title, 'Nightly report');
      const download = await fetch(`${t.base}${new URL(file.url_private).pathname}`, { headers: { cookie: member.cookie } });
      assert.equal(await download.text(), 'All 1,205 tests passed.\n');
    });

    test('setStatus(), conversations.history and sayStream(): a streamed answer', async () => {
      const { ts } = await member.ok('chat.postMessage', { channel: general, text: 'summarise the channel' });
      const status = await stream.next((event) => event.type === 'assistant_thread_status' && event.thread_ts === ts, 5000);
      assert.equal(status.status, 'is reading the channel…');
      const final = await stream.next(
        (event) => event.subtype === 'message_changed' && event.message.thread_ts === ts && !event.message.streaming,
        5000,
      );
      assert.equal(final.message.text, 'I read the last **3** messages. Nothing is on fire.');
      assert.deepEqual(final.message.blocks, [{ type: 'markdown', text: 'I read the last **3** messages. Nothing is on fire.' }]);
      assert.equal(final.message.user, creds.botUserId);
    });

    test('app.event(reaction_added) with chat.postEphemeral', async () => {
      const { ts } = await owner.ok('chat.postMessage', { channel: general, text: 'what does this error mean' });
      await member.ok('reactions.add', { channel: general, timestamp: ts, name: 'question' });
      const hint = await stream.next((event) => event.is_ephemeral === true && event.text === 'Need a hand with that message?', 5000);
      assert.equal(hint.channel, general);
    });

    test('the Web API client: reading, writing and paginating with typed methods', async () => {
      const { client } = app;
      const auth = await client.auth.test();
      assert.equal(auth.user_id, creds.botUserId);
      assert.equal(auth.bot_id, creds.botId);

      const team = await client.team.info();
      assert.equal(team.team?.name, 'Acme');
      const users = await client.users.list({});
      assert.ok(users.members?.some((user) => user.id === member.userId && user.real_name === 'Mina Member'));
      assert.equal((await client.users.lookupByEmail({ email: 'mina.member@acme.test' })).user?.id, member.userId);
      assert.equal((await client.bots.info({ bot: creds.botId })).bot?.user_id, creds.botUserId);
      assert.deepEqual((await client.emoji.list()).emoji, {});

      const created = await client.conversations.create({ name: 'bolt-made-this' });
      const channel = created.channel!.id!;
      await client.conversations.invite({ channel, users: member.userId });
      await client.conversations.setTopic({ channel, topic: 'Made by a bot' });
      const info = await client.conversations.info({ channel, include_num_members: true });
      assert.equal(info.channel?.topic?.value, 'Made by a bot');
      assert.equal(info.channel?.num_members, 2);
      assert.deepEqual((await client.conversations.members({ channel })).members?.sort(), [creds.botUserId, member.userId].sort());
      const mine = await client.users.conversations({ types: 'public_channel,private_channel' });
      assert.ok(mine.channels?.some((entry) => entry.id === channel));
      assert.ok((await client.conversations.list({ limit: 200 })).channels?.some((entry) => entry.name === 'bolt-made-this'));

      const sent: string[] = [];
      for (let i = 1; i <= 5; i += 1) sent.push((await client.chat.postMessage({ channel, text: `line ${i}` })).ts!);
      // Cursor pagination, driven by the SDK's own paginator.
      const pages: string[][] = [];
      for await (const page of client.paginate('conversations.history', { channel, limit: 2 })) {
        pages.push(((page as Json).messages as Json[]).map((message) => message.text));
      }
      assert.deepEqual(pages.flat().filter((text) => text.startsWith('line')), ['line 5', 'line 4', 'line 3', 'line 2', 'line 1']);
      assert.ok(pages.length >= 3);

      const updated = await client.chat.update({ channel, ts: sent[0]!, text: 'line one, edited' });
      assert.equal(updated.text, 'line one, edited');
      await client.chat.postMessage({ channel, thread_ts: sent[0]!, text: 'a reply' });
      const thread = await client.conversations.replies({ channel, ts: sent[0]! });
      assert.deepEqual(thread.messages?.map((message) => message.text), ['line one, edited', 'a reply']);
      assert.equal(thread.messages?.[0]?.reply_count, 1);

      await client.reactions.add({ channel, timestamp: sent[1]!, name: 'tada' });
      const reactions = await client.reactions.get({ channel, timestamp: sent[1]! });
      assert.deepEqual(reactions.message?.reactions, [{ name: 'tada', users: [creds.botUserId], count: 1 }]);
      await client.reactions.remove({ channel, timestamp: sent[1]!, name: 'tada' });
      await client.pins.add({ channel, timestamp: sent[2]! });
      assert.equal(((await client.pins.list({ channel })) as Json).items[0].message.text, 'line 3');
      await client.pins.remove({ channel, timestamp: sent[2]! });
      assert.match((await client.chat.getPermalink({ channel, message_ts: sent[3]! })).permalink!, /\/archives\/C[A-Z0-9]+\/p\d{16}$/);
      await client.chat.delete({ channel, ts: sent[4]! });

      const dm = await client.conversations.open({ users: member.userId });
      await client.chat.postMessage({ channel: dm.channel!.id!, text: 'a direct message from the bot' });
      await fromBot((event) => event.text === 'a direct message from the bot');

      const found = await client.search.messages({ query: 'line one, edited' });
      assert.equal(found.messages?.total, 1);

      // Errors arrive the way the SDK expects: HTTP 200, ok false, an error code.
      await assert.rejects(client.chat.postMessage({ channel: 'C0NOTHERE00', text: 'x' }), (error: Json) => {
        assert.equal(error.code, 'slack_webapi_platform_error');
        assert.equal(error.data.error, 'channel_not_found');
        return true;
      });
      await assert.rejects(client.apiCall('admin.barriers.list', {}), (error: Json) => error.data.error === 'unknown_method');
      await assert.rejects(client.views.open({ trigger_id: '1.2.abc', view: { type: 'modal', title: { type: 'plain_text', text: 'x' }, blocks: [] } }), (error: Json) => error.data.error === 'invalid_trigger_id');
      await client.conversations.archive({ channel });
    });

    test('canvases and lists through the typed methods: create, edit by section, share, look up; items created, updated, listed, exported', async () => {
      const { client } = app;
      const created = await client.canvases.create({
        title: 'Release notes',
        document_content: { type: 'markdown', markdown: '# Release notes\n\n## Fixed\n\n- Login\n\n## Known issues\n\nNone yet.' },
      });
      const canvasId = created.canvas_id!;
      const headers = await client.canvases.sections.lookup({ canvas_id: canvasId, criteria: { section_types: ['h2'] } });
      assert.equal(headers.sections?.length, 2);
      const known = await client.canvases.sections.lookup({ canvas_id: canvasId, criteria: { contains_text: 'None yet' } });
      await client.canvases.edit({
        canvas_id: canvasId,
        changes: [
          { operation: 'insert_after', section_id: headers.sections![0]!.id!, document_content: { type: 'markdown', markdown: '- Search is faster' } },
          { operation: 'replace', section_id: known.sections![0]!.id!, document_content: { type: 'markdown', markdown: `Ask ![](@${member.userId}).` } },
          { operation: 'insert_at_end', document_content: { type: 'markdown', markdown: '---\n\n**Shipped** with [docs](https://example.com/docs).' } },
        ],
      });
      await assert.rejects(client.canvases.edit({ canvas_id: canvasId, changes: [{ operation: 'delete', section_id: 'temp:C:NOPE' }] }), (error: Json) => error.data.error === 'canvas_editing_failed');
      assert.match((await client.canvases.getContent({ canvas_id: canvasId })).content!, /^# Release notes\n\n## Fixed/);
      assert.match((await client.canvases.getContent({ canvas_id: canvasId, content_type: 'html' })).content!, /<h2>Fixed<\/h2>/);
      assert.equal((await member.call('canvases.getContent', { canvas_id: canvasId })).error, 'canvas_not_found');
      await client.canvases.access.set({ canvas_id: canvasId, access_level: 'read', user_ids: [member.userId] });
      const content: string = (await member.ok('canvases.getContent', { canvas_id: canvasId })).content;
      assert.match(content, /## Fixed\n\n- Search is faster\n\n- Login/);
      assert.match(content, new RegExp(`Ask !\\[\\]\\(@${member.userId}\\)\\.`));
      assert.match(content, /\*\*Shipped\*\* with \[docs\]\(https:\/\/example\.com\/docs\)\.$/);
      await client.canvases.access.delete({ canvas_id: canvasId, user_ids: [member.userId] });
      assert.equal((await member.call('client.canvases.info', { canvas_id: canvasId })).error, 'canvas_not_found');
      const channelCanvas = await client.conversations.canvases.create({ channel_id: general, document_content: { type: 'markdown', markdown: 'How we work here' } });
      assert.equal((await member.ok('client.canvases.info', { canvas_id: channelCanvas.canvas_id })).canvas.access_level, 'write');
      await assert.rejects(client.conversations.canvases.create({ channel_id: general }), (error: Json) => error.data.error === 'channel_canvas_already_exists');
      await client.canvases.delete({ canvas_id: canvasId });
      await assert.rejects(client.canvases.sections.lookup({ canvas_id: canvasId, criteria: { contains_text: 'x' } }), (error: Json) => error.data.error === 'canvas_not_found');

      const list = await client.slackLists.create({
        name: 'Bugs',
        schema: [
          { key: 'title', name: 'Bug', type: 'text', is_primary_column: true },
          { key: 'status', name: 'Status', type: 'select', options: { choices: [{ value: 'open', label: 'Open', color: 'red' }, { value: 'fixed', label: 'Fixed', color: 'green' }] } },
          { key: 'owner', name: 'Owner', type: 'user' },
          { key: 'due', name: 'Due', type: 'date' },
        ],
      });
      const listId = list.list_id!;
      const columns = (list as Json).list_metadata.schema as Json[];
      const column = (key: string): string => columns.find((entry) => entry.key === key).id;
      const title = (text: string): Json => [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }] }];
      const first = await client.slackLists.items.create({
        list_id: listId,
        initial_fields: [
          { column_id: column('title'), rich_text: title('Login button does nothing') },
          { column_id: column('status'), select: ['open'] },
          { column_id: column('due'), date: ['2026-12-01'] },
        ],
      });
      const itemId = (first as Json).item.id;
      await client.slackLists.items.create({ list_id: listId, initial_fields: [{ column_id: column('title'), rich_text: title('Slow search') }] });
      await client.slackLists.items.update({
        list_id: listId,
        cells: [
          { row_id: itemId, column_id: column('status'), select: ['fixed'] },
          { row_id: itemId, column_id: column('owner'), user: [member.userId] },
        ],
      });
      const info = await client.slackLists.items.info({ list_id: listId, id: itemId });
      const fields = Object.fromEntries(((info as Json).record.fields as Json[]).map((field) => [field.key, field]));
      assert.deepEqual(fields.status.select, ['fixed']);
      assert.deepEqual(fields.owner.user, [member.userId]);
      assert.ok(!(await member.ok('client.activity.list', {})).items.some((entry: Json) => entry.type === 'list_assigned'), 'the member cannot open the list yet, so nothing is announced');
      await client.slackLists.access.set({ list_id: listId, access_level: 'write', user_ids: [member.userId] });
      const listed = await client.slackLists.items.list({ list_id: listId, limit: 1 });
      assert.equal(listed.items?.length, 1);
      assert.ok(listed.response_metadata?.next_cursor);
      const job = await client.slackLists.download.start({ list_id: listId });
      const ready = await client.slackLists.download.get({ list_id: listId, job_id: job.job_id! });
      assert.equal(ready.status, 'COMPLETED');
      const csv = await (await fetch(ready.download_url!.replace(/^https?:\/\/[^/]+/, t.base))).text();
      assert.match(csv, /Bug,Status,Owner,Due\r\nLogin button does nothing,Fixed,Mina Member,2026-12-01\r\nSlow search,,,\r\n/);
      await client.slackLists.items.delete({ list_id: listId, id: itemId });
      await client.slackLists.access.delete({ list_id: listId, user_ids: [member.userId] });
      assert.equal((await member.call('slackLists.items.list', { list_id: listId })).error, 'list_not_found');
    });

    test('app.shortcut, views.open, app.options, views.push and app.view: a bug filed through a modal', async () => {
      await member.ok('client.shortcuts.run', { app: creds.id, callback_id: 'file_bug' });
      const opened = await stream.next((event) => event.type === 'view_stack' && event.stack[0]?.callback_id === 'bug_form', 5000);
      const view = opened.stack[0];
      assert.equal(view.title.text, 'File a bug');

      const options = await member.ok('client.views.suggest', { view_id: view.id, action_id: 'pick', block_id: 'component', value: 'se' });
      assert.deepEqual(options.options.map((option: Json) => option.value), ['search', 'sessions']);

      await member.ok('client.views.blockAction', { view_id: view.id, action: { action_id: 'add_details', block_id: 'more' } });
      const pushed = await stream.next((event) => event.type === 'view_stack' && event.stack.length === 2, 5000);
      assert.equal(pushed.stack[1].callback_id, 'bug_details');
      const back = await member.ok('client.views.submit', { view_id: pushed.stack[1].id, state: { values: { steps: { value: { type: 'plain_text_input', value: '1. search' } } } } });
      assert.deepEqual(back.stack.map((entry: Json) => entry.id), [view.id]);

      const values = (title: string): Json => ({
        title: { value: { type: 'plain_text_input', value: title } },
        severity: { choice: { type: 'static_select', selected_option: { value: 'high' } } },
        due: { date: { type: 'datepicker', selected_date: '2026-12-01' } },
        component: { pick: { type: 'external_select', selected_option: { text: { type: 'plain_text', text: 'search' }, value: 'search' } } },
        flags: { checks: { type: 'checkboxes', selected_options: [{ value: 'regression' }] } },
      });
      const refused = await member.ok('client.views.submit', { view_id: view.id, state: { values: values('Slow') } });
      assert.deepEqual(refused.errors, { title: 'Use at least five characters' });
      const filed = await member.ok('client.views.submit', { view_id: view.id, state: { values: values('Search is slow') } });
      assert.deepEqual(filed.stack, []);
      const message = await fromBot((event) => String(event.text).startsWith('Bug filed'));
      assert.equal(message.text, `Bug filed by <@${member.userId}>: Search is slow (high, due 2026-12-01, search, regression)`);
    });

    test('a message shortcut answered with respond()', async () => {
      const { ts } = await member.ok('chat.postMessage', { channel: general, text: 'The export button does nothing' });
      await member.ok('client.shortcuts.run', { app: creds.id, callback_id: 'quote_message', channel: general, message_ts: ts });
      const note = await stream.next((event) => event.is_ephemeral === true && event.text === 'Quoted: The export button does nothing', 5000);
      assert.equal(note.channel, general);
    });

    test('a datepicker on a message, answered with respond()', async () => {
      const posted = await app.client.chat.postMessage({
        channel: general,
        text: 'When should we meet?',
        blocks: [{ type: 'actions', block_id: 'when', elements: [{ type: 'datepicker', action_id: 'pick_day', initial_date: '2026-12-20' }] }],
      });
      await member.ok('client.interactions.blockAction', { channel: general, message_ts: posted.ts, action: { action_id: 'pick_day', selected_date: '2026-12-24' } });
      const changed = await stream.next((event) => event.subtype === 'message_changed' && event.message.ts === posted.ts, 5000);
      assert.equal(changed.message.text, 'Meeting moved to 2026-12-24');
    });

    test('App Home: app_home_opened, views.publish, and a Home tab action published again with its hash', async () => {
      await member.ok('client.apps.homeOpened', { app: creds.id, tab: 'home' });
      const first = await stream.next((event) => event.type === 'app_home' && event.app_id === creds.id, 5000);
      assert.match(first.view.blocks[0].text.text, /refreshed 0 times/);
      await member.ok('client.views.blockAction', { view_id: first.view.id, action: { action_id: 'home_refresh', block_id: 'home' } });
      const second = await stream.next((event) => event.type === 'app_home' && /refreshed 1 times/.test(event.view.blocks[0].text.text), 5000);
      assert.equal(second.view.id, first.view.id);
    });

    test('link_shared and chat.unfurl: the app attaches its preview to the message', async () => {
      const { ts } = await member.ok('chat.postMessage', { channel: general, text: 'see https://tracker.example/BUG-7' });
      const changed = await stream.next((event) => event.subtype === 'message_changed' && event.message.ts === ts && Array.isArray(event.message.attachments), 5000);
      const attachment = changed.message.attachments[0];
      assert.equal(attachment.app_unfurl_url, 'https://tracker.example/BUG-7');
      assert.equal(attachment.blocks[0].text.text, '*BUG-7*: Search is slow');
    });
  });
}
