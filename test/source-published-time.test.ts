import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSourcePublishedTime,
  SHANGHAI_UTC_OFFSET_MINUTES,
  sourcePublishedAgeHours,
} from '../src/time/source-published-time.js';

const observedAt = Date.parse('2026-07-21T07:30:00.000Z'); // Shanghai 2026-07-21 15:30
const options = { observedAt, utcOffsetMinutes: SHANGHAI_UTC_OFFSET_MINUTES };

test('normalizes relative minute/hour strings against the explicit observation anchor', () => {
  assert.deepEqual(normalizeSourcePublishedTime('编辑于 20分钟前 上海', options), {
    rawText: '编辑于 20分钟前 上海',
    status: 'parsed',
    publishedAt: observedAt - 20 * 60_000,
    precision: 'minute',
    observedAt,
  });
  assert.equal(normalizeSourcePublishedTime('3小时前', options)?.publishedAt, observedAt - 3 * 3_600_000);
  assert.equal(normalizeSourcePublishedTime('3小时前', options)?.precision, 'hour');
});

test('normalizes yesterday with and without time while preserving precision', () => {
  const withTime = normalizeSourcePublishedTime('昨天 14:30', options);
  assert.equal(withTime?.publishedAt, Date.parse('2026-07-20T06:30:00.000Z'));
  assert.equal(withTime?.precision, 'minute');

  const dayOnly = normalizeSourcePublishedTime('昨天', options);
  assert.equal(dayOnly?.publishedAt, Date.parse('2026-07-19T16:00:00.000Z'));
  assert.equal(dayOnly?.precision, 'day');
  assert.ok((sourcePublishedAgeHours(dayOnly!) ?? 0) > 15);
  assert.ok((sourcePublishedAgeHours(dayOnly!) ?? 0) < 16);
});

test('infers the latest non-future year for month-day strings', () => {
  const januaryObservation = Date.parse('2026-01-02T04:00:00.000Z'); // Shanghai noon
  const result = normalizeSourcePublishedTime('12-31', {
    observedAt: januaryObservation,
    utcOffsetMinutes: SHANGHAI_UTC_OFFSET_MINUTES,
  });
  assert.equal(result?.publishedAt, Date.parse('2025-12-30T16:00:00.000Z'));
  assert.equal(result?.precision, 'day');
});

test('normalizes explicit dates and rejects invalid or future calendar values', () => {
  assert.equal(normalizeSourcePublishedTime('2026年07月05日', options)?.publishedAt, Date.parse('2026-07-04T16:00:00.000Z'));
  assert.equal(normalizeSourcePublishedTime('2026-02-30', options)?.status, 'unparseable');
  assert.equal(normalizeSourcePublishedTime('2027-01-01', options)?.status, 'unparseable');
});

test('retains unknown evidence without inventing a timestamp', () => {
  assert.deepEqual(normalizeSourcePublishedTime('猜你想搜', options), {
    rawText: '猜你想搜',
    status: 'unparseable',
    publishedAt: null,
    precision: null,
    observedAt,
  });
  assert.equal(normalizeSourcePublishedTime('  ', options), null);
});

test('rejects invalid anchors and offsets instead of reading the ambient clock', () => {
  assert.throws(() => normalizeSourcePublishedTime('3小时前', { observedAt: Number.NaN }), /observedAt/);
  assert.throws(() => normalizeSourcePublishedTime('3小时前', { observedAt, utcOffsetMinutes: 841 }), /utcOffsetMinutes/);
});
