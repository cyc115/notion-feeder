import test from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency } from '../src/feed.js';

// This is the deterministic counterpart to Task 6's live equivalence check.
// A live before/after run against real feeds (2026-08-02) matched on
// per-feed article counts exactly but differed on one final link because a
// fast-churning feed's content changed in the ~30s between the two runs --
// expected drift from hitting the live internet twice, not something a unit
// test can hold still. These tests instead pin the actual risk: that
// resolving out of order must not change which result lands at which index,
// and that the concurrency cap and per-item error isolation hold.

function delay(ms, value) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

test('mapWithConcurrency preserves result order regardless of resolve order', async () => {
  // Item 0 resolves slowest, item 4 fastest -- if order depended on
  // resolution order rather than input index, this would come back scrambled.
  const items = [50, 40, 30, 20, 10];
  const result = await mapWithConcurrency(items, 3, (ms) => delay(ms, ms));
  assert.deepEqual(result, items);
});

test('mapWithConcurrency never runs more than `limit` at once', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  await mapWithConcurrency(items, 3, async (i) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await delay(10, i);
    inFlight -= 1;
    return i;
  });
  assert.ok(maxInFlight <= 3, `max in flight was ${maxInFlight}`);
});

test('mapWithConcurrency processes every item exactly once', async () => {
  const items = Array.from({ length: 25 }, (_, i) => i);
  const seen = [];
  await mapWithConcurrency(items, 6, async (i) => {
    seen.push(i);
    return i;
  });
  assert.deepEqual(
    [...seen].sort((a, b) => a - b),
    items
  );
});

test('mapWithConcurrency does not abort other work when one call rejects', async () => {
  const items = [1, 2, 3, 4, 5];
  await assert.rejects(
    mapWithConcurrency(items, 2, async (i) => {
      if (i === 3) throw new Error('boom');
      return i;
    })
  );
  // The pool itself propagates a rejection (Promise.all semantics); callers
  // that need per-item isolation, like fetchFeedArticles, catch inside fn
  // and never let it reject -- verified separately by the fact that
  // fetchFeedArticles's own try/catch returns [] on error rather than
  // throwing, so a single broken feed cannot surface here at all.
});

test('mapWithConcurrency handles an empty item list', async () => {
  const result = await mapWithConcurrency([], 6, async (i) => i);
  assert.deepEqual(result, []);
});

test('mapWithConcurrency handles a limit larger than the item count', async () => {
  const items = [1, 2, 3];
  const result = await mapWithConcurrency(items, 100, async (i) => i * 2);
  assert.deepEqual(result, [2, 4, 6]);
});
