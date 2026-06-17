import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { SessionMonitorRole } from '../../src/agents/session-monitor-role.js';
import type { Soul } from '../../src/soul/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['编程'], seed_keywords: ['GPT'] },
  session_limits: {
    max_duration_min: 10,
    max_likes: 8,
    max_collects: 5,
    max_searches: 3,
    cooldown_between_actions_sec: [2, 5] as [number, number],
  },
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
