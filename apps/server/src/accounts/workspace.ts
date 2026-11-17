import { extractBlockMentions, extractMentions } from '@app/shared';
import type { Kernel } from '../app.ts';
import { teamToApi } from '../api/methods/client.ts';
import { Args } from '../api/registry.ts';
import { convToApi, getConv, memberIds, resolveConv, type ConvRow } from '../core/conversations.ts';
import { ApiError, fail } from '../core/errors.ts';
import { getFile } from '../core/files.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import { contentChecks, postSystemMessage } from '../core/messages.ts';
import { emitUserChange, getUser, isAdmin, requireUser, userToApi, type UserRow } from '../core/users.ts';
import type { Actor, Ctx } from '../ctx.ts';
import { allowedTo, parseDomains, PERMISSIONS, setTeamPrefs, teamPrefs, type Audience, type TeamPrefs } from './prefs.ts';

/** The settings as an admin sees and edits them, with defaults filled in. */
function settingsToApi(ctx: Ctx): Record<string, unknown> {
  const prefs = teamPrefs(ctx);
  const out: Record<string, unknown> = {
    default_channels: (prefs.default_channels ?? []).filter((id) => getConv(ctx, id) !== undefined),
    signup_domains: prefs.signup_domains ?? [],
    require_2fa: prefs.require_2fa === true,
    public_invite_code: prefs.public_invite_code ?? null,
    public_file_links: prefs.public_file_links !== false,
  };
  for (const permission of PERMISSIONS) out[permission] = prefs[permission] ?? 'everyone';
  return out;
}

export function permissionsFor(ctx: Ctx, userId: string): Record<string, boolean> {
  const user = getUser(ctx, userId);
  return {
    create_channels: allowedTo(ctx, userId, 'who_can_create_channels'),
    invite: allowedTo(ctx, userId, 'who_can_invite'),
    manage_emoji: allowedTo(ctx, userId, 'who_can_manage_emoji'),
    at_channel: allowedTo(ctx, userId, 'who_can_at_channel'),
    manage_usergroups: allowedTo(ctx, userId, 'who_can_manage_usergroups'),
    browse_channels: user !== undefined && user.guest === '',
    public_file_links: teamPrefs(ctx).public_file_links !== false,
  };
}

/** Tell every open tab that what people may do has changed; each tab refetches its own permissions. */
function announceSettings(ctx: Ctx): void {
  ctx.bus.emit({ event: { type: 'team_prefs_changed' }, audience: { all: true }, clientOnly: true });
}

function audience(value: unknown, name: string): Audience {
  if (value !== 'everyone' && value !== 'admins') fail('invalid_arguments', { needed: name });
  return value;
}

// ── Profile fields ──────────────────────────────────────────────────────────

const FIELD_TYPES = ['text', 'long_text', 'date', 'link', 'options_list', 'user'];

interface FieldRow {
  id: string;
  label: string;
  hint: string;
  type: string;
  possible_values: string | null;
  ordering: number;
  is_hidden: number;
}

export function profileFields(ctx: Ctx, includeHidden = true): FieldRow[] {
  return ctx.db.all<FieldRow>(
    `SELECT * FROM profile_fields ${includeHidden ? '' : 'WHERE is_hidden = 0'} ORDER BY ordering, id`,
  );
}

/** A field in `team.profile.get`'s shape. */
function fieldToApi(row: FieldRow): Record<string, unknown> {
  return {
    id: row.id,
    ordering: row.ordering,
    field_name: '',
    label: row.label,
    hint: row.hint,
    type: row.type,
    possible_values: row.possible_values ? (JSON.parse(row.possible_values) as string[]) : null,
    options: { is_protected: false, is_scim: false },
    is_hidden: row.is_hidden === 1,
    section_id: '',
  };
}

/** Validate one field value against its definition; returns the stored value. */
function fieldValue(ctx: Ctx, field: FieldRow, raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return '';
  if (value.length > 256) fail('invalid_profile', { field: field.id });
  switch (field.type) {
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) fail('invalid_profile', { field: field.id });
      break;
    case 'link':
      if (!/^https?:\/\/\S+$/i.test(value)) fail('invalid_profile', { field: field.id });
      break;
    case 'options_list': {
      const options = field.possible_values ? (JSON.parse(field.possible_values) as string[]) : [];
      if (!options.includes(value)) fail('invalid_profile', { field: field.id });
      break;
    }
    case 'user':
      if (!getUser(ctx, value)) fail('invalid_profile', { field: field.id });
      break;
  }
  return value;
}

/** Merge `{ Xf…: { value } }` into a person's custom fields. Returns whether anything changed. */
function setFieldValues(ctx: Ctx, target: UserRow, input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_profile');
  const fields = new Map(profileFields(ctx).map((row) => [row.id, row]));
  const current = JSON.parse(target.fields || '{}') as Record<string, { value: string; alt: string }>;
  let changed = false;
  for (const [id, entry] of Object.entries(input as Record<string, unknown>)) {
    const field = fields.get(id);
    if (!field) fail('invalid_profile', { field: id });
    const raw = entry && typeof entry === 'object' ? (entry as { value?: unknown }).value : entry;
    const value = fieldValue(ctx, field, raw);
    if (value === '') {
      if (current[id]) {
        delete current[id];
        changed = true;
      }
    } else if (current[id]?.value !== value) {
      current[id] = { value, alt: '' };
      changed = true;
    }
  }
  if (changed) ctx.db.run('UPDATE users SET fields = ?, updated = ? WHERE id = ?', JSON.stringify(current), nowSeconds(), target.id);
  return changed;
}

// ── Converting a channel ────────────────────────────────────────────────────

export function convertToPrivate(ctx: Ctx, actor: Actor, conv: ConvRow): void {
  if (conv.kind !== 'public') fail('method_not_supported_for_channel_type');
  if (conv.is_general === 1) fail('cant_convert_general');
  ctx.db.run(
    "UPDATE conversations SET kind = 'private', web_public = 0, web_files = 0, updated = ? WHERE id = ?",
    nowSeconds(),
    conv.id,
  );
  const fresh = getConv(ctx, conv.id)!;
  const members = new Set(memberIds(ctx, conv.id));
  // Everyone else stops seeing it: their tabs drop it, and it leaves the default channels.
  const others = ctx.db
    .all<{ id: string }>('SELECT id FROM users WHERE deleted = 0')
    .map((row) => row.id)
    .filter((id) => !members.has(id));
  ctx.bus.emit({ event: { type: 'channel_left', channel: conv.id }, audience: { users: others }, clientOnly: true });
  ctx.bus.emit({
    event: { type: 'channel_updated', channel: convToApi(ctx, fresh, null), event_ts: ctx.clock.eventTs() },
    audience: { conversation: conv.id },
    clientOnly: true,
  });
  const defaults = teamPrefs(ctx).default_channels ?? [];
  if (defaults.includes(conv.id)) setTeamPrefs(ctx, { default_channels: defaults.filter((id) => id !== conv.id) });
  postSystemMessage(ctx, fresh, actor.userId, 'channel_convert_to_private', `<@${actor.userId}> made this channel private`);
}

// ── Installation ────────────────────────────────────────────────────────────

const BROADCAST = /<!(?:channel|here|everyone)(?:\|[^>]*)?>/;

export function installWorkspace(kernel: Kernel): void {
  const { ctx, registry } = kernel;

  // Workspace-wide permissions, enforced on every path that leads to the action.
  registry.guards.push((name, actor) => {
    // Turning a group DM into a private channel creates a channel too, and so does an agent opening a code channel.
    const creates = name === 'conversations.create' || name === 'client.conversations.convertGroupDm' || name === 'agents.conversations.create';
    if (creates && !allowedTo(ctx, actor.userId, 'who_can_create_channels')) {
      throw new ApiError('restricted_action');
    }
    if ((name === 'admin.emoji.add' || name === 'admin.emoji.addAlias') && !allowedTo(ctx, actor.userId, 'who_can_manage_emoji')) {
      throw new ApiError('restricted_action');
    }
  });
  contentChecks.push((ctx2, userId, text, blocks) => {
    const broadcast = BROADCAST.test(text) || extractMentions(text).broadcast || (blocks ? extractBlockMentions(blocks).broadcast : false);
    if (!broadcast) return;
    const user = getUser(ctx2, userId);
    // Apps posting alerts are not people shouting; the restriction is about members.
    if (user?.is_bot === 1) return;
    if (!allowedTo(ctx2, userId, 'who_can_at_channel')) fail('restricted_action', { detail: 'at_channel' });
  });

  registry.add('client.permissions', { auth: 'session' }, ({ actor }) => ({ permissions: permissionsFor(ctx, actor.userId) }));

  registry.add('client.admin.settings', { auth: 'admin' }, () => ({ settings: settingsToApi(ctx) }));

  registry.add('client.admin.updateSettings', { auth: 'admin' }, ({ actor, args }) => {
    const patch: Partial<TeamPrefs> = {};
    for (const permission of PERMISSIONS) {
      if (args.has(permission)) patch[permission] = audience(args.str(permission), permission);
    }
    if (args.raw.signup_domains !== undefined) {
      const raw = args.raw.signup_domains;
      patch.signup_domains = parseDomains(typeof raw === 'string' && raw.trim().startsWith('[') ? args.json('signup_domains') : raw);
    }
    if (args.raw.default_channels !== undefined) {
      const ids = args.list('default_channels');
      for (const id of ids) {
        const conv = getConv(ctx, id);
        if (!conv || (conv.kind !== 'public' && conv.kind !== 'private') || conv.is_archived === 1) fail('channel_not_found');
        if (conv.kind === 'private' && !memberIds(ctx, id).includes(actor.userId)) fail('channel_not_found');
      }
      patch.default_channels = [...new Set(ids)];
    }
    if (args.has('require_2fa')) {
      const require = args.bool('require_2fa');
      // An admin who turns it on must be able to sign in under it.
      if (require && requireUser(ctx, actor.userId).totp_enabled !== 1) fail('two_factor_required_first');
      patch.require_2fa = require;
    }
    if (args.has('public_file_links')) patch.public_file_links = args.bool('public_file_links');
    if (args.raw.public_invite_code !== undefined) {
      const code = args.str('public_invite_code') || null;
      if (code && !ctx.db.get("SELECT 1 FROM invites WHERE code = ? AND revoked = 0 AND email IS NULL AND guest = ''", code)) {
        fail('invalid_invite');
      }
      patch.public_invite_code = code;
    }
    setTeamPrefs(ctx, patch);
    announceSettings(ctx);
    return { settings: settingsToApi(ctx) };
  });

  registry.add('client.admin.setTeamIcon', { auth: 'admin' }, ({ actor, args }) => {
    let key: string | null = null;
    if (args.has('file_id')) {
      const file = getFile(ctx, args.req('file_id'));
      if (!file || file.user_id !== actor.userId || file.state === 'pending') fail('file_not_found');
      if (!/^image\/(png|jpeg|gif|webp)$/.test(file.mimetype)) fail('bad_image');
      key = file.storage_key;
    }
    ctx.db.run('UPDATE team SET icon_key = ? WHERE id = ?', key, ctx.requireTeam().id);
    ctx.invalidateTeam();
    const team = teamToApi(ctx);
    ctx.bus.emit({ event: { type: 'team_updated', team }, audience: { all: true }, clientOnly: true });
    return { team };
  });

  // Slack's admin method name and argument.
  registry.add('admin.conversations.convertToPrivate', { auth: 'admin', scopes: ['admin.conversations:write'] }, ({ actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel_id', 'channel_not_found'));
    convertToPrivate(ctx, actor, conv);
  });

  // ── Profile fields ────────────────────────────────────────────────────────

  registry.add('team.profile.get', { scopes: ['users.profile:read', 'users:read'] }, ({ args }) => {
    const visibility = args.str('visibility') ?? 'all';
    const rows = profileFields(ctx).filter((row) =>
      visibility === 'visible' ? row.is_hidden === 0 : visibility === 'hidden' ? row.is_hidden === 1 : true,
    );
    return { profile: { fields: rows.map(fieldToApi), sections: [] } };
  });

  registry.add('client.admin.setProfileFields', { auth: 'admin' }, ({ args }) => {
    const input = args.json<{ id?: string; label?: string; hint?: string; type?: string; possible_values?: string[]; is_hidden?: boolean }[]>('fields');
    if (!Array.isArray(input) || input.length > 50) fail('invalid_arguments', { needed: 'fields' });
    const existing = new Set(profileFields(ctx).map((row) => row.id));
    const kept = new Set<string>();
    ctx.db.tx(() => {
      input.forEach((field, ordering) => {
        const label = String(field.label ?? '').trim().slice(0, 50);
        if (!label) fail('invalid_arguments', { needed: 'label' });
        const type = field.type ?? 'text';
        if (!FIELD_TYPES.includes(type)) fail('invalid_arguments', { needed: 'type' });
        const options = type === 'options_list' ? (field.possible_values ?? []).map(String).map((item) => item.trim()).filter(Boolean) : null;
        if (type === 'options_list' && (!options || options.length === 0)) fail('invalid_arguments', { needed: 'possible_values' });
        const id = field.id && existing.has(field.id) ? field.id : newId('Xf');
        kept.add(id);
        ctx.db.run(
          `INSERT INTO profile_fields (id, label, hint, type, possible_values, ordering, is_hidden) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET label = excluded.label, hint = excluded.hint, type = excluded.type,
             possible_values = excluded.possible_values, ordering = excluded.ordering, is_hidden = excluded.is_hidden`,
          id,
          label,
          String(field.hint ?? '').trim().slice(0, 150),
          type,
          options ? JSON.stringify(options) : null,
          ordering,
          field.is_hidden ? 1 : 0,
        );
      });
      for (const id of existing) if (!kept.has(id)) ctx.db.run('DELETE FROM profile_fields WHERE id = ?', id);
    });
    ctx.bus.emit({ event: { type: 'team_profile_change', profile: { fields: profileFields(ctx).map(fieldToApi) } }, audience: { all: true } });
    return { profile: { fields: profileFields(ctx).map(fieldToApi), sections: [] } };
  });

  // users.profile.set also accepts `fields` (Slack shape: { Xf…: { value, alt } }) and `name=Xf…`.
  const original = registry.get('users.profile.set')!;
  registry.add('users.profile.set', { auth: original.auth === 'none' ? 'any' : original.auth, scopes: original.scopes }, async (call) => {
    const { actor, args } = call;
    const targetId = args.str('user') || actor.userId;
    if (targetId !== actor.userId && !isAdmin(actor)) fail('cannot_update_admin_user');
    const target = requireUser(ctx, targetId);
    const profile = args.json<Record<string, unknown>>('profile');
    let changed = false;
    if (profile && typeof profile === 'object' && profile.fields !== undefined) {
      changed = setFieldValues(ctx, target, profile.fields);
      const rest = { ...profile };
      delete rest.fields;
      call = { ...call, args: argsWith(args, { profile: JSON.stringify(rest) }) };
      if (Object.keys(rest).length === 0) {
        if (changed) emitUserChange(ctx, target.id);
        return { profile: userToApi(ctx, requireUser(ctx, targetId), actor).profile };
      }
    } else if (!profile && args.str('name')?.startsWith('Xf')) {
      changed = setFieldValues(ctx, target, { [args.req('name')]: { value: args.str('value') ?? '' } });
      if (changed) emitUserChange(ctx, target.id);
      return { profile: userToApi(ctx, requireUser(ctx, targetId), actor).profile };
    }
    const result = await original.handler(call);
    if (changed) emitUserChange(ctx, target.id);
    return { ...(result ?? {}), profile: userToApi(ctx, requireUser(ctx, targetId), actor).profile };
  });
}

function argsWith(args: Args, extra: Record<string, unknown>): Args {
  return new Args({ ...args.raw, ...extra });
}
