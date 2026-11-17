import { clientIp } from '../../core/network.ts';
import type { BootData, Role, Team } from '@app/shared';
import type { Ctx } from '../../ctx.ts';
import {
  createSession,
  destroySession,
  hashPassword,
  readSessionToken,
  sessionCookie,
} from '../../core/auth.ts';
import {
  convToApi,
  createChannel,
  getConv,
  getMember,
  readState,
  type MemberRow,
} from '../../core/conversations.ts';
import { fail } from '../../core/errors.ts';
import { newId, newSecret, nowSeconds } from '../../core/ids.ts';
import { createUser, emitUserChange, presenceOf, requireUser, userToApi, type UserRow } from '../../core/users.ts';
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
export function decoyHash(): Promise<string> {
  decoy ??= hashPassword(newSecret(24));
  return decoy;
}

export function validEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) fail('invalid_email');
  return email;
}

export function validPassword(value: string): string {
  if (value.length < MIN_PASSWORD) fail('password_too_short', { min_length: MIN_PASSWORD });
  if (value.length > 256) fail('password_too_long');
  return value;
}

export function validTz(value: string | undefined): string {
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

    const token = createSession(ctx, owner.id, String(req.headers['user-agent'] ?? ''), clientIp(ctx, req));
    res.setHeader('set-cookie', sessionCookie(ctx, token));
    return { user_id: owner.id, team_id: ctx.requireTeam().id };
  });

  registry.addPublic('client.signout', ({ ctx, req, res }) => {
    const token = readSessionToken(req);
    if (token) destroySession(ctx, token);
    res.setHeader('set-cookie', sessionCookie(ctx, null));
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
