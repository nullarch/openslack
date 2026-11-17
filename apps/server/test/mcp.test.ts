import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { BRAND } from '@app/shared';
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from '@modelcontextprotocol/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createBot, setupWorkspace, startApp, type Bot, type Json, type Session, type TestApp } from './helpers.ts';

const SCOPES = ['channels:read', 'channels:history', 'search:read', 'chat:write', 'reactions:write', 'users:read'];

/** A client on the 2026-07-28 revision (SDK v2), negotiating as told. */
async function connectModern(base: string, token: string, mode: 'auto' | { pin: string }): Promise<ModernClient> {
  const client = new ModernClient({ name: 'modern-client', version: '1.0.0' }, { versionNegotiation: { mode } });
  const transport = new ModernTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}

/** A 2025-era client (SDK v1), which the server serves statelessly. */
async function connect(base: string, token: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function parse(result: Json): Json {
  return JSON.parse(result.content[0].text);
}

describe('MCP endpoint', () => {
  let t: TestApp;
  let owner: Session;
  let bot: Bot;
  let client: Client;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    bot = createBot(t, SCOPES);
    client = await connect(t.base, bot.token);
  });
  after(async () => {
    await client.close();
    await t.close();
  });

  test('the official client connects and sees the tools', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['add_reaction', 'list_channels', 'list_users', 'post_message', 'read_channel', 'read_thread', 'search_messages'],
    );
    assert.equal(tools.find((tool) => tool.name === 'search_messages')?.annotations?.readOnlyHint, true);
  });

  test('an agent can read, search, post in Markdown, reply and react', async () => {
    const { ts } = await owner.ok('chat.postMessage', { channel: '#general', text: 'The staging database is at capacity' });
    const history = parse(await client.callTool({ name: 'read_channel', arguments: { channel: '#general', limit: 5 } }));
    assert.equal(history.messages[0].text, 'The staging database is at capacity');
    assert.equal(history.messages[0].user_name, 'Olive Owner');

    const found = parse(await client.callTool({ name: 'search_messages', arguments: { query: 'capacity from:@owner' } }));
    assert.equal(found.total, 1);
    assert.equal(found.matches[0].channel.name, 'general');

    const posted = parse(
      await client.callTool({ name: 'post_message', arguments: { channel: '#general', text: '**Plan**\n\n1. Resize the volume', thread_ts: ts } }),
    );
    assert.match(posted.permalink, /\/archives\//);
    await client.callTool({ name: 'add_reaction', arguments: { channel: '#general', ts, name: 'eyes' } });

    const thread = parse(await client.callTool({ name: 'read_thread', arguments: { channel: '#general', thread_ts: ts } }));
    assert.equal(thread.messages.length, 2);
    assert.equal(thread.messages[1].text, '**Plan**\n\n1. Resize the volume');
    assert.deepEqual(thread.messages[0].reactions, ['eyes×1']);

    // What the agent posted is an ordinary message: people see it with a Markdown block.
    const replies = await owner.ok('conversations.replies', { channel: '#general', ts });
    assert.equal(replies.messages[1].bot_id, bot.botId);
    assert.equal(replies.messages[1].blocks[0].type, 'markdown');
  });

  test('the token’s visibility and scopes apply to tools', async () => {
    const { channel } = await owner.ok('conversations.create', { name: 'board-only', is_private: true });
    await owner.ok('chat.postMessage', { channel: channel.id, text: 'acquisition codename heron' });

    const channels = parse(await client.callTool({ name: 'list_channels', arguments: {} }));
    assert.ok(!channels.some((entry: Json) => entry.name === 'board-only'));
    assert.equal(parse(await client.callTool({ name: 'search_messages', arguments: { query: 'heron' } })).total, 0);
    const denied = await client.callTool({ name: 'read_channel', arguments: { channel: channel.id } });
    assert.equal(denied.isError, true);
    assert.equal(parse(denied).error, 'channel_not_found');

    const limited = await connect(t.base, createBot(t, ['channels:read']).token);
    const refused = await limited.callTool({ name: 'post_message', arguments: { channel: '#general', text: 'hi' } });
    assert.equal(parse(refused).error, 'missing_scope');
    await limited.close();
  });

  test('a 2026-07-28 client negotiates the modern revision and uses the same tools', async () => {
    for (const mode of ['auto', { pin: '2026-07-28' }] as const) {
      const modern = await connectModern(t.base, bot.token, mode);
      assert.equal(modern.getProtocolEra(), 'modern');
      assert.equal(modern.getNegotiatedProtocolVersion(), '2026-07-28');
      const { tools } = await modern.listTools();
      assert.ok(tools.some((tool) => tool.name === 'search_messages'));
      const found = await modern.callTool({ name: 'search_messages', arguments: { query: 'capacity' } });
      assert.equal(parse(found).total, 1);
      await modern.close();
    }
    // The 2025-era client, connected before, is still served on its own revision.
    assert.equal(client.getServerVersion()?.name, BRAND.slug);
    assert.ok((await client.listTools()).tools.length > 0);
  });

  test('a browser session or a missing token is refused', async () => {
    const withoutToken = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(withoutToken.status, 401);
    const withCookie = await fetch(`${t.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie },
      body: '{}',
    });
    assert.equal(withCookie.status, 401);
    await assert.rejects(connect(t.base, 'xoxb-not-a-real-token'));
  });
});
