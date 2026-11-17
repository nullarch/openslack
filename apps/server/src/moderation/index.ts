import type { Kernel } from '../app.ts';
import { getConv, resolveConv } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import { deleteMessage, getMessage } from '../core/messages.ts';
import { getUser } from '../core/users.ts';
import type { Ctx } from '../ctx.ts';

/**
 * Reporting messages: anyone who can see a message may flag it once, with a
 * reason; admins see open reports, and dismiss them or remove the message.
 * Admins are told about a new report as it comes in.
 */

const REASONS = ['spam', 'harassment', 'inappropriate', 'other'];

interface ReportRow {
  id: string;
  conversation_id: string;
  ts: string;
  author: string | null;
  reporter: string;
  reason: string;
  excerpt: string;
  status: 'open' | 'dismissed' | 'removed';
  resolved_by: string | null;
  resolved: number | null;
  created: number;
}

function admins(ctx: Ctx): string[] {
  return ctx.db.all<{ id: string }>("SELECT id FROM users WHERE role != 'member' AND deleted = 0 AND is_bot = 0").map((row) => row.id);
}

function reportToApi(ctx: Ctx, row: ReportRow): Record<string, unknown> {
  const conv = getConv(ctx, row.conversation_id);
  return {
    id: row.id,
    channel: row.conversation_id,
    channel_name: conv?.name ?? null,
    ts: row.ts,
    author: row.author,
    reporter: row.reporter,
    reason: row.reason,
    excerpt: row.excerpt,
    status: row.status,
    resolved_by: row.resolved_by,
    resolved: row.resolved,
    created: row.created,
    // Reports from several people about the same message are shown together.
    reports: ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM message_reports WHERE conversation_id = ? AND ts = ?', row.conversation_id, row.ts)!.n,
    message_exists: Boolean(getMessage(ctx, row.conversation_id, row.ts)),
  };
}

export function installModeration(kernel: Kernel): void {
  const { ctx } = kernel;

  kernel.registry.add('client.messages.report', { auth: 'session' }, ({ actor, args }) => {
    const conv = resolveConv(ctx, actor, args.str('channel'));
    const message = getMessage(ctx, conv.id, args.req('ts', 'message_not_found'));
    if (!message || message.subtype === 'tombstone') fail('message_not_found');
    if (message.user_id === actor.userId) fail('cannot_report_own_message');
    const reason = args.str('reason') ?? 'other';
    if (!REASONS.includes(reason)) fail('invalid_reason', { allowed: REASONS });
    const note = (args.str('note') ?? '').trim().slice(0, 500);
    const id = newId('R');
    const inserted = ctx.db.run(
      `INSERT OR IGNORE INTO message_reports (id, conversation_id, ts, author, reporter, reason, excerpt, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      conv.id,
      message.ts,
      message.user_id,
      actor.userId,
      note ? `${reason}: ${note}` : reason,
      (message.text ?? '').slice(0, 1000),
      nowSeconds(),
    ).changes;
    if (inserted) {
      const row = ctx.db.get<ReportRow>('SELECT * FROM message_reports WHERE id = ?', id)!;
      ctx.bus.emit({ event: { type: 'message_reported', report: reportToApi(ctx, row) }, audience: { users: admins(ctx) }, clientOnly: true });
    }
    // Reporting twice is not an error; the first report stands.
    return { reported: true };
  });

  kernel.registry.add('client.admin.reports.list', { auth: 'admin' }, ({ args }) => {
    const status = args.str('status') ?? 'open';
    if (!['open', 'dismissed', 'removed', 'all'].includes(status)) fail('invalid_arguments', { arg: 'status' });
    // One entry per reported message: the earliest report, with the count.
    const rows = ctx.db.all<ReportRow>(
      `SELECT * FROM message_reports r
        WHERE (? = 'all' OR status = ?)
          AND created = (SELECT min(created) FROM message_reports WHERE conversation_id = r.conversation_id AND ts = r.ts AND (? = 'all' OR status = ?))
        GROUP BY conversation_id, ts ORDER BY created DESC LIMIT 200`,
      status,
      status,
      status,
      status,
    );
    return { reports: rows.map((row) => reportToApi(ctx, row)), open: ctx.db.get<{ n: number }>("SELECT count(DISTINCT conversation_id || ts) AS n FROM message_reports WHERE status = 'open'")!.n };
  });

  kernel.registry.add('client.admin.reports.resolve', { auth: 'admin' }, ({ actor, args }) => {
    const report = ctx.db.get<ReportRow>('SELECT * FROM message_reports WHERE id = ?', args.req('report', 'report_not_found'));
    if (!report) fail('report_not_found');
    const action = args.req('action');
    if (action !== 'dismiss' && action !== 'remove') fail('invalid_arguments', { arg: 'action', allowed: ['dismiss', 'remove'] });
    if (action === 'remove') {
      const conv = getConv(ctx, report.conversation_id);
      const message = getMessage(ctx, report.conversation_id, report.ts);
      if (conv && message && message.subtype !== 'tombstone') deleteMessage(ctx, conv, message);
    }
    // Every report about the same message is settled together.
    ctx.db.run(
      "UPDATE message_reports SET status = ?, resolved_by = ?, resolved = ? WHERE conversation_id = ? AND ts = ? AND status = 'open'",
      action === 'remove' ? 'removed' : 'dismissed',
      actor.userId,
      nowSeconds(),
      report.conversation_id,
      report.ts,
    );
    const row = ctx.db.get<ReportRow>('SELECT * FROM message_reports WHERE id = ?', report.id)!;
    ctx.bus.emit({ event: { type: 'message_report_resolved', report: reportToApi(ctx, row) }, audience: { users: admins(ctx) }, clientOnly: true });
    return { report: reportToApi(ctx, row) };
  });

  // Hiding a person: their messages are folded away for you only (a client preference, kept on the server so every device agrees).
  kernel.registry.add('client.users.setHidden', { auth: 'session' }, ({ actor, args }) => {
    const target = getUser(ctx, args.req('user', 'user_not_found'));
    if (!target || target.id === actor.userId) fail('user_not_found');
    const hidden = args.bool('hidden', true);
    const self = getUser(ctx, actor.userId)!;
    let prefs: Record<string, unknown> = {};
    try {
      prefs = JSON.parse(self.prefs) as Record<string, unknown>;
    } catch {
      prefs = {};
    }
    const list = new Set(Array.isArray(prefs.hidden_users) ? (prefs.hidden_users as string[]) : []);
    if (hidden) list.add(target.id);
    else list.delete(target.id);
    prefs.hidden_users = [...list];
    ctx.db.run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify(prefs), self.id);
    // Same shape as client.prefs.set: every device of this person gets the whole preference set.
    ctx.bus.emit({ event: { type: 'pref_change', prefs, name: 'hidden_users', value: prefs.hidden_users }, audience: { users: [self.id] }, clientOnly: true });
    return { hidden_users: prefs.hidden_users };
  });
}
