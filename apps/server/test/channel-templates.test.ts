import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, setupWorkspace, startApp, type Json, type Session, type TestApp } from './helpers.ts';

describe('channel templates', () => {
  let t: TestApp;
  let owner: Session;
  let mia: Session;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    mia = await addMember(t, owner, 'Mia Member');
  });
  after(() => t.close());

  test('a project channel starts with its description, brief and task list', async () => {
    const ids = (await mia.ok('client.channels.templates.list')).templates.map((template: Json) => template.id);
    assert.ok(ids.includes('project') && ids.includes('help-requests'));
    assert.ok(!ids.includes('announcements'), 'admin-only templates are not offered to members');
    const created = await mia.ok('client.channels.createFromTemplate', { template: 'project', name: 'Website Relaunch' });
    assert.equal(created.channel.name, 'website-relaunch');
    assert.match(created.channel.purpose.value, /Planning and progress/);
    assert.deepEqual(created.docs.map((doc: Json) => [doc.kind, doc.title]), [['canvas', 'Project brief'], ['list', 'Tasks']]);
    const tabs = (await mia.ok('client.docs.list', { channel: created.channel.id })).docs.map((doc: Json) => doc.title).sort();
    assert.deepEqual(tabs, ['Project brief', 'Tasks']);
    assert.equal((await mia.call('client.channels.createFromTemplate', { template: 'project', name: 'website-relaunch' })).error, 'name_taken');
    assert.equal((await mia.call('client.channels.createFromTemplate', { template: 'nope', name: 'x' })).error, 'template_not_found');
  });

  test('help requests post a welcome; announcements restrict posting and are for admins', async () => {
    const help = await mia.ok('client.channels.createFromTemplate', { template: 'help-requests', name: 'it-help', is_private: true });
    assert.equal(help.channel.is_private, true);
    const history = (await mia.ok('conversations.history', { channel: help.channel.id })).messages.map((m: Json) => m.text);
    assert.ok(history.some((text: string) => text.startsWith('Welcome! Describe what you need')));
    assert.equal((await mia.call('client.channels.createFromTemplate', { template: 'announcements', name: 'news' })).error, 'restricted_action');
    const news = await owner.ok('client.channels.createFromTemplate', { template: 'announcements', name: 'news' });
    await mia.ok('conversations.join', { channel: news.channel.id });
    assert.equal((await mia.call('chat.postMessage', { channel: news.channel.id, text: 'can I post?' })).ok, false, 'only admins post');
  });
});
