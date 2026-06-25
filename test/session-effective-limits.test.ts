import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/event-bus/index.js';
import { SessionMonitorRole } from '../src/agents/session-monitor-role.js';
import { RoleDispatcher } from '../src/orchestrator/role-dispatcher.js';
import { DEFAULT_SESSION_DURATION_MS, type SessionLimitProvider } from '../src/risk/session-limits.js';
import type { Soul } from '../src/soul/types.js';

const mockSoul: Soul = {
  identity: { name: 'T', role: 'r', background: 'b', tone: 't' },
  interests: { primary: ['AI'], secondary: ['x'], seed_keywords: ['k'] },
};
const fullBudget = () => ({ likes: 8, collects: 5, follows: 3, searches: 3 });

/** 构造注入假时钟 + 定时器桩的看门狗；getMaxDurationMs 可选。 */
function makeMonitor(getMaxDurationMs?: () => number) {
  const bus = new EventBus();
  const ends: unknown[] = [];
  bus.on('session.should_end', (p) => {
    ends.push(p);
  });
  let now = 1_000_000;
  const role = new SessionMonitorRole({
    eventBus: bus,
    soul: mockSoul,
    getRemainingBudget: fullBudget,
    getMaxDurationMs,
    clock: () => now,
    setIntervalFn: () => 'HANDLE',
    clearIntervalFn: () => {},
  });
  return {
    role,
    bus,
    ends,
    advance: (ms: number) => { now += ms; },
  };
}

describe('SessionMonitorRole 时长上限解析（change session-limits-to-quota-layer）', () => {
  it('注入 getMaxDurationMs → 按其值到点判定（不再直读人设）', () => {
    const m = makeMonitor(() => 100_000);
    m.role.subscribe();
    m.advance(100_001); // 超注入时长
    m.bus.emit('action.completed', { action: 'scroll', ok: true, ts: 0 }); // 触发 checkSession
    assert.equal(m.ends.length, 1, '超注入时长上限应触发 session.should_end');
    m.role.unsubscribe();
  });

  it('未注入 getMaxDurationMs 且无显式覆盖 → 回落写死默认 10min（零回归）', () => {
    const m = makeMonitor(); // 无 provider
    m.role.subscribe();
    m.advance(DEFAULT_SESSION_DURATION_MS - 1); // 599_999ms < 600_000ms
    m.bus.emit('action.completed', { action: 'scroll', ok: true, ts: 0 });
    assert.equal(m.ends.length, 0, '未到默认时长上限不应结束');
    m.advance(2); // 跨过 600_000ms
    m.bus.emit('action.completed', { action: 'scroll', ok: true, ts: 0 });
    assert.equal(m.ends.length, 1, '超默认时长上限(10min)应结束');
    m.role.unsubscribe();
  });
});

describe('RoleDispatcher 单场互动预算来源（change session-limits-to-quota-layer）', () => {
  function makeDispatcher(provider?: SessionLimitProvider): RoleDispatcher {
    return new RoleDispatcher({
      soul: mockSoul,
      llm: { complete: async () => '{}' },
      sendCommand: () => {},
      ...(provider ? { sessionLimitProvider: provider } : {}),
    });
  }

  it('注入提供者 → 会话预算按提供者（更小预算更快耗尽 → 会话终止）', () => {
    const provider: SessionLimitProvider = {
      sessionDurationMsFor: () => DEFAULT_SESSION_DURATION_MS,
      sessionBudgetFor: () => ({ likes: 1, collects: 1, follows: 1, searches: 1, comments: 1, comment_likes: 1 }),
    };
    const d = makeDispatcher(provider);
    d.setup();
    d.startSession();
    // 提供者预算 likes/collects/searches 各 1 → 各扣一次即耗尽
    d.consumeBudget('like');
    d.consumeBudget('collect');
    d.consumeBudget('search');
    d.bus.emit('action.completed', { action: 'scroll', ok: true, ts: Date.now() });
    assert.equal(d.active, false, '提供者小预算耗尽后会话应终止');
  });

  it('零回归：不注入提供者 → 默认预算(10/5/5)，相同少量消费不致耗尽', () => {
    const d = makeDispatcher(); // 无提供者
    d.setup();
    d.startSession();
    d.consumeBudget('like');
    d.consumeBudget('collect');
    d.consumeBudget('search');
    d.bus.emit('action.completed', { action: 'scroll', ok: true, ts: Date.now() });
    assert.equal(d.active, true, '默认预算下相同少量消费不应耗尽（证明默认仍是 10/5/5）');
    d.endSession();
  });
});
