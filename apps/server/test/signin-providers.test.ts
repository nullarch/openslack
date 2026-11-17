import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { currentStep, totpAt } from '../src/accounts/totp.ts';
import { addMember, Session, setupWorkspace, startApp, type TestApp } from './helpers.ts';
import { FakeIdentityProvider } from './fake-idp.ts';

/** Drive a provider sign-in like a browser would: start, approve at the provider, come back. */
async function providerSignIn(t: TestApp, idp: FakeIdentityProvider, provider: string, invite?: string): Promise<{ location: string; cookie: string }> {
  const start = await fetch(`${t.base}/auth/${provider}/start${invite ? `?invite=${invite}` : ''}`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const authorize = start.headers.get('location')!;
  assert.ok(authorize.startsWith(idp.issuer), authorize);
  const callback = idp.approve(authorize);
  const done = await fetch(callback.replace(/^http:\/\/localhost:\d+/, t.base), { redirect: 'manual' });
  assert.equal(done.status, 302);
  const cookies = (done.headers.getSetCookie?.() ?? []).map((value) => value.split(';')[0]!).filter((value) => !value.endsWith('='));
  return { location: done.headers.get('location')!, cookie: cookies.join('; ') };
}

function withCookie(t: TestApp, cookie: string): Session {
  const session = new Session(t.base);
  session.cookie = cookie;
  return session;
}

const code = (secret: string, offset = 0): string => totpAt(secret, currentStep() + offset);

describe('sign in with an identity provider', () => {
  let t: TestApp;
  let idp: FakeIdentityProvider;
  let owner: Session;

  before(async () => {
    idp = new FakeIdentityProvider();
    const issuer = await idp.start();
    t = await startApp({
      identityProviders: [
        { id: 'oidc', label: 'Acme SSO', kind: 'oidc', clientId: idp.clientId, clientSecret: idp.clientSecret, issuer, createAccounts: true },
        { id: 'google', label: 'Google', kind: 'oidc', clientId: idp.clientId, clientSecret: idp.clientSecret, issuer, createAccounts: false },
        { id: 'github', label: 'GitHub', kind: 'github', clientId: idp.clientId, clientSecret: idp.clientSecret, webUrl: issuer, apiUrl: issuer, createAccounts: false },
      ],
    });
    owner = await setupWorkspace(t);
  });
  after(async () => {
    await t.close();
    await idp.stop();
  });

  test('the sign-in screen learns which providers exist', async () => {
    const status = await new Session(t.base).ok('client.status');
    assert.deepEqual(status.identity_providers, [
      { id: 'oidc', label: 'Acme SSO' },
      { id: 'google', label: 'Google' },
      { id: 'github', label: 'GitHub' },
    ]);
  });

  test('OIDC single sign-on creates the account on first use and reuses it after', async () => {
    idp.person = { sub: 'okta-1', email: 'sam@acme.test', email_verified: true, name: 'Sam Sso' };
    const first = await providerSignIn(t, idp, 'oidc');
    assert.equal(first.location, '/');
    const sam = withCookie(t, first.cookie);
    const me = await sam.ok('auth.test');
    assert.equal((await sam.ok('users.info', { user: me.user_id })).user.real_name, 'Sam Sso');
    assert.ok((await sam.ok('client.boot')).channels.some((channel: { is_general: boolean }) => channel.is_general));
    // A new address at the provider does not change which account the identity belongs to.
    idp.person = { ...idp.person, email: 'sam.renamed@acme.test' };
    const second = await providerSignIn(t, idp, 'oidc');
    assert.equal((await withCookie(t, second.cookie).ok('auth.test')).user_id, me.user_id);
  });

  test('approved domains apply to accounts created by single sign-on', async () => {
    await owner.ok('client.admin.updateSettings', { signup_domains: 'acme.test' });
    idp.person = { sub: 'okta-2', email: 'eve@elsewhere.test', email_verified: true, name: 'Eve' };
    assert.equal((await providerSignIn(t, idp, 'oidc')).location, '/signin?error=domain_not_allowed');
    await owner.ok('client.admin.updateSettings', { signup_domains: [] });
  });

  test('Google links to the account with the same verified address and creates none', async () => {
    const mina = await addMember(t, owner, 'Mina Member');
    idp.person = { sub: 'google-mina', email: 'mina.member@acme.test', email_verified: true, name: 'Mina' };
    const linked = await providerSignIn(t, idp, 'google');
    assert.equal((await withCookie(t, linked.cookie).ok('auth.test')).user_id, mina.userId);

    idp.person = { sub: 'google-stranger', email: 'stranger@acme.test', email_verified: true, name: 'Stranger' };
    assert.equal((await providerSignIn(t, idp, 'google')).location, '/signin?error=no_account');
    // An unverified address is never trusted to pick an account.
    idp.person = { sub: 'google-unverified', email: 'owner@acme.test', email_verified: false, name: 'Not Owner' };
    assert.equal((await providerSignIn(t, idp, 'google')).location, '/signin?error=email_not_verified');
  });

  test('an invite lets a provider sign-in create the account the invite is for', async () => {
    const { invite } = await owner.ok('client.invites.create', { email: 'ivy@acme.test' });
    idp.person = { sub: 'google-ivy', email: 'other@acme.test', email_verified: true, name: 'Ivy' };
    assert.equal((await providerSignIn(t, idp, 'google', invite.code)).location, `/join/${invite.code}?error=invite_email_mismatch`);
    idp.person = { sub: 'google-ivy', email: 'ivy@acme.test', email_verified: true, name: 'Ivy Invited' };
    const joined = await providerSignIn(t, idp, 'google', invite.code);
    assert.equal(joined.location, '/');
    assert.equal((await withCookie(t, joined.cookie).ok('auth.test')).user, 'ivy');
  });

  test('forged or replayed responses are refused', async () => {
    idp.person = { sub: 'okta-1', email: 'sam@acme.test', email_verified: true, name: 'Sam Sso' };
    for (const tamper of ['signature', 'nonce', 'audience'] as const) {
      idp.tamper = tamper;
      const result = await providerSignIn(t, idp, 'oidc');
      assert.equal(result.location, '/signin?error=provider_error', tamper);
      assert.equal(result.cookie, '');
    }
    idp.tamper = null;
    // A state is used once.
    const start = await fetch(`${t.base}/auth/oidc/start`, { redirect: 'manual' });
    const callback = idp.approve(start.headers.get('location')!).replace(/^http:\/\/localhost:\d+/, t.base);
    assert.equal((await fetch(callback, { redirect: 'manual' })).headers.get('location'), '/');
    assert.equal((await fetch(callback, { redirect: 'manual' })).headers.get('location'), '/signin?error=state_invalid');
    assert.equal((await fetch(`${t.base}/auth/oidc/callback?code=x&state=made-up`, { redirect: 'manual' })).headers.get('location'), '/signin?error=state_invalid');
    assert.equal((await fetch(`${t.base}/auth/nope/start`, { redirect: 'manual' })).headers.get('location'), '/signin?error=provider_not_found');
  });

  test('GitHub signs in with the verified primary address', async () => {
    const gil = await addMember(t, owner, 'Gil Hub');
    idp.githubEmails = [
      { email: 'gil.hub@personal.test', primary: false, verified: true },
      { email: 'gil.hub@acme.test', primary: true, verified: true },
    ];
    const result = await providerSignIn(t, idp, 'github');
    assert.equal((await withCookie(t, result.cookie).ok('auth.test')).user_id, gil.userId);
    idp.githubEmails = [{ email: 'gil.hub@acme.test', primary: true, verified: false }];
    idp.githubUser = { id: 9999, login: 'other', name: 'Other' };
    assert.equal((await providerSignIn(t, idp, 'github')).location, '/signin?error=email_not_verified');
  });
});

describe('two-factor sign-in', () => {
  let t: TestApp;
  let idp: FakeIdentityProvider;
  let owner: Session;
  let secret: string;

  before(async () => {
    idp = new FakeIdentityProvider();
    const issuer = await idp.start();
    t = await startApp({
      identityProviders: [{ id: 'oidc', label: 'SSO', kind: 'oidc', clientId: idp.clientId, clientSecret: idp.clientSecret, issuer, createAccounts: true }],
    });
    owner = await setupWorkspace(t);
  });
  after(async () => {
    await t.close();
    await idp.stop();
  });

  test('turning it on: an authenticator code proves the secret, and backup codes come once', async () => {
    const begun = await owner.ok('client.twoFactor.begin');
    secret = begun.secret;
    assert.match(begun.otpauth_url, /^otpauth:\/\/totp\/.+secret=[A-Z2-7]+/);
    assert.equal((await owner.call('client.twoFactor.enable', { code: '000000' === code(secret) ? '111111' : '000000' })).error, 'invalid_code');
    const enabled = await owner.ok('client.twoFactor.enable', { code: code(secret) });
    assert.equal(enabled.backup_codes.length, 10);
    assert.match(enabled.backup_codes[0], /^[a-z0-9]{5}-[a-z0-9]{5}$/);
    const status = await owner.ok('client.twoFactor.status');
    assert.deepEqual([status.enabled, status.backup_codes_left], [true, 10]);
    (globalThis as { backupCodes?: string[] }).backupCodes = enabled.backup_codes;
  });

  test('a password alone is not enough; the second step starts the session', async () => {
    const browser = new Session(t.base);
    const first = await browser.ok('client.signin', { email: 'owner@acme.test', password: 'correct horse battery' });
    assert.deepEqual([first.two_factor_required, first.user_id], [true, undefined]);
    assert.ok(browser.cookie.startsWith('tfa='));
    assert.equal((await browser.call('auth.test')).error, 'not_authed');
    assert.equal((await browser.call('client.signin.twoFactor', { code: '12345' })).error, 'invalid_code');
    // The code just used to enable it cannot be replayed; the next step's code works.
    const done = await browser.ok('client.signin.twoFactor', { code: code(secret, 1) });
    assert.equal(done.user_id, owner.userId);
    assert.equal((await browser.ok('auth.test')).user_id, owner.userId);
  });

  test('a backup code works once; a challenge allows five tries', async () => {
    const backup = (globalThis as { backupCodes?: string[] }).backupCodes![0]!;
    const browser = new Session(t.base);
    await browser.ok('client.signin', { email: 'owner@acme.test', password: 'correct horse battery' });
    await browser.ok('client.signin.twoFactor', { code: backup.toUpperCase() });
    const again = new Session(t.base);
    await again.ok('client.signin', { email: 'owner@acme.test', password: 'correct horse battery' });
    assert.equal((await again.call('client.signin.twoFactor', { code: backup })).error, 'invalid_code');
    for (let i = 0; i < 4; i += 1) await again.call('client.signin.twoFactor', { code: 'aaaaa-aaaaa' });
    assert.equal((await again.call('client.signin.twoFactor', { code: (globalThis as { backupCodes?: string[] }).backupCodes![1] })).error, 'challenge_expired');
  });

  test('provider sign-in also asks for the second factor', async () => {
    await owner.ok('client.twoFactor.status');
    idp.person = { sub: 'sso-owner', email: 'owner@acme.test', email_verified: true, name: 'Owner' };
    const start = await fetch(`${t.base}/auth/oidc/start`, { redirect: 'manual' });
    const done = await fetch(idp.approve(start.headers.get('location')!).replace(/^http:\/\/localhost:\d+/, t.base), { redirect: 'manual' });
    assert.equal(done.headers.get('location'), '/signin?step=two-factor');
    const browser = new Session(t.base);
    browser.cookie = done.headers.getSetCookie()[0]!.split(';')[0]!;
    assert.equal((await browser.call('auth.test')).error, 'not_authed');
    await browser.ok('client.signin.twoFactor', { code: (globalThis as { backupCodes?: string[] }).backupCodes![2] });
    assert.equal((await browser.ok('auth.test')).user_id, owner.userId);
  });

  test('when the workspace requires it, people set it up before anything else', async () => {
    const member = await addMember(t, owner, 'Mina Member');
    await owner.ok('client.admin.updateSettings', { require_2fa: true });
    assert.equal((await member.call('conversations.list')).error, 'two_factor_setup_required');
    assert.equal((await member.call('client.boot')).error, 'two_factor_setup_required');
    assert.equal((await member.ok('client.status')).two_factor_setup_required, true);
    await assert.rejects(member.connect());
    const begun = await member.ok('client.twoFactor.begin');
    await member.ok('client.twoFactor.enable', { code: code(begun.secret) });
    await member.ok('conversations.list');
    assert.equal((await member.call('client.twoFactor.disable', { code: code(begun.secret, 1) })).error, 'required_by_workspace');
    await owner.ok('client.admin.updateSettings', { require_2fa: false });
    await member.ok('client.twoFactor.disable', { code: code(begun.secret, 1) });
    assert.equal((await member.ok('client.twoFactor.status')).enabled, false);
  });
});
