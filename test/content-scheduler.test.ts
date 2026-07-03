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
  /** 「自动 ⊆ 活跃」闸：undefined=不注入（不限）。 */
  browseActive?: boolean;
}

function mk(overrides: Partial<State> = {}) {
  const calls: string[] = [];
  const state: State = {
    online: [ACC],
    view: { autoEnabled: true, postEnabled: true, postDailyCap: 2, commentEnabled: false, commentDailyCap: 0, effectiveMask: FULL },
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
    ...(state.browseActive !== undefined ? { browseActiveAt: () => state.browseActive! } : {}),
    now: () => state.nowMs,
    logger: { warn: () => {} },
  };
  return { scheduler: new ContentScheduler(deps), state, calls };
}

test('content-scheduler: 自动 ⊆ 活跃 — 浏览掩码休眠时段不自动（即使内容格圈了）；活跃则放行', async () => {
  // 浏览休眠 → 拦（内容格全开也不行：休眠格绝不自动发内容）
  const blocked = mk({ browseActive: false });
  await blocked.scheduler.onTick();
  assert.deepEqual(blocked.calls, [], '浏览休眠时段绝不自动发');
  // 浏览活跃 → 放行
  const allowed = mk({ browseActive: true });
  await allowed.scheduler.onTick();
  assert.deepEqual(allowed.calls, [ACC]);
  // 不注入（浏览掩码未配 = 全天活跃语义）→ 不限（既有测试的缺省路径，零回归）
  const noGate = mk({});
  await noGate.scheduler.onTick();
  assert.deepEqual(noGate.calls, [ACC]);
});

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
      view: { autoEnabled: true, postEnabled: true, postDailyCap: 2, commentEnabled: false, commentDailyCap: 0, effectiveMask: mask },
    });
    await scheduler.onTick();
    assert.deepEqual(calls, [], `掩码=${String(mask)} 应不触发（fail-closed）`);
  }
});

test('content-scheduler: 开关闸 — 总开关/发帖开关关 或 日上限0 → 不触发', async () => {
  for (const view of [
    { autoEnabled: false, postEnabled: true, postDailyCap: 2, commentEnabled: false, commentDailyCap: 0, effectiveMask: FULL },
    { autoEnabled: true, postEnabled: false, postDailyCap: 2, commentEnabled: false, commentDailyCap: 0, effectiveMask: FULL },
    { autoEnabled: true, postEnabled: true, postDailyCap: 0, commentEnabled: false, commentDailyCap: 0, effectiveMask: FULL },
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
  let r = mk({ posted: 1, pending: true, view: { autoEnabled: true, postEnabled: true, postDailyCap: 2, commentEnabled: false, commentDailyCap: 0, effectiveMask: FULL } });
  await r.scheduler.onTick();
  assert.deepEqual(r.calls, [], '已发1+在途1>=cap2 → 不发');

  // cap=2：已发2 → 不触发
  r = mk({ posted: 2 });
  await r.scheduler.onTick();
  assert.deepEqual(r.calls, [], '已发2>=cap2 → 不发');

  // cap=1：已发0+在途0 → 触发
  r = mk({ posted: 0, pending: false, view: { autoEnabled: true, postEnabled: true, postDailyCap: 1, commentEnabled: false, commentDailyCap: 0, effectiveMask: FULL } });
  await r.scheduler.onTick();
  assert.deepEqual(r.calls, [ACC], '未达上限 → 发');
});

test('content-scheduler: fire-and-forget — triggerPost 永不 settle，onTick 仍及时返回', async () => {
  const { scheduler, calls } = mk({ triggerImpl: () => new Promise(() => {}) /* 永不 resolve */ });
  await scheduler.onTick(); // 若 await 了生成管线，这里会挂住超时
  assert.deepEqual(calls, [ACC], '已发起（但未 await 其完成）');
});

test('content-scheduler: 发帖全局串行 — 同 tick 内两账号撞同偏移分钟，只发一个（postFiring 同步闸）', async () => {
  // 找两个在 BASE_DAY 上 offset 相同的账号，把 now 的分钟设为该共享 offset。
  const seen = new Map<number, string>();
  let a = '', b = '', off = -1;
  for (let i = 0; i < 5000 && off < 0; i++) {
    const id = `serial-${i}`;
    const o = offsetMinute(id, BASE_DAY, 'post');
    if (seen.has(o)) {
      a = seen.get(o)!;
      b = id;
      off = o;
    } else {
      seen.set(o, id);
    }
  }
  assert.ok(off >= 0, '应能找到一对同偏移账号');
  const nowMs = new Date(2026, 0, 5, 10, off, 0).getTime();

  const calls: string[] = [];
  const state: State = {
    online: [a, b],
    view: { autoEnabled: true, postEnabled: true, postDailyCap: 2, commentEnabled: false, commentDailyCap: 0, effectiveMask: FULL },
    risk: 'normal',
    posted: 0,
    pending: false,
    busy: false,
    nowMs,
    triggerImpl: () => new Promise(() => {}), // 第一个 fire 后永不 settle → postFiring 保持 true
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
  await new ContentScheduler(deps).onTick();
  assert.equal(calls.length, 1, '两账号同偏移分钟，本 tick 只发一个（全局串行）');
});

test('content-scheduler: 重入护栏 — 上轮未完时并发 tick 被跳过，不双触发', async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  // 让第一轮卡在 cap 检查（postedTodayCount 挂住），期间发第二轮 tick。
  const calls: string[] = [];
  const state: State = {
    online: [ACC],
    view: { autoEnabled: true, postEnabled: true, postDailyCap: 2, commentEnabled: false, commentDailyCap: 0, effectiveMask: FULL },
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

// ── Phase 2（change content-schedule-comments）：评论动作 ──────────────────────

interface CState {
  view: ContentScheduleView;
  commentBusy: boolean;
  commentSent: number;
  nowMs: number;
  /** 三件套是否注入（false 模拟 commentScheduler 未建）。 */
  wired: boolean;
}

const C_OFFSET = offsetMinute(ACC, BASE_DAY, 'comment');
const C_NOW_HIT = new Date(2026, 0, 5, 10, C_OFFSET, 0);

function mkC(overrides: Partial<CState> = {}) {
  const fired: string[] = []; // 'post:<id>' / 'comment:<id>'
  const st: CState = {
    view: { autoEnabled: true, postEnabled: false, postDailyCap: 0, commentEnabled: true, commentDailyCap: 2, effectiveMask: FULL },
    commentBusy: false,
    commentSent: 0,
    nowMs: C_NOW_HIT.getTime(),
    wired: true,
    ...overrides,
  };
  const deps: ContentSchedulerDeps = {
    onlineAccounts: () => [ACC],
    scheduleFor: () => st.view,
    riskStatus: () => 'normal',
    postedTodayCount: () => Promise.resolve(0),
    hasPendingPost: () => Promise.resolve(false),
    isPublishBusy: () => false,
    triggerPost: (id) => {
      fired.push(`post:${id}`);
      return Promise.resolve();
    },
    ...(st.wired
      ? {
          triggerComment: (id: string) => {
            fired.push(`comment:${id}`);
            return Promise.resolve();
          },
          isCommentBusy: () => st.commentBusy,
          commentedTodayCount: () => Promise.resolve(st.commentSent),
        }
      : {}),
    now: () => st.nowMs,
    logger: { warn: () => {} },
  };
  return { scheduler: new ContentScheduler(deps), st, fired };
}

test('content-scheduler/comment: happy path — 命中评论偏移分钟 → triggerComment 一次', async () => {
  const { scheduler, fired } = mkC();
  await scheduler.onTick();
  assert.deepEqual(fired, [`comment:${ACC}`]);
});

test('content-scheduler/comment: 动作幂等互不吞 — 发帖触发后同小时评论槽照常', async () => {
  // 两动作都开；先在 post 偏移分钟 tick（fire post），再把分钟拨到 comment 偏移 tick（fire comment）。
  assert.notEqual(OFFSET, C_OFFSET, '本账号两动作偏移恰好相同则换测试账号（哈希域 60，此账号已知不同）');
  const { scheduler, st, fired } = mkC({
    view: { autoEnabled: true, postEnabled: true, postDailyCap: 2, commentEnabled: true, commentDailyCap: 2, effectiveMask: FULL },
    nowMs: NOW_HIT.getTime(), // post 偏移分钟
  });
  await scheduler.onTick();
  assert.deepEqual(fired, [`post:${ACC}`], '先命中发帖');
  await new Promise((r) => setImmediate(r)); // 让 fire-and-forget 的 finally 清掉单飞（真实世界两 tick 差 60s）
  st.nowMs = C_NOW_HIT.getTime(); // 同小时、评论偏移分钟
  await scheduler.onTick();
  assert.deepEqual(fired, [`post:${ACC}`, `comment:${ACC}`], '发帖幂等键不吞评论槽');
});

test('content-scheduler/comment: 单飞 — 评论任务在跑不重触发', async () => {
  const { scheduler, fired } = mkC({ commentBusy: true });
  await scheduler.onTick();
  assert.deepEqual(fired, []);
});

test('content-scheduler/comment: 日上限 — 已发>=cap 不触发；未达则触发', async () => {
  const a = mkC({ commentSent: 2 }); // cap=2
  await a.scheduler.onTick();
  assert.deepEqual(a.fired, [], '已发 2 >= cap 2 → 不发');
  const b = mkC({ commentSent: 1 });
  await b.scheduler.onTick();
  assert.deepEqual(b.fired, [`comment:${ACC}`]);
});

test('content-scheduler/comment: 三件套未注入 — 评论开着也整体跳过（零回归、不炸）', async () => {
  const { scheduler, fired } = mkC({ wired: false });
  await scheduler.onTick();
  assert.deepEqual(fired, []);
});

test('content-scheduler/comment: 开关闸 — commentEnabled 关或 cap 0 不触发', async () => {
  for (const view of [
    { autoEnabled: true, postEnabled: false, postDailyCap: 0, commentEnabled: false, commentDailyCap: 2, effectiveMask: FULL },
    { autoEnabled: true, postEnabled: false, postDailyCap: 0, commentEnabled: true, commentDailyCap: 0, effectiveMask: FULL },
  ] as ContentScheduleView[]) {
    const { scheduler, fired } = mkC({ view });
    await scheduler.onTick();
    assert.deepEqual(fired, []);
  }
});
