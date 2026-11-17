import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody } from '../api/http.ts';
import type { Kernel } from '../app.ts';
import { authenticate, createToken, hashPassword } from '../core/auth.ts';
import { nowSeconds } from '../core/ids.ts';
import { createUser, emitUserChange, getUser, isAdmin, uniqueHandle, userToApi, type UserRow } from '../core/users.ts';

/**
 * SCIM 2.0 (RFC 7643/7644) user provisioning at /scim/v2, so an identity
 * provider (Okta, Microsoft Entra ID, OneLogin, …) creates, updates and
 * deactivates accounts here as it does for Slack. Authentication is a bearer
 * token an admin makes with `client.admin.scimToken`; it acts with that
 * admin's authority and nothing else.
 *
 * Deleting a user deactivates the account (history stays), as Slack does.
 */

const SCOPE = 'admin.scim';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const MAX_PAGE = 200;

type Json = Record<string, unknown>;

class ScimError extends Error {
  readonly status: number;
  readonly scimType: string | undefined;
  constructor(status: number, detail: string, scimType?: string) {
    super(detail);
    this.status = status;
    this.scimType = scimType;
  }
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/scim+json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

interface ScimPrefs {
  scim_external_id?: string;
  scim_user_name?: string;
}

function prefsOf(user: UserRow): Json & ScimPrefs {
  try {
    const parsed: unknown = JSON.parse(user.prefs);
    return parsed && typeof parsed === 'object' ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
const truthy = (value: unknown): boolean => value === true || (typeof value === 'string' && value.toLowerCase() === 'true');

export function installScim(kernel: Kernel): void {
  const { ctx } = kernel;
  const base = (): string => `${ctx.config.publicUrl}/scim/v2`;

  /** An admin makes the bearer token an identity provider uses (shown once; a new one replaces theirs). */
  kernel.registry.add('client.admin.scimToken', { auth: 'admin' }, ({ actor }) => {
    ctx.db.run("DELETE FROM tokens WHERE user_id = ? AND kind = 'user' AND app_id IS NULL AND scopes = ?", actor.userId, SCOPE);
    const token = createToken(ctx, { kind: 'user', userId: actor.userId, scopes: [SCOPE] });
    return { token, base_url: base() };
  });

  const toScim = (user: UserRow): Json => {
    const prefs = prefsOf(user);
    const api = userToApi(ctx, user, null);
    const [given = '', ...rest] = user.real_name.split(/\s+/);
    return {
      schemas: [USER_SCHEMA],
      id: user.id,
      ...(prefs.scim_external_id ? { externalId: prefs.scim_external_id } : {}),
      userName: prefs.scim_user_name ?? user.name,
      name: { formatted: user.real_name, givenName: given, familyName: rest.join(' ') },
      displayName: user.display_name || user.real_name,
      nickName: user.name,
      title: user.title,
      timezone: user.tz,
      active: user.deleted === 0,
      emails: user.email ? [{ value: user.email, type: 'work', primary: true }] : [],
      ...(user.phone ? { phoneNumbers: [{ value: user.phone, type: 'mobile' }] } : {}),
      photos: [{ value: api.profile.image_192, type: 'photo' }],
      meta: { resourceType: 'User', created: iso(user.created), lastModified: iso(user.updated), location: `${base()}/Users/${user.id}` },
    };
  };

  const people = (): UserRow[] => ctx.db.all<UserRow>('SELECT * FROM users WHERE is_bot = 0 ORDER BY created, id');

  /** `attr eq "value"` (optionally joined with `and`), on the attributes identity providers look people up by. */
  const matches = (filter: string): ((user: UserRow) => boolean) => {
    const terms = filter.split(/\s+and\s+/i).map((term) => {
      const match = /^\s*([\w.[\]" ]+?)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(term);
      if (!match) throw new ScimError(400, `Unsupported filter: ${term}`, 'invalidFilter');
      const attribute = match[1]!.replace(/\s+/g, ' ').toLowerCase();
      const value = match[2]!.replace(/\\(.)/g, '$1').toLowerCase();
      return (user: UserRow): boolean => {
        const prefs = prefsOf(user);
        if (attribute === 'username') return [user.name, user.email ?? '', prefs.scim_user_name ?? ''].some((candidate) => candidate.toLowerCase() === value);
        if (attribute === 'externalid') return (prefs.scim_external_id ?? '').toLowerCase() === value;
        if (attribute === 'id') return user.id.toLowerCase() === value;
        if (attribute.startsWith('emails')) return (user.email ?? '') === value;
        throw new ScimError(400, `Filtering on ${match[1]} is not supported`, 'invalidFilter');
      };
    });
    return (user) => terms.every((term) => term(user));
  };

  const find = (id: string): UserRow => {
    const user = getUser(ctx, id);
    if (!user || user.is_bot === 1) throw new ScimError(404, `User ${id} not found`);
    return user;
  };

  const setActive = (user: UserRow, active: boolean): void => {
    if (active === (user.deleted === 0)) return;
    if (!active && user.role === 'primary_owner') throw new ScimError(400, 'The primary owner cannot be deactivated.', 'mutability');
    ctx.db.tx(() => {
      ctx.db.run('UPDATE users SET deleted = ?, updated = ? WHERE id = ?', active ? 0 : 1, nowSeconds(), user.id);
      if (!active) {
        ctx.db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
        ctx.db.run('DELETE FROM tokens WHERE user_id = ?', user.id);
      }
    });
  };

  const emailOf = (body: Json): string | null => {
    const emails = Array.isArray(body.emails) ? (body.emails as Json[]) : [];
    const primary = emails.find((entry) => entry.primary === true) ?? emails[0];
    const value = typeof primary?.value === 'string' ? primary.value.trim().toLowerCase() : null;
    if (value) return value;
    const userName = typeof body.userName === 'string' ? body.userName.trim().toLowerCase() : '';
    return userName.includes('@') ? userName : null;
  };

  const realNameOf = (body: Json, fallback: string): string => {
    const name = (body.name && typeof body.name === 'object' ? body.name : {}) as Json;
    const joined = [name.givenName, name.familyName].filter((part) => typeof part === 'string' && part).join(' ');
    return String(name.formatted || joined || body.displayName || fallback).trim().slice(0, 80);
  };

  /** Apply SCIM attributes to an account (PUT replaces these; PATCH sets the ones it names). */
  const apply = async (user: UserRow, changes: Json): Promise<void> => {
    const prefs = prefsOf(user);
    const set: Record<string, string> = {};
    if ('userName' in changes && typeof changes.userName === 'string') prefs.scim_user_name = changes.userName;
    if ('externalId' in changes) {
      if (typeof changes.externalId === 'string' && changes.externalId) prefs.scim_external_id = changes.externalId;
      else delete prefs.scim_external_id;
    }
    if ('name' in changes && changes.name && typeof changes.name === 'object') {
      // A changed given or family name rebuilds the full name; a `formatted` one is taken as it is.
      const name = changes.name as Json;
      const [oldGiven = '', ...oldRest] = user.real_name.split(/\s+/);
      const given = typeof name.givenName === 'string' ? name.givenName : oldGiven;
      const family = typeof name.familyName === 'string' ? name.familyName : oldRest.join(' ');
      const formatted = typeof name.formatted === 'string' && name.formatted.trim() ? name.formatted : [given, family].filter(Boolean).join(' ');
      if (formatted.trim()) set.real_name = formatted.trim().slice(0, 80);
    }
    if ('displayName' in changes) set.display_name = String(changes.displayName ?? '').slice(0, 80);
    if ('title' in changes) set.title = String(changes.title ?? '').slice(0, 100);
    if ('emails' in changes) {
      const email = emailOf(changes);
      if (email && email !== user.email) {
        if (ctx.db.get('SELECT 1 FROM users WHERE email = ? AND id != ?', email, user.id)) throw new ScimError(409, `${email} is used by another account`, 'uniqueness');
        set.email = email;
      }
    }
    if ('password' in changes && typeof changes.password === 'string' && changes.password.length >= 8) set.password_hash = await hashPassword(changes.password);
    const columns = Object.keys(set);
    ctx.db.run(
      `UPDATE users SET ${[...columns.map((column) => `${column} = ?`), 'prefs = ?', 'updated = ?'].join(', ')} WHERE id = ?`,
      ...columns.map((column) => set[column]),
      JSON.stringify(prefs),
      nowSeconds(),
      user.id,
    );
    if ('active' in changes) setActive(getUser(ctx, user.id)!, truthy(changes.active));
  };

  /** PATCH operations → the attribute changes they make (RFC 7644 §3.5.2, with the forms Okta and Entra send). */
  const patchChanges = (body: Json): Json => {
    const operations = Array.isArray(body.Operations) ? (body.Operations as Json[]) : null;
    if (!operations) throw new ScimError(400, 'Operations are required', 'invalidSyntax');
    const changes: Json = {};
    for (const operation of operations) {
      const op = String(operation.op ?? '').toLowerCase();
      if (!['add', 'replace', 'remove'].includes(op)) throw new ScimError(400, `Unknown op ${String(operation.op)}`, 'invalidSyntax');
      const path = typeof operation.path === 'string' ? operation.path : '';
      const value = op === 'remove' ? null : operation.value;
      if (!path) {
        if (value && typeof value === 'object') {
          for (const [key, entry] of Object.entries(value as Json)) assign(changes, key, entry);
        }
        continue;
      }
      assign(changes, path, value);
    }
    return changes;
  };
  const assign = (changes: Json, path: string, value: unknown): void => {
    const key = path.toLowerCase();
    if (key === 'active') changes.active = truthy(value);
    else if (key === 'username') changes.userName = value;
    else if (key === 'externalid') changes.externalId = value;
    else if (key === 'displayname') changes.displayName = value;
    else if (key === 'title') changes.title = value;
    else if (key === 'name.givenname' || key === 'name.familyname' || key === 'name.formatted') {
      const name = ((changes.name as Json) ?? {}) as Json;
      name[{ 'name.givenname': 'givenName', 'name.familyname': 'familyName', 'name.formatted': 'formatted' }[key]!] = value;
      changes.name = name;
    } else if (key === 'name') changes.name = value;
    else if (key.startsWith('emails')) changes.emails = Array.isArray(value) ? value : [{ value, primary: true }];
    else if (key === 'password') changes.password = value;
    // Attributes this server does not keep (addresses, manager, …) are accepted and ignored, as IdPs send them routinely.
  };

  const readJson = async (req: IncomingMessage): Promise<Json> => {
    const text = (await readBody(req, 256 * 1024)).toString('utf8');
    try {
      const parsed: unknown = JSON.parse(text || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Json;
    } catch {
      // Falls through to the error below.
    }
    throw new ScimError(400, 'The body is not a JSON object', 'invalidSyntax');
  };

  const authorized = (req: IncomingMessage): boolean => {
    const { actor } = authenticate(ctx, req, undefined);
    return Boolean(actor && actor.kind === 'user' && actor.scopes?.has(SCOPE) && isAdmin(actor));
  };

  kernel.router.add(null, /^\/scim\/v2\/(Users|ServiceProviderConfig|ResourceTypes|Schemas)(?:\/([^/]+))?\/?$/, async ({ req, res, url, params }) => {
    const [resource, id] = params as [string, string | undefined];
    try {
      if (!ctx.team()) throw new ScimError(404, 'This server has not been set up yet.');
      if (!authorized(req)) throw new ScimError(401, 'A SCIM token from an admin is required (client.admin.scimToken).');
      const method = req.method ?? 'GET';

      if (resource === 'ServiceProviderConfig') {
        return send(res, 200, {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
          patch: { supported: true },
          bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
          filter: { supported: true, maxResults: MAX_PAGE },
          changePassword: { supported: true },
          sort: { supported: false },
          etag: { supported: false },
          authenticationSchemes: [{ type: 'oauthbearertoken', name: 'OAuth Bearer Token', description: 'A token made by an admin with client.admin.scimToken', primary: true }],
        });
      }
      if (resource === 'ResourceTypes') {
        return send(res, 200, {
          schemas: [LIST_SCHEMA],
          totalResults: 1,
          Resources: [{ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: USER_SCHEMA }],
        });
      }
      if (resource === 'Schemas') {
        return send(res, 200, {
          schemas: [LIST_SCHEMA],
          totalResults: 1,
          Resources: [{ id: USER_SCHEMA, name: 'User', attributes: ['userName', 'name', 'displayName', 'title', 'emails', 'active', 'externalId', 'timezone'].map((name) => ({ name })) }],
        });
      }

      if (!id && method === 'GET') {
        const filter = url.searchParams.get('filter');
        const all = filter ? people().filter(matches(filter)) : people();
        const start = Math.max(1, Number(url.searchParams.get('startIndex') ?? 1) || 1);
        const count = Math.min(MAX_PAGE, Math.max(0, Number(url.searchParams.get('count') ?? 100) || 0));
        const page = all.slice(start - 1, start - 1 + count);
        return send(res, 200, { schemas: [LIST_SCHEMA], totalResults: all.length, startIndex: start, itemsPerPage: page.length, Resources: page.map(toScim) });
      }
      if (!id && method === 'POST') {
        const body = await readJson(req);
        const userName = typeof body.userName === 'string' ? body.userName.trim() : '';
        if (!userName) throw new ScimError(400, 'userName is required', 'invalidValue');
        const email = emailOf(body);
        if (email && ctx.db.get('SELECT 1 FROM users WHERE email = ?', email)) throw new ScimError(409, `${email} already has an account`, 'uniqueness');
        if (people().some(matches(`userName eq "${userName.replace(/"/g, '\\"')}"`))) throw new ScimError(409, `${userName} already has an account`, 'uniqueness');
        const created = createUser(ctx, {
          email,
          realName: realNameOf(body, userName.split('@')[0]!),
          displayName: typeof body.displayName === 'string' ? body.displayName : '',
          handle: uniqueHandle(ctx, userName.split('@')[0]!),
          title: typeof body.title === 'string' ? body.title : '',
          tz: typeof body.timezone === 'string' ? body.timezone : undefined,
          passwordHash: typeof body.password === 'string' && body.password.length >= 8 ? await hashPassword(body.password) : null,
        });
        await apply(created, { userName, ...(typeof body.externalId === 'string' ? { externalId: body.externalId } : {}), ...('active' in body ? { active: body.active } : {}) });
        const user = getUser(ctx, created.id)!;
        ctx.bus.emit({ event: { type: 'team_join', user: userToApi(ctx, user), event_ts: ctx.clock.eventTs() }, audience: { all: true } });
        return send(res, 201, toScim(user));
      }
      if (!id) throw new ScimError(405, `${method} is not supported here`);

      const user = find(decodeURIComponent(id));
      if (method === 'GET') return send(res, 200, toScim(user));
      if (method === 'PUT') {
        const body = await readJson(req);
        await apply(user, { userName: body.userName, externalId: body.externalId ?? '', name: body.name ?? {}, displayName: body.displayName ?? '', title: body.title ?? '', emails: body.emails ?? [], ...('active' in body ? { active: body.active } : {}), ...('password' in body ? { password: body.password } : {}) });
        emitUserChange(ctx, user.id);
        return send(res, 200, toScim(find(user.id)));
      }
      if (method === 'PATCH') {
        const body = await readJson(req);
        if (Array.isArray(body.schemas) && !body.schemas.includes(PATCH_SCHEMA)) throw new ScimError(400, `Expected ${PATCH_SCHEMA}`, 'invalidSyntax');
        await apply(user, patchChanges(body));
        emitUserChange(ctx, user.id);
        return send(res, 200, toScim(find(user.id)));
      }
      if (method === 'DELETE') {
        setActive(user, false);
        emitUserChange(ctx, user.id);
        return send(res, 204);
      }
      throw new ScimError(405, `${method} is not supported here`);
    } catch (error) {
      if (!(error instanceof ScimError)) {
        if (error instanceof Error && 'code' in error && (error as { code: unknown }).code === 'email_taken') {
          return send(res, 409, { schemas: [ERROR_SCHEMA], status: '409', scimType: 'uniqueness', detail: 'That email already has an account' });
        }
        console.error('[scim]', error);
        return send(res, 500, { schemas: [ERROR_SCHEMA], status: '500', detail: 'Internal error' });
      }
      send(res, error.status, { schemas: [ERROR_SCHEMA], status: String(error.status), ...(error.scimType ? { scimType: error.scimType } : {}), detail: error.message });
    }
  });
}

