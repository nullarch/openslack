import type { Ctx } from '../../ctx.ts';
import { fail } from '../../core/errors.ts';
import { getFile } from '../../core/files.ts';
import { nowSeconds } from '../../core/ids.ts';
import type { Registry } from '../registry.ts';

interface EmojiRow {
  name: string;
  storage_key: string | null;
  mimetype: string | null;
  alias_for: string | null;
  created_by: string;
  created: number;
}

/** Custom emoji as Slack lists them: name → image URL, or `alias:other`. */
export function customEmoji(ctx: Ctx): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of ctx.db.all<EmojiRow>('SELECT * FROM emoji ORDER BY name')) {
    out[row.name] = row.alias_for ? `alias:${row.alias_for}` : `${ctx.config.publicUrl}/emoji/${encodeURIComponent(row.name)}?v=${row.created}`;
  }
  return out;
}

function validName(input: string): string {
  const name = input.trim().replace(/^:|:$/g, '').toLowerCase();
  if (!name || name.length > 100 || !/^[\p{Ll}\p{Lo}\p{N}_+'-]+$/u.test(name)) fail('invalid_name');
  return name;
}

function emitChange(ctx: Ctx, body: Record<string, unknown>): void {
  ctx.bus.emit({
    event: { type: 'emoji_changed', ...body, event_ts: ctx.clock.eventTs() },
    audience: { all: true },
  });
}

export function registerEmoji(registry: Registry): void {
  registry.add('emoji.list', { scopes: ['emoji:read'] }, ({ ctx }) => ({ emoji: customEmoji(ctx), cache_ts: String(nowSeconds()) }));

  /** Add a custom emoji from an uploaded image (`file_id`). */
  registry.add('admin.emoji.add', { auth: 'session' }, ({ ctx, actor, args }) => {
    const name = validName(args.req('name'));
    if (ctx.db.get('SELECT 1 FROM emoji WHERE name = ?', name)) fail('error_name_taken');
    const file = getFile(ctx, args.req('file_id')) ?? fail('file_not_found');
    if (file.user_id !== actor.userId || file.state === 'pending') fail('file_not_found');
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.mimetype)) fail('error_bad_format');
    if (file.size > 1024 * 1024) fail('error_too_big');
    const created = nowSeconds();
    ctx.db.run(
      'INSERT INTO emoji (name, storage_key, mimetype, created_by, created) VALUES (?, ?, ?, ?, ?)',
      name,
      file.storage_key,
      file.mimetype,
      actor.userId,
      created,
    );
    emitChange(ctx, { subtype: 'add', name, value: customEmoji(ctx)[name] });
  });

  registry.add('admin.emoji.addAlias', { auth: 'session' }, ({ ctx, actor, args }) => {
    const name = validName(args.req('name'));
    const target = validName(args.req('alias_for'));
    if (ctx.db.get('SELECT 1 FROM emoji WHERE name = ?', name)) fail('error_name_taken');
    ctx.db.run(
      'INSERT INTO emoji (name, alias_for, created_by, created) VALUES (?, ?, ?, ?)',
      name,
      target,
      actor.userId,
      nowSeconds(),
    );
    emitChange(ctx, { subtype: 'add', name, value: `alias:${target}` });
  });

  registry.add('admin.emoji.remove', { auth: 'session' }, ({ ctx, actor, args }) => {
    const name = validName(args.req('name'));
    const row = ctx.db.get<EmojiRow>('SELECT * FROM emoji WHERE name = ?', name);
    if (!row) fail('emoji_not_found');
    if (row.created_by !== actor.userId && actor.role === 'member') fail('not_allowed');
    ctx.db.run('DELETE FROM emoji WHERE name = ? OR alias_for = ?', name, name);
    emitChange(ctx, { subtype: 'remove', names: [name] });
  });
}

export function getEmojiImage(ctx: Ctx, name: string): { key: string; mimetype: string } | null {
  let row = ctx.db.get<EmojiRow>('SELECT * FROM emoji WHERE name = ?', name);
  if (row?.alias_for) row = ctx.db.get<EmojiRow>('SELECT * FROM emoji WHERE name = ?', row.alias_for);
  if (!row?.storage_key) return null;
  return { key: row.storage_key, mimetype: row.mimetype ?? 'image/png' };
}
