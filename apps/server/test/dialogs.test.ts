import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { dialogToView } from '../src/platform/dialogs.ts';
import { addMember, callWithToken, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';
import { createPlatformApp, SocketApp, type TestAppCredentials } from './platform-helpers.ts';

const DIALOG = {
  title: 'Request a laptop',
  callback_id: 'laptop-1',
  submit_label: 'Request',
  state: 'from-help-desk',
  notify_on_cancel: true,
  elements: [
    { type: 'text', label: 'Email', name: 'email', subtype: 'email', value: 'me@acme.test' },
    { type: 'textarea', label: 'Reason', name: 'reason', optional: true, hint: 'Why now?' },
    { type: 'select', label: 'Model', name: 'model', options: [{ label: 'Air', value: 'air' }, { label: 'Pro', value: 'pro' }] },
    { type: 'select', label: 'Manager', name: 'manager', data_source: 'users' },
    { type: 'select', label: 'Cost centre', name: 'cost', data_source: 'external', optional: true },
  ],
};

describe('legacy dialogs (dialog.open)', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let creds: TestAppCredentials;
  let app: SocketApp;
  let general: string;
  let answers: Record<string, (payload: Json) => Json | undefined> = {};
  const bot = (method: string, args: Json = {}): Promise<Json> => callWithToken(t.base, creds.botToken, method, args);
  const interactive = async (type: string): Promise<Json> => (await app.envelopes.next((entry) => entry.type === 'interactive' && entry.payload?.type === type)).payload;

  async function trigger(): Promise<string> {
    const { ts } = await bot('chat.postMessage', {
      channel: general,
      text: 'start',
      blocks: [{ type: 'actions', block_id: 'go', elements: [{ type: 'button', action_id: 'open', text: { type: 'plain_text', text: 'Open' } }] }],
    });
    await member.ok('client.interactions.blockAction', { channel: general, message_ts: ts, action: { action_id: 'open' } });
    return (await app.envelopes.next((entry) => entry.type === 'interactive' && entry.payload?.type === 'block_actions' && entry.payload.container.message_ts === ts)).payload.trigger_id;
  }

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    creds = await createPlatformApp(owner, 'Help desk');
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

  test('invalid dialogs are refused with Slack’s messages, before the trigger is used', async () => {
    const bad = dialogToView({ title: 'x'.repeat(30), callback_id: 'c', elements: [{ type: 'text', label: 'A', name: 'a' }, { type: 'text', label: 'B', name: 'a' }] }, null);
    assert.ok('messages' in bad);
    assert.ok(bad.messages.some((message) => message.includes('/dialog/title')));
    assert.ok(bad.messages.some((message) => message.includes('/dialog/elements/1/name')));
    const id = await trigger();
    const refused = await bot('dialog.open', { trigger_id: id, dialog: JSON.stringify({ title: 'Ok', callback_id: 'c', elements: [] }) });
    assert.equal(refused.error, 'validation_errors');
    assert.ok(refused.response_metadata.messages.length > 0);
    assert.equal((await bot('dialog.open', { trigger_id: id })).error, 'missing_dialog');
    assert.equal((await bot('dialog.open', { dialog: JSON.stringify(DIALOG) })).error, 'missing_trigger');
    assert.equal((await bot('dialog.open', { trigger_id: '1.2.abc', dialog: JSON.stringify(DIALOG) })).error, 'invalid_trigger');
    assert.equal((await bot('dialog.open', { trigger_id: id, dialog: JSON.stringify(DIALOG) })).ok, true, 'the trigger was still good');
    assert.equal((await bot('dialog.open', { trigger_id: id, dialog: JSON.stringify(DIALOG) })).error, 'trigger_exchanged');
  });

  test('the person sees a modal; the app gets dialog_submission, can send errors back, then the dialog closes', async () => {
    const stack = (await member.ok('client.views.stack')).stack as Json[];
    assert.equal(stack.length, 1);
    const view = stack[0]!;
    assert.equal(view.title.text, 'Request a laptop');
    assert.equal(view.submit.text, 'Request');
    assert.doesNotMatch(JSON.stringify(view), /from-help-desk/, 'the app’s state stays on the server');
    const blocks = view.blocks as Json[];
    assert.deepEqual(blocks.map((block) => block.element.type), ['plain_text_input', 'plain_text_input', 'static_select', 'users_select', 'external_select']);
    assert.equal(blocks[0]!.element.initial_value, 'me@acme.test');

    // Options for the external menu come from the app as dialog_suggestion.
    answers.dialog_suggestion = (payload) => ({ options: [{ label: `CC-${payload.value}`, value: payload.value }] });
    const options = await member.ok('client.views.suggest', { view_id: view.id, block_id: blocks[4]!.block_id, action_id: 'cost', value: '42' });
    assert.deepEqual(options.options, [{ text: { type: 'plain_text', text: 'CC-42', emoji: true }, value: '42' }]);
    const suggestion = await interactive('dialog_suggestion');
    assert.equal(suggestion.name, 'cost');
    assert.equal(suggestion.callback_id, 'laptop-1');

    const values = {
      [blocks[0]!.block_id]: { email: { type: 'plain_text_input', value: 'not-an-email' } },
      [blocks[1]!.block_id]: { reason: { type: 'plain_text_input', value: '' } },
      [blocks[2]!.block_id]: { model: { type: 'static_select', selected_option: { text: { type: 'plain_text', text: 'Pro' }, value: 'pro' } } },
      [blocks[3]!.block_id]: { manager: { type: 'users_select', selected_user: owner.userId } },
      [blocks[4]!.block_id]: { cost: { type: 'external_select', selected_option: null } },
    };
    answers.dialog_submission = (payload) => (payload.submission.email.includes('@') ? undefined : { errors: [{ name: 'email', error: 'Use your work address' }] });
    const first = await member.ok('client.views.submit', { view_id: view.id, state: { values } });
    assert.deepEqual(first.errors, { [blocks[0]!.block_id]: 'Use your work address' });
    assert.equal(first.stack.length, 1, 'still open');
    const submitted = await interactive('dialog_submission');
    assert.deepEqual(submitted.submission, { email: 'not-an-email', reason: null, model: 'pro', manager: owner.userId, cost: null });
    assert.equal(submitted.callback_id, 'laptop-1');
    assert.equal(submitted.state, 'from-help-desk');
    assert.equal(submitted.channel.id, general);
    assert.equal(submitted.user.id, member.userId);
    assert.ok(submitted.response_url);

    values[blocks[0]!.block_id] = { email: { type: 'plain_text_input', value: 'mina@acme.test' } };
    const second = await member.ok('client.views.submit', { view_id: view.id, state: { values } });
    assert.deepEqual(second.stack, []);
  });

  test('cancelling tells the app when it asked', async () => {
    await bot('dialog.open', { trigger_id: await trigger(), dialog: JSON.stringify(DIALOG) });
    const view = ((await member.ok('client.views.stack')).stack as Json[])[0]!;
    await member.ok('client.views.close', { view_id: view.id, clear: true });
    const cancelled = await interactive('dialog_cancellation');
    assert.equal(cancelled.callback_id, 'laptop-1');
    assert.equal(cancelled.state, 'from-help-desk');
  });
});
