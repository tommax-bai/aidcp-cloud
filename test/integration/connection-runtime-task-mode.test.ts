/**
 * 任务模式调度排除（期1-3）ConnectionRuntimeRegistry 集成单测。
 *
 * 用 FakeDispatcher 隔离注册表逻辑（与 connection-runtime.test.ts 同构），验证：
 *  - 开关开：mode=task 的会话握手照常建传输运行时，但 welcome 后不激活编排调度
 *    （不构造 RoleDispatcher），且被 runtimeForAccount / onlineAccountIds /
 *    onlineAccountIdentities 三个调度收口排除；同注册表内编排态会话不受影响；
 *  - 开关关（默认）：过滤短路，task 会话行为与编排态完全一致——与主干一致；
 *  - 排除日志按会话去重：枚举类路径每分钟跑也只记一次，断连清理去重表。
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
  setCurrentAccountId(a: string): void {
    this.accountId = a;
  }
  setup(): void {}
  tryStartSession(): void {}
  endSession(): void {}
}

interface Harness {
  registry: ConnectionRuntimeRegistry;
  built: DispatcherBuildContext[];
  logs: string[];
}

function makeHarness(taskModeExclusionEnabled: boolean): Harness {
  const built: DispatcherBuildContext[] = [];
  const logs: string[] = [];
  const logger = {
    log: (m: string) => {
      logs.push(m);
    },
    warn() {},
    error() {},
  };
  const registry = new ConnectionRuntimeRegistry({
    observerBus: new EventBus(),
    getController: async (accountId) => ({ accountId }) as unknown as RiskController,
    buildDispatcher: (ctx) => {
      built.push(ctx);
      return new FakeDispatcher() as unknown as RoleDispatcher;
    },
    ensureAccount: async () => {},
    getAccountPlatform: async () => 'xiaohongshu',
    getNickname: () => null,
    setNickname: async () => {},
    onConfigError: () => {},
    closeEdge: () => {},
    logger,
    taskModeExclusionEnabled,
  });
  return { registry, built, logs };
}

test('开关开：task 会话不激活编排调度，且被三个调度收口排除；编排态会话不受影响', async () => {
  const h = makeHarness(true);
  const taskSession: EdgeSession = { sessionId: 's-task', edgeId: 'ads-env-t', accountId: 'acc-task', mode: 'task' };
  const orchSession: EdgeSession = { sessionId: 's-orch', edgeId: 'ads-env-o', accountId: 'acc-orch' };

  assert.equal((await h.registry.onHandshake(taskSession)).ok, true, 'task 会话握手照常建传输运行时');
  assert.equal((await h.registry.onHandshake(orchSession)).ok, true);
  assert.equal(h.registry.runtimeCount(), 2, '两条传输运行时都在线（排除只作用于调度，不作用于传输）');

  h.registry.onWelcomed(taskSession);
  assert.equal(h.built.length, 0, 'task 会话 welcome 后不得构造 RoleDispatcher（transport-only）');
  h.registry.onWelcomed(orchSession);
  assert.equal(h.built.length, 1, '编排态会话照常构造 dispatcher');
  assert.equal(h.built[0]!.accountId, 'acc-orch');

  // 三个调度收口全部排除 task，编排态照常在列。
  assert.equal(h.registry.runtimeForAccount('acc-task'), null, '接管连接解析必须跳过 task');
  assert.ok(h.registry.runtimeForAccount('acc-orch'));
  assert.deepEqual(h.registry.onlineAccountIds(), ['acc-orch'], '排期扇出必须跳过 task');
  assert.deepEqual(h.registry.onlineAccountIdentities(), [{ accountId: 'acc-orch', envKey: 'env-o' }], '自动排期身份必须跳过 task');

  // 传输语义完好：task 会话仍有私有总线与 controller（后续执行引擎要用）。
  assert.equal(
    (h.registry.controllerForSession(taskSession) as unknown as { accountId: string }).accountId,
    'acc-task',
  );
});

test('开关关（默认）：过滤短路，task 会话行为与编排态完全一致——与主干一致', async () => {
  const h = makeHarness(false);
  const taskSession: EdgeSession = { sessionId: 's-task', edgeId: 'ads-env-t', accountId: 'acc-task', mode: 'task' };
  assert.equal((await h.registry.onHandshake(taskSession)).ok, true);
  h.registry.onWelcomed(taskSession);

  assert.equal(h.built.length, 1, '开关关时 task 会话照常构造 dispatcher');
  assert.ok(h.registry.runtimeForAccount('acc-task'));
  assert.deepEqual(h.registry.onlineAccountIds(), ['acc-task']);
  assert.deepEqual(h.registry.onlineAccountIdentities(), [{ accountId: 'acc-task', envKey: 'env-t' }]);
  assert.equal(h.logs.filter((m) => m.includes('调度排除')).length, 0, '开关关时不得出现排除日志');
});

test('排除日志可观测且按会话去重；断连后运行时拆除、去重表清理', async () => {
  const h = makeHarness(true);
  const taskSession: EdgeSession = { sessionId: 's-task', edgeId: 'ads-env-t', accountId: 'acc-task', mode: 'task' };
  await h.registry.onHandshake(taskSession);
  h.registry.onWelcomed(taskSession);

  const welcomeExclusions = h.logs.filter((m) => m.includes('调度排除') && m.includes('RoleDispatcher'));
  assert.equal(welcomeExclusions.length, 1, 'welcome 排除必须落日志（可观测）');
  assert.ok(welcomeExclusions[0]!.includes('ads-env-t'), '日志必须带环境标识');

  // 枚举类收口反复调用（模拟每分钟 tick），排除日志只记一次。
  h.registry.onlineAccountIds();
  h.registry.onlineAccountIds();
  h.registry.onlineAccountIdentities();
  h.registry.runtimeForAccount('acc-task');
  const enumExclusions = h.logs.filter((m) => m.includes('调度排除') && !m.includes('RoleDispatcher'));
  assert.equal(enumExclusions.length, 1, '同会话枚举类排除日志必须去重为一条');
  assert.ok(enumExclusions[0]!.includes('acc-task'), '日志必须带账号');

  // 断连：运行时拆除，模式随会话失效。
  h.registry.onDisconnect(taskSession);
  assert.equal(h.registry.runtimeCount(), 0);
  assert.deepEqual(h.registry.onlineAccountIds(), []);
});
