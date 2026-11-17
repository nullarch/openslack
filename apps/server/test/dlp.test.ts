import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { DETECTORS, findSensitive } from '../src/dlp/index.ts';
import { addMember, callWithToken, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

const all = { detectors: DETECTORS.map((detector) => detector.id), custom: [] };

describe('sensitive information', () => {
  test('detectors look at structure, not only shape', () => {
    assert.deepEqual(findSensitive(all, 'card 4111 1111 1111 1111 please'), ['Payment card numbers']);
    assert.deepEqual(findSensitive(all, 'order 4111 1111 1111 1112'), [], 'fails the Luhn check');
    assert.deepEqual(findSensitive(all, '주민번호 900101-1234567'), ['Korean resident registration numbers (주민등록번호)']);
    assert.deepEqual(findSensitive(all, 'ticket 901399-1234567'), [], 'month 13 is not a date');
    assert.deepEqual(findSensitive(all, 'SSN 123-45-6789'), ['US Social Security numbers']);
    assert.deepEqual(findSensitive(all, 'SSN 000-45-6789'), []);
    assert.deepEqual(findSensitive(all, 'AKIAIOSFODNN7EXAMPLE'), ['API keys, tokens and private keys']);
    // Built from pieces so the file itself never holds a key header (repository hooks look for them).
    const header = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');
    assert.deepEqual(findSensitive(all, `${header}\nabc`), ['API keys, tokens and private keys']);
    assert.deepEqual(findSensitive(all, 'the build is at 2026-11-17 10:00, ticket 12345'), []);
  });

  describe('in a workspace', () => {
    let t: TestApp;
    let owner: Session;
    let mia: Session;
    let general: string;

    before(async () => {
      t = await startApp();
      owner = await setupWorkspace(t);
      mia = await addMember(t, owner, 'Mia Member');
      general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    });
    after(() => t.close());

    test('off until an admin turns it on; then posts, edits, bots and Block Kit are checked', async () => {
      assert.equal((await mia.call('chat.postMessage', { channel: general, text: 'card 4111 1111 1111 1111' })).ok, true, 'nothing is checked by default');
      assert.equal((await mia.call('client.admin.dlp.set', { detectors: ['credit_card'] })).error, 'not_allowed');
      await owner.ok('client.admin.dlp.set', { detectors: ['credit_card', 'secrets'], custom: [{ name: 'Project codenames', pattern: '\\bbluebird\\b' }] });
      const blocked = await mia.call('chat.postMessage', { channel: general, text: 'my card is 4111-1111-1111-1111' });
      assert.equal(blocked.error, 'sensitive_information');
      assert.deepEqual(blocked.rules, ['Payment card numbers']);
      assert.equal((await mia.call('chat.postMessage', { channel: general, text: 'Bluebird ships Friday' })).error, 'sensitive_information');
      const fine = await mia.ok('chat.postMessage', { channel: general, text: 'nothing secret here' });
      assert.equal((await mia.call('chat.update', { channel: general, ts: fine.ts, text: 'key AKIAIOSFODNN7EXAMPLE' })).error, 'sensitive_information', 'edits are checked too');
      const bot = (await owner.ok('client.apps.create', { name: 'Deployer' })).bot_token;
      await callWithToken(t.base, bot, 'conversations.join', { channel: general });
      const fromBot = await callWithToken(t.base, bot, 'chat.postMessage', { channel: general, text: 'deploy', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }] });
      assert.equal(fromBot.error, 'sensitive_information', 'text inside blocks counts');

      const { entries } = await owner.ok('client.admin.audit.list', { action: 'message_blocked_sensitive' });
      assert.ok(entries.length >= 3);
      assert.ok(!JSON.stringify(entries).includes('4111'), 'the audit log never holds the text');
    });

    test('text inside uploaded files is checked too', async () => {
      const upload = async (name: string, content: string): Promise<Json> => {
        const form = new FormData();
        form.set('channels', general);
        form.set('file', new Blob([content]), name);
        return fetch(`${t.base}/api/files.upload`, { method: 'POST', headers: { cookie: mia.cookie, origin: t.base }, body: form }).then((r) => r.json() as Promise<Json>);
      };
      const refused = await upload('payments.csv', 'name,card\nAna,4111111111111111\n');
      assert.equal(refused.error, 'sensitive_information');
      assert.ok(!t.app.ctx.db.get("SELECT 1 FROM files WHERE name = 'payments.csv'"), 'nothing is left behind');
      assert.equal((await upload('notes.txt', 'nothing sensitive')).ok, true);
      assert.equal((await upload('photo.png', 'not text 4111111111111111')).ok, true, 'files without readable text are not checked');
    });

    test('dangerous patterns are refused; the test method previews a draft', async () => {
      assert.equal((await owner.call('client.admin.dlp.set', { custom: [{ name: 'bad', pattern: '(a+)+$' }] })).error, 'invalid_pattern');
      const preview = await owner.ok('client.admin.dlp.test', { text: 'SSN 123-45-6789', policy: { detectors: ['us_ssn'], custom: [] } });
      assert.deepEqual(preview.matches, ['US Social Security numbers']);
      const policy = await owner.ok('client.admin.dlp.get');
      assert.equal(policy.detectors.find((detector: Json) => detector.id === 'credit_card').enabled, true);
    });
  });
});
