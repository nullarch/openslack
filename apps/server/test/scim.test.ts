import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, setupWorkspace, startApp, Session, type Json, type TestApp } from './helpers.ts';

/** SCIM 2.0 provisioning, with the requests Okta and Microsoft Entra ID send. */
describe('SCIM provisioning', () => {
  let t: TestApp;
  let owner: Session;
  let token: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    token = (await owner.ok('client.admin.scimToken')).token;
  });
  after(() => t.close());

  const scim = async (method: string, path: string, body?: unknown, bearer = token): Promise<{ status: number; body: Json }> => {
    const response = await fetch(`${t.base}/scim/v2${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/scim+json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Json) : {} };
  };

  test('only an admin SCIM token gets in', async () => {
    assert.equal((await scim('GET', '/Users', undefined, 'xoxp-nope')).status, 401);
    const member = await addMember(t, owner, 'Mia Member');
    assert.equal((await member.call('client.admin.scimToken')).error, 'not_allowed');
    const config = await scim('GET', '/ServiceProviderConfig');
    assert.equal(config.status, 200);
    assert.equal(config.body.patch.supported, true);
    // The token is for provisioning only.
    const api = await fetch(`${t.base}/api/chat.postMessage`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ channel: '#general', text: 'x' }) });
    assert.equal(((await api.json()) as Json).error, 'missing_scope');
  });

  test('create (Okta style), find by userName, then sign in after a password is set', async () => {
    const created = await scim('POST', '/Users', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'dana.kim@acme.test',
      name: { givenName: 'Dana', familyName: 'Kim' },
      emails: [{ primary: true, value: 'dana.kim@acme.test', type: 'work' }],
      displayName: 'Dana',
      externalId: '00u1abcd',
      active: true,
      password: 'a long enough password',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.body.id, /^U/);
    assert.equal(created.body.userName, 'dana.kim@acme.test');
    assert.equal(created.body.name.formatted, 'Dana Kim');
    assert.equal(created.body.externalId, '00u1abcd');
    assert.equal(created.body.active, true);

    const found = await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "Dana.Kim@acme.test"')}&startIndex=1&count=10`);
    assert.equal(found.body.totalResults, 1);
    assert.equal(found.body.Resources[0].id, created.body.id);
    assert.equal((await scim('GET', `/Users?filter=${encodeURIComponent('externalId eq "00u1abcd"')}`)).body.totalResults, 1);
    assert.equal((await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "nobody@acme.test"')}`)).body.totalResults, 0);

    const dana = new Session(t.base);
    await dana.ok('client.signin', { email: 'dana.kim@acme.test', password: 'a long enough password' });
    const users = (await owner.ok('users.list')).members;
    assert.equal(users.find((user: Json) => user.id === created.body.id).real_name, 'Dana Kim');

    const duplicate = await scim('POST', '/Users', { userName: 'dana.kim@acme.test', emails: [{ value: 'dana.kim@acme.test' }] });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.scimType, 'uniqueness');
  });

  test('PATCH (Entra style) changes names and deactivates; PUT replaces; DELETE deactivates', async () => {
    const created = await scim('POST', '/Users', { userName: 'lee@acme.test', name: { givenName: 'Lee', familyName: 'Park' }, emails: [{ value: 'lee@acme.test', primary: true }] });
    const id = created.body.id;
    const lee = new Session(t.base);
    await scim('PATCH', `/Users/${id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'password', value: 'another long password' }] });
    await lee.ok('client.signin', { email: 'lee@acme.test', password: 'another long password' });

    const renamed = await scim('PATCH', `/Users/${id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [
        { op: 'Replace', path: 'name.familyName', value: 'Park-Kim' },
        { op: 'Replace', path: 'title', value: 'Designer' },
        { op: 'Add', path: 'emails[type eq "work"].value', value: 'lee.park@acme.test' },
      ],
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.name.formatted, 'Lee Park-Kim');
    assert.equal(renamed.body.title, 'Designer');
    assert.equal(renamed.body.emails[0].value, 'lee.park@acme.test');

    // Entra sends booleans as strings.
    const off = await scim('PATCH', `/Users/${id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] });
    assert.equal(off.body.active, false);
    assert.equal((await lee.call('auth.test')).ok, false, 'a deactivated account is signed out');

    const back = await scim('PUT', `/Users/${id}`, { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'lee.park@acme.test', name: { givenName: 'Lee', familyName: 'Park' }, emails: [{ value: 'lee.park@acme.test', primary: true }], active: true });
    assert.equal(back.body.active, true);
    assert.equal(back.body.name.formatted, 'Lee Park');
    // Okta's whole-object form.
    const viaValue = await scim('PATCH', `/Users/${id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', value: { active: false } }] });
    assert.equal(viaValue.body.active, false);
    await scim('PATCH', `/Users/${id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', value: { active: true } }] });

    assert.equal((await scim('DELETE', `/Users/${id}`)).status, 204);
    assert.equal((await scim('GET', `/Users/${id}`)).body.active, false, 'deleting keeps the account, deactivated');
    assert.equal((await scim('GET', '/Users/UNOPE')).status, 404);
  });

  test('the primary owner cannot be deactivated; bots are not listed', async () => {
    const refused = await scim('PATCH', `/Users/${owner.userId}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }] });
    assert.equal(refused.status, 400);
    await owner.ok('client.apps.create', { name: 'Some Bot' });
    const all = await scim('GET', '/Users?count=200');
    assert.ok(all.body.Resources.every((user: Json) => !String(user.userName).includes('some-bot')));
    assert.equal((await scim('GET', `/Users?filter=${encodeURIComponent('title co "x"')}`)).status, 400);
  });
});
