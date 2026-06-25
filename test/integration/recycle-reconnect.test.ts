/**
 * 节点回收（edge-own-chrome-supervised-recycle）下的云端不变量回归。
 *
 * 边缘节点失去浏览器到终态时会「诚实下线 + 退出 + 看护重起」，这会在同一 edgeId 上制造
 * 比以往**高得多的断连→重新握手频率**。本测试守住该高频回收模式下的既有不变量（云端零业务码改动）：
 *  - 回收（断连）拆除该连接的运行时（结束会话），随后同槽位新握手干净起一个新运行时；
 *  - 回收一个节点**绝不广播**结束给兄弟节点（multi-account 隔离 + a38fb96 红线：不向所有 edge 广播 session.end）；
 *  - 旧 ws 未拆时同 edgeId 新握手到 → 顶替驱逐旧连接、只活一个运行时（快速重连竞态）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionRuntimeRegistry, type DispatcherBuildContext } from '../../src/orchestrator/connection-runtime.js';
import { EventBus } from '../../src/event-bus/index.js';
import type { RoleDispatcher } from '../../src/orchestrator/role-dispatcher.js';
import type { RiskController } from '../../src/risk/index.js';
import type { EdgeSession } from '../../src/comm/ws-server.js';

class FakeDispatcher {
  accountId = '';
  active = false;
  starts = 0;
  ends = 0;
  setCurrentAccountId(a: string): void {
    this.accountId = a;
  }
  setup(): void {}
  tryStartSession(): void {
    this.active = true;
    this.starts++;
  }
  endSession(): void {
    this.active = false;
    this.ends++;
  }
}

const silent = { log() {}, warn() {}, error() {} };

function makeHarness() {
  const observerBus = new EventBus();
  const built: DispatcherBuildContext[] = [];
  const ensured: string[] = [];
  const closed: string[] = [];
  const dispatchers: FakeDispatcher[] = [];
  const registry = new ConnectionRuntimeRegistry({
    observerBus,
    getController: async (accountId) => ({ accountId }) as unknown as RiskController,
    buildDispatcher: (ctx) => {
      built.push(ctx);
      const d = new FakeDispatcher();
      dispatchers.push(d);
      return d as unknown as RoleDispatcher;
    },
    ensureAccount: async (accountId) => {
      ensured.push(accountId);
    },
    onConfigError: () => {},
    closeEdge: (sessionId) => {
      closed.push(sessionId);
    },
    logger: silent,
  });
  return { registry, observerBus, built, ensured, closed, dispatchers };
}

test('回收（断连）拆除运行时，随后同槽位重新握手干净起一个新运行时', async () => {
  const h = makeHarness();
  const s1: EdgeSession = { sessionId: 's1', edgeId: 'eX', accountId: 'A' };
  await h.registry.onHandshake(s1);
  assert.equal(h.registry.runtimeCount(), 1);

  // 节点回收退出 → 边-云连接干净关闭 → 云端断连拆除
  h.registry.onDisconnect(s1);
  assert.equal(h.registry.runtimeCount(), 0);
  assert.equal(h.dispatchers[0]!.ends, 1, '回收应结束该连接的会话（拆除）');

  // 看护重起的新进程握手回来（同 edgeId、同账号）
  const s2: EdgeSession = { sessionId: 's2', edgeId: 'eX', accountId: 'A' };
  const outcome = await h.registry.onHandshake(s2);
  assert.equal(outcome.ok, true);
  assert.equal(h.registry.runtimeCount(), 1, '重起后恰好一个运行时');
  assert.equal(h.built.length, 2, '为重起的新连接建了一个全新的运行时');
});

test('回收一个节点绝不广播结束给兄弟节点（隔离 + a38fb96 红线）', async () => {
  const h = makeHarness();
  const s1: EdgeSession = { sessionId: 's1', edgeId: 'eX', accountId: 'A' };
  const s2: EdgeSession = { sessionId: 's2', edgeId: 'eY', accountId: 'B' };
  await h.registry.onHandshake(s1);
  await h.registry.onHandshake(s2);
  assert.equal(h.registry.runtimeCount(), 2);

  // 仅回收 eX
  h.registry.onDisconnect(s1);

  assert.equal(h.dispatchers[0]!.ends, 1, 'eX 运行时被拆除');
  assert.equal(h.dispatchers[1]!.ends, 0, 'eY（兄弟节点）运行时绝不受影响——不广播结束');
  assert.equal(h.registry.runtimeCount(), 1, '只剩 eY 一个运行时');
});

test('高频回收：旧 ws 未拆时同 edgeId 新握手到 → 顶替驱逐旧，最终收敛到只活一个运行时', async () => {
  const h = makeHarness();
  const s1: EdgeSession = { sessionId: 's1', edgeId: 'eX', accountId: 'A' };
  await h.registry.onHandshake(s1);
  // 硬退出无干净 FIN 的边角：新进程握手到时旧连接尚未被云端判掉
  const s2: EdgeSession = { sessionId: 's2', edgeId: 'eX', accountId: 'A' };
  await h.registry.onHandshake(s2);

  // 顶替即时请求驱逐旧 ws；旧运行时与新短暂并存，待旧 ws 真关闭再拆（真实异步序列）。
  assert.deepEqual(h.closed, ['s1'], '同 edgeId 顶替：请求驱逐旧 sessionId 的连接');
  assert.equal(h.dispatchers[0]!.ends, 0, '此刻旧运行时尚未拆（等旧 ws 真关闭）');

  // closeEdge 关旧 ws → onDisconnect(s1) → 拆旧运行时，收敛到单运行时。
  h.registry.onDisconnect(s1);
  assert.equal(h.dispatchers[0]!.ends, 1, '旧运行时最终被拆除');
  assert.equal(h.registry.runtimeCount(), 1, '收敛到只活一个运行时（新连接，不会两个长期并存争路由）');
});
