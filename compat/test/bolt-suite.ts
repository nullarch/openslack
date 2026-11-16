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
      await assert.rejects(client.apiCall('views.open', { trigger_id: 'x' }), (error: Json) => error.data.error === 'unknown_method');
      await client.conversations.archive({ channel });
    });
  });
}
