import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, callWithToken, createBot, setupWorkspace, startApp, type Json, type Session, type Stream, type TestApp } from './helpers.ts';
import { createPlatformApp, sleep, SocketApp, type TestAppCredentials } from './platform-helpers.ts';

describe('code channels (agents.conversations.*)', () => {
  let t: TestApp;
  let owner: Session;
  let mina: Session;
  let otto: Session;
  let coder: TestAppCredentials;
  let helper: TestAppCredentials;
  let coderSocket: SocketApp;
  let helperSocket: SocketApp;
  let origin: string;
  let originTs: string;
  let channel: string;
  let watching: Stream;
  const as = (app: TestAppCredentials, method: string, args: Json = {}): Promise<Json> => callWithToken(t.base, app.botToken, method, args);
  const ok = async (app: TestAppCredentials, method: string, args: Json = {}): Promise<Json> => {
    const result = await as(app, method, args);
    if (!result.ok) throw new Error(`${method} failed: ${JSON.stringify(result)}`);
    return result;
  };
  const info = async (who: Session, id = channel): Promise<Json> => (await who.ok('conversations.info', { channel: id })).channel;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    mina = await addMember(t, owner, 'Mina Member');
    otto = await addMember(t, owner, 'Otto Outsider');
    origin = (await owner.ok('conversations.create', { name: 'builds', is_private: true })).channel.id;
    coder = await createPlatformApp(owner, 'Coder');
    helper = await createPlatformApp(owner, 'Helper');
    await owner.ok('conversations.invite', { channel: origin, users: `${mina.userId},${coder.botUserId}` });
    coderSocket = await SocketApp.connect(t.base, coder.appToken);
    helperSocket = await SocketApp.connect(t.base, helper.appToken);
    originTs = (await mina.ok('chat.postMessage', { channel: origin, text: '<@' + coder.botUserId + '> *Fix* the flaky login test. It fails on CI about once a day.\nLogs are in the build.' })).ts;
    watching = await mina.connect();
  });
  after(async () => {
    watching.close();
    coderSocket.close();
    helperSocket.close();
    await t.close();
  });

  test('an agent creates a code channel from a message: named after it, private like it, the author invited, a card in the thread', async () => {
    const joined = watching.next((event) => event.type === 'channel_joined' && event.channel.name === 'fix-the-flaky-login-test');
    const created = await ok(coder, 'agents.conversations.create', { origin_channel_id: origin, origin_message_ts: originTs, session_id: 'job-1' });
    channel = created.channel_id;
    assert.match(channel, /^C/);
    assert.equal((await joined).channel.id, channel, 'opened in the author’s sidebar');
    const conv = await info(mina);
    assert.deepEqual([conv.name, conv.is_private], ['fix-the-flaky-login-test', true]);
    assert.equal(conv.properties.record_channel.record_type, 'agent_channel');
    assert.deepEqual(conv.properties.agent_session, {
      status: 'active',
      encoded_agent_bot_user_ids: [coder.botUserId],
      title: 'Fix the flaky login test',
      origin_link: { channel_id: origin, ts: originTs },
    });
    assert.deepEqual(conv.properties.code_channel, { context_bar_items: [], agent_session_views: [] });
    const card = (await mina.ok('conversations.replies', { channel: origin, ts: originTs })).messages.at(-1);
    assert.deepEqual([card.text, card.bot_id], [`<#${channel}>`, coder.botId]);
    // The same session id is the same channel.
    assert.equal((await ok(coder, 'agents.conversations.create', { name: 'anything', session_id: 'job-1' })).channel_id, channel);
    assert.equal((await otto.call('conversations.info', { channel })).error, 'channel_not_found', 'private: not found for others');
  });

  test('create: a name without an origin, public by default; Slack’s errors', async () => {
    const named = await ok(coder, 'agents.conversations.create', { name: 'Upgrade Node' });
    const conv = await info(owner, named.channel_id);
    assert.deepEqual([conv.name, conv.is_private, conv.properties.agent_session.title], ['upgrade-node', false, 'Upgrade Node']);
    assert.equal((await ok(coder, 'agents.conversations.create', { name: 'Upgrade Node' })).channel_id !== named.channel_id, true);
    assert.equal((await info(owner, (await ok(coder, 'agents.conversations.create', { name: 'upgrade node' })).channel_id)).name, 'upgrade-node-3');
    assert.equal((await as(coder, 'agents.conversations.create', {})).error, 'name_or_origin_required');
    assert.equal((await as(coder, 'agents.conversations.create', { origin_channel_id: origin })).error, 'invalid_origin_link');
    assert.equal((await as(coder, 'agents.conversations.create', { origin_channel_id: origin, origin_message_ts: '1111111111.000001' })).error, 'invalid_origin_link');
    const dm = (await mina.ok('conversations.open', { users: coder.botUserId })).channel.id;
    const hello = await mina.ok('chat.postMessage', { channel: dm, text: 'can you look at this?' });
    assert.equal((await as(coder, 'agents.conversations.create', { origin_channel_id: dm, origin_message_ts: hello.ts })).error, 'origin_channel_externally_shared');
    const secret = (await owner.ok('conversations.create', { name: 'secret', is_private: true })).channel.id;
    const hidden = await owner.ok('chat.postMessage', { channel: secret, text: 'not for bots' });
    assert.equal((await as(coder, 'agents.conversations.create', { origin_channel_id: secret, origin_message_ts: hidden.ts })).error, 'invalid_origin_link', 'a channel the agent cannot see');
    const canvas = await ok(coder, 'canvases.create', { title: 'Notes' });
    assert.equal((await as(coder, 'agents.conversations.create', { origin_channel_id: canvas.canvas_id, origin_message_ts: originTs })).error, 'origin_channel_is_file_channel');
    assert.equal((await as(coder, 'agents.conversations.create', { name: 'x', team_id: 'T000000000' })).error, 'team_not_found');
    assert.equal((await mina.call('agents.conversations.create', { name: 'mine' })).error, 'not_allowed_token_type');
    const scopeless = createBot(t, ['chat:write']);
    assert.equal((await callWithToken(t.base, scopeless.token, 'agents.conversations.create', { name: 'nope' })).error, 'missing_scope');
    await owner.ok('client.admin.updateSettings', { who_can_create_channels: 'admins' });
    assert.equal((await as(coder, 'agents.conversations.create', { name: 'not now' })).error, 'restricted_action');
    await owner.ok('client.admin.updateSettings', { who_can_create_channels: 'everyone' });
  });

  test('the channel is the session: no thread_ts there, renaming renames the channel', async () => {
    assert.equal((await as(coder, 'agents.sessions.setStatus', { channel_id: channel, thread_ts: originTs, status: 'processing' })).error, 'thread_ts_not_allowed');
    assert.equal((await as(coder, 'agents.sessions.setStatus', { channel_id: origin, status: 'processing' })).error, 'thread_ts_required', 'ordinary channels keep thread sessions');
    const seen = watching.next((event) => event.type === 'agent_session' && event.session.channel === channel && event.session.status === 'processing');
    const set = await ok(coder, 'agents.sessions.setStatus', { channel_id: channel, status: 'processing' });
    assert.deepEqual([set.status, set.agent_status, set.title], ['processing', 'processing', 'Fix the flaky login test']);
    assert.equal((await seen).session.thread_ts, null);
    assert.equal((await info(mina)).properties.agent_session.status, 'processing');

    const renamed = await ok(coder, 'agents.sessions.rename', { channel_id: channel, title: 'Quarantine flaky login test' });
    assert.equal(renamed.title, 'Quarantine flaky login test');
    const conv = await info(mina);
    assert.deepEqual([conv.name, conv.properties.agent_session.title], ['quarantine-flaky-login-test', 'Quarantine flaky login test']);
    assert.equal((await as(coder, 'agents.sessions.rename', { channel_id: channel, title: '!!!' })).error, 'invalid_name');
    assert.equal((await as(coder, 'agents.sessions.rename', { channel_id: channel, title: 'Upgrade Node' })).error, 'name_taken');
    assert.equal((await as(coder, 'agents.sessions.rename', { channel_id: channel, thread_ts: originTs, title: 'x' })).error, 'thread_ts_not_allowed');
  });

  test('a second agent joins by reporting a status; Stop without a thread tells the processing ones', async () => {
    assert.equal((await as(helper, 'agents.sessions.setStatus', { channel_id: channel, status: 'active' })).error, 'channel_not_found', 'not in the private channel yet');
    await mina.ok('conversations.invite', { channel, users: helper.botUserId });
    await ok(helper, 'agents.sessions.setStatus', { channel_id: channel, status: 'suspended' });
    assert.deepEqual((await info(mina)).properties.agent_session.encoded_agent_bot_user_ids, [coder.botUserId, helper.botUserId]);
    assert.equal((await info(mina)).properties.agent_session.status, 'suspended', 'the most pressing state');
    const stream = await ok(coder, 'chat.startStream', { channel, markdown_text: 'Running the suite…' });
    const stopped = coderSocket.event('agent_session_stopped', (event) => event.channel === channel);
    assert.equal((await mina.ok('client.agents.stop', { channel })).stopped, 1);
    const event = await stopped;
    assert.equal('thread_ts' in event, false, 'the whole channel stops');
    assert.deepEqual([event.user, event.streaming_message_ts], [mina.userId, [stream.ts]]);
    await ok(coder, 'chat.stopStream', { channel, ts: stream.ts });
    await ok(helper, 'agents.sessions.setStatus', { channel_id: channel, status: 'closed' });

    const changed = coderSocket.event('agent_session_title_changed', (item) => item.channel === channel);
    await mina.ok('client.agents.rename', { channel, title: 'Fix login test for good' });
    const title = await changed;
    assert.deepEqual([title.title, title.previous_title, 'thread_ts' in title], ['Fix login test for good', 'Quarantine flaky login test', false]);
    assert.equal((await info(mina)).name, 'fix-login-test-for-good', 'people renaming the session rename the channel');
  });

  test('setProperties: the context bar (with Slack’s warnings), a summary message, the agent resource', async () => {
    const items = [
      { key: 'branch', label: 'fix/login-flake', icon: 'branch' },
      { key: 'pr', label: 'PR #42', icon: 'link', url: 'https://git.example.com/acme/app/pull/42' },
      { key: 'rerun', label: 'Re-run CI', icon: 'terminal', item_type: 'action' },
      { key: 'docs', label: 'Runbook', url: 'https://docs.example.com/runbook', item_type: 'action' },
      { key: 'logs', label: 'Logs', icon: 'search' },
      { key: 'extra', label: 'Dropped' },
    ];
    const set = await ok(coder, 'agents.conversations.setProperties', {
      channel_id: channel,
      code_channel: { context_bar_items: items, summary_message: { message_ts: originTs } },
      agent_resource: { url: 'https://git.example.com/acme/app/issues/7', resource_type: 'issue', title: 'Login flake', provider: 'git' },
    });
    assert.equal(set.channel_id, channel);
    assert.deepEqual(set.response_metadata.warnings, ['too_many_context_bar_items', 'action_with_url_overridden_to_info']);
    const conv = await info(mina);
    const bar = conv.properties.code_channel.context_bar_items;
    assert.deepEqual(bar.map((item: Json) => [item.key, item.item_type]), [['branch', 'info'], ['pr', 'info'], ['rerun', 'action'], ['docs', 'info'], ['logs', 'info']]);
    assert.equal(bar[0].bot_user_id, coder.botUserId);
    assert.deepEqual(conv.properties.code_channel.summary_message, { message_ts: originTs });
    assert.equal(conv.properties.agent_resource.title, 'Login flake');
    // Partial: the resource keeps what was not sent.
    await ok(coder, 'agents.conversations.setProperties', { channel_id: channel, agent_resource: { title: 'Login flake (CI)' } });
    assert.equal((await info(mina)).properties.agent_resource.provider, 'git');

    assert.equal((await as(coder, 'agents.conversations.setProperties', { channel_id: channel })).error, 'no_properties_provided');
    assert.equal((await as(coder, 'agents.conversations.setProperties', { channel_id: origin, code_channel: {} })).error, 'not_agent_channel');
    assert.equal((await as(coder, 'agents.conversations.setProperties', { channel_id: channel, status: 'sleeping' })).error, 'invalid_status');
    assert.equal((await as(coder, 'agents.conversations.setProperties', { channel_id: channel, code_channel: { context_bar_items: [{ key: 'k', label: 'x', icon: 'rocket' }] } })).error, 'invalid_arguments');
    const outsider = await createPlatformApp(owner, 'Bystander');
    await mina.ok('conversations.invite', { channel, users: outsider.botUserId });
    assert.equal((await as(outsider, 'agents.conversations.setProperties', { channel_id: channel, code_channel: {} })).error, 'not_authorized', 'a bot in the channel that is not one of its agents');
  });

  test('an action item in the context bar sends code_channel_action to the agent that set it', async () => {
    const heard = coderSocket.event('code_channel_action', (event) => event.channel === channel);
    await mina.ok('client.codeChannels.action', { channel, key: 'rerun' });
    const event = await heard;
    assert.deepEqual([event.key, event.user, event.channel], ['rerun', mina.userId, channel]);
    assert.equal((await mina.call('client.codeChannels.action', { channel, key: 'branch' })).error, 'item_not_found', 'info items do nothing');
    assert.equal((await otto.call('client.codeChannels.action', { channel, key: 'rerun' })).error, 'channel_not_found');
  });

  test('views: html with its declared origins, the one diff, Block Kit; listViews, upserts and Slack’s errors', async () => {
    const html = await ok(coder, 'agents.conversations.setView', {
      channel_id: channel,
      view_key: 'reports/coverage.html',
      content: '<!doctype html><html><body><h1>Coverage 91%</h1></body></html>',
      csp: { resource_domains: ['https://cdn.example.com'] },
    });
    assert.match(html.view_id, /^Ct/);
    assert.deepEqual([html.type, html.content_version, html.channel_id], ['html', 1, channel]);
    const again = await ok(coder, 'agents.conversations.setView', { channel_id: channel, view_key: 'reports/coverage.html', content: '<p>Coverage 92%</p>', name: 'Coverage' });
    assert.deepEqual([again.view_id, again.content_version], [html.view_id, 2]);
    const diff = await ok(coder, 'agents.conversations.setView', {
      channel_id: channel,
      type: 'diff',
      content: 'diff --git a/login.test.ts b/login.test.ts\n--- a/login.test.ts\n+++ b/login.test.ts\n@@ -1,2 +1,2 @@\n-it("logs in", flaky)\n+it("logs in", stable)\n',
      base_branch: 'main',
      head_branch: 'fix/login-flake',
    });
    assert.equal(diff.type, 'diff');
    await ok(coder, 'agents.conversations.setView', {
      channel_id: channel,
      type: 'block_kit',
      view_key: 'controls',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: '*Deploy*' } },
        { type: 'actions', block_id: 'deploy', elements: [{ type: 'button', action_id: 'ship', text: { type: 'plain_text', text: 'Ship it' }, value: 'staging' }] },
        { type: 'section', block_id: 'pick', text: { type: 'mrkdwn', text: 'Target' }, accessory: { type: 'external_select', action_id: 'target', placeholder: { type: 'plain_text', text: 'Pick' } } },
      ],
    });
    const listed = (await ok(coder, 'agents.conversations.listViews', { channel_id: channel })).views;
    assert.deepEqual(listed.map((view: Json) => [view.view_key, view.label, view.content_version]), [['reports/coverage.html', 'Coverage', 2], [undefined, 'Diff', 1], ['controls', 'controls', 1]]);
    assert.ok(listed.every((view: Json) => /^F/.test(view.file_id) && typeof view.date_added === 'number'));
    const tabs = (await info(mina)).properties.code_channel.agent_session_views;
    assert.deepEqual(tabs.map((view: Json) => view.type), ['html', 'diff', 'block_kit']);

    // People in the channel read a view with its content.
    const seen = (await mina.ok('client.codeChannels.view', { channel, view_id: html.view_id })).view;
    assert.deepEqual([seen.content, seen.name, seen.csp.resource_domains], ['<p>Coverage 92%</p>', 'Coverage', []], 'an update replaces what it sends');
    const shown = (await mina.ok('client.codeChannels.view', { channel, view_id: diff.view_id })).view;
    assert.deepEqual([shown.base_branch, shown.head_branch], ['main', 'fix/login-flake']);
    assert.equal((await otto.call('client.codeChannels.view', { channel, view_id: html.view_id })).error, 'channel_not_found');

    const bad = (args: Json): Promise<string> => as(coder, 'agents.conversations.setView', { channel_id: channel, ...args }).then((result) => result.error);
    assert.equal(await bad({ type: 'video', view_key: 'v' }), 'invalid_view_type');
    assert.equal(await bad({ view_key: 'a.html' }), 'missing_required_arg');
    assert.equal(await bad({ content: '<p>x</p>' }), 'missing_required_arg', 'html needs a view_key');
    assert.equal(await bad({ type: 'block_kit', view_key: 'b' }), 'missing_required_arg');
    assert.equal(await bad({ type: 'block_kit', view_key: 'b', blocks: [{ text: 'no type' }] }), 'invalid_blocks');
    assert.equal(await bad({ type: 'canvas', view_key: 'c', canvas_id: 'F0000000000' }), 'canvas_not_found');
    assert.equal(await bad({ view_key: 'big.html', content: 'x'.repeat(1_000_001) }), 'content_too_large');
    for (const domain of ['http://cdn.example.com', 'https://10.0.0.8', 'https://localhost', 'https://build.internal', 'https://cdn.example.com/path']) {
      assert.equal(await bad({ view_key: 'c.html', content: '<p>x</p>', csp: { resource_domains: [domain] } }), 'invalid_csp_domain', domain);
    }
    await mina.ok('conversations.invite', { channel, users: helper.botUserId }).catch(() => undefined);
    assert.equal((await as(helper, 'agents.conversations.setView', { channel_id: channel, view_key: 'controls', type: 'block_kit', blocks: [{ type: 'divider' }] })).error, 'not_view_owner');
    assert.equal((await as(helper, 'agents.conversations.setView', { channel_id: channel, type: 'diff', content: 'diff --git a/x b/x' })).error, 'not_view_owner', 'one diff per channel');
    await ok(coder, 'agents.conversations.setView', { channel_id: channel, view_key: 'four.html', content: '<p>4</p>' });
    await ok(coder, 'agents.conversations.setView', { channel_id: channel, type: 'pull_request', view_key: 'pr', pr_url: 'https://git.example.com/acme/app/pull/42' });
    assert.equal(await bad({ view_key: 'six.html', content: '<p>6</p>' }), 'too_many_views');

    assert.equal((await as(coder, 'agents.conversations.removeView', { channel_id: channel })).error, 'invalid_arguments');
    assert.equal((await as(coder, 'agents.conversations.removeView', { channel_id: channel, view_key: 'four.html', view_id: html.view_id })).error, 'invalid_arguments');
    assert.equal((await as(coder, 'agents.conversations.removeView', { channel_id: channel, view_key: 'nope' })).error, 'view_not_found');
    assert.equal((await as(helper, 'agents.conversations.removeView', { channel_id: channel, view_key: 'four.html' })).error, 'not_view_owner');
    const removed = await ok(coder, 'agents.conversations.removeView', { channel_id: channel, view_key: 'four.html' });
    assert.equal(removed.channel_id, channel);
    await ok(coder, 'agents.conversations.removeView', { channel_id: channel, view_key: 'pr' });
    assert.equal((await ok(coder, 'agents.conversations.listViews', { channel_id: channel })).views.length, 3);
    assert.equal((await as(coder, 'agents.conversations.listViews', { channel_id: origin })).error, 'not_agent_channel');
  });

  test('Block Kit views: clicks and external menus go to the agent that owns the view', async () => {
    const view = (await ok(coder, 'agents.conversations.listViews', { channel_id: channel })).views.find((item: Json) => item.view_key === 'controls');
    coderSocket.autoAck = (envelope) => (envelope.payload?.type === 'block_suggestion' ? { options: [{ text: { type: 'plain_text', text: 'staging' }, value: 'staging' }] } : undefined);
    const clicked = coderSocket.envelopes.next((entry) => entry.type === 'interactive' && entry.payload?.type === 'block_actions');
    await mina.ok('client.codeChannels.blockAction', { channel, view_id: view.view_id, action: { action_id: 'ship', block_id: 'deploy' } });
    const payload = (await clicked).payload;
    assert.deepEqual(payload.container, { type: 'view', view_id: view.view_id, channel_id: channel });
    assert.deepEqual([payload.actions[0].action_id, payload.actions[0].value, payload.user.id, payload.channel.id], ['ship', 'staging', mina.userId, channel]);
    assert.match(payload.response_url, /^http/);
    const options = await mina.ok('client.codeChannels.suggest', { channel, view_id: view.view_id, action_id: 'target', block_id: 'pick', value: 'st' });
    assert.equal(options.options[0].value, 'staging');
    coderSocket.autoAck = true;
    assert.equal((await mina.call('client.codeChannels.blockAction', { channel, view_id: view.view_id, action: { action_id: 'missing' } })).error, 'action_not_found');
  });

  test('canvases: a view at the access level the agent chose, getCanvas with comments, setCanvasContent changing only what differs', async () => {
    const markdown = '# Migration plan\n\n1. Inventory cron jobs\n\nMove billing jobs last.\n\nThen retire the old box.';
    const { canvas_id: canvasId } = await ok(coder, 'canvases.create', { title: 'Migration plan', document_content: { type: 'markdown', markdown } });
    const view = await ok(coder, 'agents.conversations.setView', { channel_id: channel, type: 'canvas', view_key: 'plan', canvas_id: canvasId, access_level: 'comment' });
    assert.deepEqual([view.canvas_id, view.file_id, view.type], [canvasId, canvasId, 'canvas']);
    // Members read and comment; only the agent writes.
    const opened = (await mina.ok('client.canvases.info', { canvas_id: canvasId })).canvas;
    assert.equal(opened.access_level, 'read');
    const comment = (await mina.ok('client.canvases.comments.add', { canvas_id: canvasId, text: 'Can we do the billing jobs last?', quote: 'Inventory cron jobs' })).comment;
    await owner.ok('conversations.join', { channel }).catch(() => undefined);
    await mina.ok('client.canvases.comments.add', { canvas_id: canvasId, root_id: comment.id, text: '+1, those are the riskiest' });
    const resolvedOne = (await mina.ok('client.canvases.comments.add', { canvas_id: canvasId, text: 'Typo in the title' })).comment;
    await mina.ok('client.canvases.comments.resolve', { canvas_id: canvasId, comment_id: resolvedOne.id }).catch(() => undefined);

    const got = await ok(coder, 'agents.conversations.getCanvas', { channel, canvas_id: canvasId });
    assert.deepEqual([got.canvas_id, got.title, got.has_more_comments], [canvasId, 'Migration plan', false]);
    assert.equal(got.content, markdown);
    assert.equal(got.comments.length, 1, 'resolved threads are left out by default');
    const thread = got.comments[0];
    assert.deepEqual([thread.text, thread.quoted_text, thread.user_id, thread.is_resolved, thread.has_more_replies], ['Can we do the billing jobs last?', 'Inventory cron jobs', mina.userId, false, false]);
    assert.match(thread.ts, /^\d{10}\.\d{6}$/);
    assert.deepEqual(thread.replies.map((reply: Json) => reply.text), ['+1, those are the riskiest']);
    assert.equal((await ok(coder, 'agents.conversations.getCanvas', { channel, canvas_id: canvasId, include_resolved: true })).comments.length, 2);

    const versions = async (): Promise<number> => (await mina.ok('client.canvases.versions.list', { canvas_id: canvasId })).versions.length;
    const before = await versions();
    assert.equal((await ok(coder, 'agents.conversations.setCanvasContent', { channel, canvas_id: canvasId, content: markdown })).sections_changed_count, 0, 'the same content changes nothing');
    assert.equal(await versions(), before, 'and keeps no new version');
    const next = markdown.replace('Move billing jobs last.', 'Move billing jobs last, after payroll.');
    assert.equal((await ok(coder, 'agents.conversations.setCanvasContent', { channel, canvas_id: canvasId, content: next })).sections_changed_count, 1);
    const added = `${next}\n\n## Rollback\n\nKeep the old box for a week.`;
    assert.equal((await ok(coder, 'agents.conversations.setCanvasContent', { channel, canvas_id: canvasId, content: added })).sections_changed_count, 2);
    assert.equal((await ok(coder, 'agents.conversations.getCanvas', { channel, canvas_id: canvasId })).content, added);
    assert.equal((await mina.call('canvases.edit', { canvas_id: canvasId, changes: [{ operation: 'insert_at_end', document_content: { type: 'markdown', markdown: 'mine' } }] })).error, 'access_denied', 'members only comment');

    // Read: members read without commenting.
    await ok(coder, 'agents.conversations.setView', { channel_id: channel, type: 'canvas', view_key: 'plan', canvas_id: canvasId, access_level: 'read' });
    assert.equal((await mina.call('client.canvases.comments.add', { canvas_id: canvasId, text: 'more?' })).error, 'access_denied');
    assert.equal((await mina.ok('client.codeChannels.view', { channel, view_id: view.view_id })).view.access_level, 'read');

    assert.equal((await as(coder, 'agents.conversations.getCanvas', { channel: origin, canvas_id: canvasId })).error, 'not_agent_channel');
    assert.equal((await as(coder, 'agents.conversations.getCanvas', { channel, canvas_id: 'F0000000000' })).error, 'canvas_not_found');
    const others = await ok(helper, 'canvases.create', { title: 'Helper notes' });
    assert.equal((await as(coder, 'agents.conversations.getCanvas', { channel, canvas_id: others.canvas_id })).error, 'canvas_not_found', 'a canvas the agent cannot open');
    assert.equal((await as(coder, 'agents.conversations.setCanvasContent', { channel, canvas_id: canvasId, content: 'x'.repeat(400_001) })).error, 'content_too_large');
    await ok(coder, 'agents.conversations.removeView', { channel_id: channel, view_key: 'plan' });
  });

  test('setCommands: the agent’s commands appear in that channel’s autocomplete and run there', async () => {
    const commands = [
      { name: 'create-pr', description: 'Open a pull request', argument_hint: '[title]' },
      { name: 'rerun', description: 'Run the tests again', should_escape: true },
    ];
    const set = await ok(coder, 'agents.conversations.setCommands', { channel_id: channel, commands });
    assert.deepEqual([set.channel_id, set.command_count], [channel, 2]);
    const listed = (await mina.ok('client.commands.list')).commands.filter((command: Json) => command.channel_id === channel);
    assert.deepEqual(listed.map((command: Json) => [command.command, command.usage_hint, command.app_name]), [['/create-pr', '[title]', 'Coder'], ['/rerun', '', 'Coder']]);
    assert.equal((await otto.ok('client.commands.list')).commands.some((command: Json) => command.channel_id === channel), false, 'only for people in the channel');

    const ran = coderSocket.envelopes.next((entry) => entry.type === 'slash_commands');
    await mina.ok('client.commands.run', { channel, command: '/create-pr', text: 'Stabilise login test' });
    const payload = (await ran).payload;
    assert.deepEqual([payload.command, payload.text, payload.channel_id, payload.user_id, payload.api_app_id], ['/create-pr', 'Stabilise login test', channel, mina.userId, coder.id]);
    assert.match(payload.response_url, /^http/);
    assert.ok(payload.trigger_id);
    assert.equal((await mina.call('client.commands.run', { channel: origin, command: '/create-pr' })).error, 'command_not_found', 'only in its channel');

    const bad = (app: TestAppCredentials, list: unknown): Promise<string> => as(app, 'agents.conversations.setCommands', { channel_id: channel, commands: list }).then((result) => result.error);
    assert.equal(await bad(coder, [{ name: 'a' }, { name: 'a' }]), 'duplicate_command');
    assert.equal(await bad(coder, [{ name: 'remind' }]), 'colliding_with_builtin');
    assert.equal(await bad(coder, [{ name: '/slash' }]), 'invalid_commands');
    assert.equal(await bad(coder, [{ name: 'x'.repeat(32) }]), 'invalid_commands');
    assert.equal(await bad(coder, 'not a list'), 'invalid_commands');
    await ok(helper, 'agents.sessions.setStatus', { channel_id: channel, status: 'active' });
    assert.equal(await bad(helper, Array.from({ length: 9 }, (_, index) => ({ name: `h${index}`, description: 'helper' }))), 'too_many_commands', 'ten across the channel’s agents');
    assert.equal((await ok(helper, 'agents.conversations.setCommands', { channel_id: channel, commands: [{ name: 'lint', description: 'Lint' }] })).command_count, 1);
    assert.equal((await mina.call('agents.conversations.setCommands', { channel_id: channel, commands: [] })).error, 'agent_required');
    // An empty list clears only the caller's set.
    await ok(coder, 'agents.conversations.setCommands', { channel_id: channel, commands: [] });
    assert.deepEqual((await mina.ok('client.commands.list')).commands.filter((command: Json) => command.channel_id === channel).map((command: Json) => command.command), ['/lint']);
  });

  test('message.session: an app that subscribes hears its code channels through it, once', async () => {
    await owner.ok('client.apps.update', { app: helper.id, bot_events: ['message.session', 'message.channels', 'message.groups'] });
    const start = helperSocket.envelopes.items.length;
    await mina.ok('chat.postMessage', { channel, text: 'Can you also add a test for the retry path?' });
    await mina.ok('conversations.invite', { channel: origin, users: helper.botUserId });
    await mina.ok('chat.postMessage', { channel: origin, text: 'unrelated' });
    await sleep(300);
    const texts = helperSocket.envelopes.items
      .slice(start)
      .filter((entry) => entry.type === 'events_api' && entry.payload?.event?.type === 'message')
      .map((entry) => entry.payload.event.text);
    assert.equal(texts.filter((value) => value === 'Can you also add a test for the retry path?').length, 1, 'no duplicates with message.groups');
    assert.ok(texts.includes('unrelated'), 'ordinary channels still come as message.groups');
    await owner.ok('client.apps.update', { app: helper.id, bot_events: ['message.session'] });
    await mina.ok('chat.postMessage', { channel: origin, text: 'not a session' });
    await mina.ok('chat.postMessage', { channel, text: 'a session message' });
    const event = await helperSocket.event('message', (item) => item.text === 'a session message');
    assert.equal(event.channel_type, 'group');
    await sleep(200);
    assert.equal(helperSocket.events('message').some((item) => item.text === 'not a session'), false);
  });

  test('archive: only an agent of the channel; a summary goes back to the origin thread', async () => {
    const summary = await ok(coder, 'chat.postMessage', { channel, text: 'Done: the login test is stable (PR #42).' });
    const plain = await ok(coder, 'agents.conversations.create', { name: 'No origin here' });
    assert.equal((await as(coder, 'agents.conversations.archive', { channel_id: plain.channel_id, summary_message_ts: summary.ts })).error, 'no_origin_link');
    assert.equal((await as(coder, 'agents.conversations.archive', { channel_id: channel, summary_message_ts: '1111111111.000001' })).error, 'summary_message_not_found');
    assert.equal((await as(coder, 'agents.conversations.archive', { channel_id: origin })).error, 'not_agent_channel');
    const outsider = await createPlatformApp(owner, 'Late Bot');
    await mina.ok('conversations.invite', { channel, users: outsider.botUserId });
    assert.equal((await as(outsider, 'agents.conversations.archive', { channel_id: channel })).error, 'not_authorized');
    await ok(coder, 'agents.conversations.archive', { channel_id: channel, summary_message_ts: summary.ts });
    const conv = await info(mina);
    assert.equal(conv.is_archived, true);
    assert.deepEqual(conv.properties.code_channel.summary_message, { message_ts: summary.ts });
    const back = (await mina.ok('conversations.replies', { channel: origin, ts: originTs })).messages.at(-1);
    assert.deepEqual([back.text, back.bot_id], ['Done: the login test is stable (PR #42).', coder.botId]);
    assert.equal((await as(coder, 'agents.conversations.archive', { channel_id: channel })).error, 'already_archived');
    assert.equal((await as(coder, 'agents.conversations.setView', { channel_id: channel, view_key: 'late.html', content: '<p>late</p>' })).error, 'is_archived');
  });
});
