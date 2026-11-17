import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Who the fake provider signs in, decided by the test before each flow. */
export interface FakePerson {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
}

interface Grant {
  person: FakePerson;
  nonce: string;
  challenge: string;
  redirectUri: string;
}

async function body(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/**
 * An OpenID Connect provider and a GitHub-shaped OAuth provider in one small
 * HTTP server, enough to run the real sign-in flow end to end in tests.
 */
export class FakeIdentityProvider {
  issuer = '';
  readonly clientId = 'test-client';
  readonly clientSecret = 'test-secret';
  person: FakePerson = { sub: 'sub-1', email: 'someone@acme.test', email_verified: true, name: 'Some One' };
  /** Break things on purpose: 'signature' | 'nonce' | 'audience' | null. */
  tamper: 'signature' | 'nonce' | 'audience' | null = null;
  githubEmails: { email: string; primary: boolean; verified: boolean }[] = [];
  githubUser = { id: 4242, login: 'octo', name: 'Octo Cat' };
  private readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly grants = new Map<string, Grant>();
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ({ status, json, location }) => {
          if (location) {
            res.writeHead(302, { location });
            res.end();
            return;
          }
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(json));
        },
        (error: unknown) => {
          res.writeHead(500);
          res.end(String(error));
        },
      );
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.issuer;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /**
   * Play the provider's sign-in page: given the authorize URL our server
   * redirected to, approve it and return the callback URL with a code.
   */
  approve(authorizeUrl: string): string {
    const url = new URL(authorizeUrl);
    const code = randomBytes(12).toString('hex');
    const redirectUri = url.searchParams.get('redirect_uri')!;
    this.grants.set(code, {
      person: { ...this.person },
      nonce: url.searchParams.get('nonce') ?? '',
      challenge: url.searchParams.get('code_challenge') ?? '',
      redirectUri,
    });
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state')!);
    return back.toString();
  }

  private idToken(grant: Grant): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: this.issuer,
      aud: this.tamper === 'audience' ? 'someone-else' : this.clientId,
      sub: grant.person.sub,
      email: grant.person.email,
      email_verified: grant.person.email_verified,
      name: grant.person.name,
      nonce: this.tamper === 'nonce' ? 'wrong' : grant.nonce,
      iat: now,
      exp: now + 300,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    let signature = sign('sha256', Buffer.from(`${header}.${payload}`), this.keys.privateKey).toString('base64url');
    if (this.tamper === 'signature') signature = signature.slice(0, -4) + (signature.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    return `${header}.${payload}.${signature}`;
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; json: unknown; location?: string }> {
    const url = new URL(req.url ?? '/', this.issuer);
    switch (url.pathname) {
      // A browser arriving at the sign-in page is approved at once, as `person`.
      case '/authorize':
      case '/login/oauth/authorize':
        return { status: 302, json: null, location: this.approve(url.toString()) };
      case '/.well-known/openid-configuration':
        return {
          status: 200,
          json: {
            issuer: this.issuer,
            authorization_endpoint: `${this.issuer}/authorize`,
            token_endpoint: `${this.issuer}/token`,
            jwks_uri: `${this.issuer}/jwks`,
          },
        };
      case '/jwks':
        return { status: 200, json: { keys: [{ ...this.keys.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] } };
      case '/token': {
        const form = await body(req);
        const grant = this.grants.get(form.get('code') ?? '');
        if (!grant || form.get('client_secret') !== this.clientSecret || form.get('redirect_uri') !== grant.redirectUri) {
          return { status: 400, json: { error: 'invalid_grant' } };
        }
        const verifier = form.get('code_verifier') ?? '';
        if (createHash('sha256').update(verifier).digest('base64url') !== grant.challenge) return { status: 400, json: { error: 'invalid_grant' } };
        this.grants.delete(form.get('code')!);
        return { status: 200, json: { access_token: 'at', token_type: 'Bearer', id_token: this.idToken(grant) } };
      }
      case '/login/oauth/access_token': {
        const form = await body(req);
        const grant = this.grants.get(form.get('code') ?? '');
        if (!grant || form.get('client_secret') !== this.clientSecret) return { status: 200, json: { error: 'bad_verification_code' } };
        this.grants.delete(form.get('code')!);
        return { status: 200, json: { access_token: 'gho_test', token_type: 'bearer', scope: 'read:user,user:email' } };
      }
      case '/user':
        return req.headers.authorization === 'Bearer gho_test' ? { status: 200, json: this.githubUser } : { status: 401, json: {} };
      case '/user/emails':
        return req.headers.authorization === 'Bearer gho_test' ? { status: 200, json: this.githubEmails } : { status: 401, json: {} };
      default:
        return { status: 404, json: {} };
    }
  }
}
