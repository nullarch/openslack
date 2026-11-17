import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';
import { asBot, botOk, createPlatformApp, type TestAppCredentials } from './platform-helpers.ts';

describe('featured workflows (workflows.featured.*) and team.billing.info', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let outsider: Session;
  let app: TestAppCredentials;
  let channel: string;
  let secret: string;
  let linkTrigger: string;
  let otherLink: string;
  let scheduled: Json;

  const build = async (name: string, trigger: Json): Promise<Json> => {
    const destination = trigger.type === 'link' ? { to: 'trigger_channel' } : { to: 'channel', channel };
    const saved = await owner.ok('client.workflows.save', { name, trigger, steps: [{ id: 'say', type: 'message', destination, text: 'hi' }] });
    await owner.ok('client.workflows.publish', { workflow: saved.workflow.id });
    return (await owner.ok('client.workflows.get', { workflow: saved.workflow.id })).workflow;
  };

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    outsider = await addMember(t, owner, 'Otto Outsider');
    app = await createPlatformApp(owner, 'Ops');
    channel = (await owner.ok('conversations.create', { name: 'onboarding' })).channel.id;
    secret = (await owner.ok('conversations.create', { name: 'hr', is_private: true })).channel.id;
    await owner.ok('conversations.invite', { channel, users: `${member.userId},${app.botUserId}` });
    linkTrigger = (await build('Request access', { type: 'link' })).trigger_id;
    otherLink = (await build('Order a laptop', { type: 'link' })).trigger_id;
    scheduled = await build('Weekly check-in', { type: 'schedule', schedule: { frequency: 'daily', time: '09:00', tz: 'UTC' } });
  });
  after(() => t.close());

  test('add, list, set and remove, in the channel’s order', async () => {
    assert.match(linkTrigger, /^FtWf[A-Z0-9]+$/);
    await botOk(t.base, app, 'workflows.featured.add', { channel_id: channel, trigger_ids: linkTrigger });
    await member.ok('workflows.featured.add', { channel_id: channel, trigger_ids: [otherLink] });
    const listed = await member.ok('workflows.featured.list', { channel_ids: [channel] });
    assert.deepEqual(listed.featured_workflows, [{ channel_id: channel, triggers: [{ id: linkTrigger, title: 'Request access' }, { id: otherLink, title: 'Order a laptop' }] }]);
    await member.ok('workflows.featured.set', { channel_id: channel, trigger_ids: [otherLink, linkTrigger] });
    assert.deepEqual((await member.ok('workflows.featured.list', { channel_ids: channel })).featured_workflows[0].triggers.map((item: Json) => item.id), [otherLink, linkTrigger]);
    await member.ok('workflows.featured.remove', { channel_id: channel, trigger_ids: [otherLink] });
    const featured = (await member.ok('client.workflows.featured', { channel })).featured;
    assert.deepEqual(featured.map((item: Json) => item.title), ['Request access']);
    assert.ok(featured[0].link, 'the client gets the link to start it');
    await member.ok('workflows.featured.set', { channel_id: channel, trigger_ids: [] });
    assert.deepEqual((await member.ok('client.workflows.featured', { channel })).featured, []);
  });

  test('only published link workflows; only channels the caller can see and post in', async () => {
    assert.equal((await member.call('workflows.featured.add', { channel_id: channel, trigger_ids: `Ft${scheduled.id}` })).error, 'error_modifying_workflows');
    assert.equal((await member.call('workflows.featured.add', { channel_id: channel, trigger_ids: 'Ft123' })).error, 'error_modifying_workflows');
    assert.equal((await outsider.call('workflows.featured.add', { channel_id: secret, trigger_ids: linkTrigger })).error, 'channel_not_found');
    assert.equal((await outsider.call('workflows.featured.list', { channel_ids: secret })).error, 'channel_not_found');
    assert.equal((await outsider.call('workflows.featured.list', { channel_ids: [] })).error, 'error_invalid_channels');
  });

  test('team.billing.info: no plan limits here', async () => {
    assert.equal((await botOk(t.base, app, 'team.billing.info')).plan, 'plus');
    assert.equal((await asBot(t.base, app, 'team.billing.info')).ok, true);
  });
});
