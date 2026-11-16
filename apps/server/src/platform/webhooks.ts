import type { ServerResponse } from 'node:http';
import type { Kernel } from '../app.ts';
import { parseBody, readBody } from '../api/http.ts';
import type { Ctx } from '../ctx.ts';
import { canonicalTs } from '../core/clock.ts';
import { convToApi, getConv, resolveConv } from '../core/conversations.ts';
import { ApiError, fail } from '../core/errors.ts';
import { newId, newSecret, nowSeconds } from '../core/ids.ts';
import { getMessage, postMessage } from '../core/messages.ts';
import { getApp, requireApp, type AppRow } from './apps.ts';
import { hasContent, readResponseContent } from './responses.ts';

interface WebhookRow {
  id: string;
  app_id: string;
  conversation_id: string;
  secret: string;
  created_by: string;
  created: number;
}

function webhookToApi(ctx: Ctx, row: WebhookRow, app: AppRow): Record<string, unknown> {
  const conv = getConv(ctx, row.conversation_id);
  return {
    id: row.id,
    url: `${ctx.config.publicUrl}/services/${ctx.requireTeam().id}/${app.bot_id}/${row.secret}`,
    channel: row.conversation_id,
    channel_name: conv ? (convToApi(ctx, conv, null).name ?? '') : '',
    created: row.created,
    created_by: row.created_by,
  };
}

/** Incoming webhooks answer in plain text, with real HTTP status codes. */
function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export function installWebhooks(kernel: Kernel): void {
  const { ctx } = kernel;

  /** Create an incoming webhook: a URL that posts into one conversation as the app. */
  kernel.registry.add('client.apps.webhooks.create', { auth: 'admin' }, ({ actor, args }) => {
    const app = requireApp(ctx, args.str('app'));
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    if (conv.is_archived === 1) fail('is_archived');
    const id = newId('W', 10);
    ctx.db.run(
      'INSERT INTO webhooks (id, app_id, conversation_id, secret, created_by, created) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      app.id,
      conv.id,
      newSecret(18).replace(/[-_]/g, 'x'),
      actor.userId,
      nowSeconds(),
    );
    return { webhook: webhookToApi(ctx, ctx.db.get<WebhookRow>('SELECT * FROM webhooks WHERE id = ?', id)!, app) };
  });

  kernel.registry.add('client.apps.webhooks.list', { auth: 'admin' }, ({ args }) => {
    const app = requireApp(ctx, args.str('app'));
    const rows = ctx.db.all<WebhookRow>('SELECT * FROM webhooks WHERE app_id = ? ORDER BY created, id', app.id);
    return { webhooks: rows.map((row) => webhookToApi(ctx, row, app)) };
  });

  kernel.registry.add('client.apps.webhooks.delete', { auth: 'admin' }, ({ args }) => {
    const app = requireApp(ctx, args.str('app'));
    const result = ctx.db.run('DELETE FROM webhooks WHERE id = ? AND app_id = ?', args.req('id'), app.id);
    if (result.changes === 0) fail('webhook_not_found');
  });

  kernel.router.add('POST', /^\/services\/([A-Z0-9]+)\/([A-Z0-9]+)\/([A-Za-z0-9]+)$/, async ({ req, res, params }) => {
    const [teamId, botId, secret] = params;
    const row = ctx.db.get<WebhookRow>('SELECT * FROM webhooks WHERE secret = ?', secret!);
    const app = row ? getApp(ctx, row.app_id) : undefined;
    if (!row || !app || app.bot_id !== botId || ctx.team()?.id !== teamId) {
      plain(res, 404, 'no_service');
      return;
    }
    const conv = getConv(ctx, row.conversation_id);
    if (!conv) {
      plain(res, 404, 'channel_not_found');
      return;
    }
    if (conv.is_archived === 1) {
      plain(res, 410, 'channel_is_archived');
      return;
    }

    let body: Record<string, unknown>;
    let content;
    try {
      body = parseBody(String(req.headers['content-type'] ?? ''), await readBody(req));
      // The legacy form: a form-encoded body with the JSON in `payload`.
      if (typeof body.payload === 'string') body = JSON.parse(body.payload) as Record<string, unknown>;
      content = readResponseContent(body);
    } catch (error) {
      if (error instanceof ApiError && error.status === 413) throw error;
      plain(res, 400, 'invalid_payload');
      return;
    }
    if (!hasContent(content)) {
      plain(res, 400, 'no_text');
      return;
    }
    const threadTs = typeof body.thread_ts === 'string' ? canonicalTs(body.thread_ts) : null;
    try {
      postMessage(ctx, {
        conv,
        userId: app.bot_user_id,
        botId: app.bot_id,
        appId: app.id,
        text: content.text ?? '',
        blocks: content.blocks ?? null,
        attachments: content.attachments ?? null,
        threadTs: threadTs && getMessage(ctx, conv.id, threadTs) ? threadTs : null,
        username: typeof body.username === 'string' ? body.username.slice(0, 80) : null,
        iconEmoji: typeof body.icon_emoji === 'string' ? body.icon_emoji.slice(0, 100) : null,
        iconUrl: typeof body.icon_url === 'string' ? body.icon_url.slice(0, 1000) : null,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        plain(res, 400, error.code === 'msg_too_long' ? 'invalid_payload' : error.code);
        return;
      }
      throw error;
    }
    plain(res, 200, 'ok');
  });
}
