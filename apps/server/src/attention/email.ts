import type { Kernel } from '../app.ts';
import { mailEnabled, sendMail } from '../core/mail.ts';
import { getUser, type UserRow } from '../core/users.ts';
import type { Ctx } from '../ctx.ts';

/**
 * Email about what someone missed: mentions and direct messages they have not
 * read, while they are away. At most once every 15 minutes (the default) or
 * once an hour, per the person's `email_notifications` preference ('15m',
 * '1h' or 'off'); never about the same message twice; only messages at least
 * two minutes old (time to read them on another device) and at most a week.
 * Needs SMTP_URL.
 */

const GRACE = 120;
const LOOKBACK = 7 * 86_400;
const INTERVAL: Record<string, number> = { '15m': 15 * 60, '1h': 3600 };
const MAX_LISTED = 10;

interface Missed {
  conversation_id: string;
  ts: string;
  thread_ts: string | null;
  user_id: string | null;
  plain: string;
  kind: string;
  name: string | null;
}

const tsOf = (seconds: number): string => `${String(seconds).padStart(10, '0')}.000000`;

export function emailPreference(user: UserRow): '15m' | '1h' | 'off' {
  try {
    const value = (JSON.parse(user.prefs) as { email_notifications?: unknown }).email_notifications;
    return value === '1h' || value === 'off' ? value : '15m';
  } catch {
    return '15m';
  }
}

/** Unread mentions and direct messages for one person, oldest first. */
export function missedFor(ctx: Ctx, userId: string, since: string, until: string): Missed[] {
  const unreadInThread = `(m.thread_ts IS NULL OR m.thread_ts = m.ts OR m.ts > coalesce((SELECT last_read FROM thread_subs t WHERE t.conversation_id = m.conversation_id AND t.thread_ts = m.thread_ts AND t.user_id = mb.user_id), '0'))`;
  return ctx.db.all<Missed>(
    `SELECT m.conversation_id, m.ts, m.thread_ts, m.user_id, m.plain, c.kind, c.name
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN members mb ON mb.conversation_id = m.conversation_id AND mb.user_id = ?
      WHERE m.ts > ? AND m.ts <= ? AND m.ts > mb.last_read AND mb.is_muted = 0
        AND m.subtype IS NULL AND (m.user_id IS NULL OR m.user_id != mb.user_id)
        AND ${unreadInThread}
        AND (c.kind IN ('im', 'mpim')
             OR EXISTS (SELECT 1 FROM mentions x WHERE x.conversation_id = m.conversation_id AND x.ts = m.ts AND x.user_id = mb.user_id))
      ORDER BY m.ts
      LIMIT 200`,
    userId,
    since,
    until,
  );
}

function render(ctx: Ctx, user: UserRow, missed: Missed[]): { subject: string; text: string; url: string } {
  const team = ctx.requireTeam();
  const base = ctx.config.publicUrl;
  const mentions = missed.filter((item) => item.kind !== 'im' && item.kind !== 'mpim').length;
  const direct = missed.length - mentions;
  const parts = [mentions ? `${mentions} mention${mentions === 1 ? '' : 's'}` : '', direct ? `${direct} direct message${direct === 1 ? '' : 's'}` : ''].filter(Boolean);
  const subject = `${parts.join(' and ')} in ${team.name}`;
  const lines = missed.slice(-MAX_LISTED).map((item) => {
    const author = item.user_id ? getUser(ctx, item.user_id) : undefined;
    const who = author ? author.real_name || author.display_name || author.name : 'Someone';
    const where = item.kind === 'im' ? 'in a direct message' : item.kind === 'mpim' ? 'in a group message' : `in #${item.name ?? 'a channel'}`;
    const text = item.plain.replace(/\s+/g, ' ').trim();
    const link = `${base}/archives/${item.conversation_id}/p${item.ts.replace('.', '')}`;
    return `${who} ${where}${item.thread_ts && item.thread_ts !== item.ts ? ' (in a thread)' : ''}:\n${text.length > 240 ? `${text.slice(0, 239)}…` : text || '(no text)'}\n${link}`;
  });
  const more = missed.length > MAX_LISTED ? `\n\n…and ${missed.length - MAX_LISTED} more.` : '';
  const text = `Hi ${user.real_name || user.name}, while you were away:\n\n${lines.join('\n\n')}${more}\n\nYou get these because you were not online. Change how often in Preferences → Notifications.`;
  return { subject, text, url: base || '/' };
}

/** One pass over everyone; returns how many emails went out. */
export async function sendEmailDigests(ctx: Ctx, now = Math.floor(Date.now() / 1000)): Promise<number> {
  if (!mailEnabled(ctx) || !ctx.team()) return 0;
  let sent = 0;
  const people = ctx.db.all<UserRow>("SELECT * FROM users WHERE is_bot = 0 AND deleted = 0 AND email IS NOT NULL AND email != ''");
  for (const user of people) {
    const preference = emailPreference(user);
    if (preference === 'off') continue;
    if (ctx.presence.isOnline(user.id)) continue;
    const state = ctx.db.get<{ last_sent: number; watermark: string }>('SELECT last_sent, watermark FROM email_digests WHERE user_id = ?', user.id);
    if (state && now - state.last_sent < INTERVAL[preference]!) continue;
    const floor = tsOf(now - LOOKBACK);
    const since = state && state.watermark > floor ? state.watermark : floor;
    const missed = missedFor(ctx, user.id, since, tsOf(now - GRACE));
    if (missed.length === 0) continue;
    const mail = render(ctx, user, missed);
    try {
      await sendMail(ctx, { to: user.email!, subject: mail.subject, text: mail.text, action: { label: `Open ${ctx.requireTeam().name}`, url: mail.url } });
    } catch {
      continue; // tried again on the next pass
    }
    ctx.db.run(
      `INSERT INTO email_digests (user_id, last_sent, watermark) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET last_sent = excluded.last_sent, watermark = excluded.watermark`,
      user.id,
      now,
      missed.at(-1)!.ts,
    );
    sent += 1;
  }
  return sent;
}

export function installEmailNotifications(kernel: Kernel): void {
  const { ctx } = kernel;
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    running ??= sendEmailDigests(ctx)
      .catch((error: unknown) => console.error('[email-digest]', error))
      .finally(() => {
        running = null;
      });
  }, 60_000);
  timer.unref();
  kernel.onClose.push(async () => {
    clearInterval(timer);
    await running;
  });
}
