/** Time-zone arithmetic with nothing but `Intl`. */

/** Seconds east of UTC that `tz` is at the instant `at` (seconds). */
export function offsetSeconds(tz: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date(at * 1000));
  const text = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(text);
  if (!match) return 0;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 3600 + Number(match[3] ?? 0) * 60);
}

/** The local calendar date in `tz` at instant `at`. */
function localDate(tz: string, at: number): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(at * 1000));
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day') };
}

/** The instant (seconds) when the wall clock in `tz` shows the given local date and time. */
export function zonedInstant(tz: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  const first = guess - offsetSeconds(tz, guess);
  const second = guess - offsetSeconds(tz, first);
  return second;
}

/** The first instant after `after` when the clock in `tz` reads `hh:mm`. */
export function nextLocalTime(localTime: string, tz: string, after: number): number {
  const [hour = 0, minute = 0] = localTime.split(':').map(Number);
  for (let days = 0; days <= 2; days += 1) {
    const date = localDate(tz, after + days * 86_400);
    const candidate = zonedInstant(tz, date.year, date.month, date.day, hour, minute);
    if (candidate > after) return candidate;
  }
  return after + 86_400;
}

/** Midnight today in `tz`, as seconds. */
export function startOfToday(tz: string, now: number): number {
  const date = localDate(tz, now);
  return zonedInstant(tz, date.year, date.month, date.day, 0, 0);
}

export function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
