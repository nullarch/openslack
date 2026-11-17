import type { Kernel } from '../app.ts';
import { fail } from '../core/errors.ts';
import type { Ctx } from '../ctx.ts';

/**
 * Workspace analytics for admins: how many people are active and posting,
 * how much is said where, per day and per channel and person. A person counts
 * as active on a day (UTC) when they were connected, posted or reacted; that
 * is recorded as it happens, once per person per day.
 */

const DAY = 86_400;
const ACTIVE_EVENTS = new Set(['message', 'reaction_added', 'presence_change']);

const dayOf = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

export function installStats(kernel: Kernel): void {
  const { ctx } = kernel;
  const seen = new Set<string>();
  const record = (userId: string, seconds = Math.floor(Date.now() / 1000)): void => {
    const day = dayOf(seconds);
    const key = `${day}:${userId}`;
    if (seen.has(key)) return;
    if (seen.size > 50_000) seen.clear();
    seen.add(key);
    ctx.db.run('INSERT OR IGNORE INTO activity_days (day, user_id) VALUES (?, ?)', day, userId);
  };

  const unsubscribe = ctx.bus.subscribe(({ event }) => {
    if (!ACTIVE_EVENTS.has(event.type)) return;
    if (event.type === 'presence_change' && event.presence !== 'active') return;
    if (event.type === 'message' && (event.subtype || event.bot_id)) return;
    const user = event.user;
    if (typeof user === 'string' && user.startsWith('U')) record(user);
  });
  // People connected across midnight count for the new day too.
  const tick = setInterval(() => {
    if (!ctx.team() || !ctx.instances.isLeader()) return;
    for (const id of ctx.presence.onlineUsers()) record(id);
  }, 3_600_000);
  tick.unref();
  kernel.onClose.push(() => {
    unsubscribe();
    clearInterval(tick);
  });

  kernel.registry.add('client.admin.stats', { auth: 'admin' }, ({ args }) => {
    const days = args.int('days', 30);
    if (![7, 30, 90].includes(days)) fail('invalid_arguments', { arg: 'days', allowed: [7, 30, 90] });
    return workspaceStats(ctx, days);
  });
}

export function workspaceStats(ctx: Ctx, days: number): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const since = now - (days - 1) * DAY;
  const firstDay = dayOf(since);
  const sinceTs = `${String(Math.floor(since / DAY) * DAY).padStart(10, '0')}.000000`;
  const dayList = Array.from({ length: days }, (_, index) => dayOf(since + index * DAY));

  const people = ctx.db.get<{ total: number; joined: number }>(
    "SELECT count(*) AS total, sum(created >= ?) AS joined FROM users WHERE is_bot = 0 AND deleted = 0 AND home = ''",
    Math.floor(since / DAY) * DAY,
  )!;

  // Messages people wrote (not bots, not system lines), by day and kind of conversation.
  const daily = ctx.db.all<{ day: string; kind: string; messages: number; posters: number }>(
    `SELECT date(CAST(substr(m.ts, 1, 10) AS INTEGER), 'unixepoch') AS day,
            CASE WHEN c.kind = 'public' THEN 'public' WHEN c.kind = 'private' THEN 'private' ELSE 'direct' END AS kind,
            count(*) AS messages, count(DISTINCT m.user_id) AS posters
       FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN users u ON u.id = m.user_id
      WHERE m.ts >= ? AND u.is_bot = 0 AND m.subtype IS NULL
      GROUP BY day, kind`,
    sinceTs,
  );
  const postersByDay = new Map(
    ctx.db
      .all<{ day: string; n: number }>(
        `SELECT date(CAST(substr(m.ts, 1, 10) AS INTEGER), 'unixepoch') AS day, count(DISTINCT m.user_id) AS n
           FROM messages m JOIN users u ON u.id = m.user_id
          WHERE m.ts >= ? AND u.is_bot = 0 AND m.subtype IS NULL GROUP BY day`,
        sinceTs,
      )
      .map((row) => [row.day, row.n]),
  );
  const activeByDay = new Map(ctx.db.all<{ day: string; n: number }>('SELECT day, count(*) AS n FROM activity_days WHERE day >= ? GROUP BY day', firstDay).map((row) => [row.day, row.n]));
  const series = dayList.map((day) => {
    const rows = daily.filter((row) => row.day === day);
    const count = (kind: string): number => rows.find((row) => row.kind === kind)?.messages ?? 0;
    return { day, active: activeByDay.get(day) ?? 0, posting: postersByDay.get(day) ?? 0, messages: { public: count('public'), private: count('private'), direct: count('direct') } };
  });

  const active = ctx.db.get<{ n: number }>('SELECT count(DISTINCT user_id) AS n FROM activity_days WHERE day >= ?', firstDay)!.n;
  const weekAgo = dayOf(now - 6 * DAY);
  const weeklyActive = ctx.db.get<{ n: number }>('SELECT count(DISTINCT user_id) AS n FROM activity_days WHERE day >= ?', weekAgo)!.n;

  const channels = ctx.db.all<{ id: string; name: string; kind: string; messages: number; posters: number; last_ts: string; members: number }>(
    `SELECT c.id, c.name, c.kind, count(m.id) AS messages, count(DISTINCT m.user_id) AS posters, c.last_ts,
            (SELECT count(*) FROM members WHERE conversation_id = c.id) AS members
       FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id AND m.ts >= ? AND m.subtype IS NULL AND m.bot_id IS NULL
      WHERE c.kind IN ('public', 'private') AND c.is_archived = 0
      GROUP BY c.id ORDER BY messages DESC, c.name LIMIT 100`,
    sinceTs,
  );

  const members = ctx.db.all<{ id: string; name: string; real_name: string; messages: number; days_active: number; last_active: string | null }>(
    `SELECT u.id, u.name, u.real_name,
            (SELECT count(*) FROM messages m WHERE m.user_id = u.id AND m.ts >= ? AND m.subtype IS NULL) AS messages,
            (SELECT count(*) FROM activity_days a WHERE a.user_id = u.id AND a.day >= ?) AS days_active,
            (SELECT max(day) FROM activity_days a WHERE a.user_id = u.id) AS last_active
       FROM users u WHERE u.is_bot = 0 AND u.deleted = 0 AND u.home = '' ORDER BY messages DESC, u.real_name LIMIT 500`,
    sinceTs,
    firstDay,
  );

  const files = ctx.db.get<{ uploaded: number; bytes: number }>(
    "SELECT sum(created >= ?) AS uploaded, coalesce(sum(size), 0) AS bytes FROM files WHERE state != 'pending'",
    Math.floor(since / DAY) * DAY,
  )!;

  return {
    days,
    since: firstDay,
    summary: {
      members: people.total,
      joined: people.joined ?? 0,
      active,
      weekly_active: weeklyActive,
      messages: series.reduce((sum, day) => sum + day.messages.public + day.messages.private + day.messages.direct, 0),
      public_share: (() => {
        const total = series.reduce((sum, day) => sum + day.messages.public + day.messages.private + day.messages.direct, 0);
        return total ? Math.round((series.reduce((sum, day) => sum + day.messages.public, 0) / total) * 100) : 0;
      })(),
      files_uploaded: files.uploaded ?? 0,
      storage_bytes: files.bytes,
    },
    series,
    channels: channels.map((row) => ({ id: row.id, name: row.name, is_private: row.kind === 'private', messages: row.messages, posters: row.posters, members: row.members, last_ts: row.last_ts })),
    members,
  };
}
