import type { IncomingMessage } from 'node:http';
import type { Registry } from '../api/registry.ts';
import { hashPassword } from '../core/auth.ts';
import { validEmail, validPassword, validTz, teamToApi } from '../api/methods/client.ts';
import { addMember, canSee, getConv, type ConvRow } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { newId, newSecret, nowSeconds } from '../core/ids.ts';
import { mailEnabled, sendMail } from '../core/mail.ts';
import { createUser, emitUserChange, getUser, isAdmin, requireUser, userToApi, type UserRow } from '../core/users.ts';
import type { Actor, Ctx } from '../ctx.ts';
import { allowedTo, domainAllowed, teamPrefs } from './prefs.ts';
import { finishSignIn, linkOrigin } from './signin.ts';

export interface InviteRow {
  code: string;
  created_by: string;
  email: string | null;
  max_uses: number;
  uses: number;
  revoked: number;
  created: number;
  expires: number;
  guest: '' | 'multi' | 'single';
  guest_channels: string;
  guest_expires: number;
}

export function findInvite(ctx: Ctx, code: string): InviteRow | undefined {
  const row = ctx.db.get<InviteRow>('SELECT * FROM invites WHERE code = ?', code);
  if (!row || row.revoked === 1 || row.expires < nowSeconds()) return undefined;
  if (row.max_uses > 0 && row.uses >= row.max_uses) return undefined;
  return row;
}

/**
 * An account an invitation may take over: imported from an export, with no
 * password and no linked sign-in yet. Everyone else with that address is
 * already in the workspace.
 */
export function claimable(ctx: Ctx, user: UserRow | undefined): boolean {
  if (!user || user.password_hash !== null || user.is_bot === 1 || user.deleted === 1) return false;
  return ctx.db.get('SELECT 1 FROM identities WHERE user_id = ?', user.id) === undefined;
}

export function inTeam(ctx: Ctx, email: string): boolean {
  const user = ctx.db.get<UserRow>('SELECT * FROM users WHERE email = ?', email);
  return user !== undefined && !claimable(ctx, user);
}

export function inviteToApi(origin: string, row: InviteRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    code: row.code,
    url: `${origin}/join/${row.code}`,
    email: row.email,
    created_by: row.created_by,
    created: row.created,
    expires: row.expires,
    max_uses: row.max_uses,
    uses: row.uses,
  };
  if (row.guest) {
    out.guest = row.guest;
    out.channels = JSON.parse(row.guest_channels) as string[];
    out.guest_expires = row.guest_expires;
  }
  return out;
}

/** Channels every new member joins: the general channel plus the workspace's chosen defaults. */
export function defaultChannels(ctx: Ctx): ConvRow[] {
  const ids = teamPrefs(ctx).default_channels ?? [];
  const rows = ids
    .map((id) => getConv(ctx, id))
    .filter((row): row is ConvRow => row !== undefined && row.is_archived === 0 && (row.kind === 'public' || row.kind === 'private'));
  const general = ctx.db.get<ConvRow>('SELECT * FROM conversations WHERE is_general = 1');
  if (general && !rows.some((row) => row.id === general.id)) rows.unshift(general);
  return rows;
}

export interface NewInvite {
  email: string | null;
  createdBy: string;
  expiresInDays: number;
  maxUses: number;
  guest?: '' | 'multi' | 'single';
  guestChannels?: string[];
  guestExpires?: number;
}

export function createInvite(ctx: Ctx, input: NewInvite): InviteRow {
  const code = newSecret(12);
  const now = nowSeconds();
  ctx.db.run(
    `INSERT INTO invites (code, created_by, email, max_uses, created, expires, guest, guest_channels, guest_expires)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    code,
    input.createdBy,
    input.email,
    input.email ? 1 : input.maxUses,
    now,
    now + input.expiresInDays * 86_400,
    input.guest ?? '',
    JSON.stringify(input.guestChannels ?? []),
    input.guestExpires ?? 0,
  );
  return ctx.db.get<InviteRow>('SELECT * FROM invites WHERE code = ?', code)!;
}

/** Mail an invitation when mail is set up. Returns whether it was sent. */
export async function mailInvite(ctx: Ctx, invite: InviteRow, origin: string): Promise<boolean> {
  if (!invite.email || !mailEnabled(ctx)) return false;
  const inviter = getUser(ctx, invite.created_by);
  const team = ctx.requireTeam();
  const who = inviter ? inviter.display_name || inviter.real_name : 'Someone';
  try {
    await sendMail(ctx, {
      to: invite.email,
      subject: `${who} invited you to ${team.name}`,
      text: `${who} invited you to join ${team.name}${invite.guest ? ' as a guest' : ''}. The invitation works until ${new Date(invite.expires * 1000).toUTCString().slice(0, 16)}.`,
      action: { label: `Join ${team.name}`, url: `${origin}/join/${invite.code}` },
    });
    return true;
  } catch {
    return false;
  }
}

function guestChannelsFor(ctx: Ctx, actor: Actor, guest: string, ids: string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) fail('no_channels');
  if (guest === 'single' && unique.length !== 1) fail('single_channel_guest_needs_one_channel');
  for (const id of unique) {
    const conv = getConv(ctx, id);
    if (!conv || !canSee(ctx, conv, actor.userId) || (conv.kind !== 'public' && conv.kind !== 'private')) fail('channel_not_found');
    if (conv.is_archived === 1) fail('is_archived');
  }
  return unique;
}

function origin(ctx: Ctx, req: IncomingMessage): string {
  return linkOrigin(ctx, req);
}

export function registerInvites(registry: Registry): void {
  registry.addPublic('client.invites.info', ({ ctx, args }) => {
    const invite = findInvite(ctx, args.req('code'));
    if (!invite) return { valid: false };
    const inviter = getUser(ctx, invite.created_by);
    return {
      valid: true,
      team: teamToApi(ctx),
      inviter_name: inviter?.real_name ?? '',
      email: invite.email,
      guest: invite.guest || null,
      signup_domains: invite.email ? [] : (teamPrefs(ctx).signup_domains ?? []),
    };
  });

  registry.addPublic('client.signup', async ({ ctx, args, req, res }) => {
    ctx.requireTeam();
    const invite = findInvite(ctx, args.req('code'));
    if (!invite) fail('invalid_invite');
    const email = validEmail(args.req('email'));
    if (invite.email && invite.email !== email) fail('invite_email_mismatch');
    // A shareable link only admits approved domains; an invitation to one address was a deliberate choice.
    if (!invite.email && !domainAllowed(ctx, email)) fail('domain_not_allowed');
    const realName = args.req('real_name').trim().slice(0, 80);
    if (!realName) fail('invalid_arguments', { needed: 'real_name' });
    const passwordHash = await hashPassword(validPassword(args.req('password')));
    const user = joinWithInvite(ctx, invite, { email, realName, passwordHash, tz: validTz(args.str('tz')) });
    return { ...finishSignIn(ctx, user, req, res) };
  });

  registry.add('client.invites.create', { auth: 'session' }, async ({ ctx, actor, args, req }) => {
    const email = args.has('email') ? validEmail(args.req('email')) : null;
    const guest = (args.str('guest') ?? '') as '' | 'multi' | 'single';
    if (!['', 'multi', 'single'].includes(guest)) fail('invalid_arguments', { needed: 'guest' });
    if (guest) {
      if (!isAdmin(actor)) fail('not_allowed');
      if (!email) fail('invalid_email');
    } else if (!allowedTo(ctx, actor.userId, 'who_can_invite')) {
      fail('restricted_action');
    }
    if (email && inTeam(ctx, email)) fail('already_in_team');
    if (email && !isAdmin(actor) && !domainAllowed(ctx, email)) fail('domain_not_allowed');
    const channels = guest ? guestChannelsFor(ctx, actor, guest, args.list('channels')) : [];
    const guestDays = args.int('guest_expires_in_days', 0, { min: 0, max: 3650 });
    const invite = createInvite(ctx, {
      email,
      createdBy: actor.userId,
      expiresInDays: args.int('expires_in_days', 30, { min: 1, max: 365 }),
      maxUses: args.int('max_uses', 0, { min: 0, max: 10_000 }),
      guest,
      guestChannels: channels,
      guestExpires: guest && guestDays > 0 ? nowSeconds() + guestDays * 86_400 : 0,
    });
    const sent = await mailInvite(ctx, invite, origin(ctx, req));
    return { invite: inviteToApi(origin(ctx, req), invite), email_sent: sent };
  });

  registry.add('client.invites.list', { auth: 'session' }, ({ ctx, actor, req }) => {
    const rows = ctx.db.all<InviteRow>(
      isAdmin(actor)
        ? 'SELECT * FROM invites WHERE revoked = 0 AND expires > ? ORDER BY created DESC'
        : 'SELECT * FROM invites WHERE revoked = 0 AND expires > ? AND created_by = ? ORDER BY created DESC',
      nowSeconds(),
      ...(isAdmin(actor) ? [] : [actor.userId]),
    );
    const live = rows.filter((row) => row.max_uses === 0 || row.uses < row.max_uses);
    return { invites: live.map((row) => inviteToApi(origin(ctx, req), row)) };
  });

  registry.add('client.invites.revoke', { auth: 'session' }, ({ ctx, actor, args }) => {
    const invite = ctx.db.get<InviteRow>('SELECT * FROM invites WHERE code = ?', args.req('code'));
    if (!invite) fail('invalid_invite');
    if (invite.created_by !== actor.userId && !isAdmin(actor)) fail('invalid_invite');
    ctx.db.run('UPDATE invites SET revoked = 1 WHERE code = ?', invite.code);
    if (teamPrefs(ctx).public_invite_code === invite.code) {
      ctx.db.run('UPDATE team SET prefs = json_set(prefs, \'$.public_invite_code\', NULL)');
      ctx.invalidateTeam();
    }
  });

  // ── Invite requests ───────────────────────────────────────────────────────

  registry.add('client.inviteRequests.create', { auth: 'session' }, ({ ctx, actor, args }) => {
    const user = requireUser(ctx, actor.userId);
    if (user.guest !== '') fail('not_allowed');
    if (allowedTo(ctx, actor.userId, 'who_can_invite')) fail('can_invite_directly');
    const email = validEmail(args.req('email'));
    if (inTeam(ctx, email)) fail('already_in_team');
    if (ctx.db.get("SELECT 1 FROM invite_requests WHERE email = ? AND status = 'pending'", email)) fail('already_requested');
    const id = newId('IR');
    ctx.db.run(
      'INSERT INTO invite_requests (id, email, reason, requested_by, created) VALUES (?, ?, ?, ?, ?)',
      id,
      email,
      (args.str('reason') ?? '').trim().slice(0, 500),
      actor.userId,
      nowSeconds(),
    );
    notifyAdmins(ctx);
    return { request: requestToApi(ctx, id) };
  });

  registry.add('client.admin.inviteRequests.list', { auth: 'admin' }, ({ ctx }) => {
    const rows = ctx.db.all<{ id: string }>("SELECT id FROM invite_requests WHERE status = 'pending' ORDER BY created");
    return { requests: rows.map((row) => requestToApi(ctx, row.id)) };
  });

  registry.add('client.admin.inviteRequests.approve', { auth: 'admin' }, async ({ ctx, actor, args, req }) => {
    const request = pendingRequest(ctx, args.req('id'));
    const invite = createInvite(ctx, { email: request.email, createdBy: actor.userId, expiresInDays: 30, maxUses: 1 });
    ctx.db.run(
      "UPDATE invite_requests SET status = 'approved', decided_by = ?, decided = ? WHERE id = ?",
      actor.userId,
      nowSeconds(),
      request.id,
    );
    const sent = await mailInvite(ctx, invite, origin(ctx, req));
    notifyAdmins(ctx);
    return { invite: inviteToApi(origin(ctx, req), invite), email_sent: sent };
  });

  registry.add('client.admin.inviteRequests.deny', { auth: 'admin' }, ({ ctx, actor, args }) => {
    const request = pendingRequest(ctx, args.req('id'));
    ctx.db.run(
      "UPDATE invite_requests SET status = 'denied', decided_by = ?, decided = ? WHERE id = ?",
      actor.userId,
      nowSeconds(),
      request.id,
    );
    notifyAdmins(ctx);
  });
}

interface RequestRow {
  id: string;
  email: string;
  reason: string;
  requested_by: string;
  status: string;
  created: number;
}

function pendingRequest(ctx: Ctx, id: string): RequestRow {
  const row = ctx.db.get<RequestRow>("SELECT * FROM invite_requests WHERE id = ? AND status = 'pending'", id);
  if (!row) fail('request_not_found');
  return row;
}

function requestToApi(ctx: Ctx, id: string): Record<string, unknown> {
  const row = ctx.db.get<RequestRow>('SELECT * FROM invite_requests WHERE id = ?', id)!;
  return { id: row.id, email: row.email, reason: row.reason, requested_by: row.requested_by, status: row.status, created: row.created };
}

/** Tell admins' open tabs that the list of pending requests changed. */
function notifyAdmins(ctx: Ctx): void {
  const admins = ctx.db
    .all<{ id: string }>("SELECT id FROM users WHERE role IN ('admin', 'owner', 'primary_owner') AND deleted = 0")
    .map((row) => row.id);
  const pending = ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM invite_requests WHERE status = 'pending'")?.n ?? 0;
  ctx.bus.emit({ event: { type: 'invite_requests_changed', pending }, audience: { users: admins }, clientOnly: true });
}

export interface Joiner {
  email: string;
  realName: string;
  passwordHash: string | null;
  tz: string;
}

/**
 * Create (or claim) the account an invitation is for, and put it in its
 * channels: a guest's invited channels, or everyone's default channels.
 */
export function joinWithInvite(ctx: Ctx, invite: InviteRow, joiner: Joiner): UserRow {
  const existing = ctx.db.get<UserRow>('SELECT * FROM users WHERE email = ?', joiner.email);
  // An account that came from an import has no password yet; its owner claims it here and keeps their history.
  if (existing && !claimable(ctx, existing)) fail('email_taken');
  const user = ctx.db.tx(() => {
    ctx.db.run('UPDATE invites SET uses = uses + 1 WHERE code = ?', invite.code);
    if (!existing) {
      return createUser(ctx, {
        email: joiner.email,
        realName: joiner.realName,
        passwordHash: joiner.passwordHash,
        tz: joiner.tz,
        guest: invite.guest,
        guestExpires: invite.guest_expires,
        invitedBy: invite.created_by,
      });
    }
    ctx.db.run(
      'UPDATE users SET password_hash = coalesce(?, password_hash), real_name = ?, tz = ?, updated = ? WHERE id = ?',
      joiner.passwordHash,
      joiner.realName,
      joiner.tz,
      nowSeconds(),
      existing.id,
    );
    return requireUser(ctx, existing.id);
  });
  if (existing) {
    emitUserChange(ctx, user.id);
  } else {
    ctx.bus.emit({
      event: { type: 'team_join', user: userToApi(ctx, user), event_ts: ctx.clock.eventTs() },
      audience: { all: true },
    });
  }
  const channels = invite.guest
    ? (JSON.parse(invite.guest_channels) as string[]).map((id) => getConv(ctx, id)).filter((row): row is ConvRow => row !== undefined)
    : defaultChannels(ctx);
  for (const conv of channels) addMember(ctx, conv, user.id);
  return user;
}
