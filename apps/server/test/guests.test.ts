import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createToken } from '../src/core/auth.ts';
import { addMember, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';

async function signupGuest(t: TestApp, owner: Session, email: string, guest: 'multi' | 'single', channels: string[], extra: Record<string, unknown> = {}): Promise<Session> {
  const { invite } = await owner.ok('client.invites.create', { email, guest, channels, ...extra });
  const session = new Session(t.base);
  const result = await session.ok('client.signup', { code: invite.code, email, password: 'a guest password', real_name: email.split('@')[0] });
  session.userId = result.user_id;
  return session;
}

describe('guests', () => {
  let t: TestApp;
  let owner: Session;
  let mina: Session;
  let guest: Session;
  let general: string;
  let project: string;
  let secret: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    mina = await addMember(t, owner, 'Mina Member');
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    project = (await owner.ok('conversations.create', { name: 'project' })).channel.id;
    secret = (await owner.ok('conversations.create', { name: 'secret', is_private: true })).channel.id;
    await owner.ok('chat.postMessage', { channel: general, text: 'zebra crossing in general' });
    await owner.ok('chat.postMessage', { channel: project, text: 'zebra crossing in project' });
  });
  after(() => t.close());

  test('only admins invite guests, to named channels', async () => {
    assert.equal((await mina.call('client.invites.create', { email: 'g@x.test', guest: 'multi', channels: [project] })).error, 'not_allowed');
    assert.equal((await owner.call('client.invites.create', { email: 'g@x.test', guest: 'multi', channels: [] })).error, 'no_channels');
    assert.equal((await owner.call('client.invites.create', { guest: 'multi', channels: [project] })).error, 'invalid_email');
    assert.equal((await owner.call('client.invites.create', { email: 'g@x.test', guest: 'single', channels: [project, secret] })).error, 'single_channel_guest_needs_one_channel');

    guest = await signupGuest(t, owner, 'gus@agency.test', 'multi', [project]);
    const boot = await guest.ok('client.boot');
    assert.equal(boot.self.is_restricted, true);
    assert.equal(boot.self.is_ultra_restricted, false);
    assert.deepEqual(boot.channels.map((channel: Json) => channel.name), ['project']);
    assert.equal(boot.permissions.browse_channels, false);
    // Only the people in their channels exist for them.
    assert.deepEqual(boot.users.map((user: Json) => user.id).sort(), [owner.userId, guest.userId].sort());
    assert.ok(!Object.keys(boot.presence).includes(mina.userId));
    assert.equal(boot.self.profile.guest_invited_by, owner.userId);
  });

  test('channels outside theirs do not exist for a guest', async () => {
    const list = await guest.ok('conversations.list', { types: 'public_channel,private_channel' });
    assert.deepEqual(list.channels.map((channel: Json) => channel.name), ['project']);
    assert.equal((await guest.call('conversations.info', { channel: general })).error, 'channel_not_found');
    assert.equal((await guest.call('conversations.history', { channel: general })).error, 'channel_not_found');
    assert.equal((await guest.call('conversations.join', { channel: general })).error, 'channel_not_found');
    assert.equal((await guest.call('chat.postMessage', { channel: '#general', text: 'hi' })).error, 'channel_not_found');
    assert.deepEqual((await guest.ok('client.channels.browse')).channels.map((channel: Json) => channel.name), ['project']);
    const found = await guest.ok('search.messages', { query: 'zebra' });
    assert.equal(found.messages.total, 1);
    assert.equal(found.messages.matches[0].channel.name, 'project');
    assert.equal((await guest.ok('search.messages', { query: 'zebra in:#general' })).messages.total, 0);
  });

  test('people outside their channels do not exist for a guest, and cannot be messaged', async () => {
    assert.equal((await guest.call('users.info', { user: mina.userId })).error, 'user_not_found');
    assert.equal((await guest.call('users.lookupByEmail', { email: 'mina.member@acme.test' })).error, 'user_not_found');
    assert.equal((await guest.call('users.getPresence', { user: mina.userId })).error, 'user_not_found');
    const people = (await guest.ok('users.list')).members.map((user: Json) => user.id);
    assert.ok(!people.includes(mina.userId));
    assert.equal((await guest.call('conversations.open', { users: mina.userId })).error, 'user_not_found');
    assert.equal((await guest.call('chat.postMessage', { channel: mina.userId, text: 'hi' })).error, 'user_not_found');
    assert.equal((await mina.call('conversations.open', { users: guest.userId })).error, 'restricted_action');
    // Someone they share a channel with is fine, both ways.
    await guest.ok('conversations.open', { users: owner.userId });
    await owner.ok('chat.postMessage', { channel: guest.userId, text: 'welcome' });
  });

  test('a guest’s tab hears only about their channels and people', async () => {
    const stream = await guest.connect();
    await owner.ok('conversations.create', { name: 'brand-new' });
    await owner.ok('chat.postMessage', { channel: general, text: 'general chatter' });
    await addMember(t, owner, 'Late Joiner');
    await mina.ok('users.profile.set', { profile: { title: 'Changed title' } });
    await owner.ok('chat.postMessage', { channel: project, text: 'project marker' });
    await stream.next((event) => event.type === 'message' && event.text === 'project marker');
    await new Promise((resolve) => setTimeout(resolve, 100));
    stream.close();
    const types = stream.events.map((event) => `${event.type}:${event.channel?.name ?? event.channel ?? event.user?.id ?? ''}`);
    assert.ok(!types.some((entry) => entry.startsWith('channel_created')), types.join(' '));
    assert.ok(!stream.events.some((event) => event.text === 'general chatter'));
    assert.ok(!stream.events.some((event) => event.type === 'team_join'));
    assert.ok(!stream.events.some((event) => event.type === 'user_change' && event.user.id === mina.userId));
  });

  test('guests cannot create channels, invite, add people or manage groups', async () => {
    assert.equal((await guest.call('conversations.create', { name: 'guest-room' })).error, 'restricted_action');
    assert.equal((await guest.call('client.invites.create', {})).error, 'restricted_action');
    assert.equal((await guest.call('conversations.invite', { channel: project, users: owner.userId })).error, 'restricted_action');
    assert.equal((await guest.call('usergroups.create', { name: 'Guests' })).error, 'permission_denied');
    assert.deepEqual((await guest.ok('usergroups.list')).usergroups, []);
    assert.equal((await guest.call('client.inviteRequests.create', { email: 'x@y.test' })).error, 'not_allowed');
  });

  test('newer lists follow the same rules: file search, RTM start, Do Not Disturb', async () => {
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const { upload_url, file_id } = await owner.ok('files.getUploadURLExternal', { filename: 'zebra-general.png', length: PNG.length });
    await fetch(upload_url, { method: 'POST', body: PNG });
    await owner.ok('files.completeUploadExternal', { files: [{ id: file_id }], channel_id: general });
    assert.equal((await mina.ok('search.files', { query: 'zebra' })).files.total, 1);
    assert.equal((await guest.ok('search.files', { query: 'zebra' })).files.total, 0);

    const token = createToken(t.app.ctx, { kind: 'user', userId: guest.userId, scopes: ['rtm:stream', 'users:read', 'dnd:read'] });
    const call = async (method: string, args: Record<string, string> = {}): Promise<Json> =>
      (await fetch(`${t.base}/api/${method}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(args) })).json();
    const started = await call('rtm.start');
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.ok(!started.users.some((user: Json) => user.id === mina.userId));
    assert.ok(started.users.some((user: Json) => user.id === owner.userId));
    const team = await call('dnd.teamInfo');
    assert.equal(team.ok, true, JSON.stringify(team));
    assert.ok(!Object.keys(team.users).includes(mina.userId));
    const one = await call('dnd.info', { user: mina.userId });
    assert.ok(!one.ok);
  });

  test('a single-channel guest stays in one channel; only admins add guests', async () => {
    const single = await signupGuest(t, owner, 'sol@agency.test', 'single', [project]);
    const boot = await single.ok('client.boot');
    assert.equal(boot.self.is_ultra_restricted, true);
    assert.equal((await owner.call('conversations.invite', { channel: secret, users: single.userId })).error, 'ura_max_channels');
    assert.equal((await mina.call('conversations.invite', { channel: general, users: guest.userId })).error, 'restricted_action');
    await owner.ok('conversations.invite', { channel: secret, users: guest.userId });
    assert.deepEqual((await guest.ok('client.boot')).channels.filter((channel: Json) => channel.is_channel).map((channel: Json) => channel.name).sort(), ['project', 'secret']);
  });

  test('a group DM with guests becomes a private channel only under the guest rules', async () => {
    const solo = await signupGuest(t, owner, 'sam@agency.test', 'single', [project]);
    const pia = await addMember(t, owner, 'Pia Project');
    await owner.ok('conversations.invite', { channel: project, users: pia.userId });
    const group = (await owner.ok('conversations.open', { users: `${solo.userId},${pia.userId}` })).channel.id;
    // Guests create no channels; members do not add guests to one; a single-channel guest stays in one.
    assert.equal((await solo.call('client.conversations.convertGroupDm', { channel: group, name: 'solo-room' })).error, 'restricted_action');
    assert.equal((await pia.call('client.conversations.convertGroupDm', { channel: group, name: 'solo-room' })).error, 'restricted_action');
    assert.equal((await owner.call('client.conversations.convertGroupDm', { channel: group, name: 'solo-room' })).error, 'ura_max_channels');
    // Someone outside the conversation learns nothing about it.
    assert.equal((await mina.call('client.conversations.convertGroupDm', { channel: group, name: 'solo-room' })).error, 'channel_not_found');

    const withGuest = (await owner.ok('conversations.open', { users: `${guest.userId},${pia.userId}` })).channel.id;
    assert.equal((await pia.call('client.conversations.convertGroupDm', { channel: withGuest, name: 'guest-room' })).error, 'restricted_action');
    await owner.ok('client.conversations.convertGroupDm', { channel: withGuest, name: 'guest-room' });
    assert.ok((await guest.ok('client.boot')).channels.some((channel: Json) => channel.name === 'guest-room'));
  });

  test('a guest’s API token and MCP tools follow the same rules', async () => {
    const token = createToken(t.app.ctx, { kind: 'user', userId: guest.userId, scopes: ['search:read', 'channels:read', 'channels:history', 'users:read'] });
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${t.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const found = JSON.parse(((await client.callTool({ name: 'search_messages', arguments: { query: 'zebra' } })) as Json).content[0].text);
    assert.equal(found.total, 1);
    const users = JSON.parse(((await client.callTool({ name: 'list_users', arguments: {} })) as Json).content[0].text);
    assert.ok(!users.some((user: Json) => user.id === mina.userId));
    await client.close();
  });

  test('an expired guest is signed out and cannot sign back in', async () => {
    const temp = await signupGuest(t, owner, 'tim@agency.test', 'multi', [project], { guest_expires_in_days: 30 });
    assert.ok((await temp.ok('client.boot')).self.profile.guest_expiration_ts > 0);
    t.app.ctx.db.run('UPDATE users SET guest_expires = ? WHERE id = ?', Math.floor(Date.now() / 1000) - 1, temp.userId);
    assert.equal((await temp.call('auth.test')).error, 'account_inactive');
    assert.equal((await new Session(t.base).call('client.signin', { email: 'tim@agency.test', password: 'a guest password' })).error, 'account_inactive');
    assert.equal((await owner.ok('users.info', { user: temp.userId })).user.deleted, true);
  });

  test('an admin can make a guest a full member', async () => {
    assert.equal((await mina.call('client.admin.setAccountType', { user: guest.userId, type: 'member' })).error, 'not_allowed');
    await owner.ok('client.admin.setAccountType', { user: guest.userId, type: 'member' });
    assert.equal((await guest.ok('conversations.info', { channel: general })).channel.name, 'general');
    assert.equal((await guest.ok('users.info', { user: mina.userId })).user.id, mina.userId);
  });
});
