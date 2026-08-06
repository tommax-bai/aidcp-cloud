import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '@automation/event-bus/index.js';
import { SessionMonitorRole } from '@automation/agents/session-monitor-role.js';
import type { Soul } from '@kernel/kernel/soul-types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['编程'], seed_keywords: ['GPT'] },
};

const fullBudget = () => ({ likes: 8, collects: 5, follows: 3, searches: 3 });

/** 构造一个注入假时钟 + 定时器桩的看门狗；返回 role、捕获的 tick 回调、清理记录、事件桶。 */
function makeMonitor(opts?: { idleNudgeMs?: number; idleEndMs?: number }) {
  const bus = new EventBus();
  const nudges: unknown[] = [];
  const ends: unknown[] = [];
  bus.on('session.idle_nudge', (p) => {
    nudges.push(p);
  });
  bus.on('session.should_end', (p) => {
    ends.push(p);
  });

  let now = 1_000_000;
  let tickFn: (() => void) | undefined;
  const cleared: unknown[] = [];

  const role = new SessionMonitorRole({
    eventBus: bus,
    soul: mockSoul,
    getRemainingBudget: fullBudget,
    clock: () => now,
    idleNudgeMs: opts?.idleNudgeMs ?? 130_000,
    idleEndMs: opts?.idleEndMs ?? 240_000,
    idleTickMs: 5_000,
    setIntervalFn: (fn) => {
      tickFn = fn;
      return 'HANDLE';
    },
    clearIntervalFn: (h) => {
      cleared.push(h);
    },
  });

  return {
    bus,
    role,
    nudges,
    ends,
    cleared,
    tick: () => tickFn?.(),
    advance: (ms: number) => {
      now += ms;
    },
    nowFn: () => now,
  };
}

describe('SessionMonitorRole idle 看门狗', () => {
  it('idle 超 N → 发一次 session.idle_nudge（且按 N 节流，不每 tick 重复）', () => {
    const m = makeMonitor();
    m.role.subscribe();
    m.advance(130_001); // 超过 idleNudgeMs
    m.tick();
    assert.equal(m.nudges.length, 1, '超 N 应发一次恢复 nudge');
    assert.equal(m.ends.length, 0, '未到 M 不应结束会话');
    // 同一时刻再 tick：距上次 nudge 未过 N → 节流，不重复发
    m.tick();
    assert.equal(m.nudges.length, 1, 'nudge 应被节流，不每 tick 重复');
    m.role.unsubscribe();
  });

  it('idle 超 M → 触发 session.should_end（看门狗终止，不死等 SIGTERM）', () => {
    const m = makeMonitor();
    m.role.subscribe();
    m.advance(240_001); // 超过 idleEndMs
    m.tick();
    assert.equal(m.ends.length, 1, '超 M 应触发 session.should_end');
    m.role.unsubscribe();
  });

  it('收到 edge 上报（page.cards.arrived）刷新活动时间 → 不误判 idle', () => {
    const m = makeMonitor();
    m.role.subscribe();
    m.advance(100_000);
    m.bus.emit('page.cards.arrived', { cards: [], ts: m.nowFn() }); // 刷新 lastActivityAt
    m.advance(100_000); // 距刷新仅 100s < N(130s)
    m.tick();
    assert.equal(m.nudges.length, 0, '活动刷新后不应误判 idle 发 nudge');
    assert.equal(m.ends.length, 0);
    m.role.unsubscribe();
  });

  it('unsubscribe 清理定时器；之后的残留 tick 不再产生事件（防泄漏/误触已结束会话）', () => {
    const m = makeMonitor();
    m.role.subscribe();
    m.role.unsubscribe();
    assert.deepEqual(m.cleared, ['HANDLE'], 'unsubscribe 应 clearInterval 一次');
    // 残留 tick：intervalHandle 已置空 → checkIdle 守卫直接 return
    m.advance(999_999);
    m.tick();
    assert.equal(m.nudges.length, 0, '结束后不应再发 nudge');
    assert.equal(m.ends.length, 0, '结束后不应再触发 should_end');
  });
});

// change session-auto-resume-with-excursions：可暂停时钟（巡视期延期时限、扣除其耗时）+ 看门狗阈值可配。
const DEFAULT_MAX_MS = 10 * 60_000; // DEFAULT_SESSION_DURATION_MS（缺省时长上限）

describe('SessionMonitorRole 可暂停时钟（excursion 不计时、不被时限打断）', () => {
  it('暂停期 action.completed 不触发时限结束；解除后补发', () => {
    const m = makeMonitor();
    m.role.subscribe(); // startedAt = 1_000_000
    // 不发 action.completed 地推进到超时长上限（checkSession 只在 action.completed/resume 时核）。
    m.advance(DEFAULT_MAX_MS + 5_000);
    m.role.pauseClock('patrol'); // 巡视开始：暂停时限判定
    m.advance(50_000); // 巡视耗时 50s
    // 暂停期即便来 action.completed 也不结束（延期）。
    m.bus.emit('action.completed', { action: 'scroll', ok: true, ts: m.nowFn() });
    assert.equal(m.ends.length, 0, '暂停期 MUST NOT 结束会话');
    m.role.resumeClock('patrol'); // 巡视结束：扣除 50s + 补核
    assert.equal(m.ends.length, 1, '解除后真实浏览时长仍超限 → 补发 should_end');
    m.role.unsubscribe();
  });

  it('巡视耗时从单场时长扣除：暂停覆盖了超限段则不结束', () => {
    const m = makeMonitor();
    m.role.subscribe(); // startedAt = 1_000_000
    m.advance(500_000); // 未超 600_000
    m.role.pauseClock('patrol');
    m.advance(200_000); // 若不扣除：500k+200k=700k>600k 会误判超限
    m.role.resumeClock('patrol'); // 扣除 200k → 真实浏览 500k < 600k
    assert.equal(m.ends.length, 0, '巡视那段被扣除，未超限 → 不结束');
    // 再真实浏览 110k → 真实 610k 超限，action.completed 触发结束。
    m.advance(110_000);
    m.bus.emit('action.completed', { action: 'scroll', ok: true, ts: m.nowFn() });
    assert.equal(m.ends.length, 1, '扣除后继续浏览至真实超限 → 结束');
    m.role.unsubscribe();
  });

  it('陌生 token resumeClock 为 no-op（不前移、不误结束）', () => {
    const m = makeMonitor();
    m.role.subscribe();
    m.role.resumeClock('never-paused'); // 未暂停 → no-op
    m.advance(300_000);
    m.bus.emit('action.completed', { action: 'scroll', ok: true, ts: m.nowFn() });
    assert.equal(m.ends.length, 0, '300s < 600s，no-op 未误前移导致误结束');
    m.role.unsubscribe();
  });

  it('暂停态绝不跨场残留：重订阅清空 pauseReasons', () => {
    const m = makeMonitor();
    m.role.subscribe();
    m.role.pauseClock('patrol');
    m.role.unsubscribe(); // restartSession 先拆旧订阅
    m.role.subscribe(); // 再重订阅 → 清空暂停态 + 重置 startedAt
    m.advance(DEFAULT_MAX_MS + 5_000);
    m.bus.emit('action.completed', { action: 'scroll', ok: true, ts: m.nowFn() });
    assert.equal(m.ends.length, 1, '重订阅已清暂停态 → 超限正常结束（未被残留暂停冻住）');
    m.role.unsubscribe();
  });

  it('巡视期不冻空闲看门狗：长时间无上报仍 idle-end 兜底', () => {
    const m = makeMonitor({ idleEndMs: 240_000 });
    m.role.subscribe();
    m.role.pauseClock('patrol'); // 暂停时限，但**不**冻 idle 看门狗
    m.advance(240_001); // 无任何上报
    m.tick();
    assert.equal(m.ends.length, 1, '暂停期空闲看门狗仍生效（卡死巡视兜底）');
    m.role.unsubscribe();
  });
});

describe('SessionMonitorRole 看门狗阈值可配（getIdle*Ms 热加载）', () => {
  function makeConfigurable(getEnd: () => number) {
    const bus = new EventBus();
    const ends: unknown[] = [];
    bus.on('session.should_end', (p) => {
      ends.push(p);
    });
    let now = 1_000_000;
    let tickFn: (() => void) | undefined;
    const role = new SessionMonitorRole({
      eventBus: bus,
      soul: mockSoul,
      getRemainingBudget: fullBudget,
      clock: () => now,
      getIdleEndMs: getEnd, // 按账号现读（热加载）
      idleTickMs: 5_000,
      setIntervalFn: (fn) => {
        tickFn = fn;
        return 'H';
      },
      clearIntervalFn: () => {},
    });
    return { role, ends, tick: () => tickFn?.(), advance: (ms: number) => (now += ms) };
  }

  it('idle-end 经 getIdleEndMs 现读：改阈值即生效', () => {
    let endMs = 300_000; // 5min
    const m = makeConfigurable(() => endMs);
    m.role.subscribe();
    m.advance(250_000);
    m.tick();
    assert.equal(m.ends.length, 0, '250s < 300s 不结束');
    m.advance(60_000); // 累计 310s
    m.tick();
    assert.equal(m.ends.length, 1, '310s > 300s → 结束（阈值经 thunk 现读）');
    m.role.unsubscribe();
  });
});
