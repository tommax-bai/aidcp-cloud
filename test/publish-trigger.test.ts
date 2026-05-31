import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublishTrigger, DEFAULT_TRIGGER_CONFIG } from '../src/publish/index.js';
import type { TriggerMetrics } from '../src/publish/index.js';

const trigger = new PublishTrigger();

function m(p: Partial<TriggerMetrics>): TriggerMetrics {
  return { hoursSinceLastPublish: 0, newConceptCount: 0, likedSinceLastPublish: 0, ...p };
}

test('默认配置与设计约束一致', () => {
  assert.equal(DEFAULT_TRIGGER_CONFIG.minTimeSinceLastPublishHours, 20);
  assert.equal(DEFAULT_TRIGGER_CONFIG.minNewConcepts, 3);
  assert.equal(DEFAULT_TRIGGER_CONFIG.minLikedSinceLastPublish, 15);
  assert.equal(DEFAULT_TRIGGER_CONFIG.maxSilenceHours, 48);
});

test('时间硬下限未到 → 即使内容充足也不发', () => {
  const d = trigger.evaluate(m({ hoursSinceLastPublish: 19, newConceptCount: 10, likedSinceLastPublish: 100 }));
  assert.equal(d.shouldPublish, false);
  assert.equal(d.relaxed, false);
  assert.match(d.reason, /硬下限/);
});

test('正常路径：时间达标 + 概念达标 + 点赞达标 → 发布', () => {
  const d = trigger.evaluate(m({ hoursSinceLastPublish: 21, newConceptCount: 3, likedSinceLastPublish: 15 }));
  assert.equal(d.shouldPublish, true);
  assert.equal(d.relaxed, false);
});

test('正常路径：概念不足 → 不发', () => {
  const d = trigger.evaluate(m({ hoursSinceLastPublish: 21, newConceptCount: 2, likedSinceLastPublish: 20 }));
  assert.equal(d.shouldPublish, false);
  assert.match(d.reason, /新概念/);
});

test('正常路径：点赞不足 → 不发', () => {
  const d = trigger.evaluate(m({ hoursSinceLastPublish: 21, newConceptCount: 5, likedSinceLastPublish: 10 }));
  assert.equal(d.shouldPublish, false);
  assert.match(d.reason, /点赞/);
});

test('正常路径：概念与点赞都不足 → reason 同时列出两项', () => {
  const d = trigger.evaluate(m({ hoursSinceLastPublish: 30, newConceptCount: 1, likedSinceLastPublish: 1 }));
  assert.equal(d.shouldPublish, false);
  assert.match(d.reason, /新概念/);
  assert.match(d.reason, /点赞/);
});

test('软上限：沉默 >= 48h 且有 >=1 概念 → 放宽发布（即使点赞为 0）', () => {
  const d = trigger.evaluate(m({ hoursSinceLastPublish: 50, newConceptCount: 1, likedSinceLastPublish: 0 }));
  assert.equal(d.shouldPublish, true);
  assert.equal(d.relaxed, true);
  assert.match(d.reason, /放宽/);
});

test('软上限：沉默 >= 48h 但 0 概念 → 仍不发', () => {
  const d = trigger.evaluate(m({ hoursSinceLastPublish: 100, newConceptCount: 0, likedSinceLastPublish: 0 }));
  assert.equal(d.shouldPublish, false);
  assert.equal(d.relaxed, true);
});

test('从未发布过（Infinity 小时）→ 走软上限放宽路径', () => {
  const d = trigger.evaluate(m({ hoursSinceLastPublish: Infinity, newConceptCount: 1, likedSinceLastPublish: 0 }));
  assert.equal(d.shouldPublish, true);
  assert.equal(d.relaxed, true);
});

test('边界：恰好达到时间硬下限 20h + 内容达标 → 发布', () => {
  const d = trigger.evaluate(m({ hoursSinceLastPublish: 20, newConceptCount: 3, likedSinceLastPublish: 15 }));
  assert.equal(d.shouldPublish, true);
});

test('自定义配置覆盖默认值', () => {
  const t = new PublishTrigger({ minNewConcepts: 1, minLikedSinceLastPublish: 1 });
  assert.equal(t.getConfig().minNewConcepts, 1);
  const d = t.evaluate(m({ hoursSinceLastPublish: 21, newConceptCount: 1, likedSinceLastPublish: 1 }));
  assert.equal(d.shouldPublish, true);
});