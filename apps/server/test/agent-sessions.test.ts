import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, callWithToken, setupWorkspace, startApp, type Json, type Session, type Stream, type TestApp } from './helpers.ts';
import { createPlatformApp, SocketApp, type TestAppCredentials } from './platform-helpers.ts';

describe('agent sessions (agents.sessions.*)', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let outsider: Session;
  let coder: TestAppCredentials;
  let reviewer: TestAppCredentials;
  let socket: SocketApp;
  let channel: string;
  let threadTs: string;
  let watching: Stream;
  const as = (app: TestAppCredentials, method: string, args: Json = {}): Promise<Json> => callWithToken(t.base, app.botToken, method, args);

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    outsider = await addMember(t, owner, 'Otto Outsider');
    channel = (await owner.ok('conversations.create', { name: 'builds', is_private: true })).channel.id;
    coder = await createPlatformApp(owner, 'Coder');
    reviewer = await createPlatformApp(owner, 'Reviewer');
    await owner.ok('conversations.invite', { channel, users: `${member.userId},${coder.botUserId},${reviewer.botUserId}` });
    socket = await SocketApp.connect(t.base, coder.appToken);
    threadTs = (await member.ok('chat.postMessage', { channel, text: '@Coder fix the flaky test' })).ts;
    watching = await member.connect();
  });
  after(async () => {
    watching.close();
    socket.close();
    await t.close();
  });

  test('an agent reports processing with a title; people in the conversation see it', async () => {
    const seen = watching.next((event) => event.type === 'agent_session' && event.session.status === 'processing');
    const set = await as(coder, 'agents.sessions.setStatus', { channel_id: channel, thread_ts: threadTs, status: 'processing', title: 'Fix flaky test', initiator_user_id: member.userId });
    assert.deepEqual([set.status, set.agent_status, set.title], ['processing', 'processing', 'Fix flaky test']);
    const event = await seen;
    assert.equal(event.session.thread_ts, threadTs);
    assert.deepEqual(event.session.agents.map((agent: Json) => [agent.name, agent.status]), [['Coder', 'processing']]);
    const listed = await member.ok('client.agents.sessions', { channel });
    assert.equal(listed.sessions[0].title, 'Fix flaky test');
    assert.equal((await outsider.call('client.agents.sessions', { channel })).error, 'channel_not_found');
  });

  test('several agents: the thread shows the most pressing state', async () => {
    const set = await as(reviewer, 'agents.sessions.setStatus', { channel_id: channel, thread_ts: threadTs, status: 'suspended' });
    assert.deepEqual([set.status, set.agent_status], ['suspended', 'suspended']);
    await as(reviewer, 'agents.sessions.setStatus', { channel_id: channel, thread_ts: threadTs, status: 'closed' });
    assert.equal((await member.ok('client.agents.sessions', { channel })).sessions[0].status, 'processing');
  });

  test('Stop tells the agents still processing, with their open streams; the status is theirs to change', async () => {
    const stream = await as(coder, 'chat.startStream', { channel, thread_ts: threadTs, markdown_text: 'Running the tests…' });
    const stopped = socket.envelopes.next((entry) => entry.type === 'events_api' && entry.payload?.event?.type === 'agent_session_stopped');
    assert.equal((await member.ok('client.agents.stop', { channel, thread_ts: threadTs })).stopped, 1, 'only the processing one');
    const event = (await stopped).payload.event;
    assert.deepEqual([event.channel, event.thread_ts, event.user], [channel, threadTs, member.userId]);
    assert.deepEqual(event.streaming_message_ts, [stream.ts]);
    assert.equal((await member.ok('client.agents.sessions', { channel })).sessions[0].status, 'processing', 'unchanged until the agent says');
    await as(coder, 'chat.stopStream', { channel, ts: stream.ts });
    assert.equal((await member.ok('client.agents.sessions', { channel })).sessions[0].agents.find((agent: Json) => agent.name === 'Coder').status, 'active', 'a finished stream is active again');
  });

  test('people rename a session; the agents hear about it', async () => {
    const changed = socket.envelopes.next((entry) => entry.type === 'events_api' && entry.payload?.event?.type === 'agent_session_title_changed');
    await member.ok('client.agents.rename', { channel, thread_ts: threadTs, title: 'Quarantine flaky test' });
    const event = (await changed).payload.event;
    assert.deepEqual([event.title, event.previous_title, event.user], ['Quarantine flaky test', 'Fix flaky test', member.userId]);
    assert.equal((await as(coder, 'agents.sessions.rename', { channel_id: channel, thread_ts: threadTs, title: 'Done: quarantined' })).title, 'Done: quarantined');
  });

  test('errors follow Slack', async () => {
    assert.equal((await as(coder, 'agents.sessions.setStatus', { channel_id: channel, thread_ts: threadTs, status: 'sleeping' })).error, 'invalid_status');
    assert.equal((await as(coder, 'agents.sessions.setStatus', { channel_id: channel, status: 'active' })).error, 'thread_ts_required');
    assert.equal((await as(coder, 'agents.sessions.setStatus', { channel_id: channel, thread_ts: '1111111111.000001', status: 'active' })).error, 'session_not_found');
    assert.equal((await as(coder, 'agents.sessions.rename', { channel_id: channel, thread_ts: threadTs, title: 'x'.repeat(201) })).error, 'invalid_name');
    assert.equal((await as(coder, 'agents.sessions.setStatus', { channel_id: channel, thread_ts: threadTs, status: 'active', initiator_user_id: outsider.userId })).error, 'user_not_found');
    const general = (await owner.ok('client.boot')).channels.find((conv: Json) => conv.is_general).id;
    const parent = await owner.ok('chat.postMessage', { channel: general, text: 'hello' });
    assert.equal((await as(coder, 'agents.sessions.setStatus', { channel_id: general, thread_ts: parent.ts, status: 'active' })).error, 'not_authorized', 'not a member');
    assert.equal((await member.call('agents.sessions.setStatus', { channel_id: channel, thread_ts: threadTs, status: 'active' })).error, 'not_allowed_token_type');
  });
});
