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

function scheduleView(overrides: Partial<ContentScheduleView> = {}): ContentScheduleView {
  const next: ContentScheduleView = {
    autoEnabled: true,
    postEnabled: true,
    postMode: 'review',
    postDailyCap: 2,
    commentEnabled: false,
    commentMode: 'off',
    commentDailyCap: 0,
    contactCommentEnabled: false,
    contactCommentMode: 'off',
    contactCommentDailyCap: 0,
    effectiveMask: FULL,
    ...overrides,
  };
  if (overrides.postMode === undefined) next.postMode = next.postEnabled ? 'review' : 'off';
  if (overrides.commentMode === undefined) next.commentMode = next.commentEnabled ? 'review' : 'off';
  if (overrides.contactCommentMode === undefined)
    next.contactCommentMode = next.contactCommentEnabled ? 'review' : 'off';
  return next;
}

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
    view: scheduleView(),
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
    pendingAutonomousCount: () => Promise.resolve(state.pending ? 1 : 0),
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

test('content-scheduler: 三档模式透传 — postMode=auto_approve 下发给 triggerPost', async () => {
  let seenMode: string | undefined;
  const deps: ContentSchedulerDeps = {
    onlineAccounts: () => [ACC],
    scheduleFor: () => scheduleView({ postMode: 'auto_approve', postEnabled: true }),
    riskStatus: () => 'normal',
    postedTodayCount: () => Promise.resolve(0),
    pendingAutonomousCount: () => Promise.resolve(0),
    isPublishBusy: () => false,
    triggerPost: (_id, mode) => {
      seenMode = mode;
      return Promise.resolve();
    },
    now: () => NOW_HIT.getTime(),
    logger: { warn: () => {} },
  };
  await new ContentScheduler(deps).onTick();
  assert.equal(seenMode, 'auto_approve');
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
	      view: scheduleView({ effectiveMask: mask }),
	    });
    await scheduler.onTick();
    assert.deepEqual(calls, [], `掩码=${String(mask)} 应不触发（fail-closed）`);
  }
});

test('content-scheduler: 开关闸 — 总开关/发帖开关关 或 日上限0 → 不触发', async () => {
	  for (const view of [
	    scheduleView({ autoEnabled: false, postEnabled: true }),
	    scheduleView({ postEnabled: false }),
	    scheduleView({ postDailyCap: 0 }),
	  ]) {
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
	  let r = mk({ posted: 1, pending: true, view: scheduleView() });
  await r.scheduler.onTick();
  assert.deepEqual(r.calls, [], '已发1+在途1>=cap2 → 不发');

  // cap=2：已发2 → 不触发
  r = mk({ posted: 2 });
  await r.scheduler.onTick();
  assert.deepEqual(r.calls, [], '已发2>=cap2 → 不发');

  // cap=1：已发0+在途0 → 触发
	  r = mk({ posted: 0, pending: false, view: scheduleView({ postDailyCap: 1 }) });
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
	    view: scheduleView(),
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
    pendingAutonomousCount: () => Promise.resolve(state.pending ? 1 : 0),
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
	    view: scheduleView(),
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
    pendingAutonomousCount: () => Promise.resolve(state.pending ? 1 : 0),
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
	    view: scheduleView({ postEnabled: false, postDailyCap: 0, commentEnabled: true, commentDailyCap: 2 }),
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
    pendingAutonomousCount: () => Promise.resolve(0),
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
	    view: scheduleView({ postEnabled: true, postDailyCap: 2, commentEnabled: true, commentDailyCap: 2 }),
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

test('content-scheduler/join: join 与 comment 共用账号级单飞，join 在跑时不并发评论', async () => {
  const joinOffset = offsetMinute(ACC, BASE_DAY, 'join');
  const joinNow = new Date(2026, 0, 5, 10, joinOffset, 0);
  const fired: string[] = [];
  const state = {
    nowMs: joinNow.getTime(),
    joinBusy: false,
    joinedToday: 0,
    commentBusy: false,
    commentedToday: 0,
  };
	const deps: ContentSchedulerDeps = {
	  onlineAccounts: () => [ACC],
	  scheduleFor: () => scheduleView({ postEnabled: false, postDailyCap: 0, commentEnabled: true, commentDailyCap: 2 }),
    riskStatus: () => 'normal',
    postedTodayCount: () => Promise.resolve(0),
    pendingAutonomousCount: () => Promise.resolve(0),
    isPublishBusy: () => false,
    triggerPost: () => Promise.resolve(),
    triggerJoin: (id) => {
      fired.push(`join:${id}`);
      state.joinBusy = true;
      return new Promise(() => {});
    },
    isJoinBusy: () => state.joinBusy,
    joinedTodayCount: () => Promise.resolve(state.joinedToday),
    joinDailyCap: () => 3,
    triggerComment: (id) => {
      fired.push(`comment:${id}`);
      return Promise.resolve();
    },
    isCommentBusy: () => state.commentBusy,
    commentedTodayCount: () => Promise.resolve(state.commentedToday),
    now: () => state.nowMs,
    logger: { warn: () => {} },
  };
  const scheduler = new ContentScheduler(deps);
  await scheduler.onTick();
  assert.deepEqual(fired, [`join:${ACC}`], 'join 槽先触发');
  state.nowMs = C_NOW_HIT.getTime();
  await scheduler.onTick();
  assert.deepEqual(fired, [`join:${ACC}`], '同账号 join 未结束时，comment 槽被账号级 inFlight 拦下');
});

test('content-scheduler/cross-guard: 正在评论（isCommentBusy）→ 后台自动加群本 tick 跳过（change facebook-manual-join-comment）', async () => {
  const joinOffset = offsetMinute(ACC, BASE_DAY, 'join');
  const joinNow = new Date(2026, 0, 5, 10, joinOffset, 0);
  const fired: string[] = [];
	const deps: ContentSchedulerDeps = {
	  onlineAccounts: () => [ACC],
	  scheduleFor: () => scheduleView({ postEnabled: false, postDailyCap: 0 }),
    riskStatus: () => 'normal',
    postedTodayCount: () => Promise.resolve(0),
    pendingAutonomousCount: () => Promise.resolve(0),
    isPublishBusy: () => false,
    triggerPost: () => Promise.resolve(),
    triggerJoin: (id) => { fired.push(`join:${id}`); return Promise.resolve(); },
    isJoinBusy: () => false,
    joinedTodayCount: () => Promise.resolve(0),
    joinDailyCap: () => 3,
    isCommentBusy: () => true, // 手动 /comment（含 --join 的评论阶段）在跑
    now: () => joinNow.getTime(),
    logger: { warn: () => {} },
  };
  await new ContentScheduler(deps).onTick();
  assert.deepEqual(fired, [], '正在评论 → 后台自动加群绝不抢同一物理边端');
});

test('content-scheduler/cross-guard: 正在加群（isJoinBusy）→ 后台自动评论本 tick 跳过（change facebook-manual-join-comment）', async () => {
  const commentOffset = offsetMinute(ACC, BASE_DAY, 'comment');
  const commentNow = new Date(2026, 0, 5, 10, commentOffset, 0);
  const fired: string[] = [];
	const deps: ContentSchedulerDeps = {
	  onlineAccounts: () => [ACC],
	  scheduleFor: () => scheduleView({ postEnabled: false, postDailyCap: 0, commentEnabled: true, commentDailyCap: 2 }),
    riskStatus: () => 'normal',
    postedTodayCount: () => Promise.resolve(0),
    pendingAutonomousCount: () => Promise.resolve(0),
    isPublishBusy: () => false,
    triggerPost: () => Promise.resolve(),
    triggerComment: (id) => { fired.push(`comment:${id}`); return Promise.resolve(); },
    isCommentBusy: () => false,
    commentedTodayCount: () => Promise.resolve(0),
    isJoinBusy: () => true, // 加群（含手动 --join 的加群阶段）在跑
    now: () => commentNow.getTime(),
    logger: { warn: () => {} },
  };
  await new ContentScheduler(deps).onTick();
  assert.deepEqual(fired, [], '正在加群 → 后台自动评论绝不抢同一物理边端');
});

test('content-scheduler/comment: 三件套未注入 — 评论开着也整体跳过（零回归、不炸）', async () => {
  const { scheduler, fired } = mkC({ wired: false });
  await scheduler.onTick();
  assert.deepEqual(fired, []);
});

test('content-scheduler/comment: 开关闸 — commentEnabled 关或 cap 0 不触发', async () => {
	for (const view of [
	  scheduleView({ postEnabled: false, postDailyCap: 0, commentEnabled: false, commentDailyCap: 2 }),
	  scheduleView({ postEnabled: false, postDailyCap: 0, commentEnabled: true, commentDailyCap: 0 }),
	]) {
    const { scheduler, fired } = mkC({ view });
    await scheduler.onTick();
    assert.deepEqual(fired, []);
  }
});

// ── Phase 3（change content-schedule-group-comments → generalize-contact-info）：联系评论动作 ─────────────────

const G_OFFSET = offsetMinute(ACC, BASE_DAY, 'contact_comment');
const G_NOW_HIT = new Date(2026, 0, 5, 10, G_OFFSET, 0);

interface GState {
  view: ContentScheduleView;
  commentBusy: boolean;
  attempts: number;
  nowMs: number;
  wired: boolean;
}

function mkG(overrides: Partial<GState> = {}) {
	  const fired: string[] = [];
	  const st: GState = {
	    view: scheduleView({
	      postEnabled: false,
	      postDailyCap: 0,
	      contactCommentEnabled: true,
	      contactCommentDailyCap: 3,
	    }),
    commentBusy: false,
    attempts: 0,
    nowMs: G_NOW_HIT.getTime(),
    wired: true,
    ...overrides,
  };
  const deps: ContentSchedulerDeps = {
    onlineAccounts: () => [ACC],
    scheduleFor: () => st.view,
    riskStatus: () => 'normal',
    postedTodayCount: () => Promise.resolve(0),
    pendingAutonomousCount: () => Promise.resolve(0),
    isPublishBusy: () => false,
    triggerPost: (id) => { fired.push(`post:${id}`); return Promise.resolve(); },
    isCommentBusy: () => st.commentBusy,
    ...(st.wired
      ? {
          triggerContactComment: (id: string) => { fired.push(`contact:${id}`); return Promise.resolve(); },
          contactAttemptsTodayCount: () => Promise.resolve(st.attempts),
        }
      : {}),
    now: () => st.nowMs,
    logger: { warn: () => {} },
  };
  return { scheduler: new ContentScheduler(deps), st, fired };
}

test('content-scheduler/contact: happy path — 命中联系评论偏移分钟 → triggerContactComment 一次', async () => {
  const { scheduler, fired } = mkG();
  await scheduler.onTick();
  assert.deepEqual(fired, [`contact:${ACC}`]);
});

test('content-scheduler/contact: 单飞复用评论机器 — isCommentBusy 时不触发', async () => {
  const { scheduler, fired } = mkG({ commentBusy: true });
  await scheduler.onTick();
  assert.deepEqual(fired, []);
});

test('content-scheduler/contact: 尝试型日上限 — attempts>=cap 不触发（被拒/无目标也占额度的保守方向）', async () => {
  const a = mkG({ attempts: 3 }); // cap=3
  await a.scheduler.onTick();
  assert.deepEqual(a.fired, [], '尝试满 3 → 不再触发');
  const b = mkG({ attempts: 2 });
  await b.scheduler.onTick();
  assert.deepEqual(b.fired, [`contact:${ACC}`]);
});

test('content-scheduler/contact: 两件套未注入 — 联系评论开着也整体跳过（零回归、不炸）', async () => {
  const { scheduler, fired } = mkG({ wired: false });
  await scheduler.onTick();
  assert.deepEqual(fired, []);
});

test('content-scheduler/contact: 开关闸 — contactCommentEnabled 关或 cap 0 不触发', async () => {
	  for (const patch of [
	    { contactCommentEnabled: false, contactCommentDailyCap: 3 },
	    { contactCommentEnabled: true, contactCommentDailyCap: 0 },
	  ]) {
	    const { scheduler, fired } = mkG({
	      view: scheduleView({
	        postEnabled: false,
	        postDailyCap: 0,
	        ...patch,
	      }),
	    });
    await scheduler.onTick();
    assert.deepEqual(fired, []);
  }
});

test('content-scheduler/contact: 幂等独立 — 联系评论槽不被同小时其它动作吞（发帖先触发后联系评论照常）', async () => {
  assert.notEqual(OFFSET, G_OFFSET, '两动作偏移已知不同');
	  const { scheduler, st, fired } = mkG({
	    view: scheduleView({
	      postEnabled: true,
	      postDailyCap: 2,
	      contactCommentEnabled: true,
	      contactCommentDailyCap: 3,
	    }),
    nowMs: NOW_HIT.getTime(), // post 偏移分钟
  });
  await scheduler.onTick();
  assert.deepEqual(fired, [`post:${ACC}`]);
  await new Promise((r) => setImmediate(r)); // settle 单飞
  st.nowMs = G_NOW_HIT.getTime();
  await scheduler.onTick();
  assert.deepEqual(fired, [`post:${ACC}`, `contact:${ACC}`], '发帖幂等键不吞联系评论槽');
});
