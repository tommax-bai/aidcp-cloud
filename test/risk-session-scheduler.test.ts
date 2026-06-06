import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_TIME_SLOTS,
  ColdStartPlanner,
  SessionBudget,
  TimeScheduler,
  applyHourlyDecay,
  hourlyDecayFactor,
  slotForDate,
} from '../src/risk/index.js';

test('SessionBudget 按档位生成会话预算并限制 15-60min', () => {
  const budget = new SessionBudget({ quotaLevel: 'normal', random: () => 0.5, naturalLeaveProbability: 0.03 });
  assert.equal(budget.quotaLevel, 'normal');
  assert.equal(budget.maxActions, 60);
  assert.ok(budget.durationMs >= 15 * 60_000);
  assert.ok(budget.durationMs <= 60 * 60_000);
  assert.equal(budget.naturalLeaveProbability, 0.03);
});

test('SessionBudget 满足动作数、时长、自然离开任一条件即结束', () => {
  const byAction = new SessionBudget({ quotaLevel: 'conservative', random: () => 0.99, naturalLeaveProbability: 0.02 });
  for (let i = 0; i < 30; i++) byAction.recordAction();
  assert.equal(byAction.shouldEnd(byAction.startedAt), true);

  const byTime = new SessionBudget({ quotaLevel: 'aggressive', random: () => 0.99, naturalLeaveProbability: 0.02 });
  assert.equal(byTime.shouldEnd(byTime.startedAt + byTime.durationMs), true);

  const byLeave = new SessionBudget({ quotaLevel: 'normal', random: () => 0.01, naturalLeaveProbability: 0.02 });
  assert.equal(byLeave.shouldEnd(byLeave.startedAt), true);
});

test('小时级衰减因子符合 risk-control 公式', () => {
  assert.equal(hourlyDecayFactor(1), 1);
  assert.equal(hourlyDecayFactor(2), 0.75);
  assert.equal(hourlyDecayFactor(3), 0.5);
  assert.equal(hourlyDecayFactor(4), 0.3);
  assert.equal(applyHourlyDecay(100, 3), 50);
});

test('TimeScheduler 使用工作日与周末时段概率并标记凌晨纯浏览', () => {
  const scheduler = new TimeScheduler({ random: () => 0.01 });
  const weekdayPrime = scheduler.evaluate(new Date('2026-06-03T20:10:00+08:00'));
  assert.equal(weekdayPrime.slot.name, 'prime');
  assert.equal(weekdayPrime.probability, 0.85);
  assert.equal(weekdayPrime.shouldStart, true);

  const weekendMorning = scheduler.evaluate(new Date('2026-06-06T09:10:00+08:00'));
  assert.equal(weekendMorning.slot.name, 'forenoon');
  assert.equal(weekendMorning.probability, 0.45);

  const lateNight = scheduler.evaluate(new Date('2026-06-03T01:00:00+08:00'));
  assert.equal(lateNight.viewOnly, true);
});

test('TimeScheduler 启动时间使用名义起点 +-30min 高斯抖动', () => {
  let calls = 0;
  const scheduler = new TimeScheduler({
    random: () => {
      calls += 1;
      return calls % 3 === 0 ? 0.5 : 0.99;
    },
  });
  const plan = scheduler.planDay(new Date('2026-06-03T00:00:00+08:00'));
  assert.equal(plan.length, ACTIVE_TIME_SLOTS.length);
  for (const session of plan) {
    const expected = new Date(session.startAt);
    expected.setHours(0, 0, 0, 0);
    expected.setTime(expected.getTime() + session.slot.startMinute * 60_000);
    const diffMinutes = Math.abs((session.startAt.getTime() - expected.getTime()) / 60_000);
    assert.ok(diffMinutes <= 30);
  }
  assert.equal(slotForDate(new Date('2026-06-03T12:30:00+08:00')).name, 'noon');
});

test('ColdStartPlanner 根据账号年龄返回 Day1-7 配额覆盖，Day8+ 返回 null', () => {
  const planner = new ColdStartPlanner({ random: () => 0.999 });
  assert.deepEqual(planner.quotaForAccountAge(0), { view: 50, like: 3, collect: 1, comment: 0, follow: 1, publish: 0 });
  assert.deepEqual(planner.quotaForAccountAge(2), { view: 80, like: 10, collect: 3, comment: 1, follow: 2, publish: 0 });
  assert.deepEqual(planner.quotaForAccountAge(5), { view: 120, like: 20, collect: 5, comment: 3, follow: 3, publish: 1 });
  assert.equal(planner.quotaForAccountAge(7), null);
});