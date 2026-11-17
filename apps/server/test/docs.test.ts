import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { runDueSweep } from '../src/docs/lists.ts';
import { createListItem } from '../src/docs/index.ts';
import { addMember, callWithToken, createBot, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';

/** A minimal y-websocket client: what the editor's provider does, without an editor. */
class CanvasClient {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly socket: WebSocket;
  readonly synced: Promise<void>;
  readonly closed: Promise<number>;

  constructor(base: string, id: string, cookie: string) {
    this.socket = new WebSocket(`${base.replace('http', 'ws')}/canvas/${id}`, { headers: { cookie } });
    this.socket.binaryType = 'arraybuffer';
    this.closed = new Promise((resolve) => this.socket.once('close', (code) => resolve(code)));
    let markSynced: () => void = () => {};
    let failSync: (error: Error) => void = () => {};
    this.synced = new Promise((resolve, reject) => {
      markSynced = resolve;
      failSync = reject;
    });
    this.socket.once('unexpected-response', (_req, res) => failSync(new Error(`refused: ${res.statusCode}`)));
    this.socket.once('error', (error) => failSync(error));
    this.socket.on('open', () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.socket.send(encoding.toUint8Array(encoder));
    });
    this.socket.on('message', (data: ArrayBuffer) => {
      const decoder = decoding.createDecoder(new Uint8Array(data));
      const type = decoding.readVarUint(decoder);
      if (type === 0) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        const step = syncProtocol.readSyncMessage(decoder, encoder, this.doc, 'remote');
        if (encoding.length(encoder) > 1) this.socket.send(encoding.toUint8Array(encoder));
        if (step === syncProtocol.messageYjsSyncStep2) markSynced();
      } else if (type === 1) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), 'remote');
      }
    });
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote' || this.socket.readyState !== WebSocket.OPEN) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeUpdate(encoder, update);
      this.socket.send(encoding.toUint8Array(encoder));
    });
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === 'remote' || this.socket.readyState !== WebSocket.OPEN) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 1);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]));
      this.socket.send(encoding.toUint8Array(encoder));
    });
  }

  get fragment(): Y.XmlFragment {
    return this.doc.getXmlFragment('default');
  }

  /** Append a paragraph, the way the editor would write one. */
  addParagraph(text: string): void {
    const paragraph = new Y.XmlElement('paragraph');
    const run = new Y.XmlText();
    run.insert(0, text);
    paragraph.insert(0, [run]);
    this.fragment.insert(this.fragment.length, [paragraph]);
  }

  text(): string {
    return this.fragment
      .toArray()
      .map((node) => (node instanceof Y.XmlElement ? node.toArray().map((child) => (child instanceof Y.XmlText ? child.toString() : '')).join('') : ''))
      .join('\n');
  }

  /** Disconnect; the awareness timer is stopped too so the test process can exit. */
  close(): void {
    this.socket.close();
    this.awareness.destroy();
  }
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(40);
  }
  throw new Error('condition not met in time');
}

const md = (markdown: string): Json => ({ type: 'markdown', markdown });
// A 2×2 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQoYGBgAGwQBAfMqSXQAAAAASUVORK5CYII=', 'base64');

describe('canvases', () => {
  let test_: TestApp;
  let owner: Session;
  let mina: Session;
  let jun: Session;
  let outsider: Session;
  let channel: string;
  let secret: string;

  before(async () => {
    test_ = await startApp();
    owner = await setupWorkspace(test_);
    mina = await addMember(test_, owner, 'Mina Park');
    jun = await addMember(test_, owner, 'Jun Lee');
    outsider = await addMember(test_, owner, 'Ola Out');
    channel = (await owner.ok('conversations.create', { name: 'design' })).channel.id;
    await owner.ok('conversations.invite', { channel, users: mina.userId });
    secret = (await owner.ok('conversations.create', { name: 'secret-plans', is_private: true })).channel.id;
  });
  after(() => test_.close());

  test('Slack methods: create from Markdown, look up sections, edit by section, rename, read back', async () => {
    const bot = createBot(test_, ['canvases:write', 'canvases:read']);
    const created = await callWithToken(test_.base, bot.token, 'canvases.create', {
      title: 'Launch plan',
      document_content: md('# Launch plan\n\nWe ship on **Friday** with [docs](https://example.com).\n\n## Risks\n\n- [ ] Load test\n- [x] Legal review\n\n> Keep it small.\n\n```ts\nconst x = 1;\n```\n\n| Owner | Task |\n| --- | --- |\n| Mina | Copy |\n\n---\n\nPing ![](@' + mina.userId + ') in ![](#' + channel + ')'),
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const id = created.canvas_id;
    assert.match(id, /^F[A-Z0-9]+$/);

    const headers = await callWithToken(test_.base, bot.token, 'canvases.sections.lookup', { canvas_id: id, criteria: { section_types: ['h2'] } });
    assert.equal(headers.ok, true, JSON.stringify(headers));
    assert.equal(headers.sections.length, 1);
    assert.match(headers.sections[0].id, /^temp:C:/);
    const any = await callWithToken(test_.base, bot.token, 'canvases.sections.lookup', { canvas_id: id, criteria: { section_types: ['any_header'] } });
    assert.equal(any.sections.length, 2);
    const byText = await callWithToken(test_.base, bot.token, 'canvases.sections.lookup', { canvas_id: id, criteria: { contains_text: 'friday' } });
    assert.equal(byText.sections.length, 1);

    const edited = await callWithToken(test_.base, bot.token, 'canvases.edit', {
      canvas_id: id,
      changes: [
        { operation: 'insert_after', section_id: headers.sections[0].id, document_content: md('Inserted after risks heading.') },
        { operation: 'insert_at_end', document_content: md('The end.') },
        { operation: 'insert_at_start', document_content: md('Draft — do not share.') },
        { operation: 'replace', section_id: byText.sections[0].id, document_content: md('We ship on **Monday**.') },
        { operation: 'rename', title_content: md('Launch plan v2') },
      ],
    });
    assert.equal(edited.ok, true, JSON.stringify(edited));
    const content = await callWithToken(test_.base, bot.token, 'canvases.getContent', { canvas_id: id });
    const text: string = content.content;
    assert.ok(text.startsWith('Draft — do not share.\n\n# Launch plan'), text);
    assert.match(text, /## Risks\n\nInserted after risks heading\./);
    assert.match(text, /We ship on \*\*Monday\*\*\./);
    assert.doesNotMatch(text, /Friday/);
    assert.match(text, /- \[ \] Load test\n- \[x\] Legal review/);
    assert.match(text, /> Keep it small\./);
    assert.match(text, /```ts\nconst x = 1;\n```/);
    assert.match(text, /\| Owner \| Task \|/);
    assert.match(text, new RegExp(`!\\[\\]\\(@${mina.userId}\\)`));
    assert.match(text, /The end\.$/);
    const html: string = (await callWithToken(test_.base, bot.token, 'canvases.getContent', { canvas_id: id, content_type: 'html' })).content;
    assert.match(html, /<h1>Launch plan<\/h1>/);
    assert.match(html, /<p>We ship on <strong>Monday<\/strong>\.<\/p>/);
    assert.match(html, /<ul data-type="taskList"><li data-checked="false"><p>Load test<\/p><\/li><li data-checked="true">/);
    assert.match(html, /<pre><code>const x = 1;<\/code><\/pre>/);
    assert.match(html, /<th><p>Owner<\/p><\/th>/);
    assert.match(html, new RegExp(`<span data-type="mention" data-id="${mina.userId}">@Mina Park</span>`));
    assert.equal((await callWithToken(test_.base, bot.token, 'canvases.getContent', { canvas_id: id, content_type: 'pdf' })).error, 'invalid_arguments');

    const deleted =await callWithToken(test_.base, bot.token, 'canvases.edit', {
      canvas_id: id,
      changes: [{ operation: 'delete', section_id: (await callWithToken(test_.base, bot.token, 'canvases.sections.lookup', { canvas_id: id, criteria: { contains_text: 'Draft' } })).sections[0].id }],
    });
    assert.equal(deleted.ok, true);
    const bad = await callWithToken(test_.base, bot.token, 'canvases.edit', { canvas_id: id, changes: [{ operation: 'insert_after', section_id: 'temp:C:NOPE', document_content: md('x') }] });
    assert.equal(bad.error, 'canvas_editing_failed');
    assert.equal((await callWithToken(test_.base, bot.token, 'canvases.edit', { canvas_id: id, changes: [{ operation: 'explode' }] })).error, 'canvas_editing_failed');

    // A canvas the bot did not share is not there for anyone else.
    assert.equal((await mina.call('client.canvases.info', { canvas_id: id })).error, 'canvas_not_found');
    assert.equal((await callWithToken(test_.base, bot.token, 'canvases.delete', { canvas_id: id })).ok, true);
    assert.equal((await callWithToken(test_.base, bot.token, 'canvases.sections.lookup', { canvas_id: id, criteria: { contains_text: 'x' } })).error, 'canvas_not_found');
  });

  test('channel canvases: members edit, others in the workspace read public ones, private ones do not exist for outsiders', async () => {
    const made = await owner.ok('conversations.canvases.create', { channel_id: channel, document_content: md('Channel notes') });
    assert.equal((await owner.call('conversations.canvases.create', { channel_id: channel })).error, 'channel_canvas_already_exists');
    const id = made.canvas_id;
    assert.equal((await mina.ok('client.canvases.info', { canvas_id: id })).canvas.access_level, 'write');
    assert.equal((await jun.ok('client.canvases.info', { canvas_id: id })).canvas.access_level, 'read');
    assert.equal((await jun.call('canvases.edit', { canvas_id: id, changes: [{ operation: 'insert_at_end', document_content: md('nope') }] })).error, 'access_denied');
    const tabs = await mina.ok('client.docs.list', { channel });
    assert.ok(tabs.docs.some((doc: Json) => doc.id === id));

    const hidden = await owner.ok('canvases.create', { title: 'Secret roadmap', channel_id: secret, document_content: md('acquisition of zebracorp') });
    assert.equal((await mina.call('client.canvases.info', { canvas_id: hidden.canvas_id })).error, 'canvas_not_found');
    assert.equal((await mina.call('canvases.edit', { canvas_id: hidden.canvas_id, changes: [{ operation: 'insert_at_end', document_content: md('x') }] })).error, 'canvas_not_found');
    assert.equal((await mina.call('canvases.create', { title: 'x', channel_id: secret })).error, 'channel_not_found');
  });

  test('sharing with people: read, write, removed; only the owner manages access', async () => {
    const { canvas_id: id } = await owner.ok('canvases.create', { title: 'Shared doc', document_content: md('hello') });
    assert.equal((await jun.call('client.canvases.info', { canvas_id: id })).error, 'canvas_not_found');
    await owner.ok('canvases.access.set', { canvas_id: id, access_level: 'read', user_ids: [jun.userId] });
    assert.equal((await jun.ok('client.canvases.info', { canvas_id: id })).canvas.access_level, 'read');
    assert.equal((await jun.call('canvases.access.set', { canvas_id: id, access_level: 'write', user_ids: [jun.userId] })).error, 'restricted_action');
    await owner.ok('canvases.access.set', { canvas_id: id, access_level: 'write', user_ids: [jun.userId] });
    await jun.ok('canvases.edit', { canvas_id: id, changes: [{ operation: 'insert_at_end', document_content: md('from jun') }] });
    const both = await owner.call('canvases.access.set', { canvas_id: id, access_level: 'read', user_ids: [jun.userId], channel_ids: [channel] });
    assert.equal(both.error, 'invalid_arguments');
    const partial = await owner.ok('canvases.access.set', { canvas_id: id, access_level: 'read', user_ids: [jun.userId, 'UNOPE'] });
    assert.deepEqual(partial.failed_to_update_user_ids, ['UNOPE']);
    await owner.ok('canvases.access.delete', { canvas_id: id, user_ids: [jun.userId] });
    assert.equal((await jun.call('client.canvases.info', { canvas_id: id })).error, 'canvas_not_found');
  });

  test('search finds canvas text only for people who can open it, including short Korean words', async () => {
    const { canvas_id: open } = await owner.ok('canvases.create', { title: 'Public', channel_id: channel, document_content: md('The pelican migration report. 회의 결과') });
    await owner.ok('canvases.create', { title: 'Private', document_content: md('pelican secrets nobody else may find') });
    const minaHits = await mina.ok('client.docs.search', { query: 'pelican' });
    assert.deepEqual(minaHits.docs.map((doc: Json) => doc.id), [open]);
    assert.match(minaHits.docs[0].snippet, /pelican/);
    assert.equal((await owner.ok('client.docs.search', { query: 'pelican' })).docs.length, 2);
    assert.equal((await mina.ok('client.docs.search', { query: '회의' })).docs[0].id, open);
    assert.equal((await mina.ok('client.docs.search', { query: 'zebracorp' })).docs.length, 0);
    assert.equal((await outsider.ok('client.docs.search', { query: 'pelican' })).docs.length, 1);
  });

  test('live co-editing: two people converge, cursors are shared, a read-only viewer cannot change anything', async () => {
    const { canvas_id: id } = await owner.ok('canvases.create', { title: 'Live', document_content: md('start') });
    await owner.ok('canvases.access.set', { canvas_id: id, access_level: 'write', user_ids: [mina.userId] });
    await owner.ok('canvases.access.set', { canvas_id: id, access_level: 'read', user_ids: [outsider.userId] });
    const a = new CanvasClient(test_.base, id, owner.cookie);
    const b = new CanvasClient(test_.base, id, mina.cookie);
    await Promise.all([a.synced, b.synced]);
    assert.equal(b.text(), 'start');
    a.addParagraph('from owner');
    b.addParagraph('from mina');
    await until(() => a.text() === b.text() && a.text().includes('from owner') && a.text().includes('from mina'));

    a.awareness.setLocalStateField('user', { name: 'Olive', color: '#f00' });
    await until(() => [...b.awareness.getStates().values()].some((state) => state.user?.name === 'Olive'));

    const viewer = new CanvasClient(test_.base, id, outsider.cookie);
    await viewer.synced;
    assert.equal(viewer.text(), a.text());
    viewer.addParagraph('vandalism');
    await sleep(300);
    assert.doesNotMatch(a.text(), /vandalism/);

    // Nobody without access gets a socket at all.
    const { canvas_id: hidden } = await owner.ok('canvases.create', { title: 'Hidden live' });
    const stranger = new CanvasClient(test_.base, hidden, jun.cookie);
    await assert.rejects(stranger.synced, /refused: 404/);
    stranger.close();
    const anonymous = new CanvasClient(test_.base, id, '');
    await assert.rejects(anonymous.synced, /refused: 404/);
    anonymous.close();

    // Live edits reach the API's view and search after the short flush.
    await until(async () => (await mina.ok('client.docs.search', { query: 'from mina' })).docs.some((doc: Json) => doc.id === id));

    // Losing access closes the open copy.
    await owner.ok('canvases.access.delete', { canvas_id: id, user_ids: [outsider.userId] });
    assert.equal(await viewer.closed, 4403);
    viewer.close();
    a.close();
    b.close();
    await Promise.all([a.closed, b.closed]);
  });

  test('offline edits merge when a person reconnects', async () => {
    const { canvas_id: id } = await owner.ok('canvases.create', { title: 'Offline', channel_id: channel, document_content: md('base') });
    const a = new CanvasClient(test_.base, id, owner.cookie);
    const b = new CanvasClient(test_.base, id, mina.cookie);
    await Promise.all([a.synced, b.synced]);
    b.close();
    await b.closed;
    // Mina keeps typing while offline; Olive keeps typing online.
    b.addParagraph('typed offline');
    a.addParagraph('typed online');
    await sleep(100);
    const again = new CanvasClient(test_.base, id, mina.cookie);
    Y.applyUpdate(again.doc, Y.encodeStateAsUpdate(b.doc), 'local');
    await again.synced;
    await until(() => again.text() === a.text() && /typed offline/.test(a.text()) && /typed online/.test(again.text()));
    a.close();
    again.close();
  });

  test('versions: kept, listed, viewed and restored; a restore can be undone', async () => {
    const { canvas_id: id } = await owner.ok('canvases.create', { title: 'Versioned', document_content: md('first draft') });
    const saved = await owner.ok('client.canvases.versions.save', { canvas_id: id, label: 'v1' });
    await owner.ok('canvases.edit', { canvas_id: id, changes: [{ operation: 'replace', document_content: md('rewritten completely') }] });
    assert.equal((await owner.ok('canvases.getContent', { canvas_id: id })).content, 'rewritten completely');
    const v = await owner.ok('client.canvases.versions.get', { canvas_id: id, version_id: saved.version_id });
    assert.equal(v.version.markdown, 'first draft');
    await owner.ok('client.canvases.versions.restore', { canvas_id: id, version_id: saved.version_id });
    assert.equal((await owner.ok('canvases.getContent', { canvas_id: id })).content, 'first draft');
    const list = await owner.ok('client.canvases.versions.list', { canvas_id: id });
    const before = list.versions.find((version: Json) => version.label === 'Before restore');
    assert.ok(before);
    await owner.ok('client.canvases.versions.restore', { canvas_id: id, version_id: before.id });
    assert.equal((await owner.ok('canvases.getContent', { canvas_id: id })).content, 'rewritten completely');
    assert.equal((await mina.call('client.canvases.versions.list', { canvas_id: id })).error, 'canvas_not_found');
  });

  test('comments on a selection: threads, replies, resolve, delete; readers can comment', async () => {
    const { canvas_id: id } = await owner.ok('canvases.create', { title: 'Review me', channel_id: channel, document_content: md('A sentence worth arguing about.') });
    const root = await jun.ok('client.canvases.comments.add', { canvas_id: id, text: 'Is this right?', quote: 'worth arguing', anchor: { from: 3, to: 16 } });
    const reply = await mina.ok('client.canvases.comments.add', { canvas_id: id, text: 'Yes', root_id: root.comment.id });
    assert.equal(reply.comment.root_id, root.comment.id);
    assert.equal((await owner.ok('client.canvases.info', { canvas_id: id })).canvas.open_comments, 1);
    assert.equal((await jun.call('client.canvases.comments.resolve', { canvas_id: id, comment_id: reply.comment.id })).error, 'comment_not_found');
    await jun.ok('client.canvases.comments.resolve', { canvas_id: id, comment_id: root.comment.id });
    const comments = (await mina.ok('client.canvases.comments.list', { canvas_id: id })).comments;
    assert.equal(comments.length, 2);
    assert.equal(comments[0].resolved, true);
    assert.equal(comments[0].resolved_by, jun.userId);
    assert.deepEqual(comments[0].anchor, { from: 3, to: 16 });
    assert.equal((await owner.ok('client.canvases.info', { canvas_id: id })).canvas.open_comments, 0);
    await owner.ok('client.canvases.comments.resolve', { canvas_id: id, comment_id: root.comment.id, resolved: false });
    assert.equal((await owner.ok('client.canvases.info', { canvas_id: id })).canvas.open_comments, 1);
    assert.equal((await mina.call('client.canvases.comments.delete', { canvas_id: id, comment_id: root.comment.id })).error, 'access_denied');
    await owner.ok('client.canvases.comments.delete', { canvas_id: id, comment_id: root.comment.id });
    assert.equal((await owner.ok('client.canvases.comments.list', { canvas_id: id })).comments.length, 0);
    const { canvas_id: hidden } = await owner.ok('canvases.create', { title: 'Hidden' });
    assert.equal((await jun.call('client.canvases.comments.add', { canvas_id: hidden, text: 'hi' })).error, 'canvas_not_found');
  });

  test('mentioning someone in a canvas puts it in their Activity, once, and only if they can open it', async () => {
    const stream = await mina.connect();
    const { canvas_id: id } = await owner.ok('canvases.create', {
      title: 'Mentions',
      channel_id: channel,
      document_content: md(`Hey ![](@${mina.userId}) and ![](@${jun.userId})`),
    });
    const added = await stream.next((event) => event.type === 'activity_added' && event.item.type === 'canvas_mention');
    assert.equal(added.item.doc.id, id);
    assert.equal(added.item.doc.title, 'Mentions');
    const items = (await mina.ok('client.activity.list', {})).items.filter((item: Json) => item.type === 'canvas_mention');
    assert.equal(items.length, 1);
    assert.equal(items[0].actor, owner.userId);
    // Jun is not in #design, but the channel is public, so Jun can read it.
    assert.equal((await jun.ok('client.activity.list', {})).items.filter((item: Json) => item.type === 'canvas_mention').length, 1);
    await owner.ok('canvases.edit', { canvas_id: id, changes: [{ operation: 'insert_at_end', document_content: md(`again ![](@${mina.userId})`) }] });
    assert.equal((await mina.ok('client.activity.list', {})).items.filter((item: Json) => item.type === 'canvas_mention').length, 1);
    await owner.ok('canvases.create', { title: 'Private mention', channel_id: secret, document_content: md(`psst ![](@${mina.userId})`) });
    assert.equal((await mina.ok('client.activity.list', {})).items.filter((item: Json) => item.type === 'canvas_mention').length, 1);
    stream.close();
  });

  test('an uploaded image in a canvas loads for the canvas\'s readers and nobody else', async () => {
    const upload = async (who: Session): Promise<Json> => {
      const reserved = await who.ok('files.getUploadURLExternal', { filename: 'pixel.png', length: PNG.length });
      await fetch(reserved.upload_url, { method: 'POST', body: PNG });
      return (await who.ok('files.completeUploadExternal', { files: [{ id: reserved.file_id, title: 'pixel' }] })).files[0];
    };
    const image = await upload(owner);
    const path = new URL(image.url_private).pathname;
    const load = async (who: Session): Promise<number> => (await fetch(`${test_.base}${path}`, { headers: { cookie: who.cookie } })).status;
    assert.equal(await load(mina), 404);
    const { canvas_id: id } = await owner.ok('canvases.create', { title: 'With image', document_content: md(`Look:\n\n![pixel](${path})`) });
    assert.match((await owner.ok('canvases.getContent', { canvas_id: id })).content, /!\[pixel\]\(\/files-pri\//);
    assert.equal(await load(mina), 404);
    await owner.ok('canvases.access.set', { canvas_id: id, access_level: 'read', user_ids: [mina.userId] });
    assert.equal(await load(mina), 200);
    assert.equal(await load(jun), 404);

    // Putting someone else's file into your own canvas grants nobody anything.
    const other = await upload(jun);
    const otherPath = new URL(other.url_private).pathname;
    const { canvas_id: mine } = await mina.ok('canvases.create', { title: 'Borrowed', document_content: md(`![x](${otherPath})`) });
    await mina.ok('canvases.access.set', { canvas_id: mine, access_level: 'read', user_ids: [outsider.userId] });
    assert.equal((await fetch(`${test_.base}${otherPath}`, { headers: { cookie: mina.cookie } })).status, 404);
    assert.equal((await fetch(`${test_.base}${otherPath}`, { headers: { cookie: outsider.cookie } })).status, 404);
  });

  test('link cards: what a canvas link shows depends on who looks', async () => {
    const { canvas_id: id } = await owner.ok('canvases.create', { title: 'Card me', channel_id: channel, document_content: md('Body text for the card') });
    const card = await mina.ok('client.docs.card', { id });
    assert.equal(card.card.title, 'Card me');
    assert.match(card.card.permalink, new RegExp(`/docs/T[A-Z0-9]+/${id}$`));
    const { canvas_id: hidden } = await owner.ok('canvases.create', { title: 'No card' });
    assert.equal((await mina.call('client.docs.card', { id: hidden })).error, 'not_found');
  });
});

describe('canvas storage', () => {
  test('stored updates are compacted and the canvas survives a restart unchanged', async () => {
    const first = await startApp({ keepData: true });
    const owner = await setupWorkspace(first);
    const { canvas_id: id } = await owner.ok('canvases.create', { title: 'Durable', document_content: md('kept') });
    const client = new CanvasClient(first.base, id, owner.cookie);
    await client.synced;
    for (let i = 0; i < 230; i += 1) client.addParagraph(`line ${i}`);
    await until(() => (first.app.ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM canvas_updates WHERE doc_id = ?', id)?.n ?? 0) >= 200);
    // The flush after the burst compacts the many small updates into one.
    await until(() => (first.app.ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM canvas_updates WHERE doc_id = ?', id)?.n ?? 999) <= 2, 5000);
    const expected = client.text();
    client.close();
    await client.closed;
    const dir = first.app.ctx.config.dataDir;
    await first.close();

    const second = await startApp({ dataDir: dir });
    try {
      const again = new Session(second.base);
      await again.ok('client.signin', { email: 'owner@acme.test', password: 'correct horse battery' });
      const content: string = (await again.ok('canvases.getContent', { canvas_id: id })).content;
      assert.equal(content.split('\n\n').length, 231);
      assert.ok(content.endsWith('line 229'));
      const reader = new CanvasClient(second.base, id, again.cookie);
      await reader.synced;
      assert.equal(reader.text(), expected);
      reader.close();
      await reader.closed;
    } finally {
      await second.close();
    }
  });
});

describe('lists', () => {
  let test_: TestApp;
  let owner: Session;
  let mina: Session;
  let jun: Session;
  let channel: string;

  before(async () => {
    test_ = await startApp();
    owner = await setupWorkspace(test_);
    mina = await addMember(test_, owner, 'Mina Park');
    jun = await addMember(test_, owner, 'Jun Lee');
    channel = (await owner.ok('conversations.create', { name: 'tracker' })).channel.id;
    await owner.ok('conversations.invite', { channel, users: mina.userId });
  });
  after(() => test_.close());

  const schema = [
    { key: 'name', name: 'Task', type: 'text', is_primary_column: true },
    { key: 'status', name: 'Status', type: 'select', options: { choices: [{ value: 'todo', label: 'To do', color: 'gray' }, { value: 'doing', label: 'Doing', color: 'blue' }, { value: 'done', label: 'Done', color: 'green' }] } },
    { key: 'tags', name: 'Tags', type: 'select', options: { format: 'multi_select', choices: [{ value: 'ui', label: 'UI' }, { value: 'api', label: 'API' }] } },
    { key: 'owner', name: 'Owner', type: 'user' },
    { key: 'due', name: 'Due', type: 'date' },
    { key: 'points', name: 'Points', type: 'number' },
    { key: 'done', name: 'Done', type: 'checkbox' },
    { key: 'spec', name: 'Spec', type: 'link' },
    { key: 'stars', name: 'Stars', type: 'rating', options: { max: 5 } },
  ];

  test('Slack methods with a bot token: create, add, update, read, page, delete', async () => {
    const bot = createBot(test_, ['lists:write', 'lists:read']);
    const created = await callWithToken(test_.base, bot.token, 'slackLists.create', { name: 'Sprint', schema });
    assert.equal(created.ok, true, JSON.stringify(created));
    const listId = created.list_id;
    const columns: Json[] = created.list_metadata.schema;
    assert.equal(columns.length, schema.length);
    assert.equal(columns[0].is_primary_column, true);
    const col = (key: string): string => columns.find((column) => column.key === key).id;

    const item = await callWithToken(test_.base, bot.token, 'slackLists.items.create', {
      list_id: listId,
      initial_fields: [
        { column_id: col('name'), rich_text: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Write the API' }] }] }] },
        { column_id: col('status'), select: ['doing'] },
        { column_id: col('tags'), select: ['ui', 'api'] },
        { column_id: col('points'), number: [3] },
        { column_id: col('done'), checkbox: false },
        { column_id: col('spec'), link: [{ original_url: 'https://example.com/spec' }] },
        { column_id: col('stars'), rating: [9] },
      ],
    });
    assert.equal(item.ok, true, JSON.stringify(item));
    const fields = Object.fromEntries(item.item.fields.map((field: Json) => [field.key, field]));
    assert.equal(fields.name.text, 'Write the API');
    assert.deepEqual(fields.status.select, ['doing']);
    assert.deepEqual(fields.tags.select, ['ui', 'api']);
    assert.deepEqual(fields.stars.rating, [5]);
    assert.equal(fields.spec.link[0].original_url, 'https://example.com/spec');

    const badSelect = await callWithToken(test_.base, bot.token, 'slackLists.items.create', { list_id: listId, initial_fields: [{ column_id: col('status'), select: ['nope'] }] });
    assert.equal(badSelect.error, 'invalid_value');
    const badDate = await callWithToken(test_.base, bot.token, 'slackLists.items.create', { list_id: listId, initial_fields: [{ column_id: col('due'), date: ['tomorrow'] }] });
    assert.equal(badDate.error, 'invalid_value');

    for (let i = 0; i < 4; i += 1) {
      await callWithToken(test_.base, bot.token, 'slackLists.items.create', { list_id: listId, initial_fields: [{ column_id: col('name'), text: `Task ${i}` }] });
    }
    const page1 = await callWithToken(test_.base, bot.token, 'slackLists.items.list', { list_id: listId, limit: 3 });
    assert.equal(page1.items.length, 3);
    assert.ok(page1.response_metadata.next_cursor);
    const page2 = await callWithToken(test_.base, bot.token, 'slackLists.items.list', { list_id: listId, limit: 3, cursor: page1.response_metadata.next_cursor });
    assert.equal(page2.items.length, 2);
    assert.equal(page2.response_metadata.next_cursor, '');

    const updated = await callWithToken(test_.base, bot.token, 'slackLists.items.update', {
      list_id: listId,
      cells: [
        { row_id: item.item.id, column_id: col('status'), select: ['done'] },
        { row_id: item.item.id, column_id: col('done'), checkbox: true },
      ],
    });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    const info = await callWithToken(test_.base, bot.token, 'slackLists.items.info', { list_id: listId, id: item.item.id });
    const after_ = Object.fromEntries(info.record.fields.map((field: Json) => [field.key, field]));
    assert.deepEqual(after_.status.select, ['done']);
    assert.equal(after_.done.checkbox, true);
    assert.equal(info.list.name, 'Sprint');

    const sub = await callWithToken(test_.base, bot.token, 'slackLists.items.create', { list_id: listId, parent_item_id: item.item.id, initial_fields: [{ column_id: col('name'), text: 'Subtask' }] });
    assert.equal(sub.item.parent_item_id, item.item.id);
    assert.equal((await callWithToken(test_.base, bot.token, 'slackLists.items.info', { list_id: listId, id: item.item.id })).subtasks.length, 1);

    assert.equal((await callWithToken(test_.base, bot.token, 'slackLists.items.delete', { list_id: listId, id: item.item.id })).ok, true);
    assert.equal((await callWithToken(test_.base, bot.token, 'slackLists.items.info', { list_id: listId, id: sub.item.id })).error, 'item_not_found');
    const remaining = (await callWithToken(test_.base, bot.token, 'slackLists.items.list', { list_id: listId })).items;
    const two = remaining.slice(0, 2).map((row: Json) => row.id);
    assert.equal((await callWithToken(test_.base, bot.token, 'slackLists.items.deleteMultiple', { list_id: listId, ids: two })).ok, true);
    assert.equal((await callWithToken(test_.base, bot.token, 'slackLists.items.list', { list_id: listId })).items.length, 2);

    assert.equal((await callWithToken(test_.base, bot.token, 'slackLists.update', { id: listId, name: 'Sprint 2', todo_mode: true })).ok, true);
    const todo = await mina.call('slackLists.items.list', { list_id: listId });
    assert.equal(todo.error, 'list_not_found');
    const meta = await callWithToken(test_.base, bot.token, 'slackLists.items.info', { list_id: listId, id: remaining[2].id });
    assert.equal(meta.list.name, 'Sprint 2');
    assert.ok(meta.list.list_metadata.schema.some((column: Json) => column.key === 'todo_assignee'));
  });

  test('access: shared into a channel, with people, removed; read-only people cannot change items', async () => {
    const { list_id: listId, list_metadata } = await owner.ok('slackLists.create', { name: 'Shared tracker', schema, channel_id: channel });
    const name = list_metadata.schema[0].id;
    assert.equal((await mina.ok('client.lists.info', { list_id: listId })).list.access_level, 'write');
    await mina.ok('slackLists.items.create', { list_id: listId, initial_fields: [{ column_id: name, text: 'from mina' }] });
    assert.equal((await jun.ok('client.lists.info', { list_id: listId })).list.access_level, 'read');
    assert.equal((await jun.call('slackLists.items.create', { list_id: listId, initial_fields: [] })).error, 'access_denied');

    const { list_id: personal } = await owner.ok('slackLists.create', { name: 'Personal', schema });
    assert.equal((await jun.call('client.lists.info', { list_id: personal })).error, 'list_not_found');
    await owner.ok('slackLists.access.set', { list_id: personal, access_level: 'write', user_ids: [jun.userId] });
    await jun.ok('slackLists.items.create', { list_id: personal, initial_fields: [] });
    assert.equal((await jun.call('slackLists.access.set', { list_id: personal, access_level: 'write', user_ids: [mina.userId] })).error, 'restricted_action');
    await owner.ok('slackLists.access.delete', { list_id: personal, user_ids: [jun.userId] });
    assert.equal((await jun.call('slackLists.items.list', { list_id: personal })).error, 'list_not_found');
    assert.equal((await jun.ok('client.docs.search', { query: 'from mina' })).docs.length, 1);
  });

  test('assigning someone puts the item in their Activity; due dates remind assignees once', async () => {
    const { list_id: listId, list_metadata } = await owner.ok('slackLists.create', { name: 'Assignments', schema, channel_id: channel });
    const col = (key: string): string => list_metadata.schema.find((column: Json) => column.key === key).id;
    const stream = await mina.connect();
    const item = await owner.ok('slackLists.items.create', {
      list_id: listId,
      initial_fields: [
        { column_id: col('name'), text: 'Review copy' },
        { column_id: col('owner'), user: [mina.userId] },
      ],
    });
    const added = await stream.next((event) => event.type === 'activity_added' && event.item.type === 'list_assigned');
    assert.equal(added.item.item.title, 'Review copy');
    assert.equal(added.item.doc.id, listId);
    assert.equal(added.item.actor, owner.userId);

    // Adding Jun too notifies only Jun, and only if Jun can open the list (the channel is public).
    await owner.ok('slackLists.items.update', { list_id: listId, cells: [{ row_id: item.item.id, column_id: col('owner'), user: [mina.userId, jun.userId] }] });
    assert.equal((await mina.ok('client.activity.list', {})).items.filter((entry: Json) => entry.type === 'list_assigned').length, 1);
    assert.equal((await jun.ok('client.activity.list', {})).items.filter((entry: Json) => entry.type === 'list_assigned').length, 1);
    // Assigning yourself is not news.
    await mina.ok('slackLists.items.create', { list_id: listId, initial_fields: [{ column_id: col('owner'), user: [mina.userId] }] });
    assert.equal((await mina.ok('client.activity.list', {})).items.filter((entry: Json) => entry.type === 'list_assigned').length, 1);

    const today = '2026-11-17';
    await owner.ok('slackLists.items.update', { list_id: listId, cells: [{ row_id: item.item.id, column_id: col('due'), date: [today] }] });
    const doneItem = await owner.ok('slackLists.items.create', {
      list_id: listId,
      initial_fields: [
        { column_id: col('owner'), user: [mina.userId] },
        { column_id: col('due'), date: [today] },
        { column_id: col('done'), checkbox: true },
      ],
    });
    assert.ok(doneItem.item.id);
    assert.equal(runDueSweep(test_.app.ctx, today), 2);
    assert.equal(runDueSweep(test_.app.ctx, today), 0);
    const due = (await mina.ok('client.activity.list', {})).items.filter((entry: Json) => entry.type === 'list_due');
    assert.equal(due.length, 1);
    assert.equal(due[0].due, today);
    assert.equal(due[0].item.title, 'Review copy');
    stream.close();
  });

  test('item comments, board moves, archive, columns; CSV export for people and through download URLs', async () => {
    const { list_id: listId, list_metadata } = await owner.ok('slackLists.create', { name: 'Board, "quoted"', schema, channel_id: channel });
    const col = (key: string): string => list_metadata.schema.find((column: Json) => column.key === key).id;
    const a = (await owner.ok('slackLists.items.create', { list_id: listId, initial_fields: [{ column_id: col('name'), text: 'Alpha, first' }, { column_id: col('status'), select: ['todo'] }] })).item;
    const b = (await owner.ok('slackLists.items.create', { list_id: listId, initial_fields: [{ column_id: col('name'), text: 'Beta' }, { column_id: col('owner'), user: [mina.userId] }] })).item;
    const c = (await owner.ok('slackLists.items.create', { list_id: listId, initial_fields: [{ column_id: col('name'), text: 'Gamma "g"' }] })).item;

    await mina.ok('client.lists.items.move', { list_id: listId, id: c.id });
    let order = (await mina.ok('client.lists.info', { list_id: listId })).items.map((item: Json) => item.id);
    assert.deepEqual(order, [c.id, a.id, b.id]);
    await mina.ok('client.lists.items.move', { list_id: listId, id: c.id, after_id: a.id });
    order = (await mina.ok('client.lists.info', { list_id: listId })).items.map((item: Json) => item.id);
    assert.deepEqual(order, [a.id, c.id, b.id]);

    await jun.ok('client.lists.comments.add', { list_id: listId, item_id: a.id, text: 'Looks good' });
    assert.equal((await mina.ok('client.lists.comments.list', { list_id: listId, item_id: a.id })).comments[0].text, 'Looks good');
    assert.equal((await mina.ok('client.lists.info', { list_id: listId })).items[0].comment_count, 1);

    await owner.ok('client.lists.items.archive', { list_id: listId, id: b.id });
    assert.equal((await mina.ok('client.lists.info', { list_id: listId })).items.length, 2);

    const columns = (await owner.ok('client.lists.columns.set', { list_id: listId, schema: [...list_metadata.schema, { name: 'Notes', type: 'text' }] })).schema;
    assert.equal(columns.length, schema.length + 1);
    assert.equal(columns[0].id, list_metadata.schema[0].id);
    assert.equal((await owner.call('client.lists.columns.set', { list_id: listId, schema: [{ name: 'x', type: 'teleport' }] })).error, 'invalid_schema');

    const csv = await fetch(`${test_.base}/lists-export/${listId}.csv`, { headers: { cookie: mina.cookie } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
    const body = (await csv.text()).replace(/^\uFEFF/, '');
    const lines = body.trim().split('\r\n');
    assert.equal(lines[0], 'Task,Status,Tags,Owner,Due,Points,Done,Spec,Stars,Notes');
    assert.equal(lines[1], '"Alpha, first",To do,,,,,,,,');
    assert.equal(lines[2], '"Gamma ""g""",,,,,,,,,');
    assert.equal(lines.length, 3);
    const withArchived = await (await fetch(`${test_.base}/lists-export/${listId}.csv?archived=1`, { headers: { cookie: mina.cookie } })).text();
    assert.match(withArchived, /Beta,,,Mina Park/);
    assert.equal((await fetch(`${test_.base}/lists-export/${listId}.csv`)).status, 404);

    const bot = createBot(test_, ['lists:read']);
    await owner.ok('slackLists.access.set', { list_id: listId, access_level: 'read', user_ids: [bot.userId] });
    const job = await callWithToken(test_.base, bot.token, 'slackLists.download.start', { list_id: listId });
    const got = await callWithToken(test_.base, bot.token, 'slackLists.download.get', { list_id: listId, job_id: job.job_id });
    assert.equal(got.status, 'COMPLETED');
    const download = await fetch(got.download_url.replace(/^https?:\/\/[^/]+/, test_.base));
    assert.equal(download.status, 200);
    assert.match(await download.text(), /Alpha, first/);
    assert.equal((await callWithToken(test_.base, bot.token, 'slackLists.download.get', { list_id: listId, job_id: 'LeJNOPE' })).error, 'job_not_found');
  });

  test('createListItem adds items for workflow steps, with plain values keyed by column', async () => {
    const { list_id: listId } = await owner.ok('slackLists.create', { name: 'Intake', schema, channel_id: channel });
    const actor = { userId: mina.userId, kind: 'session', role: 'member', isBot: false, appId: null, botId: null, scopes: null } as never;
    const item = createListItem(test_.app.ctx, actor, listId, { name: 'From a workflow', status: 'Doing', owner: [jun.userId], due: '2026-12-01', points: 2, done: false }) as Json;
    const fields = Object.fromEntries(item.fields.map((field: Json) => [field.key, field]));
    assert.equal(fields.name.text, 'From a workflow');
    assert.deepEqual(fields.status.select, ['doing']);
    assert.deepEqual(fields.owner.user, [jun.userId]);
    assert.equal((await jun.ok('client.activity.list', {})).items.some((entry: Json) => entry.type === 'list_assigned' && entry.item.id === item.id), true);
    assert.throws(() => createListItem(test_.app.ctx, { ...(actor as object), userId: 'UNOBODY' } as never, listId, {}), /list_not_found/);
  });
});

describe('lists in workflows', () => {
  test('a workflow step adds a list item through the list\'s own checks, and its assignee hears about it', async () => {
    const t = await startApp();
    try {
      const owner = await setupWorkspace(t);
      const mina = await addMember(t, owner, 'Mina Park');
      const channel = (await owner.ok('conversations.create', { name: 'intake' })).channel.id;
      const { list_id: listId } = await owner.ok('slackLists.create', {
        name: 'Requests',
        channel_id: channel,
        schema: [
          { key: 'title', name: 'Request', type: 'text' },
          { key: 'status', name: 'Status', type: 'select', options: { choices: [{ label: 'New' }, { label: 'Done' }] } },
          { key: 'owner', name: 'Owner', type: 'user' },
        ],
      });
      assert.equal((await owner.ok('client.workflows.stepTypes')).lists_available, true);
      const saved = await owner.ok('client.workflows.save', {
        name: 'File a request',
        trigger: { type: 'webhook', variables: ['what'] },
        steps: [{ id: 'add', type: 'list_item', list_id: listId, fields: { title: '{{webhook.what}}', Status: 'New', owner: `<@${mina.userId}>` } }],
      });
      const workflow = (await owner.ok('client.workflows.publish', { workflow: saved.workflow.id })).workflow;
      const full = (await owner.ok('client.workflows.get', { workflow: workflow.id })).workflow;
      const response = await fetch(`${t.base}${new URL(full.webhook_url).pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ what: 'New laptop' }) });
      assert.equal(response.status, 200);
      await until(async () => (await owner.ok('client.workflows.runs', { workflow: workflow.id })).runs[0]?.status === 'completed');
      const items = (await owner.ok('slackLists.items.list', { list_id: listId })).items;
      assert.equal(items.length, 1);
      const fields = Object.fromEntries(items[0].fields.map((field: Json) => [field.key, field]));
      assert.equal(fields.title.text, 'New laptop');
      assert.deepEqual(fields.status.select, ['New']);
      assert.deepEqual(fields.owner.user, [mina.userId]);
      assert.ok((await mina.ok('client.activity.list', {})).items.some((entry: Json) => entry.type === 'list_assigned'));
    } finally {
      await t.close();
    }
  });
});

describe('templates', () => {
  let test_: TestApp;
  let owner: Session;
  let mina: Session;

  before(async () => {
    test_ = await startApp();
    owner = await setupWorkspace(test_);
    mina = await addMember(test_, owner, 'Mina Park');
  });
  after(() => test_.close());

  test('built-in templates create canvases and lists; anything can be saved as a template for everyone', async () => {
    const all = (await mina.ok('client.docs.templates.list', {})).templates;
    const titles = all.map((template: Json) => template.title);
    for (const title of ['Meeting notes', 'Project brief', 'Bug tracker', 'Onboarding checklist']) assert.ok(titles.includes(title), title);

    const notes = await mina.ok('client.docs.create', { kind: 'canvas', template_id: 'TPLmeeting' });
    assert.equal(notes.doc.title, 'Meeting notes');
    assert.match((await mina.ok('canvases.getContent', { canvas_id: notes.doc.id })).content, /## Action items\n\n- \[ \]/);

    const bugs = await mina.ok('client.docs.create', { kind: 'list', template_id: 'TPLbugs', title: 'Our bugs' });
    const info = await mina.ok('client.lists.info', { list_id: bugs.doc.id });
    assert.equal(info.list.name, 'Our bugs');
    assert.deepEqual(info.list.list_metadata.schema.map((column: Json) => column.name), ['Bug', 'Status', 'Severity', 'Assignee', 'Due', 'Link']);
    const onboarding = await mina.ok('client.docs.create', { kind: 'list', template_id: 'TPLonboarding' });
    assert.equal((await mina.ok('client.lists.info', { list_id: onboarding.doc.id })).items.length, 6);
    assert.equal((await mina.call('client.docs.create', { kind: 'canvas', template_id: 'TPLbugs' })).error, 'template_not_found');

    await mina.ok('canvases.edit', { canvas_id: notes.doc.id, changes: [{ operation: 'insert_at_end', document_content: md('Our own closing section') }] });
    const saved = await mina.ok('client.docs.templates.save', { doc_id: notes.doc.id, title: 'Team retro', description: 'Ours' });
    assert.ok((await owner.ok('client.docs.templates.list', { kind: 'canvas' })).templates.some((template: Json) => template.id === saved.template_id && !template.builtin));
    const fromSaved = await owner.ok('client.docs.create', { kind: 'canvas', template_id: saved.template_id });
    assert.equal(fromSaved.doc.title, 'Team retro');
    assert.match((await owner.ok('canvases.getContent', { canvas_id: fromSaved.doc.id })).content, /Our own closing section$/);

    const listTemplate = await mina.ok('client.docs.templates.save', { doc_id: onboarding.doc.id, include_items: true });
    const fromList = await owner.ok('client.docs.create', { kind: 'list', template_id: listTemplate.template_id });
    assert.equal((await owner.ok('client.lists.info', { list_id: fromList.doc.id })).items.length, 6);

    // Saving needs access to the source; deleting is for the person who saved it (or an admin).
    const { canvas_id: privateCanvas } = await owner.ok('canvases.create', { title: 'Private' });
    assert.equal((await mina.call('client.docs.templates.save', { doc_id: privateCanvas })).error, 'not_found');
    await owner.ok('client.docs.templates.delete', { template_id: saved.template_id });
    assert.equal((await mina.call('client.docs.templates.delete', { template_id: 'TPLmeeting' })).error, 'template_not_found');
  });
});
