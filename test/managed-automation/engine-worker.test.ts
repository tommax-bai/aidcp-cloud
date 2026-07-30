/**
 * 期1-5 TaskRun worker 单测：认领互斥 / 检查点续跑 / 租约过期接管 / cancel 安全点 /
 * 总开关 / 诚实终态聚合。全部走假执行器 + 内存 fakes（engine-fakes.ts），
 * 每个用例末尾 assertAllInvariantsHold() 兜底正交不变式全程满足。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionPlanInsert, TaskRunInsert } from '../../src/managed-automation/stores/index.js';
import {
  MANAGED_AUTOMATION_WORKER_ENV,
  TaskRunWorker,
  aggregateRunOutcome,
  isManagedAutomationWorkerEnabled,
  type TaskRunWorkerDeps,
} from '../../src/managed-automation/engine/index.js';
import { FakeClock, FakeStepExecutor, InMemoryPlanAuthority, InMemoryRunState } from './engine-fakes.js';

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

const makePlanInsert = (nodeIds: string[], disabled: string[] = []): ExecutionPlanInsert => ({
  executionPlanId: 'plan-1',
  taskId: 'task-1',
  taskRevisionId: 'rev-1',
  executionTarget: 'dev',
  taskDefinitionId: 'def-1',
  taskDefinitionVersion: 1,
  planId: null,
  planVersion: null,
  authorizationRef: 'auth:none',
  nodes: nodeIds.map((nodeId) => ({
    nodeId,
    capabilityId: `cap.${nodeId}`,
    capabilityVersion: 1,
    inputBindingRef: `bind:${nodeId}`,
    enabled: !disabled.includes(nodeId),
  })),
  edges: nodeIds.slice(0, -1).map((from, i) => ({ kind: 'linear', from, to: nodeIds[i + 1] })),
  entryNodeId: nodeIds[0],
  bounds: {
    maxNodes: 10, maxLoopIterations: 0, maxDerivationDepth: 1,
    maxExecutionAttempts: 3, maxWallClockMs: 60_000,
  },
  completionConditionRef: 'complete:all-steps',
});

const makeRunInsert = (overrides: Partial<TaskRunInsert> = {}): TaskRunInsert => ({
  runId: 'run-1', taskId: 'task-1', taskRevisionId: 'rev-1', executionPlanId: 'plan-1',
  cycleId: null, executionTarget: 'dev', correlationId: 'corr-1', planId: null, planVersion: null,
  taskDefinitionId: 'def-1', taskDefinitionVersion: 1, personaVersion: null,
  accountId: 'acc-1', envKey: 'env-1', platform: 'facebook' as never,
  accountBindingRevision: 'bind-1', candidateVersionId: null, contentVersion: null,
  approvalRevision: null, schedule: { scheduledAt: 1, latestStartAt: 2, missPolicy: 'skip' },
  budgets: { platformRisk: null, executionResource: null, aiContent: null },
  idempotencyKey: 'idem-1', status: 'queued', waitReason: null, terminalOutcome: null,
  reasonCode: null,
  ...overrides,
});

interface Harness {
  clock: FakeClock;
  runState: InMemoryRunState;
  planAuthority: InMemoryPlanAuthority;
  executor: FakeStepExecutor;
  worker: TaskRunWorker;
  makeWorker: (deps?: Partial<TaskRunWorkerDeps>) => TaskRunWorker;
}

async function makeHarness(
  nodeIds: string[] = ['n1', 'n2', 'n3'],
  options: { disabled?: string[]; deps?: Partial<TaskRunWorkerDeps> } = {},
): Promise<Harness> {
  const clock = new FakeClock();
  const runState = new InMemoryRunState(clock.now);
  const planAuthority = new InMemoryPlanAuthority(clock.now);
  const executor = new FakeStepExecutor();
  await planAuthority.insertExecutionPlan('dev', makePlanInsert(nodeIds, options.disabled ?? []));
  const makeWorker = (deps: Partial<TaskRunWorkerDeps> = {}): TaskRunWorker =>
    new TaskRunWorker({
      executionTarget: 'dev',
      runState,
      planAuthority,
      executorFor: () => executor,
      enabled: true,
      now: clock.now,
      leaseMs: 60_000,
      renewIntervalMs: 3_600_000, // 单测里不靠续租定时器（不真实计时），续租语义单独测
      logger: silentLogger,
      ...deps,
    });
  return { clock, runState, planAuthority, executor, worker: makeWorker(options.deps), makeWorker };
}

test('总开关：默认关闭，仅显式 true 启动；关闭时 start() 返回 false', async () => {
  assert.equal(isManagedAutomationWorkerEnabled({}), false, '缺省必须关闭');
  assert.equal(isManagedAutomationWorkerEnabled({ [MANAGED_AUTOMATION_WORKER_ENV]: '1' }), false, "非 'true' 一律关闭");
  assert.equal(isManagedAutomationWorkerEnabled({ [MANAGED_AUTOMATION_WORKER_ENV]: 'true' }), true);

  const logged: string[] = [];
  const { makeWorker, runState, executor } = await makeHarness(['n1']);
  const disabledWorker = makeWorker({
    enabled: false,
    logger: { log: (msg: string) => logged.push(msg), warn: () => {}, error: () => {} },
  });
  assert.equal(disabledWorker.start(), false, '开关关闭必须拒绝启动');
  assert.ok(logged.some((msg) => msg.includes(MANAGED_AUTOMATION_WORKER_ENV)), '拒绝启动必须点名开关，不静默');

  // 未启动时 enqueue 只落库不执行（wake 是 no-op）。
  assert.equal(await disabledWorker.enqueue(makeRunInsert()), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executor.calls.length, 0, '开关关闭绝不执行');
  const run = await runState.getRun('dev', 'run-1');
  assert.equal(run?.status, 'queued');
  runState.assertAllInvariantsHold();
});

test('enqueue 落库幂等 + tick 执行整链 → run terminal/succeeded、检查点齐全', async () => {
  const { runState, executor, worker } = await makeHarness(['n1', 'n2', 'n3']);
  assert.equal(await worker.enqueue(makeRunInsert()), true);
  assert.equal(await worker.enqueue(makeRunInsert()), false, '同 idempotencyKey 重放返回 false');

  assert.equal(await worker.tick(), 1);
  const run = await runState.getRun('dev', 'run-1');
  assert.equal(run?.status, 'terminal');
  assert.equal(run?.terminalOutcome, 'succeeded');
  assert.equal(run?.reasonCode, null);
  assert.deepEqual(
    { confirmed: run?.progress.confirmedCount, attempts: run?.progress.attemptCount, skipped: run?.progress.skippedCount },
    { confirmed: 3, attempts: 3, skipped: 0 },
  );
  assert.equal(run?.currentNodeId, 'n3', '每步完成必须写检查点（currentNodeId 推进到末节点）');

  const steps = await runState.listStepRunsByRun('dev', 'run-1');
  assert.deepEqual(steps.map((s) => s.nodeId), ['n1', 'n2', 'n3']);
  for (const step of steps) {
    assert.equal(step.status, 'terminal');
    assert.equal(step.terminalOutcome, 'succeeded');
    assert.equal(step.checkpointRef, `ckpt:${step.nodeId}`);
    assert.equal(step.attemptCount, 1);
  }
  assert.deepEqual(executor.calls.map((c) => c.nodeId), ['n1', 'n2', 'n3']);
  runState.assertAllInvariantsHold();
});

test('认领互斥：两个 worker 并发 tick，同一 run 每个节点只执行一次', async () => {
  const { runState, executor, makeWorker } = await makeHarness(['n1', 'n2']);
  await runState.insertRun('dev', makeRunInsert());
  const [a, b] = await Promise.all([makeWorker().tick(), makeWorker().tick()]);
  assert.equal(a + b, 1, 'claimNextQueued 原子认领：恰好一个 worker 拿到');
  for (const nodeId of ['n1', 'n2']) {
    assert.equal(executor.callCount(nodeId), 1, `节点 ${nodeId} 必须恰好执行一次`);
  }
  const run = await runState.getRun('dev', 'run-1');
  assert.equal(run?.terminalOutcome, 'succeeded');
  runState.assertAllInvariantsHold();
});

test('租约过期接管 + 检查点续跑：不重跑已完成步，从残留检查点继续', async () => {
  const { clock, runState, executor, worker } = await makeHarness(['n1', 'n2', 'n3']);
  // 模拟已崩溃的前任 worker：认领后完成 n1、n2 执行到一半（running + 检查点）。
  await runState.insertRun('dev', makeRunInsert());
  const claimed = await runState.claimNextQueued('dev', 'dead-token', 60_000);
  assert.ok(claimed);
  await runState.insertStepRun('dev', {
    stepRunId: 's1', runId: 'run-1', nodeId: 'n1', capabilityId: 'cap.n1', capabilityVersion: 1,
    executionTarget: 'dev', inputRef: 'bind:n1',
    status: 'queued', waitReason: null, terminalOutcome: null, reasonCode: null,
  });
  await runState.transitionStep('dev', 's1', 'queued', { status: 'running', waitReason: null, terminalOutcome: null, reasonCode: null });
  await runState.recordStepCheckpoint('dev', 's1', 'ckpt:n1', 'result:n1');
  await runState.transitionStep('dev', 's1', 'running', { status: 'terminal', waitReason: null, terminalOutcome: 'succeeded', reasonCode: null });
  await runState.recordRunProgress('dev', 'run-1', 'dead-token',
    { confirmedCount: 1, targetCount: null, attemptCount: 1, skippedCount: 0, failureCount: 0 }, 'n1');
  await runState.insertStepRun('dev', {
    stepRunId: 's2', runId: 'run-1', nodeId: 'n2', capabilityId: 'cap.n2', capabilityVersion: 1,
    executionTarget: 'dev', inputRef: 'bind:n2',
    status: 'queued', waitReason: null, terminalOutcome: null, reasonCode: null,
  });
  await runState.transitionStep('dev', 's2', 'queued', { status: 'running', waitReason: null, terminalOutcome: null, reasonCode: null });
  await runState.recordStepCheckpoint('dev', 's2', 'ckpt:n2-partial', null);

  // 前任死亡：推表越过租约，新 worker 的 tick 先回收再接管。
  clock.advance(61_000);
  assert.equal(await worker.tick(), 1);

  assert.equal(executor.callCount('n1'), 0, '已终态步是检查点真相，不得重跑');
  assert.equal(executor.callCount('n2'), 1);
  assert.equal(executor.callCount('n3'), 1);
  assert.equal(
    executor.calls.find((c) => c.nodeId === 'n2')?.checkpointRef,
    'ckpt:n2-partial',
    '续跑必须携带最后检查点，不从 0 开始',
  );
  const s2 = (await runState.listStepRunsByRun('dev', 'run-1')).find((s) => s.stepRunId === 's2');
  assert.equal(s2?.attemptCount, 2, '崩溃残留 running 步续跑必须递增 attempt_count');
  assert.equal(await runState.renewLease('dev', 'run-1', 'dead-token', 60_000), false, '旧 token 不得再续租');

  const run = await runState.getRun('dev', 'run-1');
  assert.equal(run?.terminalOutcome, 'succeeded');
  assert.equal(run?.progress.confirmedCount, 3, '已确认计数保留 1 + 续跑 n2/n3 各 1');
  assert.equal(run?.progress.attemptCount, 3);
  runState.assertAllInvariantsHold();
});

test('cancel 安全点：步中取消 → 当前步执行完即停，后续节点不执行，run terminal/cancelled', async () => {
  const { runState, executor, worker } = await makeHarness(['n1', 'n2']);
  executor.behaviors.set('n1', async (ctx) => {
    // 步执行中途外部请求取消（reason 已写在 run 上）。
    await runState.transitionRun('dev', ctx.run.runId, 'running', {
      status: 'cancel_requested', waitReason: null, terminalOutcome: null, reasonCode: 'cancelled_by_user',
    });
    return { kind: 'succeeded', resultRef: 'result:n1', checkpointRef: 'ckpt:n1', confirmedDelta: 1 };
  });
  await worker.enqueue(makeRunInsert());
  await worker.tick();

  assert.equal(executor.callCount('n1'), 1);
  assert.equal(executor.callCount('n2'), 0, '取消在步间安全点生效：后续节点不得执行');
  const steps = await runState.listStepRunsByRun('dev', 'run-1');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].terminalOutcome, 'succeeded', '当前步必须执行完并如实落终态');
  const run = await runState.getRun('dev', 'run-1');
  assert.equal(run?.status, 'terminal');
  assert.equal(run?.terminalOutcome, 'cancelled');
  assert.equal(run?.reasonCode, 'cancelled_by_user', '取消来源码原样保留');
  runState.assertAllInvariantsHold();
});

test('cancel 保底扫表：queued 期被取消的 run 由 tick 收敛终态，不执行任何步', async () => {
  const { runState, executor, worker } = await makeHarness(['n1']);
  await runState.insertRun('dev', makeRunInsert());
  await runState.transitionRun('dev', 'run-1', 'queued', {
    status: 'cancel_requested', waitReason: null, terminalOutcome: null, reasonCode: 'cancelled_by_system',
  });
  assert.equal(await worker.tick(), 0);
  assert.equal(executor.calls.length, 0);
  assert.equal((await runState.listStepRunsByRun('dev', 'run-1')).length, 0);
  const run = await runState.getRun('dev', 'run-1');
  assert.equal(run?.terminalOutcome, 'cancelled');
  assert.equal(run?.reasonCode, 'cancelled_by_system');
  runState.assertAllInvariantsHold();
});

test('跳过步诚实聚合：有成有跳 → partially_succeeded，reason_code 原样传播', async () => {
  const { runState, worker, executor } = await makeHarness(['n1', 'n2', 'n3']);
  executor.behaviors.set('n2', () => ({ kind: 'skipped', reasonCode: 'no_qualified_target' }));
  await worker.enqueue(makeRunInsert());
  await worker.tick();
  const run = await runState.getRun('dev', 'run-1');
  assert.equal(run?.terminalOutcome, 'partially_succeeded');
  assert.equal(run?.reasonCode, 'no_qualified_target');
  assert.equal(run?.progress.skippedCount, 1);
  assert.equal(run?.progress.confirmedCount, 2);
  runState.assertAllInvariantsHold();
});

test('失败步就地终结：run terminal/failed，后续节点不执行', async () => {
  const { runState, worker, executor } = await makeHarness(['n1', 'n2', 'n3']);
  executor.behaviors.set('n2', () => ({ kind: 'failed', reasonCode: 'edge_unavailable', detail: '边缘节点失联' }));
  await worker.enqueue(makeRunInsert());
  await worker.tick();
  assert.equal(executor.callCount('n3'), 0);
  const run = await runState.getRun('dev', 'run-1');
  assert.equal(run?.terminalOutcome, 'failed');
  assert.equal(run?.reasonCode, 'edge_unavailable');
  assert.equal(run?.progress.failureCount, 1);
  const steps = await runState.listStepRunsByRun('dev', 'run-1');
  assert.equal(steps.find((s) => s.nodeId === 'n2')?.terminalOutcome, 'failed');
  runState.assertAllInvariantsHold();
});

test('执行器抛异常 → 步/run 诚实 failed(executor_unavailable)，绝不伪装成功', async () => {
  const { runState, worker, executor } = await makeHarness(['n1', 'n2']);
  executor.behaviors.set('n1', () => {
    throw new Error('boom');
  });
  await worker.enqueue(makeRunInsert());
  await worker.tick();
  const run = await runState.getRun('dev', 'run-1');
  assert.equal(run?.terminalOutcome, 'failed');
  assert.equal(run?.reasonCode, 'executor_unavailable');
  assert.equal(executor.callCount('n2'), 0);
  runState.assertAllInvariantsHold();
});

test('能力路由不到执行器 → run failed(capability_not_available)，不产生步残骸', async () => {
  const { runState, makeWorker } = await makeHarness(['n1']);
  const worker = makeWorker({ executorFor: () => null });
  await worker.enqueue(makeRunInsert());
  await worker.tick();
  const run = await runState.getRun('dev', 'run-1');
  assert.equal(run?.terminalOutcome, 'failed');
  assert.equal(run?.reasonCode, 'capability_not_available');
  assert.equal((await runState.listStepRunsByRun('dev', 'run-1')).length, 0);
  runState.assertAllInvariantsHold();
});

test('编译期禁用的节点不执行、不建步；执行图缺失 → failed(contract_invalid)', async () => {
  const { runState, worker, executor } = await makeHarness(['n1', 'n2', 'n3'], { disabled: ['n2'] });
  await worker.enqueue(makeRunInsert());
  await worker.tick();
  assert.equal(executor.callCount('n2'), 0);
  const steps = await runState.listStepRunsByRun('dev', 'run-1');
  assert.deepEqual(steps.map((s) => s.nodeId), ['n1', 'n3']);
  assert.equal((await runState.getRun('dev', 'run-1'))?.terminalOutcome, 'succeeded');

  // plan 读不回：诚实 failed，不猜执行顺序。
  await worker.enqueue(makeRunInsert({ runId: 'run-2', idempotencyKey: 'idem-2', executionPlanId: 'plan-missing' }));
  await worker.tick();
  const run2 = await runState.getRun('dev', 'run-2');
  assert.equal(run2?.terminalOutcome, 'failed');
  assert.equal(run2?.reasonCode, 'contract_invalid');
  runState.assertAllInvariantsHold();
});

test('aggregateRunOutcome：全成/全跳/混合/空集的诚实口径', () => {
  assert.deepEqual(aggregateRunOutcome([{ outcome: 'succeeded', reasonCode: null }]),
    { outcome: 'succeeded', reasonCode: null });
  assert.deepEqual(
    aggregateRunOutcome([
      { outcome: 'skipped', reasonCode: 'no_qualified_target' },
      { outcome: 'skipped', reasonCode: 'content_exhausted' },
    ]),
    { outcome: 'skipped', reasonCode: 'content_exhausted' },
  );
  assert.deepEqual(
    aggregateRunOutcome([
      { outcome: 'succeeded', reasonCode: null },
      { outcome: 'skipped', reasonCode: 'no_qualified_target' },
    ]),
    { outcome: 'partially_succeeded', reasonCode: 'no_qualified_target' },
  );
  // 全部节点被禁用（零工作被授权执行）→ 空洞成立的 succeeded。
  assert.deepEqual(aggregateRunOutcome([]), { outcome: 'succeeded', reasonCode: null });
});
