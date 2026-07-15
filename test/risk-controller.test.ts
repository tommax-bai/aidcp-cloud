import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAILY_QUOTAS, RiskController, SlidingWindowCounter, deriveWindowQuotas } from '../src/risk/index.js';

test('三档每日配额符合 risk-control 第 6 节', () => {
  assert.deepEqual(DAILY_QUOTAS.conservative, { view: 80, like: 20, collect: 10, comment: 3, follow: 5, publish: 1, comment_like: 3, join_group: 1, dm_reply: 0 });
  assert.deepEqual(DAILY_QUOTAS.normal, { view: 150, like: 50, collect: 25, comment: 8, follow: 15, publish: 1, comment_like: 6, join_group: 3, dm_reply: 0 });
  assert.deepEqual(DAILY_QUOTAS.aggressive, { view: 300, like: 100, collect: 50, comment: 15, follow: 30, publish: 2, comment_like: 12, join_group: 5, dm_reply: 0 });
});

test('dailyRemaining: comment 按当日配额递减、用尽即 0（评论每日上限预闸源）', async () => {
  let now = 0;
  const c = new RiskController({ quotaLevel: 'conservative', clock: () => now, minViewsForLikeRatio: 0 });
  assert.equal(c.dailyRemaining('comment'), 3); // 保守档日配额 3
  assert.equal(await c.record('comment'), true);
  now += 3_600_001; // 跨小时窗口，清分钟/小时 burst，仅留当日计数
  assert.equal(c.dailyRemaining('comment'), 2);
  assert.equal(await c.record('comment'), true);
  now += 3_600_001;
  assert.equal(await c.record('comment'), true);
  now += 3_600_001;
  // 当日 3 条已用尽 → canDo false → dailyRemaining 0
  assert.equal(c.canDo('comment'), false);
  assert.equal(c.dailyRemaining('comment'), 0);
});

test('record 撞配额被拒是背压、绝不升级威胁态（change decouple-quota-hit-from-risk）', async () => {
  let now = 0;
  const c = new RiskController({ quotaLevel: 'conservative', clock: () => now, minViewsForLikeRatio: 0 });
  // 用尽当日 comment 配额（保守档 3），每次跨小时窗只留当日计数
  for (let i = 0; i < DAILY_QUOTAS.conservative.comment; i++) {
    assert.equal(await c.record('comment'), true);
    now += 3_600_001;
  }
  assert.equal(c.canDo('comment'), false);
  const before = c.getState();
  // 反复撞配额：始终返 false，且威胁态 / 信号计数 / 最后信号时间都不动（不自升 warned/restricted）
  for (let i = 0; i < 5; i++) {
    assert.equal(await c.record('comment'), false, '撞配额 record 返 false（背压）');
    now += 1000;
  }
  const after = c.getState();
  assert.equal(after.status, 'normal', '撞配额绝不把 normal 推向 warned/restricted');
  assert.equal(after.signalCount, before.signalCount, '撞配额不 bump signalCount');
  assert.equal(after.lastSignalAt, before.lastSignalAt, '撞配额不刷新 lastSignalAt（不重置恢复窗口）');
});

test('滑动窗口按动作分别计数并自动淘汰过期事件', () => {
  let now = 1_000_000;
  const counter = new SlidingWindowCounter({ clock: () => now });
  counter.record('like');
  counter.record('view');
  assert.equal(counter.count('like', 'minute'), 1);
  assert.equal(counter.count('view', 'minute'), 1);
  assert.equal(counter.count('collect', 'minute'), 0);
  now += 60_001;
  assert.equal(counter.count('like', 'minute'), 0);
  assert.equal(counter.count('like', 'hour'), 1);
});

test('canDo: 分钟窗口超限返回 false', async () => {
  const controller = new RiskController({ quotaLevel: 'conservative', minViewsForLikeRatio: 0 });
  const quota = deriveWindowQuotas('conservative').minute.collect;
  for (let i = 0; i < quota; i++) assert.equal(await controller.record('collect'), true);
  assert.equal(controller.canDo('collect'), false);
});

test('explain: 配额超限时返回滑动窗口重试时间', async () => {
  let now = 0;
  const controller = new RiskController({ quotaLevel: 'conservative', clock: () => now, minViewsForLikeRatio: 0 });
  const quota = deriveWindowQuotas('conservative').minute.view;
  for (let i = 0; i < quota; i++) {
    assert.equal(await controller.record('view'), true);
    now += 1_000;
  }

  const decision = controller.explain('view');
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'quota:minute');
  assert.equal(decision.retryAfterMs, 60_000 - now);
});

test('quotaReleaseAfterMs: 按指定窗口只读返回释放时间', async () => {
  let now = 0;
  const controller = new RiskController({ quotaLevel: 'conservative', clock: () => now, minViewsForLikeRatio: 0 });
  const quota = deriveWindowQuotas('conservative').hour.view;
  for (let i = 0; i < quota; i++) {
    assert.equal(await controller.record('view'), true);
    now += 61_000;
  }

  const before = controller.getState();
  assert.equal(controller.quotaReleaseAfterMs('view', 'hour'), 60 * 60_000 - now);
  assert.equal(controller.getState().updatedAt, before.updatedAt, '只读 release hint 不写风控状态');
});

test('day quota: 按 Asia/Shanghai 自然日计算，昨天的浏览不占今天额度', () => {
  const now = Date.UTC(2026, 6, 7, 4, 0, 0); // 2026-07-07 12:00 CST
  const controller = new RiskController({ quotaLevel: 'normal', clock: () => now, minViewsForLikeRatio: 0 });
  const debugCounter = controller as unknown as { counter: { record(action: 'view', at: number, count?: number): void } };

  debugCounter.counter.record('view', Date.UTC(2026, 6, 6, 9, 59, 22), 150); // 2026-07-06 17:59 CST
  debugCounter.counter.record('view', Date.UTC(2026, 6, 7, 0, 30, 0), 76); // 2026-07-07 08:30 CST

  const decision = controller.explain('view');
  assert.equal(decision.allowed, true, '今天自然日仅 76/150，应允许继续浏览');
});

test('day quota: 当日满额后的释放时间为下一个 Asia/Shanghai 00:00', () => {
  const now = Date.UTC(2026, 6, 7, 4, 0, 0); // 2026-07-07 12:00 CST
  const nextLocalMidnight = Date.UTC(2026, 6, 7, 16, 0, 0); // 2026-07-08 00:00 CST
  const controller = new RiskController({ quotaLevel: 'normal', clock: () => now, minViewsForLikeRatio: 0 });
  const debugCounter = controller as unknown as { counter: { record(action: 'view', at: number, count?: number): void } };

  debugCounter.counter.record('view', Date.UTC(2026, 6, 7, 0, 30, 0), 150); // 2026-07-07 08:30 CST

  const decision = controller.explain('view');
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'quota:day');
  assert.equal(decision.retryAfterMs, nextLocalMidnight - now);
  assert.equal(controller.quotaReleaseAfterMs('view', 'day'), nextLocalMidnight - now);
});

test('canDo: 小时窗口超限返回 false', async () => {
  let now = 0;
  const controller = new RiskController({ quotaLevel: 'conservative', clock: () => now, minViewsForLikeRatio: 0 });
  const quota = deriveWindowQuotas('conservative').hour.follow;
  for (let i = 0; i < quota; i++) {
    assert.equal(await controller.record('follow'), true);
    now += 61_000;
  }
  assert.equal(controller.canDo('follow'), false);
});

test('canDo: 天窗口超限返回 false', async () => {
  let now = 0;
  const controller = new RiskController({ quotaLevel: 'conservative', clock: () => now, minViewsForLikeRatio: 0 });
  for (let i = 0; i < DAILY_QUOTAS.conservative.comment; i++) {
    assert.equal(await controller.record('comment'), true);
    now += 61 * 60_000;
  }
  assert.equal(controller.canDo('comment'), false);
});

test('点赞率 projected like/view 超过 35% 时禁止点赞', async () => {
  let now = 0;
  const controller = new RiskController({ quotaLevel: 'aggressive', clock: () => now, minViewsForLikeRatio: 10 });
  for (let i = 0; i < 20; i++) {
    assert.equal(await controller.record('view'), true);
    now += 61_000;
  }
  for (let i = 0; i < 3; i++) {
    assert.equal(await controller.record('like'), true);
    now += 61_000;
  }
  const debugCounter = controller as unknown as { counter: { record(action: 'like', at: number): void } };
  for (let i = 0; i < 5; i++) debugCounter.counter.record('like', now);
  assert.equal(controller.canDo('like'), false);
});

test('点赞率低于 15% 时允许点赞以拉回区间', async () => {
  let now = 0;
  const controller = new RiskController({ quotaLevel: 'aggressive', clock: () => now, minViewsForLikeRatio: 10 });
  for (let i = 0; i < 20; i++) {
    assert.equal(await controller.record('view'), true);
    now += 61_000;
  }
  assert.equal(controller.canDo('like'), true);
  assert.equal(await controller.record('like'), true);
});

test('warned 状态使用 conservative x0.7 且暂停发布', async () => {
  const controller = new RiskController({ quotaLevel: 'aggressive' });
  await controller.applySignal({ kind: 'light' });
  assert.equal(controller.getState().status, 'warned');
  assert.equal(controller.canDo('publish'), false);
  assert.equal(controller.effectiveQuotas().day.like, 14);
});

test('restricted 仅允许浏览，frozen 完全停止', async () => {
  const controller = new RiskController();
  await controller.applySignal({ kind: 'confirmed' });
  assert.equal(controller.getState().status, 'restricted');
  assert.equal(controller.canDo('view'), true);
  assert.equal(controller.canDo('like'), false);
  await controller.applySignal({ kind: 'fatal' });
  assert.equal(controller.getState().status, 'frozen');
  assert.equal(controller.canDo('view'), false);
});
