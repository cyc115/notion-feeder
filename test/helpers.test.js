import test from 'node:test';
import assert from 'node:assert/strict';
import timeDifference from '../src/helpers.js';

// date1/date2 are unix timestamps in seconds, matching how feed.js calls this:
// new Date().getTime() / 1000.

test('timeDifference computes whole-day differences', () => {
  const now = 1_700_000_000;
  const oneDayAgo = now - 86400;
  const { diffInDays } = timeDifference(now, oneDayAgo);
  assert.equal(diffInDays, 1);
});

test('timeDifference computes sub-day differences as 0 days', () => {
  const now = 1_700_000_000;
  const twoHoursAgo = now - 2 * 3600;
  const { diffInDays, diffInHours } = timeDifference(now, twoHoursAgo);
  assert.equal(diffInDays, 0);
  assert.equal(diffInHours, 2);
});

test('timeDifference handles date2 in the future as a negative difference', () => {
  const now = 1_700_000_000;
  const inTheFuture = now + 3600;
  const { diffInDays, diffInHours } = timeDifference(now, inTheFuture);
  assert.ok(diffInDays <= 0);
  assert.ok(diffInHours < 0);
});

test('timeDifference returns the inputs alongside the computed diffs', () => {
  const result = timeDifference(100, 40);
  assert.equal(result.date1, 100);
  assert.equal(result.date2, 40);
  assert.equal(result.diffInSeconds, 60);
});
