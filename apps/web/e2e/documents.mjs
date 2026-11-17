// Browser test for documents: a file an app keeps elsewhere (files.remote.*)
// shown as a card with its preview image that opens at its own address, and
// a Word document read as its text.
//
//   pnpm --filter @app/web build && node e2e/documents.mjs
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { openChannel, row, run, shot, signIn, startServer, step, watch, wide } from './lib.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A minimal zip archive, enough for an Office document. */
function zip(files) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

async function main(browser) {
  const { base } = await startServer({ seed: true });
  const maya = watch(await (await browser.newContext({ ...wide })).newPage());
  await signIn(maya, base, 'maya@example.com');
  await openChannel(maya, 'engineering');

  await step('an app shares a document it keeps elsewhere: a card with its preview, opening at its own address', async () => {
    await maya.evaluate(async (png) => {
      const post = async (method, body, token) => {
        const response = await fetch(`/api/${method}`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : { 'content-type': 'application/json' }, body: token ? body : JSON.stringify(body) });
        const json = await response.json();
        if (!json.ok) throw new Error(`${method}: ${json.error}`);
        return json;
      };
      const boot = await post('client.boot', {});
      const engineering = boot.channels.find((channel) => channel.name === 'engineering').id;
      const app = await post('client.apps.create', { name: 'Docs Drive' });
      await post('conversations.invite', { channel: engineering, users: app.app.bot_user_id });
      const form = new FormData();
      form.set('external_id', 'gdoc-42');
      form.set('external_url', 'https://docs.example.test/d/42');
      form.set('title', 'Launch checklist');
      form.set('preview_image', new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: 'image/png' }), 'preview.png');
      await post('files.remote.add', form, app.bot_token);
      const share = new FormData();
      share.set('channels', engineering);
      share.set('external_id', 'gdoc-42');
      await post('files.remote.share', share, app.bot_token);
    }, PNG);
    const card = maya.locator('.msg .file-remote', { hasText: 'Launch checklist' });
    await card.waitFor();
    assert.equal(await card.getAttribute('href'), 'https://docs.example.test/d/42');
    assert.equal(await card.getAttribute('target'), '_blank');
    assert.match(await card.innerText(), /docs\.example\.test/);
    await card.locator('img').waitFor();
    assert.equal(await maya.locator('.msg', { has: card }).locator('a[aria-label="Download"]').count(), 0, 'nothing to download here');
    await shot(maya, 'remote-file');
  });

  await step('a Word document opens as its text', async () => {
    const docx = zip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Launch runbook</w:t></w:r></w:p><w:p><w:r><w:t>Step 1: freeze the branch</w:t></w:r></w:p></w:body></w:document>' });
    await maya.evaluate(async (bytes) => {
      const data = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
      const post = async (method, body) => (await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
      const boot = await post('client.boot', {});
      const engineering = boot.channels.find((channel) => channel.name === 'engineering').id;
      const reserved = await post('files.getUploadURLExternal', { filename: 'runbook.docx', length: data.length });
      await fetch(reserved.upload_url, { method: 'POST', body: data });
      await post('files.completeUploadExternal', { files: [{ id: reserved.file_id }], channel_id: engineering, initial_comment: 'Runbook for launch day' });
    }, docx.toString('base64'));
    const message = row(maya, 'Runbook for launch day');
    await message.waitFor();
    await message.getByRole('button', { name: 'Preview' }).click();
    await message.locator('.file-preview-doc', { hasText: 'Step 1: freeze the branch' }).waitFor();
    await shot(maya, 'office-preview');
  });
}

await run(main);
