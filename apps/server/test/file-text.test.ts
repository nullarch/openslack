import assert from 'node:assert/strict';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { backfillFileText, extractorFor } from '../src/core/file-text.ts';
import { setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

/** A minimal zip (deflated entries), enough for Office files. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(content));
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.byteLength(content), 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(Buffer.byteLength(content), 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A one-page PDF whose content stream is deflated; extra objects (a ToUnicode CMap) may be added. */
function pdf(content: string, extra: string[] = []): Buffer {
  const parts: string[] = ['%PDF-1.4\n'];
  const body = deflateSync(Buffer.from(content));
  parts.push(`4 0 obj\n<< /Length ${body.length} /Filter /FlateDecode >>\nstream\n`);
  const head = Buffer.from(parts.join(''), 'latin1');
  const tail = Buffer.from(`\nendstream\nendobj\n${extra.join('\n')}\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
  return Buffer.concat([head, body, tail]);
}

describe('text inside files', () => {
  let t: TestApp;
  let owner: Session;
  let general: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
  });
  after(() => t.close());

  const upload = async (name: string, bytes: Buffer | string): Promise<string> => {
    const form = new FormData();
    form.set('channels', general);
    form.set('file', new Blob([bytes]), name);
    const result = (await (await fetch(`${t.base}/api/files.upload`, { method: 'POST', headers: { cookie: owner.cookie, origin: t.base }, body: form })).json()) as Json;
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.file.id;
  };
  const search = async (query: string): Promise<string[]> => (await owner.ok('search.files', { query })).files.matches.map((file: Json) => file.name);
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 50 && t.app.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM files WHERE state != 'pending' AND id NOT IN (SELECT file_id FROM file_text)")!.n > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  test('extractors read Word, Excel, PowerPoint and PDF text', () => {
    const docx = zip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Launch plan for &amp; the Q3 review</w:t></w:r></w:p></w:body></w:document>' });
    assert.match(extractorFor('plan.docx', 'application/octet-stream')!(docx), /Launch plan for & the Q3 review/);
    const xlsx = zip({ 'xl/sharedStrings.xml': '<sst><si><t>Revenue</t></si><si><t>Seoul office</t></si></sst>' });
    assert.match(extractorFor('sheet.xlsx', '')!(xlsx), /Seoul office/);
    const pptx = zip({ 'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Roadmap</a:t></a:r></a:p></p:sld>' });
    assert.match(extractorFor('deck.pptx', '')!(pptx), /Roadmap/);
    const simple = pdf('BT /F1 12 Tf 72 712 Td (Quarterly revenue grew \\(again\\)) Tj ET\nBT [(Kerned) -300 (words)] TJ ET');
    const text = extractorFor('report.pdf', 'application/pdf')!(simple);
    assert.match(text, /Quarterly revenue grew \(again\)/);
    assert.match(text, /Kerned words/);
    const cmap = deflateSync(Buffer.from('/CIDInit /ProcSet findresource begin begincmap 2 beginbfchar <0001> <D55C> <0002> <AE00> endbfchar 1 beginbfrange <0003> <0004> <0041> endbfrange endcmap'));
    const korean = Buffer.concat([
      pdf('BT /F1 12 Tf <000100020003 0004> Tj ET'),
      Buffer.from(`5 0 obj\n<< /Length ${cmap.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      cmap,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ]);
    assert.match(extractorFor('k.pdf', 'application/pdf')!(korean), /한글AB/);
    assert.equal(extractorFor('photo.png', 'image/png'), null);
  });

  test('search finds files by the text inside them, and only where the caller can see', async () => {
    await upload('notes.txt', 'The migration window is Saturday 02:00 KST');
    await upload('plan.docx', zip({ 'word/document.xml': '<w:p><w:t>Budget for the offsite in Jeju</w:t></w:p>' }));
    await upload('report.pdf', pdf('BT (Churn fell to three percent) Tj ET'));
    await settle();
    assert.deepEqual(await search('Saturday'), ['notes.txt']);
    assert.deepEqual(await search('offsite in Jeju'), ['plan.docx']);
    assert.deepEqual(await search('churn fell'), ['report.pdf']);
    assert.deepEqual(await search('nowhere-to-be-found'), []);
  });

  test('files from before are indexed by the backfill; deleting a file drops its text', async () => {
    const id = await upload('later.md', '# Incident review\nThe cache stampede');
    await settle();
    t.app.ctx.db.run('DELETE FROM file_text WHERE file_id = ?', id);
    assert.deepEqual(await search('stampede'), []);
    assert.ok((await backfillFileText(t.app.ctx)) >= 1);
    assert.deepEqual(await search('stampede'), ['later.md']);
    await owner.ok('files.delete', { file: id });
    assert.equal(t.app.ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM file_text WHERE file_id = ?', id)!.n, 0);
  });
});
