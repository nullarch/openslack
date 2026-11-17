/**
 * Wall-clock time in a named time zone, and the English time phrases Slack's
 * `/remind` and `reminders.add` accept ("in 15 minutes", "tomorrow at 9am",
 * "every weekday at 9:30"). Shared by the server and the web client so both
 * read a phrase the same way.
 */

export interface ZonedParts {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let format = formatters.get(tz);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        weekday: 'short',
      });
    } catch {
      format = formatter('UTC');
    }
    formatters.set(tz, format);
  }
  return format;
}

const WEEKDAY_SHORT: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The calendar date and clock time at `epochMs` as seen in `tz`. */
export function zonedParts(epochMs: number, tz: string): ZonedParts {
  const out: ZonedParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0, weekday: 0 };
  for (const part of formatter(tz).formatToParts(new Date(epochMs))) {
    if (part.type === 'year') out.year = Number(part.value);
    else if (part.type === 'month') out.month = Number(part.value);
    else if (part.type === 'day') out.day = Number(part.value);
    else if (part.type === 'hour') out.hour = Number(part.value) % 24;
    else if (part.type === 'minute') out.minute = Number(part.value);
    else if (part.type === 'second') out.second = Number(part.value);
    else if (part.type === 'weekday') out.weekday = WEEKDAY_SHORT[part.value] ?? 0;
  }
  return out;
}

function offsetAt(epochMs: number, tz: string): number {
  const p = zonedParts(epochMs, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(epochMs / 1000) * 1000;
}

export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

/** The instant at which the clock in `tz` shows the given date and time. */
export function zonedToEpoch(date: LocalDate, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const first = guess - offsetAt(guess, tz);
  const second = guess - offsetAt(first, tz);
  return second;
}

/** Move a calendar date by whole days (or months), normalising overflow. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function addMonths(date: LocalDate, months: number, anchorDay: number): LocalDate {
  const first = new Date(Date.UTC(date.year, date.month - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return { year: first.getUTCFullYear(), month: first.getUTCMonth() + 1, day: Math.min(anchorDay, last) };
}

function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

// ── Recurrence ──────────────────────────────────────────────────────────────

export const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
export type WeekdayName = (typeof WEEKDAY_NAMES)[number];

/** Slack's recurrence shape, plus the time of day it fires at (local to the person). */
export interface Recurrence {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  weekdays?: WeekdayName[];
  hour: number;
  minute: number;
  /** Day of month (monthly, yearly) and month (yearly) the series is anchored to. */
  day?: number;
  month?: number;
}

/** The first occurrence of `rule` strictly after `afterMs`. */
export function nextOccurrence(rule: Recurrence, afterMs: number, tz: string): number {
  const today = zonedParts(afterMs, tz);
  let date: LocalDate = { year: today.year, month: today.month, day: today.day };
  for (let step = 0; step < 400 * 31; step += 1) {
    let candidate: LocalDate | null = null;
    if (rule.frequency === 'daily') candidate = date;
    else if (rule.frequency === 'weekly') {
      const days = (rule.weekdays?.length ? rule.weekdays : [WEEKDAY_NAMES[today.weekday]!]).map((name) => WEEKDAY_NAMES.indexOf(name));
      if (days.includes(weekdayOf(date))) candidate = date;
    } else if (rule.frequency === 'monthly') {
      const anchor = rule.day ?? today.day;
      const target = addMonths({ ...date, day: 1 }, 0, anchor);
      if (target.day === date.day) candidate = date;
    } else {
      const anchorMonth = rule.month ?? today.month;
      const anchorDay = rule.day ?? today.day;
      if (date.month === anchorMonth) {
        const target = addMonths({ ...date, day: 1 }, 0, anchorDay);
        if (target.day === date.day) candidate = date;
      }
    }
    if (candidate) {
      const at = zonedToEpoch(candidate, rule.hour, rule.minute, tz);
      if (at > afterMs) return at;
    }
    date = addDays(date, 1);
  }
  return afterMs + 86_400_000;
}

/** A short description such as "every weekday at 9:00 AM". */
export function describeRecurrence(rule: Recurrence): string {
  const time = clockText(rule.hour, rule.minute);
  if (rule.frequency === 'daily') return `every day at ${time}`;
  if (rule.frequency === 'monthly') return `every month at ${time}`;
  if (rule.frequency === 'yearly') return `every year at ${time}`;
  const days = rule.weekdays ?? [];
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
  if (days.length === 5 && weekdays.every((day) => days.includes(day as WeekdayName))) return `every weekday at ${time}`;
  const names = days.map((day) => day[0]!.toUpperCase() + day.slice(1));
  return `every ${names.join(', ')} at ${time}`;
}

export function clockText(hour: number, minute: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minute).padStart(2, '0')} ${suffix}`;
}

// ── Phrases ─────────────────────────────────────────────────────────────────

export interface When {
  /** The first time it happens, in milliseconds. */
  time: number;
  recurrence?: Recurrence;
}

const DEFAULT_HOUR = 9;

const UNIT_MS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
};
const UNIT_ALIASES: Record<string, string> = {
  sec: 'second',
  secs: 'second',
  second: 'second',
  seconds: 'second',
  min: 'minute',
  mins: 'minute',
  minute: 'minute',
  minutes: 'minute',
  hr: 'hour',
  hrs: 'hour',
  hour: 'hour',
  hours: 'hour',
  day: 'day',
  days: 'day',
  week: 'week',
  weeks: 'week',
  month: 'month',
  months: 'month',
  year: 'year',
  years: 'year',
};
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, fifteen: 15, twenty: 20, thirty: 30 };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function monthIndex(word: string): number {
  const lower = word.toLowerCase();
  if (lower.length < 3) return -1;
  return MONTHS.findIndex((month) => month.startsWith(lower));
}

function weekdayIndex(word: string): number {
  const lower = word.toLowerCase().replace(/s$/, '');
  if (lower.length < 3) return -1;
  return WEEKDAY_NAMES.findIndex((day) => day.startsWith(lower) && (lower.length >= 3 || day === lower));
}

const TIME_RE = String.raw`(noon|midnight|morning|afternoon|evening|night|(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?)`;

/** Parse a clock time ("3pm", "15:30", "noon"); null when it is not one. */
function parseClock(text: string): { hour: number; minute: number } | null {
  const match = new RegExp(`^${TIME_RE}$`).exec(text.trim());
  if (!match) return null;
  const word = match[1]!;
  if (word === 'noon') return { hour: 12, minute: 0 };
  if (word === 'midnight') return { hour: 0, minute: 0 };
  if (word === 'morning') return { hour: 9, minute: 0 };
  if (word === 'afternoon') return { hour: 14, minute: 0 };
  if (word === 'evening') return { hour: 18, minute: 0 };
  if (word === 'night') return { hour: 20, minute: 0 };
  let hour = Number(match[2]);
  const minute = match[3] ? Number(match[3]) : 0;
  const meridiem = match[4]?.replace(/\./g, '');
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute };
}

/** Split a trailing "at 3pm" / "3pm" / "in the morning" from a phrase. */
function splitClock(text: string): { rest: string; clock: { hour: number; minute: number } | null } | null {
  const match = new RegExp(String.raw`^(.*?)(?:\s+(?:at\s+|in the\s+)?${TIME_RE})?$`).exec(text);
  if (!match) return null;
  const rest = match[1]!.trim();
  const clockText = text.slice(match[1]!.length).trim().replace(/^(at|in the)\s+/, '');
  if (!clockText) return { rest, clock: null };
  const clock = parseClock(clockText);
  if (!clock) return null;
  return { rest, clock };
}

function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[.!]+$/, '')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRecurring(text: string, now: number, tz: string): When | null {
  const match = /^(?:every|each) (.+)$/.exec(text) ?? (/^(daily|weekly|monthly|yearly)(?: (.+))?$/.exec(text) ? ['', text] : null);
  if (!match) return null;
  const split = splitClock(match[1]!);
  if (!split) return null;
  const clock = split.clock ?? { hour: DEFAULT_HOUR, minute: 0 };
  const today = zonedParts(now, tz);
  const what = split.rest;
  let rule: Recurrence | null = null;
  if (what === 'day' || what === 'daily' || what === 'morning' || what === '') {
    rule = { frequency: 'daily', ...clock };
    if (what === 'morning' && !split.clock) rule.hour = 9;
  } else if (what === 'weekday' || what === 'weekdays') {
    rule = { frequency: 'weekly', weekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], ...clock };
  } else if (what === 'week' || what === 'weekly') {
    rule = { frequency: 'weekly', weekdays: [WEEKDAY_NAMES[today.weekday]!], ...clock };
  } else if (what === 'month' || what === 'monthly') {
    rule = { frequency: 'monthly', day: today.day, ...clock };
  } else if (what === 'year' || what === 'yearly') {
    rule = { frequency: 'yearly', day: today.day, month: today.month, ...clock };
  } else {
    const words = what.split(/ |\band\b/).filter((word) => word && word !== 'and');
    const days = words.map(weekdayIndex);
    if (days.length === 0 || days.some((day) => day < 0)) return null;
    rule = { frequency: 'weekly', weekdays: [...new Set(days)].sort().map((day) => WEEKDAY_NAMES[day]!), ...clock };
  }
  return { time: nextOccurrence(rule, now, tz), recurrence: rule };
}

function parseDate(text: string, now: number, tz: string): LocalDate | null {
  const today = zonedParts(now, tz);
  const base: LocalDate = { year: today.year, month: today.month, day: today.day };
  if (text === 'today' || text === 'tonight' || text === '') return base;
  if (text === 'tomorrow' || text === 'tmrw') return addDays(base, 1);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  const weekday = /^(?:on |next |this )?([a-z]+)$/.exec(text);
  if (weekday) {
    const index = weekdayIndex(weekday[1]!);
    if (index >= 0) {
      let delta = (index - today.weekday + 7) % 7;
      if (text.startsWith('next ') && delta === 0) delta = 7;
      return addDays(base, delta);
    }
  }
  const monthDay = /^(?:on )?([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(text) ?? /^(?:on )?(?:the )?(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]+)(?: (\d{4}))?$/.exec(text);
  if (monthDay) {
    const [monthWord, dayText] = /^\d/.test(monthDay[1]!) ? [monthDay[2]!, monthDay[1]!] : [monthDay[1]!, monthDay[2]!];
    const month = monthIndex(monthWord);
    const day = Number(dayText);
    if (month < 0 || day < 1 || day > 31) return null;
    const explicitYear = monthDay[3] ? Number(monthDay[3]) : null;
    let date: LocalDate = { year: explicitYear ?? today.year, month: month + 1, day };
    // A date already gone this year means next year.
    if (!explicitYear && (date.month < today.month || (date.month === today.month && date.day < today.day))) date = { ...date, year: date.year + 1 };
    return date;
  }
  return null;
}

/**
 * Parse a whole time phrase. Returns null when the phrase is not entirely a
 * time expression, so callers can search for one inside longer text.
 */
export function parseWhen(input: string, now: number, tz: string): When | null {
  const text = normalize(input);
  if (!text) return null;

  const relative = /^in (?:(half an?|\d+(?:\.\d+)?|[a-z]+) )?([a-z]+)$/.exec(text);
  if (relative) {
    const unit = UNIT_ALIASES[relative[2]!];
    if (!unit) return null;
    let amount: number;
    const word = relative[1];
    if (word === undefined) amount = 1;
    else if (word.startsWith('half')) amount = 0.5;
    else if (/^\d/.test(word)) amount = Number(word);
    else if (NUMBER_WORDS[word] !== undefined) amount = NUMBER_WORDS[word]!;
    else return null;
    if (!(amount > 0)) return null;
    if (unit === 'month' || unit === 'year') {
      const parts = zonedParts(now, tz);
      const months = Math.round(amount * (unit === 'year' ? 12 : 1));
      const date = addMonths({ year: parts.year, month: parts.month, day: 1 }, months, parts.day);
      return { time: zonedToEpoch(date, parts.hour, parts.minute, tz) };
    }
    return { time: now + Math.round(amount * UNIT_MS[unit]!) };
  }

  const recurring = parseRecurring(text, now, tz);
  if (recurring) return recurring;

  // A bare clock time ("3pm", "at 15:30") means the next time the clock shows it.
  const bare = parseClock(text.replace(/^at /, ''));
  if (bare && !/^\d{1,2}$/.test(text)) {
    const parts = zonedParts(now, tz);
    const today: LocalDate = { year: parts.year, month: parts.month, day: parts.day };
    let time = zonedToEpoch(today, bare.hour, bare.minute, tz);
    if (time <= now) time = zonedToEpoch(addDays(today, 1), bare.hour, bare.minute, tz);
    return { time };
  }

  const split = splitClock(text);
  if (!split) return null;
  const rest = split.rest.replace(/^at$/, '');
  const date = parseDate(rest, now, tz);
  if (!date) return null;
  // A bare date means 9 in the morning; "tonight" means 8 in the evening.
  const clock = split.clock ?? (rest === 'tonight' ? { hour: 20, minute: 0 } : rest === '' ? null : { hour: DEFAULT_HOUR, minute: 0 });
  if (!clock) return null;
  let time = zonedToEpoch(date, clock.hour, clock.minute, tz);
  if (time <= now) {
    // "at 3pm" after 3pm means tomorrow; an explicit past date stays in the past (and is rejected by callers).
    if (rest === '' || rest === 'today') time = zonedToEpoch(addDays(date, 1), clock.hour, clock.minute, tz);
  }
  return { time };
}

export interface ReminderParts {
  /** What to be reminded of. */
  what: string;
  /** The time phrase that was recognised. */
  when: string;
  parsed: When;
}

function stripWhat(text: string): string {
  return text
    .trim()
    .replace(/^to\s+/i, '')
    .replace(/^"(.*)"$/s, '$1')
    .replace(/^“(.*)”$/s, '$1')
    .replace(/\s+(?:to|at|on)$/i, '')
    .trim();
}

/**
 * Split "drink water at 3pm", "in 10 minutes to stand up" or
 * "\"Standup\" every weekday at 9am" into what and when.
 */
export function splitReminder(input: string, now: number, tz: string): ReminderParts | null {
  const words = input.trim().split(/\s+/).filter(Boolean);
  // Prefer the longest time phrase at the end, then the longest at the start.
  for (let start = 1; start < words.length; start += 1) {
    const when = words.slice(start).join(' ');
    const parsed = parseWhen(when, now, tz);
    if (parsed) {
      const what = stripWhat(words.slice(0, start).join(' '));
      if (what) return { what, when, parsed };
    }
  }
  for (let end = words.length - 1; end >= 1; end -= 1) {
    const when = words.slice(0, end).join(' ');
    const parsed = parseWhen(when, now, tz);
    if (parsed) {
      const what = stripWhat(words.slice(end).join(' '));
      if (what) return { what, when, parsed };
    }
  }
  return null;
}
