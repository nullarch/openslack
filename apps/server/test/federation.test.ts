import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { signedHeaders } from '../src/federation/keys.ts';
import { until } from './canvas-client.ts';
import { addMember, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';

/** Two servers of two organisations, on this machine. */
async function organisation(name: string): Promise<{ app: TestApp; owner: Session }> {
  const app = await startApp();
  const owner = new Session(app.base);
  const result = await owner.ok('client.setup', {
    team_name: name,
    email: `owner@${name.toLowerCase()}.test`,
    password: 'correct horse battery',
    real_name: `${name} Owner`,
  });
  owner.userId = result.user_id;
  return { app, owner };
}

const history = async (session: Session, channel: string, limit = 20): Promise<Json[]> => (await session.ok('conversations.history', { channel, limit })).messages;

describe('channels shared between servers', () => {
  let acme: { app: TestApp; owner: Session };
  let globex: { app: TestApp; owner: Session };
  let ana: Session; // at Acme
  let gus: Session; // at Globex
  let acmeChannel: string;
  let globexChannel: string;

  before(async () => {
    acme = await organisation('Acme');
    globex = await organisation('Globex');
    ana = await addMember(acme.app, acme.owner, 'Ana Acme');
    gus = await addMember(globex.app, globex.owner, 'Gus Globex');
    acmeChannel = (await acme.owner.ok('conversations.create', { name: 'partners' })).channel.id;
    await acme.owner.ok('conversations.invite', { channel: acmeChannel, users: ana.userId });
    await acme.owner.ok('chat.postMessage', { channel: acmeChannel, text: 'Welcome, before anyone else joined' });
  });
  after(async () => {
    await acme.app.close();
    await globex.app.close();
  });

  test('an admin shares a channel with a link; an admin of the other server accepts it there', async () => {
    assert.equal((await ana.call('conversations.inviteShared', { channel: acmeChannel })).error, 'restricted_action');
    const invite = await acme.owner.ok('conversations.inviteShared', { channel: acmeChannel });
    assert.match(invite.invite_id, /^I[A-Z0-9]+$/);
    assert.match(invite.url, /\/connect\/I[A-Z0-9]+\.[A-Za-z0-9_-]+$/);
    assert.equal((await gus.call('conversations.acceptSharedInvite', { invite_id: invite.url, channel_name: 'acme' })).error, 'restricted_action');

    const accepted = await globex.owner.ok('conversations.acceptSharedInvite', { invite_id: invite.url, channel_name: 'acme-partners' });
    assert.equal(accepted.implicit_approval, true);
    globexChannel = accepted.channel_id;
    // The link works once.
    assert.equal((await globex.owner.call('conversations.acceptSharedInvite', { invite_id: invite.url, channel_name: 'again' })).error, 'invite_used');

    // Globex has the channel, Acme's people in it, and its recent history.
    const info = (await globex.owner.ok('conversations.info', { channel: globexChannel })).channel;
    assert.equal(info.name, 'acme-partners');
    assert.equal(info.is_shared, true);
    assert.equal(info.is_ext_shared, true);
    const acmeTeam = (await acme.owner.ok('team.info')).team.id;
    const globexTeam = (await globex.owner.ok('team.info')).team.id;
    assert.deepEqual([...info.shared_team_ids].sort(), [acmeTeam, globexTeam].sort());
    assert.equal(info.conversation_host_id, acmeTeam);
    const members = (await globex.owner.ok('conversations.members', { channel: globexChannel })).members as string[];
    assert.equal(members.length, 3);
    const standIn = (await globex.owner.ok('users.info', { user: members.find((id) => id !== globex.owner.userId) })).user;
    assert.equal(standIn.team_id, acmeTeam);
    const copied = (await history(globex.owner, globexChannel)).find((message) => message.text === 'Welcome, before anyone else joined');
    assert.ok(copied, 'the recent history came along');
    assert.equal((await globex.owner.ok('users.info', { user: copied.user })).user.team_id, (await acme.owner.ok('team.info')).team.id);
    // Stand-ins are not people of this workspace.
    const listed = (await globex.owner.ok('users.list')).members as Json[];
    assert.ok(listed.every((user) => user.team_id === globexTeam));

    // Acme sees Globex's admin join.
    await until(async () => (await acme.owner.ok('conversations.members', { channel: acmeChannel })).members.length === 3);
    assert.equal((await acme.owner.ok('conversations.info', { channel: acmeChannel })).channel.is_ext_shared, true);
  });

  test('messages, replies, mentions, edits, reactions and deletions go both ways', async () => {
    await globex.owner.ok('conversations.invite', { channel: globexChannel, users: gus.userId });
    await until(async () => (await acme.owner.ok('conversations.members', { channel: acmeChannel })).members.length === 4);
    const acmeMembers = (await acme.owner.ok('conversations.members', { channel: acmeChannel })).members as string[];
    const gusHere = (await Promise.all(acmeMembers.map(async (id) => (await acme.owner.ok('users.info', { user: id })).user))).find((user: Json) => user.real_name === 'Gus Globex');
    assert.ok(gusHere, 'Gus has a stand-in at Acme');

    // Acme → Globex, mentioning Gus by his Acme stand-in.
    const posted = await ana.ok('chat.postMessage', { channel: acmeChannel, text: `Hi <@${gusHere.id}>, the contract is ready` });
    await until(async () => (await history(gus, globexChannel)).some((message) => message.text?.startsWith('Hi <@')));
    const arrived = (await history(gus, globexChannel)).find((message) => message.text?.startsWith('Hi <@'));
    assert.equal(arrived.text, `Hi <@${gus.userId}>, the contract is ready`, 'the mention points at the real Gus');
    const mention = await until(async () => ((await gus.ok('client.activity.list', {})).items as Json[]).some((item) => item.ts === arrived.ts));
    void mention;

    // Globex → Acme, in the thread.
    await gus.ok('chat.postMessage', { channel: globexChannel, thread_ts: arrived.ts, text: 'Signed.' });
    await until(async () => (await ana.ok('conversations.replies', { channel: acmeChannel, ts: posted.ts })).messages.length === 2);

    // Edit, reaction, deletion.
    await ana.ok('chat.update', { channel: acmeChannel, ts: posted.ts, text: 'Hi, the contract is ready (v2)' });
    await until(async () => (await history(gus, globexChannel)).some((message) => message.ts === arrived.ts && message.text === 'Hi, the contract is ready (v2)'));
    await gus.ok('reactions.add', { channel: globexChannel, timestamp: arrived.ts, name: 'tada' });
    await until(async () => ((await ana.ok('reactions.get', { channel: acmeChannel, timestamp: posted.ts })).message.reactions ?? []).some((reaction: Json) => reaction.name === 'tada'));
    const doomed = await gus.ok('chat.postMessage', { channel: globexChannel, text: 'oops, wrong channel' });
    await until(async () => (await history(ana, acmeChannel)).some((message) => message.text === 'oops, wrong channel'));
    await gus.ok('chat.delete', { channel: globexChannel, ts: doomed.ts });
    await until(async () => !(await history(ana, acmeChannel)).some((message) => message.text === 'oops, wrong channel'));
  });

  test('topic and profile changes cross over', async () => {
    await gus.ok('conversations.setTopic', { channel: globexChannel, topic: 'Contract work' });
    await until(async () => (await acme.owner.ok('conversations.info', { channel: acmeChannel })).channel.topic.value === 'Contract work');
    await ana.ok('users.profile.set', { profile: { title: 'Account manager' } });
    await until(async () => {
      const members = (await globex.owner.ok('conversations.members', { channel: globexChannel })).members as string[];
      const users = await Promise.all(members.map(async (id) => (await globex.owner.ok('users.info', { user: id })).user));
      return users.some((user: Json) => user.real_name === 'Ana Acme' && user.profile.title === 'Account manager');
    });
  });

  test('people who share a channel can message each other directly', async () => {
    const acmeMembers = (await ana.ok('conversations.members', { channel: acmeChannel })).members as string[];
    const users = await Promise.all(acmeMembers.map(async (id) => (await ana.ok('users.info', { user: id })).user));
    const gusHere = users.find((user: Json) => user.real_name === 'Gus Globex');
    const dm = (await ana.ok('conversations.open', { users: gusHere.id })).channel.id;
    await ana.ok('chat.postMessage', { channel: dm, text: 'A word in private?' });
    let gusDm = '';
    await until(async () => {
      const ims = (await gus.ok('conversations.list', { types: 'im' })).channels as Json[];
      for (const im of ims) {
        const messages = await history(gus, im.id, 5);
        if (messages.some((message) => message.text === 'A word in private?')) {
          gusDm = im.id;
          return true;
        }
      }
      return false;
    });
    await gus.ok('chat.postMessage', { channel: gusDm, text: 'Sure.' });
    await until(async () => (await history(ana, dm, 5)).some((message) => message.text === 'Sure.'));
  });

  test('a peer cannot speak for this server’s people, about conversations it does not share, or unsigned', async () => {
    const path = '/federation/v1/events';
    const acmeTeam = (await acme.owner.ok('team.info')).team.id;
    const globexTeam = (await globex.owner.ok('team.info')).team.id;
    const send = async (events: Json[], sign = true): Promise<Response> => {
      const body = JSON.stringify({ events });
      // Signed by Globex, sent to Acme.
      const headers: Record<string, string> = sign ? signedHeaders(globex.app.app.ctx, 'POST', path, body) : { 'x-federation-server': globex.app.app.ctx.config.publicUrl };
      return fetch(`${acme.app.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    };
    assert.equal((await send([], false)).status, 401);
    const before = (await history(ana, acmeChannel, 50)).length;
    const remoteChannel = globexChannel;
    // Posing as Ana (an Acme person) is ignored.
    await send([{ id: 'x1', type: 'message.posted', channel: remoteChannel, message: { ref: { team: globexTeam, ts: '1700000000.000100' }, user: { team: acmeTeam, id: ana.userId }, text: 'I am Ana' } }]);
    // A conversation not shared with Globex is ignored.
    const general = (await ana.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    await send([{ id: 'x2', type: 'message.posted', channel: general, message: { ref: { team: globexTeam, ts: '1700000000.000200' }, user: { team: globexTeam, id: gus.userId }, text: 'into general' } }]);
    assert.equal((await history(ana, acmeChannel, 50)).length, before);
    assert.ok(!(await history(ana, general, 50)).some((message) => message.text === 'into general'));
    // Changing or deleting a message Acme wrote is ignored.
    const own = await ana.ok('chat.postMessage', { channel: acmeChannel, text: 'mine to keep' });
    await send([
      { id: 'x3', type: 'message.changed', channel: remoteChannel, message: { ref: { team: acmeTeam, ts: own.ts }, user: { team: globexTeam, id: gus.userId }, text: 'rewritten' } },
      { id: 'x4', type: 'message.deleted', channel: remoteChannel, ref: { team: acmeTeam, ts: own.ts } },
    ]);
    const kept = (await history(ana, acmeChannel, 5)).find((message) => message.ts === own.ts);
    assert.equal(kept?.text, 'mine to keep');
  });

  test('while the other server cannot be reached, changes wait and then arrive in order', async () => {
    const ctx = acme.app.app.ctx;
    const peer = ctx.db.get<{ id: string; url: string }>('SELECT id, url FROM peers')!;
    ctx.db.run('UPDATE peers SET url = ? WHERE id = ?', 'http://127.0.0.1:9', peer.id);
    await ana.ok('chat.postMessage', { channel: acmeChannel, text: 'queued one' });
    await ana.ok('chat.postMessage', { channel: acmeChannel, text: 'queued two' });
    await until(async () => {
      const listed = ((await acme.owner.ok('client.connect.list')).peers as Json[])[0];
      return listed.pending >= 2 && listed.last_error !== null;
    });
    ctx.db.run('UPDATE peers SET url = ? WHERE id = ?', peer.url, peer.id);
    await until(async () => (await history(gus, globexChannel, 5)).some((message) => message.text === 'queued two'), 10_000);
    const texts = (await history(gus, globexChannel, 5)).map((message) => message.text);
    assert.ok(texts.indexOf('queued two') < texts.indexOf('queued one'), 'newest first: two after one');
  });

  test('when one side stops sharing, both keep their copy and the other side’s people leave it', async () => {
    await acme.owner.ok('client.connect.stop', { channel: acmeChannel });
    assert.equal((await acme.owner.ok('conversations.info', { channel: acmeChannel })).channel.is_ext_shared, false);
    await until(async () => (await globex.owner.ok('conversations.info', { channel: globexChannel })).channel.is_ext_shared === false);
    await ana.ok('chat.postMessage', { channel: acmeChannel, text: 'after the split' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(!(await history(gus, globexChannel)).some((message) => message.text === 'after the split'));
    assert.ok((await history(gus, globexChannel, 50)).length > 0, 'history stays');
  });
});
