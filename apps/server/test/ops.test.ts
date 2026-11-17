import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { backupDataDir } from '../src/ops/backup.ts';
import { Session, setupWorkspace, startApp, type TestApp } from './helpers.ts';

describe('operations', () => {
  let t: TestApp;
  let owner: Session;

  before(async () => {
    t = await startApp({ metricsToken: 'scrape-me' });
    owner = await setupWorkspace(t);
    await owner.ok('chat.postMessage', { channel: '#general', text: 'hello' });
    await owner.call('chat.postMessage', { channel: '#nope', text: 'hello' });
  });
  after(() => t.close());

  test('/metrics speaks Prometheus to the right token only', async () => {
    assert.equal((await fetch(`${t.base}/metrics`)).status, 401);
    assert.equal((await fetch(`${t.base}/metrics`, { headers: { authorization: 'Bearer wrong-token' } })).status, 401);
    const response = await fetch(`${t.base}/metrics`, { headers: { authorization: 'Bearer scrape-me' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/plain; version=0\.0\.4/);
    const text = await response.text();
    assert.match(text, /^# TYPE chat_accounts gauge$/m);
    assert.match(text, /^chat_accounts\{kind="member"\} 1$/m);
    assert.match(text, /^chat_conversations\{kind="public"\} 2$/m);
    assert.match(text, /^chat_api_requests_total\{method="chat.postMessage",result="ok"\} 1$/m);
    assert.match(text, /^chat_api_requests_total\{method="chat.postMessage",result="channel_not_found"\} 1$/m);
    assert.match(text, /^process_resident_memory_bytes \d+$/m);
  });

  test('without a token there is no /metrics at all', async () => {
    const plain = await startApp();
    try {
      assert.equal((await fetch(`${plain.base}/metrics`)).status, 404);
    } finally {
      await plain.close();
    }
  });

  test('LOG_FORMAT=json writes one JSON object per line', () => {
    const output = execFileSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', "const { useJsonLogs } = await import('./src/ops/logging.ts'); useJsonLogs(); console.log('started %s', 'ok'); console.error(new Error('boom'));"],
      { cwd: join(import.meta.dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const line = JSON.parse(output.trim());
    assert.equal(line.level, 'info');
    assert.equal(line.msg, 'started ok');
    assert.ok(Date.parse(line.time));
  });

  test('a backup taken while the server runs restores to a working copy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-backup-'));
    try {
      const result = await backupDataDir(t.app.ctx.config.dataDir, dir);
      assert.equal(result.database, join(dir, 'app.db'));
      const restored = await startApp({ dataDir: dir });
      // startApp made its own temp dir; this one points at the backup instead.
      try {
        const browser = new Session(restored.base);
        await browser.ok('client.signin', { email: 'owner@acme.test', password: 'correct horse battery' });
        const history = await browser.ok('conversations.history', { channel: '#general' });
        assert.ok(history.messages.some((message: { text: string }) => message.text === 'hello'));
      } finally {
        await restored.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
