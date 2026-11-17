import type { Actor, Ctx } from '../../ctx.ts';
import { fail } from '../../core/errors.ts';
import { canAccessFile, fileToApi, getFile, isInlineSafe, type FileRow } from '../../core/files.ts';
import { newSecret } from '../../core/ids.ts';
import { isAdmin } from '../../core/users.ts';
import { sendJson, type Router } from '../http.ts';
import type { Registry } from '../registry.ts';

/**
 * Public links for files (`files.sharedPublicURL` / `files.revokePublicURL`):
 * anyone with the link can download the file without signing in, until the
 * link is revoked. Like Slack, only people (session or user token) can create
 * them, not bots; the uploader or an admin may. An admin can turn the feature
 * off for the workspace with the team pref `public_file_links: false`.
 */

function publicLinksAllowed(ctx: Ctx): boolean {
  try {
    const prefs = JSON.parse(ctx.requireTeam().prefs) as { public_file_links?: unknown };
    return prefs.public_file_links !== false;
  } catch {
    return true;
  }
}

export function registerPublicFiles(registry: Registry): void {
  const owned = (ctx: Ctx, fileId: string | undefined, actor: Actor): FileRow => {
    if (actor.kind === 'bot' || actor.kind === 'app') fail('not_allowed_token_type');
    const row = fileId ? getFile(ctx, fileId) : undefined;
    if (!row || row.state === 'pending' || !canAccessFile(ctx, row, actor.userId)) fail('file_not_found');
    if (row.user_id !== actor.userId && !isAdmin(actor)) fail('not_allowed');
    return row;
  };

  registry.add('files.sharedPublicURL', { scopes: ['files:write'] }, ({ ctx, actor, args }) => {
    const row = owned(ctx, args.str('file'), actor);
    if (!publicLinksAllowed(ctx)) fail('not_allowed');
    if (row.public_secret) fail('already_public');
    ctx.db.run('UPDATE files SET public_secret = ? WHERE id = ?', newSecret(15).replace(/[-_]/g, 'x').toLowerCase(), row.id);
    return { file: fileToApi(ctx, getFile(ctx, row.id)!) };
  });

  registry.add('files.revokePublicURL', { scopes: ['files:write'] }, ({ ctx, actor, args }) => {
    const row = owned(ctx, args.str('file'), actor);
    ctx.db.run('UPDATE files SET public_secret = NULL WHERE id = ?', row.id);
    return { file: fileToApi(ctx, getFile(ctx, row.id)!) };
  });
}

export function registerPublicFileRoutes(ctx: Ctx, router: Router): void {
  router.add('GET', /^\/files-pub\/[A-Z0-9]+-([A-Z0-9]+)-([a-z0-9]+)(?:\/[^/]*)?$/, async ({ req, res, params }) => {
    const row = getFile(ctx, params[0]!);
    // Unknown, revoked, or a wrong secret all look the same.
    if (!row || !row.public_secret || row.public_secret !== params[1] || !publicLinksAllowed(ctx)) {
      sendJson(res, 404, { ok: false, error: 'file_not_found' });
      return;
    }
    const size = await ctx.storage.size(row.storage_key);
    if (size === null) {
      sendJson(res, 404, { ok: false, error: 'file_not_found' });
      return;
    }
    const inline = isInlineSafe(row.mimetype);
    res.writeHead(200, {
      'content-type': inline ? row.mimetype : 'application/octet-stream',
      'content-length': size,
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'${row.mimetype === 'application/pdf' ? "; object-src 'self'" : '; sandbox'}`,
    });
    if (req.method === 'HEAD') res.end();
    else ctx.storage.read(row.storage_key).pipe(res);
  });
}
