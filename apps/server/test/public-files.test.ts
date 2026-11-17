import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, callWithToken, createBot, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

describe('public file links', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let fileId: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    const body = Buffer.from('quarterly numbers');
    const reserved = await member.ok('files.getUploadURLExternal', { filename: 'q3.txt', length: body.length });
    await fetch(reserved.upload_url, { method: 'POST', body });
    const done = await member.ok('files.completeUploadExternal', { files: [{ id: reserved.file_id }], channel_id: '#general' });
    fileId = done.files[0].id;
  });
  after(() => t.close());

  test('the uploader shares a link that works signed out, and revoking it ends it', async () => {
    const shared = await member.ok('files.sharedPublicURL', { file: fileId });
    assert.equal(shared.file.public_url_shared, true);
    const link: string = shared.file.permalink_public;
    assert.match(link, /\/files-pub\/T[A-Z0-9]+-F[A-Z0-9]+-[a-z0-9]+$/);
    const anonymous = await fetch(link.replace(/^http:\/\/localhost:\d+/, t.base));
    assert.equal(anonymous.status, 200);
    assert.equal(await anonymous.text(), 'quarterly numbers');
    assert.equal(anonymous.headers.get('x-robots-tag'), 'noindex');
    assert.equal((await member.call('files.sharedPublicURL', { file: fileId })).error, 'already_public');

    // A guessed secret does not work.
    assert.equal((await fetch(`${t.base}${new URL(link).pathname.replace(/-[a-z0-9]+$/, '-aaaaaaaaaaaaaaaaaaaa')}`)).status, 404);

    const revoked = await member.ok('files.revokePublicURL', { file: fileId });
    assert.equal(revoked.file.public_url_shared, false);
    assert.equal(revoked.file.permalink_public, undefined);
    assert.equal((await fetch(`${t.base}${new URL(link).pathname}`)).status, 404);
  });

  test('only the uploader or an admin, only people (not bots), and an admin can turn the feature off', async () => {
    const third = await addMember(t, owner, 'Theo Third');
    assert.equal((await third.call('files.sharedPublicURL', { file: fileId })).error, 'not_allowed');
    const bot = createBot(t, ['files:write', 'files:read']);
    assert.equal((await callWithToken(t.base, bot.token, 'files.sharedPublicURL', { file: fileId })).error, 'not_allowed_token_type');
    const admin = await owner.ok('files.sharedPublicURL', { file: fileId });
    assert.equal(admin.file.public_url_shared, true);
    const link = new URL(admin.file.permalink_public).pathname;

    // Turning the feature off stops existing links too.
    t.app.ctx.db.run(`UPDATE team SET prefs = json_set(prefs, '$.public_file_links', json('false'))`);
    t.app.ctx.invalidateTeam();
    assert.equal((await fetch(`${t.base}${link}`)).status, 404);
    await owner.ok('files.revokePublicURL', { file: fileId });
    assert.equal((await member.call('files.sharedPublicURL', { file: fileId })).error, 'not_allowed');
    const files: Json = await member.ok('files.info', { file: fileId });
    assert.equal(files.file.public_url_shared, false);
  });
});
