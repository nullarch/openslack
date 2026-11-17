import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { after, before, describe, test } from 'node:test';
import { WebClient } from '@slack/web-api';
import { setupWorkspace, startApp, type Json, type Session, type TestApp } from '@app/server/test/helpers.ts';
import { recordTokenCalls, saveExercised } from './harness.ts';

const require = createRequire(import.meta.url);
const version = (name: string): string => (JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as { version: string }).version;

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/**
 * The remote-file calls a Google Drive or Dropbox integration makes, through
 * the official Web API client unmodified (it sends preview_image and
 * indexable_file_contents as multipart parts).
 */
describe('@slack/web-api: remote files', () => {
  let t: TestApp;
  let owner: Session;
  let client: WebClient;
  let channel: string;
  let called: Set<string>;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    called = recordTokenCalls(t);
    const created = await owner.ok('client.apps.create', { name: 'Drive' });
    client = new WebClient(created.bot_token, { slackApiUrl: `${t.base}/api/` });
    channel = (await owner.ok('conversations.create', { name: 'docs' })).channel.id;
    await owner.ok('conversations.invite', { channel, users: created.app.bot_user_id });
  });
  after(async () => {
    saveExercised('web-api-remote-files', `@slack/web-api ${version('@slack/web-api')}`, called, []);
    await t.close();
  });

  test('add, share, info, list, update and remove', async () => {
    const added = await client.files.remote.add({
      external_id: 'drive-123',
      external_url: 'https://drive.example.test/file/123',
      title: 'Design review notes',
      filetype: 'gdoc',
      preview_image: PNG_1x1,
      indexable_file_contents: Buffer.from('typography spacing contrast'),
    });
    assert.equal(added.ok, true);
    const file = added.file as Json;
    assert.equal(file.is_external, true);
    assert.equal(file.external_id, 'drive-123');
    assert.ok(file.thumb_360);

    const shared = await client.files.remote.share({ channels: channel, external_id: 'drive-123' });
    assert.deepEqual((shared.file as Json).channels, [channel]);
    const history = await owner.ok('conversations.history', { channel, limit: 1 });
    assert.equal(history.messages[0].files[0].title, 'Design review notes');
    assert.equal((await owner.ok('search.files', { query: 'spacing contrast' })).files.total, 1);

    const info = await client.files.remote.info({ file: file.id });
    assert.equal((info.file as Json).external_url, 'https://drive.example.test/file/123');
    const list = await client.files.remote.list({ channel });
    assert.deepEqual((list.files as Json[]).map((item) => item.id), [file.id]);

    const updated = await client.files.remote.update({ external_id: 'drive-123', title: 'Design review notes (v2)' });
    assert.equal((updated.file as Json).title, 'Design review notes (v2)');

    await client.files.remote.remove({ external_id: 'drive-123' });
    await assert.rejects(client.files.remote.info({ external_id: 'drive-123' }), (error: Json) => error.data.error === 'file_not_found');
  });
});
