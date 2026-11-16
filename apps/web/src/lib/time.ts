import { S } from '../strings';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const dayYearFormat = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
const shortDayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' });

export function tsDate(ts: string): Date {
  return new Date(Number(ts) * 1000);
}

/** `9:41 AM` */
export function clock(ts: string): string {
  return timeFormat.format(tsDate(ts));
}

export function fullDateTime(ts: string): string {
  return fullFormat.format(tsDate(ts));
}

/** A stable key for the calendar day a message falls on, in the viewer's time zone. */
export function dayKey(ts: string): string {
  const date = tsDate(ts);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function daysAgo(date: Date): number {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const that = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((start - that) / 86_400_000);
}

/** `Today`, `Yesterday`, `Monday, November 16` or `November 16, 2024`. */
export function dayLabel(ts: string): string {
  const date = tsDate(ts);
  const ago = daysAgo(date);
  if (ago === 0) return S.time.today;
  if (ago === 1) return S.time.yesterday;
  if (date.getFullYear() === new Date().getFullYear()) return dayFormat.format(date);
  return dayYearFormat.format(date);
}

/** Compact stamp for lists: the time today, otherwise the date. */
export function shortStamp(ts: string): string {
  const date = tsDate(ts);
  const ago = daysAgo(date);
  if (ago === 0) return timeFormat.format(date);
  if (ago === 1) return `${S.time.yesterday} ${timeFormat.format(date)}`;
  return `${shortDayFormat.format(date)}, ${timeFormat.format(date)}`;
}

/** `2 minutes ago`, `3 hours ago`, `yesterday`, or a date. */
export function relative(ts: string): string {
  const seconds = Math.max(0, (Date.now() - tsDate(ts).getTime()) / 1000);
  if (seconds < 60) return S.time.justNow;
  if (seconds < 3600) return S.time.minutesAgo(Math.floor(seconds / 60));
  if (seconds < 86_400) return S.time.hoursAgo(Math.floor(seconds / 3600));
  const days = Math.floor(seconds / 86_400);
  if (days < 7) return S.time.daysAgo(days);
  return shortDayFormat.format(tsDate(ts));
}

/** The current time in a time zone, e.g. `4:12 PM`. */
export function localTime(tz: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date());
  } catch {
    return '';
  }
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
