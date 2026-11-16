import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Clock } from '../src/core/clock.ts';
import { Db } from '../src/db/db.ts';

test('timestamps never repeat or go backwards, across conversations and other events', () => {
  const db = new Db(':memory:');
  const clock = new Clock(db);
  let previous = '';
  let issued = 0;
  // Long enough to cross many millisecond boundaries, where a stamp built from two clocks slips.
  const until = Date.now() + 40;
  while (Date.now() < until) {
    for (const ts of [clock.eventTs(), clock.next('C1'), clock.eventTs(), clock.next('C2')]) {
      assert.ok(ts > previous, `${ts} was issued after ${previous}`);
      previous = ts;
      issued += 1;
    }
  }
  assert.ok(issued > 1000);
  assert.match(previous, /^\d{10}\.\d{6}$/);
  db.close();
});

test('a conversation keeps issuing above a timestamp it was told about', () => {
  const db = new Db(':memory:');
  const clock = new Clock(db);
  const future = `${Math.floor(Date.now() / 1000) + 3600}.000100`;
  clock.observe('C1', future);
  assert.ok(clock.next('C1') > future);
  // Other conversations are not dragged into the future with it.
  assert.ok(clock.next('C2') < future);
  db.close();
});
