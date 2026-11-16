import type { Role, User } from '@app/shared';
import type { Actor, Ctx } from '../ctx.ts';
import { fail } from './errors.ts';
import { newId, nowSeconds } from './ids.ts';

export interface UserRow {
  id: string;
  name: string;
  real_name: string;
  display_name: string;
  email: string | null;
  password_hash: string | null;
  title: string;
  phone: string;
  tz: string;
  avatar_key: string | null;
  color: string;
  status_text: string;
  status_emoji: string;
  status_expiration: number;
  manual_presence: string;
  is_bot: number;
  bot_id: string | null;
  app_id: string | null;
  role: Role;
  deleted: number;
  prefs: string;
  created: number;
  updated: number;
}

const COLORS = ['4f8cc9', 'd9822b', '3f9c73', 'c2536b', '7a61c9', '2f9aa0', 'b8843a', '5b6ee1', 'c45fa0', '6a8f3c'];

const tzCache = new Map<string, { label: string; offset: number; at: number }>();

function tzInfo(tz: string): { label: string; offset: number } {
  const cached = tzCache.get(tz);
  if (cached && Date.now() - cached.at < 3_600_000) return cached;
  let label = tz;
  let offset = 0;
  try {
    const now = new Date();
    const long = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'long' }).formatToParts(now);
    label = long.find((part) => part.type === 'timeZoneName')?.value ?? tz;
    const short = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(now);
    const text = short.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
    const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(text);
    if (match) offset = (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 3600 + Number(match[3] ?? 0) * 60);
  } catch {
    // Unknown zone: keep UTC.
  }
  const info = { label, offset, at: Date.now() };
  tzCache.set(tz, info);
  return info;
}

export function getUser(ctx: Ctx, id: string): UserRow | undefined {
  return ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
}

export function requireUser(ctx: Ctx, id: string): UserRow {
  return getUser(ctx, id) ?? fail('user_not_found');
}

export function avatarUrl(ctx: Ctx, row: Pick<UserRow, 'id' | 'updated'>, size: number): string {
  return `${ctx.config.publicUrl}/avatars/${row.id}/${size}?v=${row.updated}`;
}

/** Whether the caller may see email addresses. */
function canSeeEmail(actor: Actor | null): boolean {
  if (!actor) return false;
  return actor.scopes === null || actor.scopes.has('users:read.email');
}

export function userToApi(ctx: Ctx, row: UserRow, actor: Actor | null = null): User {
  const team = ctx.requireTeam();
  const tz = tzInfo(row.tz);
  const statusLive = row.status_expiration === 0 || row.status_expiration > nowSeconds();
  const user: User = {
    id: row.id,
    team_id: team.id,
    name: row.name,
    deleted: row.deleted === 1,
    color: row.color,
    real_name: row.real_name,
    tz: row.tz,
    tz_label: tz.label,
    tz_offset: tz.offset,
    profile: {
      title: row.title,
      phone: row.phone,
      real_name: row.real_name,
      real_name_normalized: row.real_name,
      display_name: row.display_name,
      display_name_normalized: row.display_name,
      status_text: statusLive ? row.status_text : '',
      status_emoji: statusLive ? row.status_emoji : '',
      status_expiration: statusLive ? row.status_expiration : 0,
      avatar_hash: row.avatar_key ?? `g${row.color}`,
      image_24: avatarUrl(ctx, row, 24),
      image_32: avatarUrl(ctx, row, 32),
      image_48: avatarUrl(ctx, row, 48),
      image_72: avatarUrl(ctx, row, 72),
      image_192: avatarUrl(ctx, row, 192),
      image_512: avatarUrl(ctx, row, 512),
      team: team.id,
    },
    is_admin: row.role !== 'member',
    is_owner: row.role === 'owner' || row.role === 'primary_owner',
    is_primary_owner: row.role === 'primary_owner',
    is_restricted: false,
    is_ultra_restricted: false,
    is_bot: row.is_bot === 1,
    is_app_user: false,
    updated: row.updated,
  };
  if (row.email && canSeeEmail(actor)) user.profile.email = row.email;
  if (row.bot_id) user.profile.bot_id = row.bot_id;
  if (row.app_id) user.profile.api_app_id = row.app_id;
  return user;
}

/** Derive a unique handle from an email address or a display name. */
export function uniqueHandle(ctx: Ctx, seed: string): string {
  const base =
    seed
      .split('@')[0]!
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '.')
      .replace(/^[._-]+|[._-]+$/g, '')
      .slice(0, 21) || 'member';
  let handle = base;
  for (let n = 2; ctx.db.get('SELECT 1 FROM users WHERE name = ?', handle); n += 1) handle = `${base}${n}`;
  return handle;
}

export interface NewUser {
  email?: string | null;
  realName: string;
  displayName?: string;
  passwordHash?: string | null;
  role?: Role;
  tz?: string;
  isBot?: boolean;
  botId?: string | null;
  appId?: string | null;
  handle?: string;
  /** Use this id instead of issuing one (imports keep the original ids). */
  id?: string;
  title?: string;
  deleted?: boolean;
}

export function createUser(ctx: Ctx, input: NewUser): UserRow {
  const id = input.id ?? newId('U');
  const now = nowSeconds();
  const email = input.email ? input.email.trim().toLowerCase() : null;
  if (email && ctx.db.get('SELECT 1 FROM users WHERE email = ?', email)) fail('email_taken');
  const handle = input.handle ?? uniqueHandle(ctx, email ?? input.realName);
  const color = COLORS[Math.abs(hashCode(id)) % COLORS.length]!;
  ctx.db.run(
    `INSERT INTO users (id, name, real_name, display_name, email, password_hash, tz, color, is_bot, bot_id, app_id, role,
       title, deleted, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    handle,
    input.realName.trim(),
    (input.displayName ?? '').trim(),
    email,
    input.passwordHash ?? null,
    input.tz ?? 'UTC',
    color,
    input.isBot ? 1 : 0,
    input.botId ?? null,
    input.appId ?? null,
    input.role ?? 'member',
    input.title ?? '',
    input.deleted ? 1 : 0,
    now,
    now,
  );
  return requireUser(ctx, id);
}

function hashCode(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) hash = (hash * 31 + input.charCodeAt(i)) | 0;
  return hash;
}

/** Announce a changed user to every connected client and subscribed app. */
export function emitUserChange(ctx: Ctx, id: string): void {
  const row = getUser(ctx, id);
  if (!row) return;
  ctx.bus.emit({
    event: { type: 'user_change', user: userToApi(ctx, row), event_ts: ctx.clock.eventTs() },
    audience: { all: true },
  });
}

export function touchUser(ctx: Ctx, id: string): void {
  ctx.db.run('UPDATE users SET updated = ? WHERE id = ?', nowSeconds(), id);
}

export function isAdmin(actor: Actor): boolean {
  return actor.role !== 'member' && !actor.isBot;
}

export function presenceOf(ctx: Ctx, row: UserRow): 'active' | 'away' {
  if (row.is_bot === 1) return 'active';
  if (row.manual_presence === 'away') return 'away';
  return ctx.presence.isOnline(row.id) ? 'active' : 'away';
}
