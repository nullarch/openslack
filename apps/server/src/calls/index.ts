import type { Args } from '../api/registry.ts';
import type { Kernel } from '../app.ts';
import { fail } from '../core/errors.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import { messageGuards } from '../core/messages.ts';
import { getUser } from '../core/users.ts';
import type { Actor, Ctx } from '../ctx.ts';
import { isHttpUrl } from '../platform/net.ts';

/**
 * Slack's Calls API: an app running calls elsewhere (Zoom, Meet, Jitsi, …)
 * registers a call with `calls.add`, posts it as a `call` block, and keeps it
 * current with `calls.update`, `calls.participants.*` and `calls.end`. People
 * see a card with a Join button, who is in the call and, afterwards, how long
 * it lasted; the card changes live.
 *
 * Reference: docs.slack.dev/apis/web-api/using-the-calls-api
 */

interface CallUser {
  slack_id?: string;
  external_id?: string;
  display_name?: string;
  avatar_url?: string;
}

interface CallRow {
  id: string;
  app_id: string | null;
  created_by: string | null;
  external_unique_id: string;
  external_display_id: string;
  join_url: string;
  desktop_app_join_url: string;
  title: string;
  users: string;
  date_start: number;
  date_end: number | null;
  duration: number | null;
}

const MAX_USERS = 200;

function usersOf(row: CallRow): CallUser[] {
  try {
    return JSON.parse(row.users) as CallUser[];
  } catch {
    return [];
  }
}

/** The call as the API returns it (Slack's fields), plus what the web client shows. */
export function callToApi(ctx: Ctx, row: CallRow, forClient = false): Record<string, unknown> {
  const call: Record<string, unknown> = {
    id: row.id,
    date_start: row.date_start,
    external_unique_id: row.external_unique_id,
    join_url: row.join_url,
    desktop_app_join_url: row.desktop_app_join_url,
    external_display_id: row.external_display_id,
    title: row.title,
    users: usersOf(row),
  };
  if (row.date_end) Object.assign(call, { date_end: row.date_end, duration: row.duration ?? row.date_end - row.date_start });
  if (forClient) {
    const app = row.app_id ? ctx.db.get<{ name: string }>('SELECT name FROM apps WHERE id = ?', row.app_id) : undefined;
    Object.assign(call, { app_id: row.app_id, app_name: app?.name ?? null, created_by: row.created_by, is_active: row.date_end === null });
  }
  return call;
}

function readUsers(ctx: Ctx, value: unknown, required: boolean): CallUser[] {
  if (value === undefined || value === null || value === '') {
    if (required) fail('missing_argument', { arg: 'users' });
    return [];
  }
  let list: unknown = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      fail('invalid_arguments', { arg: 'users' });
    }
  }
  if (!Array.isArray(list) || list.length > MAX_USERS) fail('invalid_arguments', { arg: 'users' });
  return list.map((entry) => {
    const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const slackId = typeof item.slack_id === 'string' ? item.slack_id : undefined;
    const externalId = typeof item.external_id === 'string' ? item.external_id : undefined;
    if (!slackId && !externalId) fail('invalid_arguments', { arg: 'users' });
    if (slackId) {
      const user = getUser(ctx, slackId);
      if (!user || user.deleted === 1) fail('user_not_found');
    }
    const avatar = typeof item.avatar_url === 'string' && isHttpUrl(item.avatar_url) ? item.avatar_url : undefined;
    return {
      ...(slackId ? { slack_id: slackId } : {}),
      ...(externalId ? { external_id: externalId.slice(0, 200) } : {}),
      ...(typeof item.display_name === 'string' ? { display_name: item.display_name.slice(0, 120) } : {}),
      ...(avatar ? { avatar_url: avatar } : {}),
    };
  });
}

const sameUser = (a: CallUser, b: CallUser): boolean => (a.slack_id && a.slack_id === b.slack_id) || (a.external_id !== undefined && a.external_id === b.external_id) || false;

export function installCalls(kernel: Kernel): void {
  const { ctx } = kernel;

  const find = (actor: Actor, args: Args): CallRow => {
    const id = args.str('id');
    if (!id) fail('missing_argument', { arg: 'id' });
    const row = ctx.db.get<CallRow>('SELECT * FROM calls WHERE id = ?', id);
    // An app sees its own calls; people (session or user token) see calls that reached them.
    if (!row) fail('invalid_call_id');
    if (actor.kind !== 'session' && actor.appId && row.app_id && row.app_id !== actor.appId) fail('invalid_call_id');
    return row;
  };

  /** Tell everyone who can see a card for this call that it changed. */
  const announce = (row: CallRow): void => {
    const fresh = ctx.db.get<CallRow>('SELECT * FROM calls WHERE id = ?', row.id)!;
    for (const { conversation_id } of ctx.db.all<{ conversation_id: string }>('SELECT conversation_id FROM call_shares WHERE call_id = ?', row.id)) {
      ctx.bus.emit({ event: { type: 'call_updated', call: callToApi(ctx, fresh, true) }, audience: { conversation: conversation_id }, clientOnly: true });
    }
  };

  // A call block names a call this server knows, and posting it records where the card is.
  messageGuards.push((_ctx, input) => {
    for (const block of input.blocks ?? []) {
      if ((block as { type?: string }).type !== 'call') continue;
      const callId = String((block as { call_id?: unknown }).call_id ?? '');
      if (!ctx.db.get('SELECT 1 FROM calls WHERE id = ?', callId)) fail('invalid_blocks', { detail: `unknown call_id ${callId}` });
      ctx.db.run('INSERT OR IGNORE INTO call_shares (call_id, conversation_id) VALUES (?, ?)', callId, input.conv.id);
    }
  });

  kernel.registry.add('calls.add', { scopes: ['calls:write'] }, ({ actor, args }) => {
    const externalId = args.str('external_unique_id');
    if (!externalId) fail('missing_argument', { arg: 'external_unique_id' });
    const joinUrl = args.str('join_url');
    if (!joinUrl) fail('missing_argument', { arg: 'join_url' });
    if (!isHttpUrl(joinUrl)) fail('invalid_arguments', { arg: 'join_url' });
    const desktopUrl = args.str('desktop_app_join_url') ?? '';
    let createdBy = args.str('created_by') ?? null;
    if (!createdBy && actor.kind === 'user') createdBy = actor.userId;
    if (!createdBy) fail('invalid_created_by');
    const creator = getUser(ctx, createdBy);
    if (!creator || creator.deleted === 1 || creator.is_bot === 1) fail('invalid_created_by');
    const start = args.has('date_start') ? args.int('date_start', 0) : nowSeconds();
    if (start <= 0) fail('invalid_start_time');
    const appId = actor.appId ?? null;
    if (ctx.db.get('SELECT 1 FROM calls WHERE app_id IS ? AND external_unique_id = ?', appId, externalId)) fail('invalid_arguments', { detail: 'external_unique_id is already registered' });
    const id = newId('R');
    ctx.db.run(
      `INSERT INTO calls (id, app_id, created_by, external_unique_id, external_display_id, join_url, desktop_app_join_url, title, users, date_start)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      appId,
      createdBy,
      externalId.slice(0, 200),
      (args.str('external_display_id') ?? '').slice(0, 100),
      joinUrl,
      desktopUrl,
      (args.str('title') ?? '').slice(0, 200),
      JSON.stringify(readUsers(ctx, args.raw.users, false)),
      start,
    );
    return { call: callToApi(ctx, ctx.db.get<CallRow>('SELECT * FROM calls WHERE id = ?', id)!) };
  });

  kernel.registry.add('calls.info', { scopes: ['calls:read'] }, ({ actor, args }) => ({ call: callToApi(ctx, find(actor, args)) }));

  kernel.registry.add('calls.update', { scopes: ['calls:write'] }, ({ actor, args }) => {
    const row = find(actor, args);
    const joinUrl = args.str('join_url');
    if (joinUrl !== undefined && !isHttpUrl(joinUrl)) fail('invalid_arguments', { arg: 'join_url' });
    ctx.db.run(
      'UPDATE calls SET title = ?, join_url = ?, desktop_app_join_url = ? WHERE id = ?',
      args.has('title') ? (args.str('title') ?? '').slice(0, 200) : row.title,
      joinUrl ?? row.join_url,
      args.has('desktop_app_join_url') ? (args.str('desktop_app_join_url') ?? '') : row.desktop_app_join_url,
      row.id,
    );
    announce(row);
    return { call: callToApi(ctx, ctx.db.get<CallRow>('SELECT * FROM calls WHERE id = ?', row.id)!) };
  });

  kernel.registry.add('calls.end', { scopes: ['calls:write'] }, ({ actor, args }) => {
    const row = find(actor, args);
    if (row.date_end !== null) fail('inactive_call');
    const end = nowSeconds();
    const duration = args.has('duration') ? Math.max(0, args.int('duration', 0)) : end - row.date_start;
    ctx.db.run('UPDATE calls SET date_end = ?, duration = ? WHERE id = ?', end, duration, row.id);
    announce(row);
  });

  const participants = (add: boolean) => ({ actor, args }: { actor: Actor; args: Args }) => {
    const row = find(actor, args);
    if (row.date_end !== null) fail('inactive_call');
    const change = readUsers(ctx, args.raw.users, true);
    const current = usersOf(row);
    if (add) {
      if (change.some((user) => current.some((existing) => sameUser(existing, user)))) fail('bad_users');
      current.push(...change);
    } else {
      if (change.some((user) => !current.some((existing) => sameUser(existing, user)))) fail('bad_users');
      for (const user of change) current.splice(current.findIndex((existing) => sameUser(existing, user)), 1);
    }
    ctx.db.run('UPDATE calls SET users = ? WHERE id = ?', JSON.stringify(current.slice(0, MAX_USERS)), row.id);
    announce(row);
  };
  kernel.registry.add('calls.participants.add', { scopes: ['calls:write'] }, participants(true));
  kernel.registry.add('calls.participants.remove', { scopes: ['calls:write'] }, participants(false));

  /** For the web client's call cards: any call posted where the person can read. */
  kernel.registry.add('client.calls.info', { auth: 'session' }, ({ actor, args }) => {
    const row = ctx.db.get<CallRow>('SELECT * FROM calls WHERE id = ?', args.req('id', 'invalid_call_id'));
    if (!row) fail('invalid_call_id');
    const visible = ctx.db.get(
      `SELECT 1 FROM call_shares s JOIN conversations c ON c.id = s.conversation_id
        WHERE s.call_id = ? AND (c.kind = 'public' OR EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = c.id AND m.user_id = ?))`,
      row.id,
      actor.userId,
    );
    if (!visible) fail('invalid_call_id');
    return { call: callToApi(ctx, row, true) };
  });
}
