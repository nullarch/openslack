import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, callWithToken, createBot, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function upload(session: Session, name: string, data: Buffer): Promise<string> {
  const { upload_url, file_id } = await session.ok('files.getUploadURLExternal', { filename: name, length: data.length });
  await fetch(upload_url, { method: 'POST', body: data });
  return file_id;
}

describe('workspace settings', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
  });
  after(() => t.close());

  test('only admins read or change settings', async () => {
    assert.equal((await member.call('client.admin.settings')).error, 'not_allowed');
    assert.equal((await member.call('client.admin.updateSettings', { who_can_invite: 'admins' })).error, 'not_allowed');
    const { settings } = await owner.ok('client.admin.settings');
    assert.equal(settings.who_can_create_channels, 'everyone');
    assert.deepEqual(settings.signup_domains, []);
    assert.equal((await owner.call('client.admin.updateSettings', { who_can_invite: 'nobody' })).error, 'invalid_arguments');
  });

  test('approved domains limit shareable links; a deliberate invite to one address is still allowed', async () => {
    assert.equal((await owner.call('client.admin.updateSettings', { signup_domains: 'not a domain' })).error, 'invalid_domain');
    const { settings } = await owner.ok('client.admin.updateSettings', { signup_domains: '@Acme.test, acme.co' });
    assert.deepEqual(settings.signup_domains, ['acme.test', 'acme.co']);

    const { invite } = await owner.ok('client.invites.create', {});
    const info = await new Session(t.base).ok('client.invites.info', { code: invite.code });
    assert.deepEqual(info.signup_domains, ['acme.test', 'acme.co']);
    const outsider = await new Session(t.base).call('client.signup', { code: invite.code, email: 'x@gmail.test', password: 'long enough pw', real_name: 'X' });
    assert.equal(outsider.error, 'domain_not_allowed');
    await new Session(t.base).ok('client.signup', { code: invite.code, email: 'ok@acme.co', password: 'long enough pw', real_name: 'Ok' });

    assert.equal((await member.call('client.invites.create', { email: 'friend@gmail.test' })).error, 'domain_not_allowed');
    const direct = await owner.ok('client.invites.create', { email: 'contractor@gmail.test' });
    await new Session(t.base).ok('client.signup', { code: direct.invite.code, email: 'contractor@gmail.test', password: 'long enough pw', real_name: 'C' });
    await owner.ok('client.admin.updateSettings', { signup_domains: [] });
  });

  test('when only admins invite, members ask and an admin approves or denies', async () => {
    await owner.ok('client.admin.updateSettings', { who_can_invite: 'admins' });
    assert.equal((await member.call('client.invites.create', {})).error, 'restricted_action');
    assert.equal((await member.ok('client.permissions')).permissions.invite, false);

    const ownerStream = await owner.connect();
    const { request } = await member.ok('client.inviteRequests.create', { email: 'pal@acme.test', reason: 'New designer' });
    assert.equal(request.status, 'pending');
    await ownerStream.next((event) => event.type === 'invite_requests_changed' && event.pending === 1);
    ownerStream.close();
    assert.equal((await member.call('client.inviteRequests.create', { email: 'pal@acme.test' })).error, 'already_requested');
    assert.equal((await member.call('client.admin.inviteRequests.list')).error, 'not_allowed');
    assert.equal((await owner.call('client.inviteRequests.create', { email: 'x@acme.test' })).error, 'can_invite_directly');

    const { requests } = await owner.ok('client.admin.inviteRequests.list');
    assert.deepEqual(requests.map((item: Json) => [item.email, item.reason, item.requested_by]), [['pal@acme.test', 'New designer', member.userId]]);
    const approved = await owner.ok('client.admin.inviteRequests.approve', { id: request.id });
    assert.equal(approved.invite.email, 'pal@acme.test');
    await new Session(t.base).ok('client.signup', { code: approved.invite.code, email: 'pal@acme.test', password: 'long enough pw', real_name: 'Pal' });

    const second = await member.ok('client.inviteRequests.create', { email: 'nope@acme.test' });
    await owner.ok('client.admin.inviteRequests.deny', { id: second.request.id });
    assert.equal((await owner.call('client.admin.inviteRequests.approve', { id: second.request.id })).error, 'request_not_found');
    assert.deepEqual((await owner.ok('client.admin.inviteRequests.list')).requests, []);
    await owner.ok('client.admin.updateSettings', { who_can_invite: 'everyone' });
  });

  test('custom profile fields: admins define them, people fill them, apps read them', async () => {
    assert.equal((await member.call('client.admin.setProfileFields', { fields: [] })).error, 'not_allowed');
    const { profile } = await owner.ok('client.admin.setProfileFields', {
      fields: [
        { label: 'Team', type: 'options_list', possible_values: ['Engineering', 'Sales'] },
        { label: 'Started', type: 'date', hint: 'First day' },
        { label: 'GitHub', type: 'link' },
      ],
    });
    const [team, started, github] = profile.fields;
    assert.match(team.id, /^Xf/);
    assert.deepEqual(team.possible_values, ['Engineering', 'Sales']);
    assert.equal(started.hint, 'First day');

    await member.ok('users.profile.set', { profile: { fields: { [team.id]: { value: 'Engineering' }, [started.id]: { value: '2026-11-01' } }, title: 'Engineer' } });
    assert.equal((await member.call('users.profile.set', { profile: { fields: { [team.id]: { value: 'Marketing' } } } })).error, 'invalid_profile');
    assert.equal((await member.call('users.profile.set', { profile: { fields: { [github.id]: { value: 'javascript:alert(1)' } } } })).error, 'invalid_profile');
    assert.equal((await member.call('users.profile.set', { profile: { fields: { XfNOPE: { value: 'x' } } } })).error, 'invalid_profile');
    await member.ok('users.profile.set', { name: github.id, value: 'https://github.com/mina' });
    // Someone else's fields are off limits to a member.
    assert.equal((await member.call('users.profile.set', { user: owner.userId, profile: { fields: { [team.id]: { value: 'Sales' } } } })).error, 'cannot_update_admin_user');

    const seen = (await owner.ok('users.info', { user: member.userId })).user;
    assert.deepEqual(seen.profile.fields, {
      [team.id]: { value: 'Engineering', alt: '' },
      [started.id]: { value: '2026-11-01', alt: '' },
      [github.id]: { value: 'https://github.com/mina', alt: '' },
    });
    assert.equal(seen.profile.title, 'Engineer');

    const bot = createBot(t, ['users:read', 'users.profile:read']);
    const viaApp = await callWithToken(t.base, bot.token, 'team.profile.get', {});
    assert.deepEqual(viaApp.profile.fields.map((field: Json) => field.label), ['Team', 'Started', 'GitHub']);
    const boot = await member.ok('client.boot');
    assert.equal(boot.profile_fields.length, 3);

    // Clearing a value removes it.
    await member.ok('users.profile.set', { profile: { fields: { [github.id]: { value: '' } } } });
    assert.equal((await owner.ok('users.info', { user: member.userId })).user.profile.fields[github.id], undefined);
  });

  test('who may create channels, add emoji and use @channel is enforced on the server', async () => {
    await owner.ok('client.admin.updateSettings', { who_can_create_channels: 'admins', who_can_manage_emoji: 'admins', who_can_at_channel: 'admins' });
    assert.equal((await member.call('conversations.create', { name: 'members-cannot' })).error, 'restricted_action');
    await owner.ok('conversations.create', { name: 'admins-can' });
    const bot = createBot(t, ['channels:manage', 'chat:write']);
    assert.equal((await callWithToken(t.base, bot.token, 'conversations.create', { name: 'bots-cannot' })).error, 'restricted_action');

    const file = await upload(member, 'party.png', PNG);
    assert.equal((await member.call('admin.emoji.add', { name: 'party', file_id: file })).error, 'restricted_action');
    assert.equal((await member.call('admin.emoji.addAlias', { name: 'yay', alias_for: 'tada' })).error, 'restricted_action');

    assert.equal((await member.call('chat.postMessage', { channel: '#general', text: 'hey <!channel>' })).error, 'restricted_action');
    assert.equal((await member.call('chat.postMessage', { channel: '#general', text: 'hey <!here|here>' })).error, 'restricted_action');
    const richBroadcast = [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'broadcast', range: 'everyone' }] }] }];
    assert.equal((await member.call('chat.postMessage', { channel: '#general', text: 'x', blocks: richBroadcast })).error, 'restricted_action');
    const plain = await member.ok('chat.postMessage', { channel: '#general', text: 'no shouting' });
    assert.equal((await member.call('chat.update', { channel: '#general', ts: plain.ts, text: 'now <!channel>' })).error, 'restricted_action');
    await owner.ok('chat.postMessage', { channel: '#general', text: 'admins may <!channel>' });
    await callWithToken(t.base, bot.token, 'chat.postMessage', { channel: '#general', text: 'deploy failed <!here>' }).then((result) => assert.equal(result.ok, true));

    const { permissions } = await member.ok('client.permissions');
    assert.deepEqual(permissions, {
      create_channels: false,
      invite: true,
      manage_emoji: false,
      at_channel: false,
      manage_usergroups: true,
      browse_channels: true,
      public_file_links: true,
    });
    await owner.ok('client.admin.updateSettings', { who_can_create_channels: 'everyone', who_can_manage_emoji: 'everyone', who_can_at_channel: 'everyone' });
    await member.ok('chat.postMessage', { channel: '#general', text: 'allowed again <!channel>' });
  });

  test('turning a group DM into a private channel follows who may create channels', async () => {
    const third = await addMember(t, owner, 'Theo Third');
    const group = (await member.ok('conversations.open', { users: `${owner.userId},${third.userId}` })).channel.id;
    await owner.ok('client.admin.updateSettings', { who_can_create_channels: 'admins' });
    assert.equal((await member.call('client.conversations.convertGroupDm', { channel: group, name: 'trio' })).error, 'restricted_action');
    await owner.ok('client.admin.updateSettings', { who_can_create_channels: 'everyone' });
    const { channel } = await member.ok('client.conversations.convertGroupDm', { channel: group, name: 'trio' });
    assert.equal(channel.is_private, true);
    assert.equal(channel.name, 'trio');
  });

  test('public file links can be turned off for the whole workspace', async () => {
    const body = Buffer.from('board minutes');
    const reserved = await member.ok('files.getUploadURLExternal', { filename: 'minutes.txt', length: body.length });
    await fetch(reserved.upload_url, { method: 'POST', body });
    const fileId = (await member.ok('files.completeUploadExternal', { files: [{ id: reserved.file_id }], channel_id: '#general' })).files[0].id;
    const shared = await member.ok('files.sharedPublicURL', { file: fileId });
    const path = new URL(shared.file.permalink_public).pathname;
    assert.equal((await fetch(`${t.base}${path}`)).status, 200);

    assert.equal((await member.call('client.admin.updateSettings', { public_file_links: false })).error, 'not_allowed');
    const { settings } = await owner.ok('client.admin.updateSettings', { public_file_links: false });
    assert.equal(settings.public_file_links, false);
    assert.equal((await member.ok('client.permissions')).permissions.public_file_links, false);
    // Links already handed out stop working, and no new ones are made.
    assert.equal((await fetch(`${t.base}${path}`)).status, 404);
    await member.ok('files.revokePublicURL', { file: fileId });
    assert.equal((await member.call('files.sharedPublicURL', { file: fileId })).error, 'not_allowed');

    await owner.ok('client.admin.updateSettings', { public_file_links: true });
    await member.ok('files.sharedPublicURL', { file: fileId });
    // The other settings in the same record are untouched.
    assert.equal((await owner.ok('client.admin.settings')).settings.who_can_create_channels, 'everyone');
  });

  test('default channels: new people join them; private ones only by an admin who is in them', async () => {
    const { channel: onboarding } = await owner.ok('conversations.create', { name: 'onboarding' });
    const { channel: secret } = await member.ok('conversations.create', { name: 'members-secret', is_private: true });
    assert.equal((await owner.call('client.admin.updateSettings', { default_channels: [secret.id] })).error, 'channel_not_found');
    await owner.ok('client.admin.updateSettings', { default_channels: [onboarding.id] });
    const newcomer = await addMember(t, owner, 'Nova Newcomer');
    const names = (await newcomer.ok('client.boot')).channels.map((channel: Json) => channel.name).sort();
    assert.deepEqual(names, ['general', 'onboarding']);
  });

  test('a team icon replaces the generated one', async () => {
    const file = await upload(owner, 'icon.png', PNG);
    assert.equal((await member.call('client.admin.setTeamIcon', { file_id: file })).error, 'not_allowed');
    const { team } = await owner.ok('client.admin.setTeamIcon', { file_id: file });
    assert.equal(team.icon.image_default, false);
    const icon = await fetch(`${t.base}${new URL(team.icon.image_132).pathname}`);
    assert.equal(icon.headers.get('content-type'), 'image/png');
    assert.equal((await owner.ok('team.info')).team.icon.image_default, false);
  });

  test('converting a public channel to private hides it from everyone outside it', async () => {
    const { channel } = await owner.ok('conversations.create', { name: 'plans' });
    await owner.ok('chat.postMessage', { channel: channel.id, text: 'the codename is pelican' });
    const outsider = await addMember(t, owner, 'Otto Outsider');
    assert.equal((await outsider.ok('conversations.info', { channel: channel.id })).channel.name, 'plans');
    assert.equal((await outsider.ok('search.messages', { query: 'pelican' })).messages.total, 1);

    assert.equal((await member.call('admin.conversations.convertToPrivate', { channel_id: channel.id })).error, 'not_allowed');
    const general = (await owner.ok('client.boot')).channels.find((entry: Json) => entry.is_general);
    assert.equal((await owner.call('admin.conversations.convertToPrivate', { channel_id: general.id })).error, 'cant_convert_general');

    const stream = await outsider.connect();
    await owner.ok('admin.conversations.convertToPrivate', { channel_id: channel.id });
    await stream.next((event) => event.type === 'channel_left' && event.channel === channel.id);
    stream.close();
    assert.equal((await outsider.call('conversations.info', { channel: channel.id })).error, 'channel_not_found');
    assert.equal((await outsider.ok('search.messages', { query: 'pelican' })).messages.total, 0);
    assert.equal((await outsider.call('conversations.join', { channel: channel.id })).error, 'channel_not_found');
    assert.equal((await owner.ok('conversations.info', { channel: channel.id })).channel.is_private, true);
    assert.equal((await owner.call('admin.conversations.convertToPrivate', { channel_id: channel.id })).error, 'method_not_supported_for_channel_type');
  });

  test('requiring two-factor sign-in needs the admin to have it first', async () => {
    assert.equal((await owner.call('client.admin.updateSettings', { require_2fa: true })).error, 'two_factor_required_first');
  });
});
