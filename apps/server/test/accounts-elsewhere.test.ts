import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { currentStep, totpAt } from '../src/accounts/totp.ts';
import { addMember, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(check: () => Promise<T> | T, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(25);
  }
}

async function signupGuest(t: TestApp, owner: Session, email: string, channels: string[]): Promise<Session> {
  const { invite } = await owner.ok('client.invites.create', { email, guest: 'multi', channels });
  const session = new Session(t.base);
  session.userId = (await session.ok('client.signup', { code: invite.code, email, password: 'a guest password', real_name: email.split('@')[0] })).user_id;
  return session;
}

/** Account rules hold in the modules that act for people outside the API methods. */
describe('account rules elsewhere', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let project: string;
  let random: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    member = await addMember(t, owner, 'Mina Member');
    project = (await owner.ok('conversations.create', { name: 'project' })).channel.id;
    random = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.name === 'random').id;
  });
  after(() => t.close());

  test('a workflow never adds a guest to a channel', async () => {
    const saved = await member.ok('client.workflows.save', {
      name: 'Onboarding',
      trigger: { type: 'member_joined', channel: project },
      steps: [{ id: 'add', type: 'add_to_channel', channel: random, user: 'trigger.user' }],
    });
    const workflow = (await member.ok('client.workflows.publish', { workflow: saved.workflow.id })).workflow;
    const runs = async (): Promise<Json[]> => (await member.ok('client.workflows.runs', { workflow: workflow.id })).runs;

    // An admin brings a guest into #project; the workflow runs and refuses the step.
    const guest = await signupGuest(t, owner, 'gia@agency.test', [project]);
    const failed = await until(async () => (await runs()).find((run) => run.runner === guest.userId && run.status === 'failed'));
    assert.match(JSON.stringify(failed.log), /do not add guests/);
    assert.equal((await guest.call('conversations.info', { channel: random })).error, 'channel_not_found');

    // A member who joins is added as before.
    await owner.ok('conversations.invite', { channel: project, users: member.userId });
    await until(async () => (await runs()).some((run) => run.runner === member.userId && run.status === 'completed'));
    assert.equal((await member.ok('conversations.info', { channel: random })).channel.is_member, true);
  });

  test('signing into an app with this workspace follows the same rules as the workspace', async () => {
    const redirect = 'https://wiki.example.com/auth/callback';
    const created = await owner.ok('client.apps.create', { name: 'Team Wiki' });
    await owner.ok('client.apps.update', { app: created.app.id, redirect_urls: [redirect] });
    const { client_id } = await owner.ok('client.apps.info', { app: created.app.id });
    const authorize = (as: Session): Promise<Response> =>
      fetch(
        `${t.base}/openid/connect/authorize?${new URLSearchParams({ response_type: 'code', scope: 'openid profile', client_id, redirect_uri: redirect, state: 's', nonce: 'n' })}`,
        { headers: { cookie: as.cookie }, redirect: 'manual' },
      );
    const consent = async (as: Session): Promise<boolean> => {
      const response = await authorize(as);
      if (response.status === 200) return /form_token/.test(await response.text());
      assert.match(response.headers.get('location') ?? '', /^\/signin\?/);
      return false;
    };
    assert.equal(await consent(member), true);

    // Two-factor sign-in becomes required: until the member sets it up, apps cannot be signed into either.
    const secret = (await owner.ok('client.security.twoFactor.begin')).secret as string;
    await owner.ok('client.security.twoFactor.enable', { code: totpAt(secret, currentStep()) });
    await owner.ok('client.admin.updateSettings', { require_2fa: true });
    assert.equal(await consent(member), false);
    assert.equal(await consent(owner), true);
    await owner.ok('client.admin.updateSettings', { require_2fa: false });
    assert.equal(await consent(member), true);

    // A guest whose access has run out is not let through, even before the next sweep.
    const guest = await signupGuest(t, owner, 'tess@agency.test', [project]);
    assert.equal(await consent(guest), true);
    t.app.ctx.db.run('UPDATE users SET guest_expires = ? WHERE id = ?', Math.floor(Date.now() / 1000) - 1, guest.userId);
    assert.equal(await consent(guest), false);
  });
});
