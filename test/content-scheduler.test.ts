import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ContentScheduler,
  offsetMinute,
  type ContentSchedulerDeps,
  type ContentScheduleView,
} from '../src/orchestrator/content-scheduler.js';

const FULL = '1'.repeat(168);
const DORMANT = '0'.repeat(168); // 168 位合法但全休眠 → isWeekActiveAt 恒 false

/** 固定「今天」为周一 10 点；now 的分钟设为该账号的错峰偏移，使 happy-path 命中。 */
const ACC = 'acc-test-1';
const BASE_DAY = new Date(2026, 0, 5, 10, 0, 0); // 本地时间
const OFFSET = offsetMinute(ACC, BASE_DAY, 'post');
const NOW_HIT = new Date(2026, 0, 5, 10, OFFSET, 0);
const NOW_MISS = new Date(2026, 0, 5, 10, (OFFSET + 1) % 60, 0);

interface State {
  online: string[];
  view: ContentScheduleView;
  risk: string;
  posted: number;
  pending: boolean;
  busy: boolean;
  nowMs: number;
  triggerImpl: (id: string) => Promise<unknown>;
}

function mk(overrides: Partial<State> = {}) {
  const calls: string[] = [];
  const state: State = {
    online: [ACC],
    view: { autoEnabled: true, postEnabled: true, postDailyCap: 2, effectiveMask: FULL },
    risk: 'normal',
    posted: 0,
    pending: false,
    busy: false,
    nowMs: NOW_HIT.getTime(),
    triggerImpl: () => Promise.resolve(),
    ...overrides,
  };
  const deps: ContentSchedulerDeps = {
    onlineAccounts: () => state.online,
    scheduleFor: () => state.view,
    riskStatus: () => state.risk,
    postedTodayCount: () => Promise.resolve(state.posted),
    hasPendingPost: () => Promise.resolve(state.pending),
    isPublishBusy: () => state.busy,
    triggerPost: (id) => {
      calls.push(id);
      return state.triggerImpl(id);
    },
    now: () => state.nowMs,
    logger: { warn: () => {} },
  };
  return { scheduler: new ContentScheduler(deps), state, calls };
}

test('content-scheduler: happy path — 命中偏移分钟 + 各闸通过 → 触发一次', async () => {
  const { scheduler, calls } = mk();
  await scheduler.onTick();
  assert.deepEqual(calls, [ACC]);
});

test('content-scheduler: 分钟未命中偏移 → 不触发', async () => {
  const { scheduler, calls } = mk({ nowMs: NOW_MISS.getTime() });
  await scheduler.onTick();
  assert.deepEqual(calls, []);
});

test('content-scheduler: 幂等 — 同小时格两次 tick 只触发一次', async () => {
  const { scheduler, calls } = mk();
  await scheduler.onTick();
  await scheduler.onTick();
  assert.deepEqual(calls, [ACC], '同小时格不重复触发');
});

test('content-scheduler: fail-closed — 掩码 null / 非法 / 全休眠 一律不触发', async () => {
  for (const mask of [null, 'not-a-mask', DORMANT]) {
    const { scheduler, calls } = mk({
      view: { autoEnabled: true, postEnabled: true, postDailyCap: 2, effectiveMask: mask },
    });
    await scheduler.onTick();
    assert.deepEqual(calls, [], `掩码=${String(mask)} 应不触发（fail-closed）`);
  }
});

test('content-scheduler: 开关闸 — 总开关/发帖开关关 或 日上限0 → 不触发', async () => {
  for (const view of [
    { autoEnabled: false, postEnabled: true, postDailyCap: 2, effectiveMask: FULL },
    { autoEnabled: true, postEnabled: false, postDailyCap: 2, effectiveMask: FULL },
    { autoEnabled: true, postEnabled: true, postDailyCap: 0, effectiveMask: FULL },
  ] as ContentScheduleView[]) {
    const { scheduler, calls } = mk({ view });
    await scheduler.onTick();
    assert.deepEqual(calls, []);
  }
});

test('content-scheduler: 风控非 normal → 不触发', async () => {
  for (const risk of ['warned', 'restricted', 'frozen']) {
    const { scheduler, calls } = mk({ risk });
    await scheduler.onTick();
    assert.deepEqual(calls, [], `risk=${risk} 不自动`);
  }
});

test('content-scheduler: 发帖全局忙 → 本槽顺延（不触发）', async () => {
  const { scheduler, calls } = mk({ busy: true });
  await scheduler.onTick();
  assert.deepEqual(calls, []);
});

test('content-scheduler: 日上限原子 — 已发+在途 >= cap 不触发；未达则触发', async () => {
  // cap=2：已发1 + 在途1 = 2 → 不触发
  let r = mk({ posted: 1, pending: true, view: { autoEnabled: true, postEnabled: true, postDailyCap: 2, effectiveMask: FULL } });
  await r.scheduler.onTick();
  assert.deepEqual(r.calls, [], '已发1+在途1>=cap2 → 不发');

  // cap=2：已发2 → 不触发
  r = mk({ posted: 2 });
  await r.scheduler.onTick();
  assert.deepEqual(r.calls, [], '已发2>=cap2 → 不发');

  // cap=1：已发0+在途0 → 触发
  r = mk({ posted: 0, pending: false, view: { autoEnabled: true, postEnabled: true, postDailyCap: 1, effectiveMask: FULL } });
  await r.scheduler.onTick();
  assert.deepEqual(r.calls, [ACC], '未达上限 → 发');
});

test('content-scheduler: fire-and-forget — triggerPost 永不 settle，onTick 仍及时返回', async () => {
  const { scheduler, calls } = mk({ triggerImpl: () => new Promise(() => {}) /* 永不 resolve */ });
  await scheduler.onTick(); // 若 await 了生成管线，这里会挂住超时
  assert.deepEqual(calls, [ACC], '已发起（但未 await 其完成）');
});

test('content-scheduler: 重入护栏 — 上轮未完时并发 tick 被跳过，不双触发', async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  // 让第一轮卡在 cap 检查（postedTodayCount 挂住），期间发第二轮 tick。
  const calls: string[] = [];
  const state: State = {
    online: [ACC],
    view: { autoEnabled: true, postEnabled: true, postDailyCap: 2, effectiveMask: FULL },
    risk: 'normal',
    posted: 0,
    pending: false,
    busy: false,
    nowMs: NOW_HIT.getTime(),
    triggerImpl: () => Promise.resolve(),
  };
  const deps: ContentSchedulerDeps = {
    onlineAccounts: () => state.online,
    scheduleFor: () => state.view,
    riskStatus: () => state.risk,
    postedTodayCount: async () => {
      await gate; // 卡住第一轮
      return state.posted;
    },
    hasPendingPost: () => Promise.resolve(state.pending),
    isPublishBusy: () => state.busy,
    triggerPost: (id) => {
      calls.push(id);
      return Promise.resolve();
    },
    now: () => state.nowMs,
    logger: { warn: () => {} },
  };
  const scheduler = new ContentScheduler(deps);
  const p1 = scheduler.onTick(); // 进入、卡在 cap 检查、tickRunning=true
  await Promise.resolve();
  const p2 = scheduler.onTick(); // 应因 tickRunning 立即返回、不触发
  await p2;
  assert.deepEqual(calls, [], '重入的第二轮不触发');
  release();
  await p1;
  assert.deepEqual(calls, [ACC], '第一轮完成后触发一次');
});
