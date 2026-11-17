import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, callWithToken, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

describe('Calls API', () => {
  let t: TestApp;
  let owner: Session;
  let mia: Session;
  let bot: string;
  let general: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    mia = await addMember(t, owner, 'Mia Member');
    bot = (await owner.ok('client.apps.create', { name: 'Meet Bridge' })).bot_token;
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
  });
  after(() => t.close());

  const api = (method: string, args: Json = {}): Promise<Json> => callWithToken(t.base, bot, method, args);

  test('add, post as a call block, update, change participants and end; the card follows', async () => {
    assert.equal((await api('calls.add', { join_url: 'https://meet.example.com/abc' })).error, 'missing_argument');
    assert.equal((await api('calls.add', { external_unique_id: 'x', join_url: 'https://meet.example.com/abc' })).error, 'invalid_created_by');
    const added = await api('calls.add', {
      external_unique_id: 'meet-abc',
      join_url: 'https://meet.example.com/abc',
      external_display_id: 'abc-defg-hij',
      title: 'Design review',
      created_by: owner.userId,
      users: JSON.stringify([{ slack_id: owner.userId }, { external_id: 'guest-1', display_name: 'Pat (guest)', avatar_url: 'https://meet.example.com/pat.png' }]),
    });
    assert.equal(added.ok, true, JSON.stringify(added));
    const call = added.call;
    assert.match(call.id, /^R/);
    assert.deepEqual(Object.keys(call), ['id', 'date_start', 'external_unique_id', 'join_url', 'desktop_app_join_url', 'external_display_id', 'title', 'users']);
    assert.equal(call.users.length, 2);

    assert.equal((await api('chat.postMessage', { channel: general, blocks: [{ type: 'call', call_id: 'RNOPE' }], text: 'call' })).error, 'invalid_blocks');
    await api('conversations.join', { channel: general });
    const posted = await api('chat.postMessage', { channel: general, text: 'Design review started', blocks: [{ type: 'call', call_id: call.id }] });
    assert.equal(posted.ok, true, JSON.stringify(posted));

    const card = await mia.ok('client.calls.info', { id: call.id });
    assert.equal(card.call.app_name, 'Meet Bridge');
    assert.equal(card.call.is_active, true);

    const stream = await mia.connect();
    await api('calls.participants.add', { id: call.id, users: [{ slack_id: mia.userId }] });
    const joined = await stream.next((event) => event.type === 'call_updated');
    assert.equal(joined.call.users.length, 3);
    assert.equal((await api('calls.participants.add', { id: call.id, users: [{ slack_id: mia.userId }] })).error, 'bad_users');
    await api('calls.participants.remove', { id: call.id, users: [{ external_id: 'guest-1' }] });
    assert.equal((await stream.next((event) => event.type === 'call_updated' && event.call.users.length === 2)).call.users.length, 2);
    const updated = await api('calls.update', { id: call.id, title: 'Design review (overtime)' });
    assert.equal(updated.call.title, 'Design review (overtime)');
    assert.deepEqual(await api('calls.end', { id: call.id, duration: 1800 }), { ok: true });
    const ended = await stream.next((event) => event.type === 'call_updated' && event.call.is_active === false);
    assert.equal(ended.call.duration, 1800);
    stream.close();
    assert.equal((await api('calls.end', { id: call.id })).error, 'inactive_call');
    assert.equal((await api('calls.info', { id: call.id })).call.duration, 1800);
  });

  test('other apps cannot touch the call; people only see calls posted where they can read', async () => {
    const added = await api('calls.add', { external_unique_id: 'meet-private', join_url: 'https://meet.example.com/p', created_by: owner.userId });
    const other = (await owner.ok('client.apps.create', { name: 'Other' })).bot_token;
    assert.equal((await callWithToken(t.base, other, 'calls.info', { id: added.call.id })).error, 'invalid_call_id');
    assert.equal((await mia.call('client.calls.info', { id: added.call.id })).error, 'invalid_call_id', 'not posted anywhere yet');
    const secret = await owner.ok('conversations.create', { name: 'secret-room', is_private: true });
    await owner.ok('conversations.invite', { channel: secret.channel.id, users: (await owner.ok('client.boot')).users.find((user: Json) => user.name === 'meet.bridge')?.id ?? '' }).catch(() => undefined);
    await owner.ok('chat.postMessage', { channel: secret.channel.id, text: 'private call', blocks: [{ type: 'call', call_id: added.call.id }] });
    assert.equal((await mia.call('client.calls.info', { id: added.call.id })).error, 'invalid_call_id');
    assert.equal((await owner.ok('client.calls.info', { id: added.call.id })).call.id, added.call.id);
  });
});
