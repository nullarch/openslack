import type { Kernel } from '../app.ts';
import type { Ctx } from '../ctx.ts';
import { canSee, getConv, openDirect, resolveConv, type ConvRow } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import { history, postMessage } from '../core/messages.ts';
import { createUser, getUser, requireUser, uniqueHandle, userToApi } from '../core/users.ts';
import { buildSources, citationsIn, DATA_RULES, type Source } from './context.ts';
import { AiProviderError, type AiProvider } from './provider.ts';
import { loadSettings, requireProvider } from './settings.ts';
import { nextLocalTime, validZone } from './zones.ts';

/**
 * Daily recaps (t157): each person picks channels and a local time; once a
 * day a built-in bot sends them a direct message summarising what was new.
 * The schedule lives in the database, so a restart only delays a recap until
 * the next check.
 */

interface RecapRow {
  user_id: string;
  channels: string;
  local_time: string;
  tz: string;
  next_at: number;
  last_sent: number | null;
  last_ts: string | null;
  created: number;
}

const MAX_CHANNELS = 20;
const MAX_PER_CHANNEL = 150;
const RETRY_AFTER_FAILURE = 15 * 60;

const RECAP_SYSTEM = `You write a short daily recap of team-chat channels for one person.
${DATA_RULES}
For each channel with something worth knowing, write a "### #channel-name" heading followed by two to five bullet points: decisions, questions waiting for answers, requests to people, deadlines, notable news. Skip small talk. Skip channels with nothing worth knowing.
End with nothing else: no greeting, no sign-off.`;

function recapToApi(row: RecapRow | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return {
    channels: JSON.parse(row.channels) as string[],
    time: row.local_time,
    tz: row.tz,
    next_at: row.next_at,
    last_sent: row.last_sent,
  };
}

/** The built-in bot that sends recaps, created the first time it is needed. */
function recapBot(ctx: Ctx): string {
  const team = ctx.requireTeam();
  const prefs = JSON.parse(team.prefs) as { ai_recap_bot?: string };
  if (prefs.ai_recap_bot && getUser(ctx, prefs.ai_recap_bot)) return prefs.ai_recap_bot;
  const bot = createUser(ctx, { realName: 'Recaps', isBot: true, botId: newId('B'), handle: uniqueHandle(ctx, 'recaps') });
  ctx.db.run("UPDATE team SET prefs = json_set(prefs, '$.ai_recap_bot', ?) WHERE id = ?", bot.id, team.id);
  ctx.invalidateTeam();
  ctx.bus.emit({ event: { type: 'team_join', user: userToApi(ctx, bot), event_ts: ctx.clock.eventTs() }, audience: { all: true } });
  return bot.id;
}

/**
 * Build and send one person's recap. Resolves with the newest message it
 * covered, or null when there was nothing new to tell.
 */
export async function sendRecap(ctx: Ctx, provider: AiProvider, row: RecapRow, now: number): Promise<string | null> {
  const oldest = row.last_ts ?? `${String(now - 86_400).padStart(10, '0')}.000000`;
  let newest = oldest;
  const sources: Source[] = [];
  const sections: string[] = [];
  for (const id of JSON.parse(row.channels) as string[]) {
    const conv = getConv(ctx, id);
    // Checked again at send time: someone who left a private channel stops getting it.
    if (!conv || conv.is_archived === 1 || !canSee(ctx, conv, row.user_id)) continue;
    const page = history(ctx, conv, { oldest, latest: '9999999999.999999', limit: MAX_PER_CHANNEL });
    const built = buildSources(ctx, conv, page.rows.slice().reverse(), sources.length + 1);
    if (built.sources.length === 0) continue;
    sources.push(...built.sources);
    sections.push(`#${conv.name ?? conv.id}:\n${built.transcript}`);
    for (const source of built.sources) if (source.ts > newest) newest = source.ts;
  }
  if (sources.length === 0) return null;

  let text = '';
  const outcome = await provider.run(
    { system: RECAP_SYSTEM, prompt: `Messages since the last recap, by channel:\n\n${sections.join('\n\n')}`, maxTokens: 4000, effort: 'medium' },
    (delta) => {
      text += delta;
    },
  );
  if (outcome.stop === 'refusal' || !text.trim()) return null;

  // Citations become links, so the recap leads back to the messages.
  const links = new Map(citationsIn(text, sources).map((citation) => [citation.n, `${ctx.config.publicUrl}${citation.link}`]));
  const body = text.replace(/\[(\d{1,4})\]/g, (all, n: string) => (links.has(Number(n)) ? `[[${n}]](${links.get(Number(n))})` : all));

  const botId = recapBot(ctx);
  const bot = requireUser(ctx, botId);
  const dm = openDirect(ctx, botId, [row.user_id]).conv;
  postMessage(ctx, {
    conv: dm,
    userId: botId,
    botId: bot.bot_id,
    text: `Your daily recap: ${sources.length} new messages`,
    blocks: [{ type: 'markdown', text: `**Your daily recap**\n\n${body.trim()}` }],
  });
  return newest;
}

/** Check for recaps that are due. Runs every interval and once at start. */
async function runDue(ctx: Ctx): Promise<void> {
  const now = nowSeconds();
  const due = ctx.db.all<RecapRow>('SELECT * FROM ai_recaps WHERE next_at <= ? ORDER BY next_at LIMIT 50', now);
  if (due.length === 0) return;
  const settings = loadSettings(ctx);
  for (const row of due) {
    let next = nextLocalTime(row.local_time, row.tz, now);
    let covered: string | null = null;
    if (settings?.features.recaps) {
      try {
        const { provider } = requireProvider(ctx, 'recaps');
        covered = await sendRecap(ctx, provider, row, now);
      } catch (error) {
        if (!(error instanceof AiProviderError)) console.error('[ai] recap failed', error);
        // Try again soon, but never past the next regular time.
        next = Math.min(next, now + RETRY_AFTER_FAILURE);
        ctx.db.run('UPDATE ai_recaps SET next_at = ? WHERE user_id = ?', next, row.user_id);
        continue;
      }
    }
    ctx.db.run(
      'UPDATE ai_recaps SET next_at = ?, last_sent = ?, last_ts = ? WHERE user_id = ?',
      next,
      covered ? now : row.last_sent,
      covered ?? row.last_ts,
      row.user_id,
    );
  }
}

export function installRecaps(kernel: Kernel): void {
  const { ctx, registry } = kernel;

  registry.add('client.ai.recaps.get', { auth: 'session' }, ({ actor }) => ({
    recap: recapToApi(ctx.db.get<RecapRow>('SELECT * FROM ai_recaps WHERE user_id = ?', actor.userId)),
  }));

  registry.add('client.ai.recaps.set', { auth: 'session' }, ({ actor, args }) => {
    const settings = loadSettings(ctx);
    if (!settings) fail('ai_not_configured');
    if (!settings.features.recaps) fail('ai_feature_disabled', { feature: 'recaps' });
    const time = args.req('time');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail('invalid_time');
    const ids = args.list('channels');
    if (ids.length === 0) fail('no_channels');
    if (ids.length > MAX_CHANNELS) fail('too_many_channels', { max: MAX_CHANNELS });
    // Only conversations the person can read; anything else is "not found".
    const channels = [...new Set(ids.map((id) => resolveConv(ctx, actor, id)).map((conv: ConvRow) => conv.id))];
    const user = requireUser(ctx, actor.userId);
    const tz = args.str('tz') && validZone(args.str('tz')!) ? args.str('tz')! : user.tz;
    const now = nowSeconds();
    ctx.db.run(
      `INSERT INTO ai_recaps (user_id, channels, local_time, tz, next_at, last_sent, last_ts, created) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT (user_id) DO UPDATE SET channels = excluded.channels, local_time = excluded.local_time, tz = excluded.tz,
         next_at = excluded.next_at`,
      actor.userId,
      JSON.stringify(channels),
      time,
      tz,
      nextLocalTime(time, tz, now),
      now,
    );
    return { recap: recapToApi(ctx.db.get<RecapRow>('SELECT * FROM ai_recaps WHERE user_id = ?', actor.userId)) };
  });

  registry.add('client.ai.recaps.delete', { auth: 'session' }, ({ actor }) => {
    ctx.db.run('DELETE FROM ai_recaps WHERE user_id = ?', actor.userId);
  });

  /** Send the recap now instead of waiting for the scheduled time (a preview). */
  registry.add('client.ai.recaps.sendNow', { auth: 'session' }, async ({ actor }) => {
    const row = ctx.db.get<RecapRow>('SELECT * FROM ai_recaps WHERE user_id = ?', actor.userId);
    if (!row) fail('no_recap');
    const { provider } = requireProvider(ctx, 'recaps');
    const now = nowSeconds();
    let covered: string | null;
    try {
      covered = await sendRecap(ctx, provider, row, now);
    } catch (error) {
      if (error instanceof AiProviderError) fail('ai_provider_error', { detail: error.reason });
      throw error;
    }
    if (covered) ctx.db.run('UPDATE ai_recaps SET last_sent = ?, last_ts = ? WHERE user_id = ?', now, covered, actor.userId);
    return { sent: covered !== null };
  });

  const interval = Number(process.env.AI_RECAP_INTERVAL_MS ?? 60_000);
  let busy = false;
  const tick = (): void => {
    if (busy || !ctx.team()) return;
    busy = true;
    void runDue(ctx)
      .catch((error) => console.error('[ai] recap check failed', error))
      .finally(() => {
        busy = false;
      });
  };
  const timer = setInterval(tick, interval);
  timer.unref();
  const first = setTimeout(tick, Math.min(interval, 1000));
  first.unref();
  kernel.onClose.push(() => {
    clearInterval(timer);
    clearTimeout(first);
  });
}

