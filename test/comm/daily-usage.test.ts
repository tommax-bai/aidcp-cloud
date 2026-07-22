import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeSessionUsageCounts,
  pickDailyUsageCounts,
  pickSessionUsageCounts,
} from '../../src/comm/daily-usage.js';

test('daily usage materializes search in user-facing order and keeps supplied totals honest', () => {
  const out = pickDailyUsageCounts({ view: 35, search: 2, like: 5, join_group: 1 });
  assert.deepEqual(Object.keys(out), ['view', 'search', 'like', 'collect', 'comment', 'follow', 'publish', 'join_group']);
  assert.deepEqual(out, {
    view: 35,
    search: 2,
    like: 5,
    collect: 0,
    comment: 0,
    follow: 0,
    publish: 0,
    join_group: 1,
  });
});

test('session usage maps runtime searches to client search without borrowing day totals', () => {
  assert.deepEqual(
    pickSessionUsageCounts({ searches: 1, likes: 2, collects: 3, comments: 4, follows: 5, search: 99 }),
    { search: 1, like: 2, collect: 3, comment: 4, follow: 5 },
  );
  assert.deepEqual(pickSessionUsageCounts({ searches: Number.NaN, likes: -2 }), { like: 0 });
  assert.deepEqual(pickSessionUsageCounts(null), {});
});

test('complete session usage prefers the session searches counter over risk totals', () => {
  const out = completeSessionUsageCounts(
    { searches: 1, likes: 2 },
    { search: 77, like: 66, view: 12, publish: 9 },
    3,
  );
  assert.equal(out.search, 1, 'session search must not borrow the risk/day-shaped search count');
  assert.equal(out.like, 2);
  assert.equal(out.view, 12, 'actions without a session counter keep their risk total');
  assert.equal(out.publish, 3, 'published count remains Cloud-confirmed by its dedicated store');
});
