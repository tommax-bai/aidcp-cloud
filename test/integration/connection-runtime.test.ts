/**
 * 按连接多租户运行时注册表（multi-account-node-support D1/D2/D4/D7 重连）单测。
 * 用 FakeDispatcher 隔离注册表逻辑：握手校验 / 新账号登记 / 私有总线 + tee / 同 edgeId 顶替 / 断连拆除 / 并行第二节点。
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
  setupCalled = false;
  starts = 0;
  ends = 0;
  setCurrentAccountId(a: string): void {
    this.accountId = a;
  }
  setup(): void {
    this.setupCalled = true;
  }
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

interface Harness {
  registry: ConnectionRuntimeRegistry;
  observerBus: EventBus;
  built: DispatcherBuildContext[];
  ensured: string[];
  configErrors: { edgeId?: string; message: string }[];
  closed: string[];
  dispatchers: FakeDispatcher[];
}

function makeHarness(): Harness {
  const observerBus = new EventBus();
  const built: DispatcherBuildContext[] = [];
  const ensured: string[] = [];
  const configErrors: { edgeId?: string; message: string }[] = [];
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
    onConfigError: (session, message) => {
      configErrors.push({ edgeId: session.edgeId, message });
    },
    closeEdge: (sessionId) => {
      closed.push(sessionId);
    },
    logger: silent,
  });
  return { registry, observerBus, built, ensured, configErrors, closed, dispatchers };
}

test('缺 accountId 握手被当配置错误拒绝：不建运行时、发配置告警、绝不偷映射 default', async () => {
  const h = makeHarness();
  const session: EdgeSession = { sessionId: 's1', edgeId: 'e1' }; // 无 accountId
  const outcome = await h.registry.onHandshake(session);
  assert.equal(outcome.ok, false);
  assert.equal(h.registry.runtimeCount(), 0);
  assert.equal(h.configErrors.length, 1);
  assert.equal(h.ensured.length, 0); // 未登记任何账号（绝不当 default）
  assert.equal(h.built.length, 0); // 未建 dispatcher
});

test('空白 accountId 同样被拒（trim 后为空）', async () => {
  const h = makeHarness();
  const outcome = await h.registry.onHandshake({ sessionId: 's1', edgeId: 'e1', accountId: '   ' });
  assert.equal(outcome.ok, false);
  assert.equal(h.registry.runtimeCount(), 0);
});

test('edge-command-target-guard R1：缺 edgeId 握手被当配置错误拒绝，不建运行时（无可路由出站身份）', async () => {
  const h = makeHarness();
  const session: EdgeSession = { sessionId: 's1', accountId: 'acctA' }; // 有账号、无 edgeId
  const outcome = await h.registry.onHandshake(session);
  assert.equal(outcome.ok, false);
  assert.equal((outcome as { code: string }).code, 'missing_edge_id');
  assert.equal(h.registry.runtimeCount(), 0); // 不建运行时
  assert.equal(h.configErrors.length, 1); // 发配置告警
  assert.equal(h.built.length, 0); // 未建 dispatcher
});

test('edge-command-target-guard R1：空白 edgeId 同样被拒（trim 后为空）', async () => {
  const h = makeHarness();
  const outcome = await h.registry.onHandshake({ sessionId: 's1', edgeId: '   ', accountId: 'acctA' });
  assert.equal(outcome.ok, false);
  assert.equal((outcome as { code: string }).code, 'missing_edge_id');
  assert.equal(h.registry.runtimeCount(), 0);
});

test('合法账号握手：登记账号 + 解析 controller + 建私有总线运行时（setup + setCurrentAccountId）', async () => {
  const h = makeHarness();
  const session: EdgeSession = { sessionId: 's1', edgeId: 'eA', accountId: 'acctA' };
  const outcome = await h.registry.onHandshake(session);
  assert.equal(outcome.ok, true);
  assert.deepEqual(h.ensured, ['acctA']);
  assert.equal(h.registry.runtimeCount(), 1);
  assert.equal(h.built[0]!.accountId, 'acctA');
  assert.equal(h.built[0]!.edgeId, 'eA');
  assert.equal(h.dispatchers[0]!.setupCalled, true);
  assert.equal(h.dispatchers[0]!.accountId, 'acctA');
  // 私有总线：busFor 返回该连接独立总线（非全局观测总线）。
  const bus = h.registry.busFor(session);
  assert.notEqual(bus, h.observerBus);
  // controllerForSession 返回该连接 controller。
  assert.equal((h.registry.controllerForSession(session) as unknown as { accountId: string }).accountId, 'acctA');
});

test('两连接（不同账号）私有总线互相隔离 + 各自 tee 到全局观测总线（看板聚合）', async () => {
  const h = makeHarness();
  const sA: EdgeSession = { sessionId: 'sA', edgeId: 'eA', accountId: 'A' };
  const sB: EdgeSession = { sessionId: 'sB', edgeId: 'eB', accountId: 'B' };
  await h.registry.onHandshake(sA);
  await h.registry.onHandshake(sB);
  const busA = h.registry.busFor(sA);
  const busB = h.registry.busFor(sB);
  assert.notEqual(busA, busB); // 两条私有通道互不相同

  // 隔离：A 通道上的事件，B 通道订阅者收不到。
  let bSaw = 0;
  busB.on('feed.entered', () => {
    bSaw++;
  });
  // 聚合：两条私有通道的事件都 tee 到全局观测总线。
  const observed: string[] = [];
  h.observerBus.onAny((event) => observed.push(event));
  busA.emit('feed.entered', { pageType: 'feed', trigger: 'session_start', ts: 1 });
  busB.emit('feed.entered', { pageType: 'feed', trigger: 'session_start', ts: 2 });
  assert.equal(bSaw, 1); // B 只收到自己通道的那一次，不混入 A 的
  assert.equal(observed.filter((e) => e === 'feed.entered').length, 2); // 全局观测总线聚合到两次
});

test('同 edgeId 重连顶替旧连接（收掉旧 ws），不计为并行第二节点', async () => {
  const h = makeHarness();
  await h.registry.onHandshake({ sessionId: 's1', edgeId: 'eX', accountId: 'A' });
  await h.registry.onHandshake({ sessionId: 's2', edgeId: 'eX', accountId: 'A' }); // 同 edgeId 重连
  assert.deepEqual(h.closed, ['s1']); // 顶替：收掉旧 sessionId 的连接
});

test('同 edgeId 换账号重连（profile 换号 A→B，account-identity-from-login 2.1）：顶替旧连接 + 新运行时按 B 建、按 B 重过就绪闸（拆旧起新不串味）', async () => {
  const h = makeHarness();
  await h.registry.onHandshake({ sessionId: 's1', edgeId: 'eX', accountId: 'A' });
  const s2: EdgeSession = { sessionId: 's2', edgeId: 'eX', accountId: 'B' };
  const outcome = await h.registry.onHandshake(s2);
  assert.equal(outcome.ok, true);
  assert.deepEqual(h.closed, ['s1']); // 按 edgeId 顶替旧连接（与账号是否相同无关）→ 触发旧账号运行时拆除
  assert.deepEqual(h.ensured, ['A', 'B']); // 新账号 B 也登记进主表
  assert.equal(h.built[1]!.accountId, 'B'); // 新运行时绑 B（私有总线 + B 的 controller + 就绪闸）
  assert.equal((h.registry.controllerForSession(s2) as unknown as { accountId: string }).accountId, 'B');
});

test('同账号不同 edgeId = 真并行第二节点：两运行时并存、不顶替', async () => {
  const h = makeHarness();
  await h.registry.onHandshake({ sessionId: 's1', edgeId: 'eA', accountId: 'A' });
  await h.registry.onHandshake({ sessionId: 's2', edgeId: 'eB', accountId: 'A' }); // 不同 edgeId
  assert.equal(h.closed.length, 0); // 不顶替
  assert.equal(h.registry.runtimeCount(), 2); // 并存
});

test('断连拆除运行时：结束会话 + 移除登记', async () => {
  const h = makeHarness();
  const session: EdgeSession = { sessionId: 's1', edgeId: 'eA', accountId: 'A' };
  await h.registry.onHandshake(session);
  assert.equal(h.registry.runtimeCount(), 1);
  h.registry.onDisconnect(session);
  assert.equal(h.registry.runtimeCount(), 0);
  assert.equal(h.dispatchers[0]!.ends, 1); // endSession 被调用
  // 断连后 busFor 回落全局观测总线（无运行时）。
  assert.equal(h.registry.busFor(session), h.observerBus);
});
