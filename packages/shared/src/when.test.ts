import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { nextOccurrence, parseWhen, splitReminder, zonedParts, zonedToEpoch } from './when.ts';

// Wednesday 2026-11-18, 14:30 in Seoul (05:30 UTC).
const SEOUL = 'Asia/Seoul';
const NOW = Date.UTC(2026, 10, 18, 5, 30);
const local = (ms: number, tz = SEOUL): string => {
  const p = zonedParts(ms, tz);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
};
const at = (phrase: string, tz = SEOUL, now = NOW): string | null => {
  const parsed = parseWhen(phrase, now, tz);
  return parsed ? local(parsed.time, tz) : null;
};

describe('zoned time', () => {
  test('converts both ways, including across a daylight-saving change', () => {
    assert.equal(local(NOW), '2026-11-18 14:30');
    assert.equal(zonedToEpoch({ year: 2026, month: 11, day: 18 }, 14, 30, SEOUL), NOW);
    // New York leaves daylight saving on 2026-11-01: 9:00 is 13:00 UTC before, 14:00 UTC after.
    assert.equal(new Date(zonedToEpoch({ year: 2026, month: 10, day: 31 }, 9, 0, 'America/New_York')).getUTCHours(), 13);
    assert.equal(new Date(zonedToEpoch({ year: 2026, month: 11, day: 2 }, 9, 0, 'America/New_York')).getUTCHours(), 14);
  });
});

describe('parseWhen', () => {
  test('relative times', () => {
    assert.equal(parseWhen('in 15 minutes', NOW, SEOUL)?.time, NOW + 15 * 60_000);
    assert.equal(parseWhen('in an hour', NOW, SEOUL)?.time, NOW + 3_600_000);
    assert.equal(parseWhen('in half an hour', NOW, SEOUL)?.time, NOW + 1_800_000);
    assert.equal(parseWhen('in 2 days', NOW, SEOUL)?.time, NOW + 2 * 86_400_000);
    assert.equal(at('in 1 month'), '2026-12-18 14:30');
  });

  test('clock times roll over to tomorrow once passed', () => {
    assert.equal(at('at 3pm'), '2026-11-18 15:00');
    assert.equal(at('3:45 pm'), '2026-11-18 15:45');
    assert.equal(at('at 9am'), '2026-11-19 09:00');
    assert.equal(at('at 14:00'), '2026-11-19 14:00');
    assert.equal(at('noon'), '2026-11-19 12:00');
  });

  test('days and dates', () => {
    assert.equal(at('tomorrow'), '2026-11-19 09:00');
    assert.equal(at('tomorrow at 10:30am'), '2026-11-19 10:30');
    assert.equal(at('tomorrow morning'), '2026-11-19 09:00');
    assert.equal(at('tonight'), '2026-11-18 20:00');
    assert.equal(at('on friday'), '2026-11-20 09:00');
    assert.equal(at('next wednesday at 5pm'), '2026-11-25 17:00');
    assert.equal(at('monday at 8:15'), '2026-11-23 08:15');
    assert.equal(at('November 25 at 5pm'), '2026-11-25 17:00');
    assert.equal(at('on the 2nd of january'), '2027-01-02 09:00');
    assert.equal(at('2026-12-01'), '2026-12-01 09:00');
  });

  test('recurring phrases', () => {
    const weekdays = parseWhen('every weekday at 9am', NOW, SEOUL);
    assert.deepEqual(weekdays?.recurrence?.weekdays, ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']);
    assert.equal(local(weekdays!.time), '2026-11-19 09:00');
    const twice = parseWhen('every Monday and Thursday at 10:00', NOW, SEOUL);
    assert.deepEqual(twice?.recurrence?.weekdays, ['monday', 'thursday']);
    assert.equal(local(twice!.time), '2026-11-19 10:00');
    assert.equal(parseWhen('every day', NOW, SEOUL)?.recurrence?.frequency, 'daily');
    const next = nextOccurrence(weekdays!.recurrence!, Date.UTC(2026, 10, 20, 1, 0), SEOUL);
    assert.equal(local(next), '2026-11-23 09:00');
  });

  test('anything that is not entirely a time phrase is rejected', () => {
    for (const phrase of ['drink water', 'at the office', '3', 'in a bit', 'every so often', 'on mars', '']) {
      assert.equal(parseWhen(phrase, NOW, SEOUL), null, phrase);
    }
  });
});

describe('splitReminder', () => {
  test('finds the time phrase at the end or the start', () => {
    const one = splitReminder('to drink water at 3pm', NOW, SEOUL);
    assert.equal(one?.what, 'drink water');
    assert.equal(one?.when, 'at 3pm');
    const two = splitReminder('in 10 minutes to stand up', NOW, SEOUL);
    assert.equal(two?.what, 'stand up');
    assert.equal(two?.parsed.time, NOW + 600_000);
    const three = splitReminder('"Standup" every weekday at 9am', NOW, SEOUL);
    assert.equal(three?.what, 'Standup');
    assert.equal(three?.parsed.recurrence?.frequency, 'weekly');
    assert.equal(splitReminder('review the PR tomorrow at 10am', NOW, SEOUL)?.what, 'review the PR');
    assert.equal(splitReminder('nothing about time here', NOW, SEOUL), null);
  });
});
