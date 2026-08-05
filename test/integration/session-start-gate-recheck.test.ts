/**
 * 启动闸复判通道（change recheck-session-start-gate）。
 *
 * 钉住的是「可恢复类拒绝绝不落终态」这条：被人设 / 副本类原因挡住的连接必须自己回来问第二遍，
 * 而结构性拒绝与运营显式停机不得被顺手纳入。承重那条是「连接拆除后复判不得再触发」——
 * 一个活过连接的复判会对着已断开的连接起会话发命令，比它要修的原缺陷更坏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher, type EdgeCommand } from '../../src/orchestrator/role-dispatcher.js';
import type { Soul } from '../../src/kernel/soul-types.js';
import type { PersonaBinding } from '../../src/kernel/persona-binding.js';
import type { PlatformId } from '../../src/kernel/platform-types.js';

const mockSoul: Soul = {
  identity: { name: 'T', role: 'r', background: 'b', tone: 't' },
  interests: { primary: ['AI'], secondary: ['x'], seed_keywords: ['k'] },
};

/** 手动推进的计时器：只记录待发项，由用例显式触发，绝不依赖墙钟。 */
function makeTimers() {
  let seq = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    pending,
    setTimeoutFn: (fn: () => void, ms: number): unknown => {
      const id = ++seq;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeoutFn: (h: unknown): void => {
      pending.delete(h as number);
    },
    /** 触发当前所有待发项（按排入序），返回它们各自的延迟。 */
    fireAll(): number[] {
      const snapshot = [...pending.entries()];
      pending.clear();
      const delays: number[] = [];
      for (const [, item] of snapshot) {
        delays.push(item.ms);
        item.fn();
      }
      return delays;
    },
  };
}

function make(opts: {
  personaBinding?: (a: string) => PersonaBinding;
  isDispatchActive?: () => boolean;
  accountPlatform?: PlatformId;
}) {
  const rejected: { accountId: string; reason: string }[] = [];
  const commands: EdgeCommand[] = [];
  const timers = makeTimers();
  const d = new RoleDispatcher({
    getSoul: () => mockSoul,
    llm: { complete: async () => '-1' },
    sendCommand: (c) => commands.push(c),
    accountPlatform: opts.accountPlatform ?? 'xiaohongshu',
    hasIdentityReadSelfProfile: () => true,
    personaBinding: opts.personaBinding,
    isDispatchActive: opts.isDispatchActive,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onSessionRejected: (accountId, reason) => {
      rejected.push({ accountId, reason });
    },
  });
  d.setup();
  return { d, rejected, commands, timers };
}

test('未绑人设被拒 → 人设补齐后复判到点即就地开跑（会话激活 + 重驱边端），且首次被拒只告警一次', () => {
  let binding: PersonaBinding = 'unbound';
  const { d, rejected, commands, timers } = make({ personaBinding: () => binding });

  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctX', ts: 1 });
  assert.equal(d.active, false, '握手当下未绑人设 → 不启动');
  assert.deepEqual(rejected, [{ accountId: 'acctX', reason: 'needs_persona_setup' }]);
  assert.equal(timers.pending.size, 1, '可恢复类拒绝必须武装复判，绝不落终态');

  // 自动补人设 / 运营手动设置落到副本 —— 云端读到的事实自己变好了。
  binding = 'bound';
  const delays = timers.fireAll();
  assert.deepEqual(delays, [2000], '首跳须短到覆盖补人设竞态（实测窗口 0.1~0.8s）');

  assert.equal(d.active, true, '复判放行 → 就地开跑，不需要边缘重连');
  assert.ok(commands.some((c) => c.action === 'scroll'), '须补一条重驱唤醒干等命令的边端');
  assert.equal(rejected.length, 1, '复判 MUST NOT 重复触发「会话被拒」回调');
  assert.equal(timers.pending.size, 0, '会话起来后复判须解除武装');
  d.endSession();
});

test('持续未绑人设：每跳静默、退避逐格拉长并稳定在末位，绝不重复触发被拒回调', () => {
  const { d, rejected, timers } = make({ personaBinding: () => 'unbound' });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctX', ts: 1 });

  const seen: number[] = [];
  for (let i = 0; i < 6; i++) seen.push(...timers.fireAll());

  assert.deepEqual(seen, [2000, 5000, 10000, 30000, 60000, 60000], '退避按节奏拉长后稳定，不再增长');
  assert.equal(rejected.length, 1, '被拒只在首次记一次，复判 MUST NOT 制造脉冲');
  assert.equal(d.active, false);
  assert.equal(timers.pending.size, 1, '仍被挡住 → 通道保持武装，绝不放弃');
  d.endSession();
});

test('承重：连接拆除（会话从未激活）后复判解除，绝不对已断开的连接起会话或发命令', () => {
  let binding: PersonaBinding = 'unbound';
  const { d, commands, timers } = make({ personaBinding: () => binding });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctX', ts: 1 });
  assert.equal(timers.pending.size, 1);

  d.endSession('disconnect'); // 连接拆除走的正是这条路（此时 sessionActive 恒 false）
  assert.equal(timers.pending.size, 0, '解除动作必须排在「本来就不活跃即返回」的短路之前');

  binding = 'bound'; // 即使事实此后变好，也不该有任何东西替一条死连接开跑
  timers.fireAll();
  assert.equal(d.active, false);
  assert.equal(commands.length, 0);
});

test('平台无浏览能力是真结构性拒绝 → 不武装复判，维持终态', () => {
  const { d, timers } = make({ personaBinding: () => 'bound', accountPlatform: 'wechat_channels' });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctX', ts: 1 });
  assert.equal(d.active, false);
  assert.equal(timers.pending.size, 0, '重来一万次也一样的结论 MUST NOT 复判');
  d.endSession();
});

test('全局调度开关关闭不纳入复判：运营的显式停机不得被任一连接自动解除', () => {
  const { d, timers } = make({ personaBinding: () => 'bound', isDispatchActive: () => false });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctX', ts: 1 });
  assert.equal(d.active, false);
  assert.equal(timers.pending.size, 0);
  d.endSession();
});

test('复判到点时会话已被别的路径起来 → 直接解除武装，不重复起会话、不重复重驱', () => {
  let binding: PersonaBinding = 'unbound';
  const { d, commands, timers } = make({ personaBinding: () => binding });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctX', ts: 1 });
  assert.equal(timers.pending.size, 1);

  // 人设补齐后边缘自己重连（既有路径）先把会话起来了。
  binding = 'bound';
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctX', ts: 2 });
  assert.equal(d.active, true);
  const beforeRecheck = commands.length;

  timers.fireAll(); // 此时复判已在会话激活处解除；即便残留一跳也必须是 no-op
  assert.equal(d.active, true);
  assert.equal(commands.length, beforeRecheck, '不得因复判重复重驱');
  d.endSession();
});
