import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, callWithToken, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';
import { createPlatformApp, SocketApp, type TestAppCredentials } from './platform-helpers.ts';

// Short enough to test expiry without waiting long.
process.env.TRIGGER_TTL_MS = '400';
process.env.EVENT_ACK_TIMEOUT_MS = '500';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const MODAL = {
  type: 'modal',
  callback_id: 'file_bug',
  private_metadata: 'secret-context',
  title: { type: 'plain_text', text: 'File a bug' },
  submit: { type: 'plain_text', text: 'File' },
  close: { type: 'plain_text', text: 'Cancel' },
  notify_on_close: true,
  blocks: [
    { type: 'input', block_id: 'title', label: { type: 'plain_text', text: 'Title' }, element: { type: 'plain_text_input', action_id: 'value' } },
    {
      type: 'input',
      block_id: 'severity',
      label: { type: 'plain_text', text: 'Severity' },
      element: {
        type: 'static_select',
        action_id: 'choice',
        options: [
          { text: { type: 'plain_text', text: 'Low' }, value: 'low' },
          { text: { type: 'plain_text', text: 'High' }, value: 'high' },
        ],
      },
    },
    { type: 'input', block_id: 'due', optional: true, label: { type: 'plain_text', text: 'Due' }, element: { type: 'datepicker', action_id: 'date' } },
    {
      type: 'actions',
      block_id: 'more',
      elements: [
        { type: 'button', action_id: 'details', text: { type: 'plain_text', text: 'More details' } },
        { type: 'external_select', action_id: 'component', placeholder: { type: 'plain_text', text: 'Component' } },
      ],
    },
  ],
};

function pushed(title: string, extra: Json = {}): Json {
  return {
    type: 'modal',
    callback_id: `step_${title}`,
    title: { type: 'plain_text', text: title },
    submit: { type: 'plain_text', text: 'Next' },
    blocks: [{ type: 'input', block_id: 'note', label: { type: 'plain_text', text: 'Note' }, element: { type: 'plain_text_input', action_id: 'v' } }],
    ...extra,
  };
}

describe('modals, App Home, shortcuts and unfurls', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let creds: TestAppCredentials;
  let app: SocketApp;
  let general: string;
  /** What the app answers to the next interactive envelope, by payload type. */
  let answers: Record<string, (payload: Json) => Json | undefined> = {};

  const bot = (method: string, args: Json = {}): Promise<Json> => callWithToken(t.base, creds.botToken, method, args);

  async function interactive(type: string, match: (payload: Json) => boolean = () => true): Promise<Json> {
    const envelope = await app.envelopes.next((entry) => entry.type === 'interactive' && entry.payload?.type === type && match(entry.payload));
    return envelope.payload;
  }

  /** A trigger, as an app gets one: from a button click on its message. */
  async function trigger(): Promise<string> {
    const { ts } = await bot('chat.postMessage', {
      channel: general,
      text: 'start',
      blocks: [{ type: 'actions', block_id: 'go', elements: [{ type: 'button', action_id: 'open', text: { type: 'plain_text', text: 'Open' } }] }],
    });
    await member.ok('client.interactions.blockAction', { channel: general, message_ts: ts, action: { action_id: 'open' } });
    return (await interactive('block_actions', (payload) => payload.container.message_ts === ts)).trigger_id;
  }

  async function openModal(): Promise<Json> {
    const opened = await bot('views.open', { trigger_id: await trigger(), view: MODAL });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    return opened.view;
  }

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    creds = await createPlatformApp(owner, 'Tracker');
    await owner.ok('conversations.invite', { channel: general, users: creds.botUserId });
    app = await SocketApp.connect(t.base, creds.appToken);
    app.autoAck = (envelope) => {
      if (envelope.type !== 'interactive') return undefined;
      const answer = answers[envelope.payload?.type];
      return answer ? answer(envelope.payload) : undefined;
    };
  });
  after(async () => {
    app.close();
    await t.close();
  });

  test('views.open exchanges a trigger once, for the app it was issued to, within its lifetime', async () => {
    const stream = await member.connect();
    const view = await openModal();
    assert.match(view.id, /^V[A-Z0-9]+$/);
    assert.equal(view.root_view_id, view.id);
    assert.equal(view.private_metadata, 'secret-context');
    assert.equal(view.app_id, creds.id);
    assert.equal(view.bot_id, creds.botId);
    assert.match(view.hash, /^\d+\.[0-9a-f]+$/);
    assert.deepEqual(view.state, { values: {} });

    // The person's browser sees the modal, without the app's private metadata.
    const event = await stream.next((entry) => entry.type === 'view_stack' && entry.stack.length === 1);
    assert.equal(event.stack[0].id, view.id);
    assert.equal(event.stack[0].private_metadata, undefined);
    assert.equal((await member.ok('client.views.stack')).stack[0].id, view.id);
    assert.deepEqual((await owner.ok('client.views.stack')).stack, []);
    stream.close();

    const used = await trigger();
    assert.equal((await bot('views.open', { trigger_id: used, view: MODAL })).ok, true);
    assert.equal((await bot('views.open', { trigger_id: used, view: MODAL })).error, 'exchanged_trigger_id');
    assert.equal((await bot('views.open', { trigger_id: 'nonsense', view: MODAL })).error, 'invalid_trigger_id');
    const late = await trigger();
    await sleep(450);
    assert.equal((await bot('views.open', { trigger_id: late, view: MODAL })).error, 'expired_trigger_id');

    const other = await createPlatformApp(owner, 'Other');
    assert.equal((await callWithToken(t.base, other.botToken, 'views.open', { trigger_id: await trigger(), view: MODAL })).error, 'invalid_trigger_id');
    // A view without a title, or with inputs but no submit button, is refused like Slack refuses it.
    const noTitle = await bot('views.open', { trigger_id: await trigger(), view: { ...MODAL, title: undefined } });
    assert.equal(noTitle.error, 'invalid_arguments');
    assert.match(noTitle.response_metadata.messages[0], /title/);
    assert.equal((await bot('views.open', { trigger_id: await trigger(), view: { ...MODAL, submit: undefined } })).error, 'invalid_arguments');
  });

  test('a submission carries checked state; the app answers with errors, push, update, clear or a plain acknowledgement', async () => {
    const view = await openModal();
    const values = {
      title: { value: { type: 'plain_text_input', value: 'Search is slow' } },
      severity: { choice: { type: 'static_select', selected_option: { value: 'high' } } },
      due: { date: { type: 'datepicker', selected_date: '2026-12-01' } },
      invented: { x: { type: 'plain_text_input', value: 'not in the view' } },
    };

    answers = { view_submission: () => ({ response_action: 'errors', errors: { title: 'Be more specific' } }) };
    const refused = await member.ok('client.views.submit', { view_id: view.id, state: { values } });
    assert.deepEqual(refused.errors, { title: 'Be more specific' });
    assert.equal(refused.stack.length, 1);
    const submission = await interactive('view_submission');
    assert.equal(submission.view.callback_id, 'file_bug');
    assert.equal(submission.view.private_metadata, 'secret-context');
    assert.deepEqual(submission.view.state.values, {
      title: { value: { type: 'plain_text_input', value: 'Search is slow' } },
      severity: { choice: { type: 'static_select', selected_option: { text: { type: 'plain_text', text: 'High' }, value: 'high' } } },
      due: { date: { type: 'datepicker', selected_date: '2026-12-01' } },
    });
    assert.equal(submission.user.id, member.userId);
    assert.deepEqual(submission.response_urls, []);
    assert.match(submission.trigger_id, /^\d+\.\d+\.[0-9a-f]+$/);
    assert.equal(
      (await member.call('client.views.submit', { view_id: view.id, state: { values: { severity: { choice: { selected_option: { value: 'nope' } } } } } })).error,
      'invalid_action_value',
    );

    answers = { view_submission: () => ({ response_action: 'push', view: pushed('Step two') }) };
    const two = await member.ok('client.views.submit', { view_id: view.id, state: { values } });
    assert.deepEqual(two.stack.map((entry: Json) => entry.title.text), ['File a bug', 'Step two']);
    assert.equal(two.stack[1].previous_view_id, view.id);
    assert.equal(two.stack[1].root_view_id, view.id);
    // What was typed in the first view is kept while the second is on top.
    assert.equal(two.stack[0].state.values.title.value.value, 'Search is slow');

    // views.push from an action inside the modal: the third and last view.
    answers = {};
    await member.ok('client.views.blockAction', { view_id: view.id, action: { action_id: 'details', block_id: 'more' } });
    const fromModal = await interactive('block_actions', (payload) => payload.container.type === 'view');
    assert.deepEqual(fromModal.container, { type: 'view', view_id: view.id });
    assert.equal(fromModal.view.id, view.id);
    assert.equal(fromModal.response_url, undefined);
    const three = await bot('views.push', { trigger_id: fromModal.trigger_id, view: pushed('Step three', { external_id: 'step-three' }) });
    assert.equal(three.ok, true, JSON.stringify(three));
    await member.ok('client.views.blockAction', { view_id: view.id, action: { action_id: 'details', block_id: 'more' } });
    const again = await interactive('block_actions', (payload) => payload.container.type === 'view' && payload.trigger_id !== fromModal.trigger_id);
    assert.equal((await bot('views.push', { trigger_id: again.trigger_id, view: pushed('Step four') })).error, 'push_limit_reached');

    // views.update by external_id, guarded by the hash.
    assert.equal((await bot('views.update', { external_id: 'step-three', hash: '1.stale', view: pushed('Step 3') })).error, 'hash_conflict');
    const updated = await bot('views.update', { external_id: 'step-three', hash: three.view.hash, view: pushed('Step 3', { external_id: 'step-three' }) });
    assert.equal(updated.view.id, three.view.id);
    assert.equal(updated.view.title.text, 'Step 3');
    assert.notEqual(updated.view.hash, three.view.hash);
    assert.equal((await bot('views.update', { view_id: 'VNOTAVIEW1', view: pushed('x') })).error, 'not_found');
    const other = await createPlatformApp(owner, 'Interloper');
    assert.equal((await callWithToken(t.base, other.botToken, 'views.update', { view_id: three.view.id, view: pushed('x') })).error, 'not_found');

    // Only the visible view can be submitted. A plain acknowledgement closes it.
    assert.equal((await member.call('client.views.submit', { view_id: view.id, state: { values } })).error, 'not_found');
    const back = await member.ok('client.views.submit', { view_id: three.view.id, state: { values: {} } });
    assert.equal(back.stack.length, 2);

    answers = { view_submission: () => ({ response_action: 'update', view: pushed('Step two, revised') }) };
    const revised = await member.ok('client.views.submit', { view_id: back.stack[1].id, state: { values: {} } });
    assert.equal(revised.stack[1].title.text, 'Step two, revised');
    assert.equal(revised.stack[1].id, back.stack[1].id);

    answers = { view_submission: () => ({ response_action: 'clear' }) };
    assert.deepEqual((await member.ok('client.views.submit', { view_id: revised.stack[1].id, state: { values: {} } })).stack, []);
  });

  test('closing a view: Cancel goes back one view, the × clears the modal; the app hears view_closed when it asked', async () => {
    const view = await openModal();
    answers = { view_submission: () => ({ response_action: 'push', view: pushed('Second', { notify_on_close: true }) }) };
    const { stack } = await member.ok('client.views.submit', { view_id: view.id, state: { values: {} } });
    answers = {};

    const cancelled = await member.ok('client.views.close', { view_id: stack[1].id });
    assert.deepEqual(cancelled.stack.map((entry: Json) => entry.id), [view.id]);
    const closed = await interactive('view_closed', (payload) => payload.view.id === stack[1].id);
    assert.equal(closed.is_cleared, false);

    const cleared = await member.ok('client.views.close', { view_id: view.id, clear: true });
    assert.deepEqual(cleared.stack, []);
    const all = await interactive('view_closed', (payload) => payload.is_cleared === true);
    assert.equal(all.view.id, view.id);
    assert.deepEqual(all.view.state, { values: {} });
    assert.equal((await member.call('client.views.close', { view_id: view.id })).error, 'not_found');
  });

  test('external menus load their options from the app, in views and on messages', async () => {
    const view = await openModal();
    answers = {
      block_suggestion: (payload) => ({
        options: [
          { text: { type: 'plain_text', text: `Search ${payload.value}` }, value: 'search' },
          { bogus: true },
        ],
      }),
    };
    const options = await member.ok('client.views.suggest', { view_id: view.id, action_id: 'component', block_id: 'more', value: 'se' });
    assert.deepEqual(options.options, [{ text: { type: 'plain_text', text: 'Search se' }, value: 'search' }]);
    const suggestion = await interactive('block_suggestion');
    assert.equal(suggestion.action_id, 'component');
    assert.equal(suggestion.value, 'se');
    assert.deepEqual(suggestion.container, { type: 'view', view_id: view.id });
    assert.equal((await owner.call('client.views.suggest', { view_id: view.id, action_id: 'component', value: 'x' })).error, 'not_found');

    const { ts } = await bot('chat.postMessage', {
      channel: general,
      text: 'pick',
      blocks: [{ type: 'section', block_id: 'pick', text: { type: 'mrkdwn', text: 'Pick' }, accessory: { type: 'external_select', action_id: 'repo' } }],
    });
    const onMessage = await member.ok('client.interactions.suggest', { channel: general, message_ts: ts, action_id: 'repo', value: 'ap' });
    assert.equal(onMessage.options[0].value, 'search');
    const fromMessage = await interactive('block_suggestion', (payload) => payload.action_id === 'repo');
    assert.equal(fromMessage.container.type, 'message');
    assert.equal(fromMessage.channel.id, general);
    // A picked external option is taken as sent, since there is no list to check it against.
    await member.ok('client.interactions.blockAction', {
      channel: general,
      message_ts: ts,
      action: { action_id: 'repo', selected_option: { text: { type: 'plain_text', text: 'Search se' }, value: 'search' } },
    });
    const picked = await interactive('block_actions', (payload) => payload.actions[0].action_id === 'repo');
    assert.equal(picked.actions[0].selected_option.value, 'search');
    answers = {};
    await member.ok('client.views.close', { view_id: view.id, clear: true });
  });

  test('App Home: opening it tells the app, which publishes a view for that person only', async () => {
    const stream = await member.connect();
    const opened = await member.ok('client.apps.homeOpened', { app: creds.id, tab: 'home' });
    assert.match(opened.channel, /^D/);
    assert.equal(opened.view, null);
    const event = await app.event('app_home_opened');
    assert.equal(event.user, member.userId);
    assert.equal(event.tab, 'home');
    assert.equal(event.channel, opened.channel);
    assert.equal(event.view, undefined);

    const home = {
      type: 'home',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: '*Your open bugs*' } },
        { type: 'actions', block_id: 'home_actions', elements: [{ type: 'button', action_id: 'refresh', text: { type: 'plain_text', text: 'Refresh' } }] },
      ],
    };
    const published = await bot('views.publish', { user_id: member.userId, view: home });
    assert.equal(published.ok, true, JSON.stringify(published));
    assert.equal(published.view.type, 'home');
    const pushedHome = await stream.next((entry) => entry.type === 'app_home' && entry.app_id === creds.id);
    assert.equal(pushedHome.view.id, published.view.id);
    assert.equal((await member.ok('client.apps.home', { app: creds.id })).view.id, published.view.id);
    assert.equal((await owner.ok('client.apps.home', { app: creds.id })).view, null);

    // Publishing again keeps the same view; a stale hash is refused.
    const second = await bot('views.publish', { user_id: member.userId, view: home, hash: published.view.hash });
    assert.equal(second.view.id, published.view.id);
    assert.equal((await bot('views.publish', { user_id: member.userId, view: home, hash: published.view.hash })).error, 'hash_conflict');
    assert.equal((await bot('views.publish', { user_id: creds.botUserId, view: home })).error, 'user_not_found');
    assert.equal((await bot('views.publish', { user_id: member.userId, view: MODAL })).error, 'invalid_arguments');

    // The next visit carries the view, and actions on the Home tab reach the app as view actions.
    await member.ok('client.apps.homeOpened', { app: creds.id, tab: 'messages' });
    const revisit = await app.event('app_home_opened', (entry) => entry.tab === 'messages');
    assert.equal(revisit.view.id, published.view.id);
    await member.ok('client.views.blockAction', { view_id: published.view.id, action: { action_id: 'refresh' } });
    const action = await interactive('block_actions', (payload) => payload.actions[0].action_id === 'refresh');
    assert.equal(action.view.type, 'home');
    assert.deepEqual(action.container, { type: 'view', view_id: published.view.id });
    assert.equal((await owner.call('client.views.blockAction', { view_id: published.view.id, action: { action_id: 'refresh' } })).error, 'not_found');
    stream.close();
  });

  test('global and message shortcuts', async () => {
    assert.equal(
      (await owner.call('client.apps.update', { app: creds.id, shortcuts: [{ type: 'global', name: 'x', callback_id: 'bad id!' }] })).error,
      'invalid_shortcuts',
    );
    await owner.ok('client.apps.update', {
      app: creds.id,
      shortcuts: [
        { type: 'global', name: 'File a bug', callback_id: 'new_bug', description: 'Report something broken' },
        { type: 'message', name: 'Turn into bug', callback_id: 'message_to_bug' },
      ],
    });
    const { shortcuts } = await member.ok('client.shortcuts.list');
    assert.deepEqual(
      shortcuts.map((entry: Json) => [entry.type, entry.callback_id, entry.app_name]),
      [
        ['global', 'new_bug', 'Tracker'],
        ['message', 'message_to_bug', 'Tracker'],
      ],
    );

    await member.ok('client.shortcuts.run', { app: creds.id, callback_id: 'new_bug' });
    const global = await interactive('shortcut');
    assert.equal(global.callback_id, 'new_bug');
    assert.equal(global.user.id, member.userId);
    assert.equal((await bot('views.open', { trigger_id: global.trigger_id, view: MODAL })).ok, true);
    await member.ok('client.views.close', { view_id: (await member.ok('client.views.stack')).stack[0].id, clear: true });

    const { ts } = await member.ok('chat.postMessage', { channel: general, text: 'The export button does nothing' });
    await member.ok('client.shortcuts.run', { app: creds.id, callback_id: 'message_to_bug', channel: general, message_ts: ts });
    const onMessage = await interactive('message_action');
    assert.equal(onMessage.message_ts, ts);
    assert.equal(onMessage.message.text, 'The export button does nothing');
    assert.deepEqual(onMessage.channel, { id: general, name: 'general' });
    const stream = await member.connect();
    await fetch(onMessage.response_url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Bug BUG-1 filed' }) });
    const note = await stream.next((entry) => entry.is_ephemeral === true && entry.text === 'Bug BUG-1 filed');
    assert.equal(note.channel, general);
    stream.close();
    assert.equal((await member.call('client.shortcuts.run', { app: creds.id, callback_id: 'nope' })).error, 'shortcut_not_found');
  });

  test('unfurls: links to a registered domain reach the app, and its preview is attached to the message', async () => {
    assert.equal((await owner.call('client.apps.update', { app: creds.id, unfurl_domains: 'not a domain' })).error, 'invalid_unfurl_domains');
    await owner.ok('client.apps.update', { app: creds.id, unfurl_domains: 'tracker.example' });
    assert.deepEqual((await owner.ok('client.apps.list')).apps.find((entry: Json) => entry.id === creds.id).unfurl_domains, ['tracker.example']);

    const posted = await member.ok('chat.postMessage', {
      channel: general,
      text: 'See https://bugs.tracker.example/BUG-7, <https://tracker.example/BUG-8|BUG-8> and https://elsewhere.example/x',
    });
    const shared = await app.event('link_shared', (event) => event.message_ts === posted.ts);
    assert.deepEqual(shared.links, [
      { domain: 'tracker.example', url: 'https://bugs.tracker.example/BUG-7' },
      { domain: 'tracker.example', url: 'https://tracker.example/BUG-8' },
    ]);
    assert.equal(shared.channel, general);
    assert.equal(shared.is_bot_user_member, true);
    assert.equal(shared.source, 'conversations_history');
    assert.equal(shared.user, member.userId);

    const stream = await member.connect();
    const unfurled = await bot('chat.unfurl', {
      channel: general,
      ts: posted.ts,
      unfurls: {
        'https://bugs.tracker.example/BUG-7': { blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*BUG-7* Search is slow' } }] },
      },
    });
    assert.equal(unfurled.ok, true, JSON.stringify(unfurled));
    const changed = await stream.next((entry) => entry.subtype === 'message_changed' && entry.message.ts === posted.ts);
    const attachment = changed.message.attachments[0];
    assert.equal(attachment.app_unfurl_url, 'https://bugs.tracker.example/BUG-7');
    assert.equal(attachment.is_app_unfurl, true);
    assert.equal(attachment.blocks[0].text.text, '*BUG-7* Search is slow');
    assert.equal(changed.message.edited, undefined);
    stream.close();

    // By unfurl_id, and the errors Slack gives.
    assert.equal(
      (await bot('chat.unfurl', { unfurl_id: shared.unfurl_id, source: 'conversations_history', unfurls: { 'https://tracker.example/BUG-8': { title: 'BUG-8', text: 'Export fails' } } })).ok,
      true,
    );
    const history = await member.ok('conversations.history', { channel: general, limit: 5 });
    const message = history.messages.find((entry: Json) => entry.ts === posted.ts);
    assert.deepEqual(message.attachments.map((entry: Json) => entry.app_unfurl_url), ['https://bugs.tracker.example/BUG-7', 'https://tracker.example/BUG-8']);
    assert.equal((await bot('chat.unfurl', { channel: general, ts: posted.ts, unfurls: { 'https://elsewhere.example/x': { title: 'x' } } })).error, 'cannot_unfurl_url');
    assert.equal((await bot('chat.unfurl', { channel: general, ts: posted.ts, unfurls: { 'https://tracker.example/nowhere': { title: 'x' } } })).error, 'cannot_unfurl_message');
    assert.equal((await bot('chat.unfurl', { unfurl_id: 'C1.1.x', source: 'conversations_history', unfurls: {} })).error, 'invalid_unfurl_id');
    assert.equal((await bot('chat.unfurl', { unfurl_id: shared.unfurl_id, source: 'composer', unfurls: {} })).error, 'invalid_source');
    assert.equal((await bot('chat.unfurl', { channel: general, ts: posted.ts })).error, 'missing_unfurls');

    // No event for the app's own links, nor for private conversations it is not in.
    await bot('chat.postMessage', { channel: general, text: 'mine: https://tracker.example/BUG-9' });
    const { channel: secret } = await member.ok('conversations.create', { name: 'secret-links', is_private: true });
    await member.ok('chat.postMessage', { channel: secret.id, text: 'https://tracker.example/BUG-10' });
    await member.ok('chat.postMessage', { channel: general, text: 'marker https://tracker.example/BUG-11' });
    await app.event('link_shared', (event) => event.links[0].url.endsWith('BUG-11'));
    const urls = app.events('link_shared').flatMap((event) => event.links.map((link: Json) => link.url));
    assert.ok(!urls.some((url: string) => url.endsWith('BUG-9') || url.endsWith('BUG-10')));
  });

  test('search.files and search.all find files by name within what the caller can see', async () => {
    const upload = async (session: Session, name: string, channel: string): Promise<string> => {
      const { upload_url, file_id } = await session.ok('files.getUploadURLExternal', { filename: name, length: 4 });
      await fetch(upload_url, { method: 'POST', body: 'data' });
      await session.ok('files.completeUploadExternal', { files: [{ id: file_id }], channel_id: channel });
      return file_id;
    };
    const { channel: hidden } = await owner.ok('conversations.create', { name: 'board', is_private: true });
    const shared = await upload(member, 'roadmap-2027.pdf', general);
    await upload(owner, 'roadmap-board-only.pdf', hidden.id);

    const files = await member.ok('search.files', { query: 'roadmap' });
    assert.deepEqual(files.files.matches.map((file: Json) => file.id), [shared]);
    assert.equal(files.files.total, 1);
    assert.equal(files.files.pagination.total_count, 1);
    assert.equal((await owner.ok('search.files', { query: 'roadmap' })).files.total, 2);
    assert.equal((await owner.ok('search.files', { query: 'roadmap from:@mina.member' })).files.total, 1);
    assert.equal((await owner.ok('search.files', { query: 'roadmap in:#board' })).files.total, 1);

    await member.ok('chat.postMessage', { channel: general, text: 'the roadmap is ready' });
    const all = await member.ok('search.all', { query: 'roadmap' });
    assert.equal(all.messages.total, 1);
    assert.equal(all.files.total, 1);
    assert.deepEqual(all.posts, { total: 0, matches: [] });
    assert.equal((await bot('search.files', { query: 'roadmap' })).files.total, 1);
  });

  test('dnd.info and dnd.teamInfo answer "not in Do Not Disturb"', async () => {
    const self = await bot('dnd.info');
    assert.equal(self.dnd_enabled, false);
    assert.equal(self.snooze_enabled, false);
    const team = await bot('dnd.teamInfo', { users: `${member.userId},${owner.userId}` });
    assert.deepEqual(Object.keys(team.users).sort(), [member.userId, owner.userId].sort());
    assert.equal(team.users[member.userId].dnd_enabled, false);
    assert.equal((await bot('dnd.info', { user: 'UNOBODY000' })).error, 'user_not_found');
  });

  test('an admin sets the per-token API limit; tokens get 429 with Retry-After past it, people do not', async () => {
    assert.equal((await member.call('client.apps.setRateLimit', { per_minute: 20 })).error, 'not_allowed');
    assert.equal((await owner.call('client.apps.setRateLimit', { per_minute: 5 })).error, 'invalid_limit');
    const set = await owner.ok('client.apps.setRateLimit', { per_minute: 10 });
    assert.equal(set.api_rate_limit_per_minute, 10);
    assert.equal((await member.ok('client.apps.limits')).api_rate_limit_per_minute, 10);

    const limited = await createPlatformApp(owner, 'Chatty');
    let refused: Response | undefined;
    for (let i = 0; i < 12 && !refused; i += 1) {
      const response = await fetch(`${t.base}/api/auth.test`, { method: 'POST', headers: { authorization: `Bearer ${limited.botToken}` } });
      if (response.status === 429) refused = response;
    }
    assert.ok(refused, 'expected a 429 within 12 calls');
    assert.ok(Number(refused.headers.get('retry-after')) >= 1);
    assert.equal(((await refused.json()) as Json).error, 'ratelimited');
    for (let i = 0; i < 15; i += 1) await member.ok('auth.test');

    await owner.ok('client.apps.setRateLimit', { per_minute: 0 });
    assert.equal((await owner.ok('client.apps.limits')).api_rate_limit_per_minute, null);
  });
});
