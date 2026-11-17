import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { vttText } from '../src/clips/vtt.ts';
import { addMember, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

async function upload(session: Session, name: string, data: Buffer): Promise<string> {
  const { upload_url, file_id } = await session.ok('files.getUploadURLExternal', { filename: name, length: data.length });
  await fetch(upload_url, { method: 'POST', body: data });
  return file_id;
}

const VTT = `WEBVTT

00:00.400 --> 00:02.900
Here is the new checkout flow.

00:03.100 --> 00:06.000
Watch the <b>coupon</b> field &amp; the total.
`;

describe('clips', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let outsider: Session;
  let channel: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    outsider = await addMember(t, owner, 'Otto Outsider');
    channel = (await owner.ok('conversations.create', { name: 'design-review', is_private: true })).channel.id;
    await owner.ok('conversations.invite', { channel, users: member.userId });
  });
  after(() => t.close());

  test('the words of a WebVTT file, without timings or tags', () => {
    assert.equal(vttText(VTT), 'Here is the new checkout flow.\nWatch the coupon field & the total.');
  });

  test('the recorder attaches captions; people in the channel get them, search finds what was said', async () => {
    const id = await upload(owner, 'Clip 2026-11-17 18.03.webm', Buffer.from('not really a video'));
    const set = await owner.ok('client.files.setTranscript', { file: id, vtt: VTT, locale: 'en-US' });
    assert.equal(set.file.transcription.status, 'complete');
    await owner.ok('files.completeUploadExternal', { files: JSON.stringify([{ id }]), channel_id: channel });

    const file = (await member.ok('files.info', { file: id })).file;
    assert.equal(file.mimetype, 'video/webm');
    assert.deepEqual(file.transcription.preview, { content: 'Here is the new checkout flow.\nWatch the coupon field & the total.', has_more: false });
    assert.equal(file.transcription.locale, 'en-US');
    const vtt = await fetch(`${t.base}${new URL(file.transcription.vtt_url).pathname}`, { headers: { cookie: member.cookie } });
    assert.equal(vtt.status, 200);
    assert.match(vtt.headers.get('content-type') ?? '', /^text\/vtt/);
    assert.equal(await vtt.text(), VTT);
    // Outside the private channel the captions do not exist either.
    const denied = await fetch(`${t.base}${new URL(file.transcription.vtt_url).pathname}`, { headers: { cookie: outsider.cookie } });
    assert.equal(denied.status, 404);

    const found = (await member.ok('search.files', { query: 'coupon field' })).files;
    assert.equal(found.total, 1);
    assert.equal((await outsider.ok('search.files', { query: 'coupon field' })).files.total, 0);
  });

  test('only the uploader, only for recordings, only real WebVTT', async () => {
    const audio = await upload(owner, 'Audio clip.weba', Buffer.from('opus'));
    assert.equal((await member.call('client.files.setTranscript', { file: audio, vtt: VTT })).error, 'file_not_found');
    assert.equal((await owner.call('client.files.setTranscript', { file: audio, vtt: 'hello' })).error, 'invalid_transcript');
    assert.equal((await owner.call('client.files.setTranscript', { file: audio, vtt: 'WEBVTT\n\nsoon --> later\nhi\n' })).error, 'invalid_transcript');
    const ok = await owner.ok('client.files.setTranscript', { file: audio, vtt: VTT });
    assert.equal(ok.file.mimetype, 'audio/webm');
    const text = await upload(owner, 'notes.txt', Buffer.from('notes'));
    assert.equal((await owner.call('client.files.setTranscript', { file: text, vtt: VTT })).error, 'not_a_recording');
  });

  test('sensitive-information rules apply to what was said', async () => {
    await owner.ok('client.admin.dlp.set', { detectors: ['credit_card'] });
    const id = await upload(owner, 'Clip card.webm', Buffer.from('video'));
    const said = 'WEBVTT\n\n00:00.000 --> 00:03.000\nMy card is 4111 1111 1111 1111\n';
    const refused = (await owner.call('client.files.setTranscript', { file: id, vtt: said })) as Json;
    assert.equal(refused.ok, false);
    assert.equal((await owner.ok('files.info', { file: id })).file.transcription, undefined);
    await owner.ok('client.admin.dlp.set', { detectors: [] });
  });
});
