import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePublishedHoursAgo, heatVelocity, evaluateHotLead } from '../src/hot-lead/heat-velocity.js';
import { DEFAULT_HOT_LEAD_GATE_CONFIG, type HotLeadGateConfig } from '../src/kernel/hot-lead-gate-config.js';

const observedAt = Date.parse('2026-07-21T07:30:00.000Z'); // Shanghai 15:30

test('relative time reuses the normalized observation anchor', () => {
  assert.equal(parsePublishedHoursAgo('5小时前', observedAt), 5);
  assert.equal(parsePublishedHoursAgo('20分钟前', observedAt), 1 / 3);
  assert.equal(parsePublishedHoursAgo('刚刚', observedAt), 0);
});

test('day precision derives a conservative minimum age instead of a magic sentinel', () => {
  const yesterday = parsePublishedHoursAgo('昨天', observedAt);
  assert.ok(yesterday !== null && yesterday > 15 && yesterday < 16);
  const oldDate = parsePublishedHoursAgo('07-05', observedAt);
  assert.ok(oldDate !== null && oldDate > 360);
});

test('prefixes and suffix locations do not change known token parsing', () => {
  assert.equal(parsePublishedHoursAgo('编辑于 3小时前 上海', observedAt), 3);
  assert.equal(parsePublishedHoursAgo('猜你想搜', observedAt), null);
  assert.equal(parsePublishedHoursAgo('', observedAt), null);
});

test('velocity uses the configured denominator floor', () => {
  assert.equal(heatVelocity(5000, 2, 1), 2500);
  assert.equal(heatVelocity(600, 0, 1), 600);
});

test('fresh fast content passes the gate', () => {
  const result = evaluateHotLead({ likeCount: 5000, publishedAtText: '2小时前', observedAt });
  assert.equal(result.isLead, true);
  assert.equal(result.hoursAgo, 2);
  assert.equal(result.velocity, 2500);
  assert.equal(result.reason, 'ok');
});

test('old day-level content fails the age gate', () => {
  const result = evaluateHotLead({ likeCount: 999999, publishedAtText: '07-05', observedAt });
  assert.equal(result.isLead, false);
  assert.equal(result.reason, 'too_old');
});

test('48-hour day-precision boundary is conservative and deterministic', () => {
  const beforeBoundary = evaluateHotLead({ likeCount: 99_999, publishedAtText: '前天', observedAt });
  assert.equal(beforeBoundary.reason, 'ok');
  const threeDays = evaluateHotLead({ likeCount: 99_999, publishedAtText: '3天前', observedAt });
  assert.equal(threeDays.reason, 'too_old');
});

test('low likes, low velocity, and unknown time remain fail-closed', () => {
  assert.equal(evaluateHotLead({ likeCount: 20, publishedAtText: '刚刚', observedAt }).reason, 'low_likes');
  const cfg: HotLeadGateConfig = { ...DEFAULT_HOT_LEAD_GATE_CONFIG };
  assert.equal(evaluateHotLead({ likeCount: 5000, publishedAtText: '40小时前', observedAt }, cfg).reason, 'low_velocity');
  const unknown = evaluateHotLead({ likeCount: 99999, publishedAtText: '猜你想搜', observedAt });
  assert.deepEqual(unknown, { isLead: false, hoursAgo: null, velocity: null, reason: 'unparseable_time' });
});

test('threshold overrides still apply to normalized ages', () => {
  const strict: HotLeadGateConfig = { ...DEFAULT_HOT_LEAD_GATE_CONFIG, velocityMin: 3000 };
  assert.equal(evaluateHotLead({ likeCount: 5000, publishedAtText: '2小时前', observedAt }, strict).reason, 'low_velocity');
});
