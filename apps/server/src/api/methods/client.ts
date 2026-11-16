import type { BootData, Role, Team } from '@app/shared';
import type { Ctx } from '../../ctx.ts';
import {
  createSession,
  destroySession,
  hashPassword,
  readSessionToken,
  sessionCookie,
  verifyPassword,
} from '../../core/auth.ts';
import {
  addMember,
  convToApi,
  createChannel,
  getConv,
  getMember,
  readState,
  type ConvRow,
  type MemberRow,
} from '../../core/conversations.ts';
import { fail } from '../../core/errors.ts';
import { newId, newSecret, nowSeconds } from '../../core/ids.ts';
import { createUser, emitUserChange, getUser, presenceOf, requireUser, userToApi, type UserRow } from '../../core/users.ts';
import type { Registry } from '../registry.ts';
import { customEmoji } from './emoji.ts';

/**
 * Methods that exist only for the first-party web client: first-run setup,
 * sign-in, the boot payload and workspace administration. Slack's public API
 * has no equivalents, so they live under their own `client.*` namespace.
 */

const MIN_PASSWORD = 8;

let decoy: Promise<string> | null = null;
/** A password hash that matches nothing, computed once. */
function decoyHash(): Promise<string> {
  decoy ??= hashPassword(newSecret(24));
  return decoy;
}

function validEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) fail('invalid_email');
  return email;
}

function validPassword(value: string): string {
  if (value.length < MIN_PASSWORD) fail('password_too_short', { min_length: MIN_PASSWORD });
  if (value.length > 256) fail('password_too_long');
  return value;
}

function validTz(value: string | undefined): string {
  if (!value) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return 'UTC';
  }
}

function slug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 21) || 'workspace'
  );
}

export function teamToApi(ctx: Ctx): Team {
  const team = ctx.requireTeam();
  const icon = (size: number): string => `${ctx.config.publicUrl}/team-icon/${size}?v=${team.icon_key ?? team.name.length}`;
  return {
    id: team.id,
    name: team.name,
    domain: team.domain,
    url: `${ctx.config.publicUrl}/`,
    icon: { image_68: icon(68), image_132: icon(132), image_default: team.icon_key === null },
  };
}

function defaultChannels(ctx: Ctx): ConvRow[] {
  const prefs = JSON.parse(ctx.requireTeam().prefs) as { default_channels?: string[] };
  const ids = prefs.default_channels ?? [];
  const rows = ids.map((id) => getConv(ctx, id)).filter((row): row is ConvRow => row !== undefined && row.is_archived === 0);
  const general = ctx.db.get<ConvRow>('SELECT * FROM conversations WHERE is_general = 1');
  if (general && !rows.some((row) => row.id === general.id)) rows.unshift(general);
  return rows;
}

function bootData(ctx: Ctx, self: UserRow, wsOrigin: string): BootData {
  const actor = { userId: self.id, kind: 'session' as const, role: self.role, isBot: false, appId: null, botId: null, scopes: null };
  const users = ctx.db.all<UserRow>('SELECT * FROM users ORDER BY created');
  const memberships = ctx.db.all<MemberRow>('SELECT * FROM members WHERE user_id = ?', self.id);
  const channels = [];
  for (const member of memberships) {
    const conv = getConv(ctx, member.conversation_id);
    if (!conv) continue;
    const direct = conv.kind === 'im' || conv.kind === 'mpim';
    // Closed direct conversations stay out of the sidebar unless something is unread.
    if (direct && member.is_open === 0 && readState(ctx, conv, member).unread === 0) continue;
    channels.push(convToApi(ctx, conv, self.id, { readState: true, numMembers: !direct }));
  }
  const presence: Record<string, 'active' | 'away'> = {};
  for (const user of users) presence[user.id] = presenceOf(ctx, user);
  return {
    self: userToApi(ctx, self, actor),
    team: teamToApi(ctx),
    users: users.map((user) => userToApi(ctx, user, actor)),
    channels,
    emoji: customEmoji(ctx),
    presence,
    prefs: JSON.parse(self.prefs) as Record<string, unknown>,
    ws_url: `${wsOrigin.replace(/^http/, 'ws')}/ws`,
    max_upload_bytes: ctx.config.maxUploadBytes,
    server_version: ctx.config.version,
  };
}

export function registerClient(registry: Registry): void {
  // ── Before sign-in ────────────────────────────────────────────────────────

  registry.addPublic('client.status', ({ ctx, actor }) => {
    const team = ctx.team();
    return {
      setup_required: team === undefined,
      signed_in: actor !== null && actor.kind === 'session',
      team: team ? teamToApi(ctx) : null,
      server_version: ctx.config.version,
    };
  });

  registry.addPublic('client.setup', async ({ ctx, args, req, res }) => {
    if (ctx.team()) fail('already_set_up');
    const teamName = args.req('team_name').trim().slice(0, 80);
    if (!teamName) fail('invalid_arguments', { needed: 'team_name' });
    const email = validEmail(args.req('email'));
    const realName = args.req('real_name').trim().slice(0, 80);
    const passwordHash = await hashPassword(validPassword(args.req('password')));
    if (ctx.team()) fail('already_set_up');

    const owner = ctx.db.tx(() => {
      ctx.db.run(
        'INSERT INTO team (id, name, domain, created) VALUES (?, ?, ?, ?)',
        newId('T'),
        teamName,
        slug(teamName),
        nowSeconds(),
      );
      ctx.invalidateTeam();
      return createUser(ctx, { email, realName, passwordHash, role: 'primary_owner', tz: validTz(args.str('tz')) });
    });
    const general = createChannel(ctx, {
      name: 'general',
      isPrivate: false,
      creator: owner.id,
      isGeneral: true,
      purpose: 'Announcements and conversation for the whole team.',
    });
    const random = createChannel(ctx, {
      name: 'random',
      isPrivate: false,
      creator: owner.id,
      purpose: 'Everything that does not fit anywhere else.',
    });
    ctx.db.run(
      'UPDATE team SET prefs = ?',
      JSON.stringify({ default_channels: [general.id, random.id] }),
    );
    ctx.invalidateTeam();

    const token = createSession(ctx, owner.id, String(req.headers['user-agent'] ?? ''));
    res.setHeader('set-cookie', sessionCookie(ctx, token));
    return { user_id: owner.id, team_id: ctx.requireTeam().id };
  });

  registry.addPublic('client.signin', async ({ ctx, args, req, res }) => {
    ctx.requireTeam();
    const email = args.req('email').trim().toLowerCase();
    const password = args.req('password');
    const user = ctx.db.get<UserRow>('SELECT * FROM users WHERE email = ? AND is_bot = 0', email);
    // Always do the hashing work, so response time does not reveal whether the address exists.
    const valid = await verifyPassword(password, user?.password_hash ?? (await decoyHash()));
    if (!user || !valid) fail('invalid_credentials');
    if (user.deleted === 1) fail('account_inactive');
    const token = createSession(ctx, user.id, String(req.headers['user-agent'] ?? ''));
    res.setHeader('set-cookie', sessionCookie(ctx, token));
    return { user_id: user.id };
  });

  registry.addPublic('client.signout', ({ ctx, req, res }) => {
    const token = readSessionToken(req);
    if (token) destroySession(ctx, token);
    res.setHeader('set-cookie', sessionCookie(ctx, null));
  });

  registry.addPublic('client.invites.info', ({ ctx, args }) => {
    const invite = findInvite(ctx, args.req('code'));
    if (!invite) return { valid: false };
    const inviter = getUser(ctx, invite.created_by);
    return {
      valid: true,
      team: teamToApi(ctx),
      inviter_name: inviter?.real_name ?? '',
      email: invite.email,
    };
  });

  registry.addPublic('client.signup', async ({ ctx, args, req, res }) => {
    ctx.requireTeam();
    const invite = findInvite(ctx, args.req('code'));
    if (!invite) fail('invalid_invite');
    const email = validEmail(args.req('email'));
    if (invite.email && invite.email !== email) fail('invite_email_mismatch');
    const realName = args.req('real_name').trim().slice(0, 80);
    if (!realName) fail('invalid_arguments', { needed: 'real_name' });
    const passwordHash = await hashPassword(validPassword(args.req('password')));
    const existing = ctx.db.get<UserRow>('SELECT * FROM users WHERE email = ?', email);
    // An account that came from an import has no password yet; its owner claims it here and keeps their history.
    const claimable = existing && existing.password_hash === null && existing.is_bot === 0 && existing.deleted === 0;
    if (existing && !claimable) fail('email_taken');

    const user = ctx.db.tx(() => {
      ctx.db.run('UPDATE invites SET uses = uses + 1 WHERE code = ?', invite.code);
      if (!existing) return createUser(ctx, { email, realName, passwordHash, tz: validTz(args.str('tz')) });
      ctx.db.run(
        'UPDATE users SET password_hash = ?, real_name = ?, tz = ?, updated = ? WHERE id = ?',
        passwordHash,
        realName,
        validTz(args.str('tz')),
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
    for (const conv of defaultChannels(ctx)) addMember(ctx, conv, user.id);

    const token = createSession(ctx, user.id, String(req.headers['user-agent'] ?? ''));
    res.setHeader('set-cookie', sessionCookie(ctx, token));
    return { user_id: user.id };
  });

  // ── Signed in ─────────────────────────────────────────────────────────────

  registry.add('client.boot', { auth: 'session' }, ({ ctx, actor, req }) => {
    const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0]!.trim();
    const origin = `${proto}://${req.headers.host ?? 'localhost'}`;
    return { ...bootData(ctx, requireUser(ctx, actor.userId), origin) };
  });

  /** Unread and mention counts for every conversation the caller belongs to. */
  registry.add('client.counts', { auth: 'session' }, ({ ctx, actor }) => {
    const memberships = ctx.db.all<MemberRow>('SELECT * FROM members WHERE user_id = ?', actor.userId);
    const counts = [];
    for (const member of memberships) {
      const conv = getConv(ctx, member.conversation_id);
      if (!conv) continue;
      const state = readState(ctx, conv, member);
      counts.push({
        id: conv.id,
        last_read: member.last_read,
        latest_ts: conv.last_ts,
        unread_count: state.unread,
        mention_count: state.mentions,
      });
    }
    return { channels: counts };
  });

  /** Star or mute a conversation for the caller only. */
  registry.add('client.conversations.setPrefs', { auth: 'session' }, ({ ctx, actor, args }) => {
    const conv = getConv(ctx, args.req('channel')) ?? fail('channel_not_found');
    if (!getMember(ctx, conv.id, actor.userId)) fail('not_in_channel');
    if (args.has('starred')) {
      ctx.db.run(
        'UPDATE members SET is_starred = ? WHERE conversation_id = ? AND user_id = ?',
        args.bool('starred') ? 1 : 0,
        conv.id,
        actor.userId,
      );
    }
    if (args.has('muted')) {
      ctx.db.run(
        'UPDATE members SET is_muted = ? WHERE conversation_id = ? AND user_id = ?',
        args.bool('muted') ? 1 : 0,
        conv.id,
        actor.userId,
      );
    }
    const channel = convToApi(ctx, conv, actor.userId, { readState: true });
    ctx.bus.emit({
      event: { type: 'channel_prefs_changed', channel },
      audience: { users: [actor.userId] },
      clientOnly: true,
    });
    return { channel };
  });

  /** Merge keys into the caller's personal preferences (theme, notification choices). */
  registry.add('client.prefs.set', { auth: 'session' }, ({ ctx, actor, args }) => {
    const patch = args.json<Record<string, unknown>>('prefs');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('invalid_arguments', { needed: 'prefs' });
    const user = requireUser(ctx, actor.userId);
    const prefs = { ...(JSON.parse(user.prefs) as Record<string, unknown>), ...patch };
    const text = JSON.stringify(prefs);
    if (text.length > 20_000) fail('prefs_too_large');
    ctx.db.run('UPDATE users SET prefs = ? WHERE id = ?', text, actor.userId);
    ctx.bus.emit({
      event: { type: 'pref_change', prefs },
      audience: { users: [actor.userId] },
      clientOnly: true,
    });
    return { prefs };
  });

  // ── Invitations ───────────────────────────────────────────────────────────

  registry.add('client.invites.create', { auth: 'session' }, ({ ctx, actor, args }) => {
    const email = args.has('email') ? validEmail(args.req('email')) : null;
    if (email && ctx.db.get('SELECT 1 FROM users WHERE email = ?', email)) fail('already_in_team');
    const days = args.int('expires_in_days', 30, { min: 1, max: 365 });
    const maxUses = email ? 1 : args.int('max_uses', 0, { min: 0, max: 10_000 });
    const code = newSecret(12);
    const now = nowSeconds();
    ctx.db.run(
      'INSERT INTO invites (code, created_by, email, max_uses, created, expires) VALUES (?, ?, ?, ?, ?, ?)',
      code,
      actor.userId,
      email,
      maxUses,
      now,
      now + days * 86_400,
    );
    return { invite: inviteToApi(ctx, findInvite(ctx, code)!) };
  });

  registry.add('client.invites.list', { auth: 'session' }, ({ ctx, actor }) => {
    const rows = ctx.db.all<InviteRow>(
      actor.role === 'member'
        ? 'SELECT * FROM invites WHERE revoked = 0 AND expires > ? AND created_by = ? ORDER BY created DESC'
        : 'SELECT * FROM invites WHERE revoked = 0 AND expires > ? AND created_by LIKE ? ORDER BY created DESC',
      nowSeconds(),
      actor.role === 'member' ? actor.userId : '%',
    );
    return { invites: rows.map((row) => inviteToApi(ctx, row)) };
  });

  registry.add('client.invites.revoke', { auth: 'session' }, ({ ctx, actor, args }) => {
    const invite = ctx.db.get<InviteRow>('SELECT * FROM invites WHERE code = ?', args.req('code'));
    if (!invite) fail('invalid_invite');
    if (invite.created_by !== actor.userId && actor.role === 'member') fail('not_allowed');
    ctx.db.run('UPDATE invites SET revoked = 1 WHERE code = ?', invite.code);
  });

  // ── Administration ────────────────────────────────────────────────────────

  registry.add('client.admin.setRole', { auth: 'admin' }, ({ ctx, actor, args }) => {
    const target = requireUser(ctx, args.req('user'));
    const role = args.req('role') as Role;
    if (!['owner', 'admin', 'member'].includes(role)) fail('invalid_role');
    if (target.is_bot === 1) fail('cannot_change_bot');
    if (target.role === 'primary_owner') fail('cannot_change_primary_owner');
    const ownerLevel = actor.role === 'primary_owner' || actor.role === 'owner';
    // Only owners may grant or remove the owner role.
    if ((role === 'owner' || target.role === 'owner') && !ownerLevel) fail('not_allowed');
    ctx.db.run('UPDATE users SET role = ?, updated = ? WHERE id = ?', role, nowSeconds(), target.id);
    emitUserChange(ctx, target.id);
    return { user: userToApi(ctx, requireUser(ctx, target.id), actor) };
  });

  registry.add('client.admin.setActive', { auth: 'admin' }, ({ ctx, actor, args }) => {
    const target = requireUser(ctx, args.req('user'));
    const active = args.bool('active', true);
    if (target.role === 'primary_owner') fail('cannot_change_primary_owner');
    if (target.id === actor.userId) fail('cannot_change_self');
    if (target.role === 'owner' && actor.role === 'admin') fail('not_allowed');
    ctx.db.tx(() => {
      ctx.db.run('UPDATE users SET deleted = ?, updated = ? WHERE id = ?', active ? 0 : 1, nowSeconds(), target.id);
      if (!active) {
        ctx.db.run('DELETE FROM sessions WHERE user_id = ?', target.id);
        ctx.db.run('DELETE FROM tokens WHERE user_id = ?', target.id);
      }
    });
    emitUserChange(ctx, target.id);
    return { user: userToApi(ctx, requireUser(ctx, target.id), actor) };
  });

  registry.add('client.admin.updateTeam', { auth: 'admin' }, ({ ctx, args }) => {
    const team = ctx.requireTeam();
    const name = args.has('name') ? args.req('name').trim().slice(0, 80) : team.name;
    if (!name) fail('invalid_arguments', { needed: 'name' });
    ctx.db.run('UPDATE team SET name = ? WHERE id = ?', name, team.id);
    ctx.invalidateTeam();
    const api = teamToApi(ctx);
    ctx.bus.emit({ event: { type: 'team_rename', name, team: api }, audience: { all: true } });
    return { team: api };
  });
}

// ── Invites ─────────────────────────────────────────────────────────────────

interface InviteRow {
  code: string;
  created_by: string;
  email: string | null;
  max_uses: number;
  uses: number;
  revoked: number;
  created: number;
  expires: number;
}

function findInvite(ctx: Ctx, code: string): InviteRow | undefined {
  const row = ctx.db.get<InviteRow>('SELECT * FROM invites WHERE code = ?', code);
  if (!row || row.revoked === 1 || row.expires < nowSeconds()) return undefined;
  if (row.max_uses > 0 && row.uses >= row.max_uses) return undefined;
  return row;
}

function inviteToApi(ctx: Ctx, row: InviteRow): Record<string, unknown> {
  return {
    code: row.code,
    url: `${ctx.config.publicUrl}/join/${row.code}`,
    email: row.email,
    created_by: row.created_by,
    created: row.created,
    expires: row.expires,
    max_uses: row.max_uses,
    uses: row.uses,
  };
}
