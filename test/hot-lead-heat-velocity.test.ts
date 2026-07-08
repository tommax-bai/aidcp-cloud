import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePublishedHoursAgo,
  heatVelocity,
  evaluateHotLead,
  STALE_SENTINEL_HOURS,
  YESTERDAY_HOURS,
  DEFAULT_HOT_LEAD_GATE_CONFIG,
  type HotLeadGateConfig,
} from '../src/hot-lead/heat-velocity.js';

// ── 解析：发布时刻文本 → 距今小时数 ──────────────────────────────────
test('小时级文案解析为精确小时数', () => {
  assert.equal(parsePublishedHoursAgo('5小时前'), 5);
  assert.equal(parsePublishedHoursAgo('12 小时前'), 12);
});

test('分钟级/刚刚 解析为 0', () => {
  assert.equal(parsePublishedHoursAgo('刚刚'), 0);
  assert.equal(parsePublishedHoursAgo('20分钟前'), 0);
});

test('昨天/前天/X天前', () => {
  assert.equal(parsePublishedHoursAgo('昨天'), YESTERDAY_HOURS);
  assert.equal(parsePublishedHoursAgo('昨天 14:30'), YESTERDAY_HOURS);
  assert.equal(parsePublishedHoursAgo('前天'), 60);
  assert.equal(parsePublishedHoursAgo('3天前'), 72);
});

test('裸日期视为超窗哨兵', () => {
  assert.equal(parsePublishedHoursAgo('07-05'), STALE_SENTINEL_HOURS);
  assert.equal(parsePublishedHoursAgo('2026-07-05'), STALE_SENTINEL_HOURS);
  assert.equal(parsePublishedHoursAgo('2026年07月05日'), STALE_SENTINEL_HOURS);
});

test('剥离「编辑于」前缀、尾随地区名不影响', () => {
  assert.equal(parsePublishedHoursAgo('编辑于 3小时前'), 3);
  assert.equal(parsePublishedHoursAgo('3小时前 上海'), 3);
});

test('无法识别 → null（不臆造）', () => {
  assert.equal(parsePublishedHoursAgo(''), null);
  assert.equal(parsePublishedHoursAgo(undefined), null);
  assert.equal(parsePublishedHoursAgo('猜你想搜'), null);
});

// ── 速率 ──────────────────────────────────────────────────────────
test('速率 = 点赞 / max(小时, 下限)', () => {
  assert.equal(heatVelocity(5000, 2, 1), 2500);
});

test('刚发布用下限分母，不除零/爆表', () => {
  assert.equal(heatVelocity(600, 0, 1), 600); // max(0,1)=1
});

// ── 过滤闸 ────────────────────────────────────────────────────────
test('涨得快且新鲜且够量 → 命中', () => {
  const r = evaluateHotLead({ likeCount: 5000, publishedAtText: '2小时前' });
  assert.equal(r.isLead, true);
  assert.equal(r.hoursAgo, 2);
  assert.equal(r.velocity, 2500);
  assert.equal(r.reason, 'ok');
});

test('帖龄超上限 → 淘汰（裸日期）', () => {
  const r = evaluateHotLead({ likeCount: 999999, publishedAtText: '07-05' });
  assert.equal(r.isLead, false);
  assert.equal(r.reason, 'too_old');
});

test('小基数假热 → 淘汰', () => {
  const r = evaluateHotLead({ likeCount: 20, publishedAtText: '刚刚' });
  assert.equal(r.isLead, false);
  assert.equal(r.reason, 'low_likes');
});

test('够量但速率不足 → 淘汰', () => {
  // 5000 赞 / 40h = 125/h < 300 阈值；但 40h ≤ 48 上限、5000 ≥ 500 赞
  const cfg: HotLeadGateConfig = { ...DEFAULT_HOT_LEAD_GATE_CONFIG };
  const r = evaluateHotLead({ likeCount: 5000, publishedAtText: '40小时前' }, cfg);
  assert.equal(r.isLead, false);
  assert.equal(r.reason, 'low_velocity');
});

test('时刻不可得 → 不臆造、非线索', () => {
  const r = evaluateHotLead({ likeCount: 99999, publishedAtText: '猜你想搜' });
  assert.equal(r.isLead, false);
  assert.equal(r.hoursAgo, null);
  assert.equal(r.velocity, null);
  assert.equal(r.reason, 'unparseable_time');
});

test('阈值可配：抬高 velocityMin 使原命中变淘汰', () => {
  const strict: HotLeadGateConfig = { ...DEFAULT_HOT_LEAD_GATE_CONFIG, velocityMin: 3000 };
  const r = evaluateHotLead({ likeCount: 5000, publishedAtText: '2小时前' }, strict);
  assert.equal(r.isLead, false);
  assert.equal(r.reason, 'low_velocity');
});
