import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { SignedXml } from 'xml-crypto';
import { parseIdpMetadata } from '../src/accounts/saml.ts';
import { setupWorkspace, startApp, type Session, type TestApp } from './helpers.ts';

/** A key and self-signed certificate, made with openssl for this run (nothing secret is kept in the repository). */
function keyPair(dir: string, name: string): { key: string; cert: string; certBody: string } {
  const keyFile = join(dir, `${name}.key`);
  const certFile = join(dir, `${name}.crt`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '2', '-subj', `/CN=${name}`], { stdio: 'ignore' });
  const cert = readFileSync(certFile, 'utf8');
  return { key: readFileSync(keyFile, 'utf8'), cert, certBody: cert.replace(/-----(BEGIN|END) CERTIFICATE-----|\s+/g, '') };
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

const IDP = 'https://idp.example.test/saml';
const SSO = 'https://idp.example.test/sso';

interface Answer {
  inResponseTo?: string | null;
  email?: string;
  name?: string;
  audience?: string;
  notOnOrAfter?: Date;
  key?: string;
  sign?: boolean;
  tamper?: (xml: string) => string;
}

describe('SAML 2.0 single sign-on', () => {
  let dir: string;
  let idp: ReturnType<typeof keyPair>;
  let other: ReturnType<typeof keyPair>;
  let t: TestApp;
  let base: string;
  let owner: Session;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'saml-'));
    idp = keyPair(dir, 'idp');
    other = keyPair(dir, 'stranger');
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    t = await startApp({
      port,
      publicUrl: base,
      identityProviders: [
        { id: 'saml', label: 'Acme Okta', kind: 'saml', clientId: '', clientSecret: '', createAccounts: true, saml: { metadataUrl: null, entryPoint: SSO, certs: [idp.certBody], entityId: null } },
      ],
    });
    owner = await setupWorkspace(t);
  });
  after(async () => {
    await t.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Press the button: returns the relay state and the id of the request sent to the provider. */
  async function start(): Promise<{ relay: string; requestId: string }> {
    const response = await fetch(`${base}/auth/saml/start`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get('location')!);
    assert.equal(`${location.origin}${location.pathname}`, SSO);
    const request = inflateRawSync(Buffer.from(location.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
    assert.match(request, new RegExp(`AssertionConsumerServiceURL="${base}/auth/saml/callback"`));
    return { relay: location.searchParams.get('RelayState')!, requestId: /ID="([^"]+)"/.exec(request)![1]! };
  }

  /** What the provider would post back. */
  function answer(options: Answer): string {
    const now = new Date();
    const later = options.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000);
    const assertionId = `_a${randomUUID().replace(/-/g, '')}`;
    const inResponse = options.inResponseTo ? ` InResponseTo="${options.inResponseTo}"` : '';
    const email = options.email ?? 'sam@acme.test';
    const assertion =
      `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${now.toISOString()}">` +
      `<saml:Issuer>${IDP}</saml:Issuer>` +
      `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${inResponse} NotOnOrAfter="${later.toISOString()}" Recipient="${base}/auth/saml/callback"/></saml:SubjectConfirmation></saml:Subject>` +
      `<saml:Conditions NotBefore="${new Date(now.getTime() - 60_000).toISOString()}" NotOnOrAfter="${later.toISOString()}"><saml:AudienceRestriction><saml:Audience>${options.audience ?? `${base}/auth/saml/metadata`}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="${assertionId}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
      `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="displayName"><saml:AttributeValue>${options.name ?? 'Sam Sato'}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
      `</saml:Assertion>`;
    let xml =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r${randomUUID().replace(/-/g, '')}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${base}/auth/saml/callback"${inResponse}>` +
      `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${IDP}</saml:Issuer>` +
      `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertion}</samlp:Response>`;
    if (options.sign !== false) {
      const signer = new SignedXml({ privateKey: options.key ?? idp.key, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
      signer.addReference({
        xpath: "//*[local-name(.)='Assertion']",
        transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
        digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      });
      signer.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
      xml = signer.getSignedXml();
    }
    if (options.tamper) xml = options.tamper(xml);
    return Buffer.from(xml).toString('base64');
  }

  async function post(relay: string, samlResponse: string): Promise<{ location: string; cookie: string }> {
    const response = await fetch(`${base}/auth/saml/callback`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://idp.example.test' },
      body: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: relay }).toString(),
    });
    assert.equal(response.status, 302);
    return { location: response.headers.get('location')!, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0]! };
  }

  test('the sign-in page offers it, and this server publishes its metadata', async () => {
    const status = await owner.ok('client.status');
    assert.deepEqual(status.identity_providers, [{ id: 'saml', label: 'Acme Okta' }]);
    const metadata = await (await fetch(`${base}/auth/saml/metadata`)).text();
    assert.match(metadata, new RegExp(`entityID="${base}/auth/saml/metadata"`));
    assert.match(metadata, new RegExp(`AssertionConsumerService[^>]+Location="${base}/auth/saml/callback"`));
    assert.match(metadata, /WantAssertionsSigned="true"/);
  });

  test('a signed answer to our request signs the person in, creating their account', async () => {
    const { relay, requestId } = await start();
    const signedIn = await post(relay, answer({ inResponseTo: requestId }));
    assert.equal(signedIn.location, '/');
    const me = await fetch(`${base}/api/auth.test`, { method: 'POST', headers: { cookie: signedIn.cookie } });
    const auth = (await me.json()) as { ok: boolean; user_id: string };
    assert.equal(auth.ok, true);
    const info = await owner.ok('users.info', { user: auth.user_id });
    assert.equal(info.user.profile.email, 'sam@acme.test');
    assert.equal(info.user.real_name, 'Sam Sato');
    // The second time, the same account.
    const again = await start();
    const second = await post(again.relay, answer({ inResponseTo: again.requestId }));
    const auth2 = (await (await fetch(`${base}/api/auth.test`, { method: 'POST', headers: { cookie: second.cookie } })).json()) as { user_id: string };
    assert.equal(auth2.user_id, auth.user_id);
  });

  test('an existing account with the same address is the one signed in', async () => {
    const { relay, requestId } = await start();
    const signedIn = await post(relay, answer({ inResponseTo: requestId, email: 'owner@acme.test' }));
    const auth = (await (await fetch(`${base}/api/auth.test`, { method: 'POST', headers: { cookie: signedIn.cookie } })).json()) as { user_id: string };
    assert.equal(auth.user_id, owner.userId);
  });

  test('refused: replayed, tampered, unsigned, signed by another key, for another audience, expired, unasked', async () => {
    const refused = async (make: (requestId: string) => string, expected = '/signin?error=provider_error'): Promise<void> => {
      const { relay, requestId } = await start();
      const result = await post(relay, make(requestId));
      assert.equal(result.location, expected);
      assert.equal(result.cookie, '', 'no session');
    };
    // Replay: the same answer for a later sign-in.
    const first = await start();
    const used = answer({ inResponseTo: first.requestId });
    await post(first.relay, used);
    await refused(() => used);
    await refused((id) => answer({ inResponseTo: id, tamper: (xml) => xml.replaceAll('sam@acme.test', 'owner@acme.test') }));
    await refused((id) => answer({ inResponseTo: id, sign: false }));
    await refused((id) => answer({ inResponseTo: id, key: other.key }));
    await refused((id) => answer({ inResponseTo: id, audience: 'https://someone-else.test' }));
    await refused((id) => answer({ inResponseTo: id, notOnOrAfter: new Date(Date.now() - 10 * 60_000) }));
    // Started at the provider (no request of ours): refused.
    await refused(() => answer({ inResponseTo: null }));
    // No sign-in in progress at all.
    const stray = await post('not-a-state', answer({ inResponseTo: 'x' }));
    assert.equal(stray.location, '/signin?error=state_invalid');
  });

  test('with account creation off, someone without an account is turned away', async () => {
    const provider = t.app.ctx.config.identityProviders![0]!;
    provider.createAccounts = false;
    try {
      const { relay, requestId } = await start();
      const result = await post(relay, answer({ inResponseTo: requestId, email: 'newcomer@acme.test' }));
      assert.equal(result.location, '/signin?error=no_account');
      assert.equal(result.cookie, '');
    } finally {
      provider.createAccounts = true;
    }
  });

  test('reads the sign-in address and the signing certificate from provider metadata', () => {
    const metadata = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${IDP}"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      <md:KeyDescriptor use="encryption"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>ENCRYPTION</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
      <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>
        MIIB SIGNING
      </ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
      <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.test/post"/>
      <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.test/redirect?a=1&amp;b=2"/>
    </md:IDPSSODescriptor></md:EntityDescriptor>`;
    assert.deepEqual(parseIdpMetadata(metadata), { entryPoint: 'https://idp.example.test/redirect?a=1&b=2', certs: ['MIIBSIGNING'] });
  });
});

describe('SAML with its own entity id', () => {
  test('the configured entity id is the one published', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'saml-closed-'));
    const idp = keyPair(dir, 'idp');
    const t = await startApp({
      identityProviders: [{ id: 'saml', label: 'SSO', kind: 'saml', clientId: '', clientSecret: '', createAccounts: true, saml: { metadataUrl: null, entryPoint: SSO, certs: [idp.certBody], entityId: 'urn:example:chat' } }],
    });
    try {
      await setupWorkspace(t);
      const metadata = await (await fetch(`${t.base}/auth/saml/metadata`)).text();
      assert.match(metadata, /entityID="urn:example:chat"/);
    } finally {
      await t.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
