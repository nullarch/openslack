import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import busboy from 'busboy';
import { readBody, sendJson } from '../api/http.ts';
import type { Kernel } from '../app.ts';
import { systemUser } from '../attention/common.ts';
import { getConv, getMember, resolveConv } from '../core/conversations.ts';
import { ApiError, fail } from '../core/errors.ts';
import { createPendingFile, receiveUpload } from '../core/files.ts';
import { newSecret, nowSeconds } from '../core/ids.ts';
import { postMessage } from '../core/messages.ts';
import type { Ctx } from '../ctx.ts';
import { parseMail } from './mime.ts';

/**
 * Email to a channel: a channel can have its own secret address
 * (`<name>.<token>@INBOUND_EMAIL_DOMAIN`); mail sent there is posted in the
 * channel by the built-in Email bot, with the sender, subject, text and
 * attachments. The mail itself arrives from a mail provider's inbound route
 * (Cloudflare Email Workers, Mailgun, SendGrid, …) as raw MIME at
 * POST /inbound/email, authenticated with INBOUND_EMAIL_SECRET.
 */

const MAX_TEXT = 12_000;

interface AddressRow {
  conversation_id: string;
  token: string;
}

function addressFor(ctx: Ctx, row: AddressRow): string | null {
  const domain = ctx.config.inboundEmailDomain;
  if (!domain) return null;
  const conv = getConv(ctx, row.conversation_id);
  const slug = (conv?.name ?? 'channel').replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'channel';
  return `${slug}.${row.token}@${domain}`;
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The raw message from the request: a MIME body, or the field providers put it in. */
async function rawMessage(ctx: Ctx, req: IncomingMessage): Promise<{ raw: Buffer; recipient: string | null }> {
  const type = String(req.headers['content-type'] ?? '');
  const limit = ctx.config.maxUploadBytes + 1024 * 1024;
  if (!type.startsWith('multipart/form-data')) return { raw: await readBody(req, limit), recipient: null };
  // SendGrid Inbound Parse ("POST the raw, full MIME message") sends `email`; Mailgun's MIME routes send `body-mime`.
  return new Promise((resolve, reject) => {
    const fields: Record<string, string> = {};
    let parser: busboy.Busboy;
    try {
      parser = busboy({ headers: req.headers, limits: { fieldSize: limit, fields: 40, files: 0 } });
    } catch {
      reject(new ApiError('invalid_form_data', {}, 400));
      return;
    }
    parser.on('field', (name, value) => {
      fields[name] = value;
    });
    parser.on('error', () => reject(new ApiError('invalid_form_data', {}, 400)));
    parser.on('close', () => {
      const raw = fields.email ?? fields['body-mime'] ?? fields.raw;
      if (!raw) reject(new ApiError('no_message', {}, 400));
      else resolve({ raw: Buffer.from(raw, 'utf8'), recipient: fields.recipient ?? fields.to ?? null });
    });
    req.pipe(parser);
  });
}

export function installInboundEmail(kernel: Kernel): void {
  const { ctx } = kernel;

  const rowFor = (conversationId: string): AddressRow | undefined => ctx.db.get<AddressRow>('SELECT conversation_id, token FROM channel_email WHERE conversation_id = ?', conversationId);

  kernel.registry.add('client.conversations.email.get', { auth: 'session' }, ({ actor, args }) => {
    const conv = resolveConv(ctx, actor, args.str('channel'));
    const row = rowFor(conv.id);
    return { enabled: Boolean(ctx.config.inboundEmailDomain && ctx.config.inboundEmailSecret), address: row && getMember(ctx, conv.id, actor.userId) ? addressFor(ctx, row) : null };
  });

  /** Make (or replace) the channel's address. Members of the channel may; replacing stops the old one. */
  kernel.registry.add('client.conversations.email.create', { auth: 'session' }, ({ actor, args }) => {
    if (!ctx.config.inboundEmailDomain || !ctx.config.inboundEmailSecret) fail('not_configured');
    const conv = resolveConv(ctx, actor, args.str('channel'));
    if (conv.kind !== 'public' && conv.kind !== 'private') fail('method_not_supported_for_channel_type');
    if (!getMember(ctx, conv.id, actor.userId)) fail('not_in_channel');
    if (conv.is_archived) fail('is_archived');
    const token = newSecret(9).toLowerCase().replace(/[^a-z0-9]/g, 'x');
    ctx.db.run(
      `INSERT INTO channel_email (conversation_id, token, created_by, created) VALUES (?, ?, ?, ?)
       ON CONFLICT (conversation_id) DO UPDATE SET token = excluded.token, created_by = excluded.created_by, created = excluded.created`,
      conv.id,
      token,
      actor.userId,
      nowSeconds(),
    );
    return { address: addressFor(ctx, rowFor(conv.id)!) };
  });

  kernel.registry.add('client.conversations.email.delete', { auth: 'session' }, ({ actor, args }) => {
    const conv = resolveConv(ctx, actor, args.str('channel'));
    if (!getMember(ctx, conv.id, actor.userId)) fail('not_in_channel');
    ctx.db.run('DELETE FROM channel_email WHERE conversation_id = ?', conv.id);
  });

  kernel.router.add('POST', /^\/inbound\/email$/, async ({ req, res, url }) => {
    const secret = ctx.config.inboundEmailSecret;
    if (!secret || !ctx.config.inboundEmailDomain || !ctx.team()) return sendJson(res, 404, { ok: false, error: 'not_found' });
    const given = String(req.headers['x-inbound-key'] ?? url.searchParams.get('key') ?? '');
    if (!given || !sameSecret(given, secret)) return sendJson(res, 401, { ok: false, error: 'invalid_auth' });
    let message: { raw: Buffer; recipient: string | null };
    try {
      message = await rawMessage(ctx, req);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'invalid_message';
      return sendJson(res, error instanceof ApiError ? error.status : 400, { ok: false, error: code });
    }
    const mail = parseMail(message.raw);
    const domain = ctx.config.inboundEmailDomain;
    const candidates = [url.searchParams.get('to'), message.recipient, ...mail.to].filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase());
    let target: AddressRow | undefined;
    for (const address of candidates) {
      const [local = '', host = ''] = address.split('@');
      if (host && host !== domain) continue;
      const token = local.split('.').pop() ?? '';
      target = ctx.db.get<AddressRow>('SELECT conversation_id, token FROM channel_email WHERE token = ?', token);
      if (target) break;
    }
    // Unknown address: accepted and dropped, so the sender learns nothing about which addresses exist.
    if (!target) return sendJson(res, 200, { ok: true, delivered: false });
    const conv = getConv(ctx, target.conversation_id);
    if (!conv || conv.is_archived) return sendJson(res, 200, { ok: true, delivered: false });

    const bot = systemUser(ctx, 'email');
    if (!getMember(ctx, conv.id, bot.id)) ctx.db.run('INSERT OR IGNORE INTO members (conversation_id, user_id, joined) VALUES (?, ?, ?)', conv.id, bot.id, nowSeconds());
    const fileIds: string[] = [];
    for (const attachment of mail.attachments.slice(0, 10)) {
      if (attachment.content.length === 0 || attachment.content.length > ctx.config.maxUploadBytes) continue;
      try {
        const pending = createPendingFile(ctx, bot.id, attachment.filename, attachment.content.length, null);
        await receiveUpload(ctx, pending.row.id, new URL(pending.uploadUrl).searchParams.get('secret')!, Readable.from([attachment.content]));
        fileIds.push(pending.row.id);
      } catch {
        // An attachment that cannot be stored (for example refused by the scanner) is left out.
      }
    }
    const sender = mail.from.name && mail.from.name !== mail.from.address ? `${mail.from.name} <${mail.from.address}>` : mail.from.address || 'Unknown sender';
    const body = mail.text.length > MAX_TEXT ? `${mail.text.slice(0, MAX_TEXT)}…` : mail.text;
    const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    try {
      const posted = postMessage(ctx, {
        conv,
        userId: bot.id,
        text: `*${escape(mail.subject || '(no subject)')}*\nFrom ${escape(sender)}\n\n${escape(body)}`,
        fileIds,
      });
      return sendJson(res, 200, { ok: true, delivered: true, channel: conv.id, ts: posted.ts });
    } catch (error) {
      if (error instanceof ApiError) return sendJson(res, 200, { ok: true, delivered: false, error: error.code });
      throw error;
    }
  });
}

