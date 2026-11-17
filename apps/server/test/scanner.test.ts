import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** A stand-in for clamd: reads an INSTREAM and reports EICAR as found. */
function fakeClamd(): Promise<{ server: Server; port: number; streams: number }> {
  const state = { server: null as unknown as Server, port: 0, streams: 0 };
  state.server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let body = Buffer.alloc(0);
    let commandRead = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!commandRead) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        assert.equal(buffer.subarray(0, end).toString(), 'zINSTREAM');
        buffer = buffer.subarray(end + 1);
        commandRead = true;
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          state.streams += 1;
          socket.end(body.includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
          return;
        }
        if (buffer.length < 4 + length) return;
        body = Buffer.concat([body, buffer.subarray(4, 4 + length)]);
        buffer = buffer.subarray(4 + length);
      }
    });
  });
  return new Promise((resolve) => state.server.listen(0, '127.0.0.1', () => {
    state.port = (state.server.address() as { port: number }).port;
    resolve(state);
  }));
}

describe('upload scanning (ClamAV)', () => {
  let t: TestApp;
  let owner: Session;
  let clamd: Awaited<ReturnType<typeof fakeClamd>>;
  let general: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    clamd = await fakeClamd();
    t.app.ctx.config.scanner = { host: '127.0.0.1', port: clamd.port, maxBytes: 1024 * 1024, failOpen: false };
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
  });
  after(async () => {
    clamd.server.close();
    await t.close();
  });

  const upload = async (name: string, content: string): Promise<Json> => {
    const form = new FormData();
    form.set('channels', general);
    form.set('file', new Blob([content]), name);
    return fetch(`${t.base}/api/files.upload`, { method: 'POST', headers: { cookie: owner.cookie, origin: t.base }, body: form }).then((r) => r.json() as Promise<Json>);
  };

  test('a clean file goes through; an infected one is refused and removed', async () => {
    const clean = await upload('notes.txt', 'just notes');
    assert.equal(clean.ok, true, JSON.stringify(clean));
    const infected = await upload('eicar.com', EICAR);
    assert.equal(infected.ok, false);
    assert.equal(infected.error, 'file_infected');
    assert.equal(infected.signature, 'Eicar-Test-Signature');
    assert.equal(clamd.streams, 2);
    const files = t.app.ctx.db.all<{ name: string }>('SELECT name FROM files');
    assert.ok(!files.some((file) => file.name === 'eicar.com'), 'nothing left behind');
  });

  test('when the scanner is down, uploads are refused unless fail-open is set', async () => {
    t.app.ctx.config.scanner = { host: '127.0.0.1', port: 1, maxBytes: 1024 * 1024, failOpen: false };
    assert.equal((await upload('a.txt', 'a')).error, 'scan_unavailable');
    t.app.ctx.config.scanner = { host: '127.0.0.1', port: 1, maxBytes: 1024 * 1024, failOpen: true };
    assert.equal((await upload('b.txt', 'b')).ok, true);
  });
});
