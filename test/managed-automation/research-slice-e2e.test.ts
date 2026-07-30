/**
 * 期1-6 端到端验收：persona 只读研究纵切（Create → 权威化 → 编译 → worker 认领 →
 * 四步执行 → 终态 → Query），全部走内存 fakes + 假 EdgeDispatchPort，不建库、不接网。
 *
 * 场景清单（任务 8 交付物 3）：
 *   1. 全链路 happy path：四步顺序执行、产出/检查点落 StepRun、进度逐步推进、
 *      run 终态 succeeded、Query 投影如实透出；全程零 denial trace（正向里程碑由
 *      权威状态行承载）。
 *   2. 断点续跑：第 2 步执行中 worker 崩溃（stop() 中断 + 租约过期）→ 新 worker
 *      回收后从检查点继续，第 1 步不重派发、不重复计数。
 *   3. Cancel 安全点：第 2 步执行中取消 → 当前步完成后停（步终态 succeeded），
 *      后续步不派发，run 终态 cancelled/cancelled_by_user。
 *   4. decision-trace 留痕：入口拒绝（unsupported / 未绑定账号）与执行负向路径
 *      （empty→skip、timeout→deadline_exceeded）原因码逐条核对。
 *   5. 写动作提案在同一注册表下仍被拒：测试缝注册写面定义后，准入闸（编译规则 4）
 *      照样以 capability_not_available 拒绝——注册表引入没有放宽准入。
 *   6. 执行器判别映射直测：aborted / 端口异常 / undeliverable 的诚实映射与留痕边界。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CapabilityDefinition,
  TaskDefinition,
} from '../../src/managed-automation/contracts/capability.js';
import type {
  CancelTaskProposal,
  CreateTaskProposal,
  QueryTaskRequest,
} from '../../src/managed-automation/contracts/agent-intents.js';
import type { ExecutionTarget } from '../../src/managed-automation/contracts/common.js';
import { PlanCompiler, TaskRunWorker } from '../../src/managed-automation/engine/index.js';
import {
  TaskEntryService,
  type AccountBindingResolution,
} from '../../src/managed-automation/service/index.js';
import {
  createManagedAutomationRegistry,
  PERSONA_RESEARCH_TASK_DEFINITION_ID,
  PERSONA_RESEARCH_TASK_DEFINITION_VERSION,
  type ManagedAutomationRegistryOptions,
} from '../../src/managed-automation/registry/index.js';
import { ResearchStepExecutor } from '../../src/managed-automation/execution/index.js';
import type {
  EdgeDispatchOptions,
  EdgeDispatchOutcome,
  EdgeDispatchPort,
  ReadOnlyEdgeCommand,
} from '../../src/managed-automation/execution/index.js';
import {
  FakeClock,
  InMemoryDecisionTrace,
  InMemoryPlanAuthority,
  InMemoryRunState,
} from './engine-fakes.js';
import { InMemoryLedgerRead, InMemoryTaskAuthority } from './entry-fakes.js';

const TARGET: ExecutionTarget = 'dev';
const NODE_ORDER = ['search', 'browse', 'assess', 'summarize'] as const;

const silentLogger = { log() {}, warn() {}, error() {} };

type DispatchBehavior = (
  command: ReadOnlyEdgeCommand,
  options: EdgeDispatchOptions,
) => EdgeDispatchOutcome | Promise<EdgeDispatchOutcome>;

/** 假端口：按 nodeId 注入行为，缺省诚实 completed（产出引用 + confirmedDelta=1）。 */
class FakeEdgeDispatchPort implements EdgeDispatchPort {
  readonly calls: { command: ReadOnlyEdgeCommand; timeoutMs: number }[] = [];
  readonly behaviors = new Map<string, DispatchBehavior>();

  async dispatchReadOnly(
    command: ReadOnlyEdgeCommand,
    options: EdgeDispatchOptions,
  ): Promise<EdgeDispatchOutcome> {
    this.calls.push({ command: structuredClone(command), timeoutMs: options.timeoutMs });
    const behavior = this.behaviors.get(command.nodeId);
    if (behavior) return behavior(command, options);
    return {
      kind: 'completed',
      resultRef: `edge-result:${command.nodeId}`,
      checkpointRef: `edge-ckpt:${command.nodeId}`,
      confirmedDelta: 1,
    };
  }

  callCount(nodeId: string): number {
    return this.calls.filter((call) => call.command.nodeId === nodeId).length;
  }
}

const makeCreateProposal = (overrides: Partial<CreateTaskProposal> = {}): CreateTaskProposal => ({
  kind: 'create_task',
  conversationMessageId: 'msg-1',
  correlationId: 'corr-1',
  proposedAt: 1,
  accountId: 'acc-1',
  platform: 'xiaohongshu',
  taskDefinitionId: PERSONA_RESEARCH_TASK_DEFINITION_ID,
  taskDefinitionVersion: PERSONA_RESEARCH_TASK_DEFINITION_VERSION,
  requestedCapabilityScope: { allow: [], deny: [] },
  requestedAuthorization: {},
  constraints: { keywords: ['ai agent', '浏览器自动化'], maxItems: 3 },
  budgets: { platformRisk: null, executionResource: null, aiContent: null },
  schedule: { scheduledAt: 1_000, latestStartAt: 2_000, missPolicy: 'skip' },
  planId: null,
  cycleId: null,
  ...overrides,
});

const makeCancelProposal = (taskId: string): CancelTaskProposal => ({
  kind: 'cancel_task',
  conversationMessageId: null,
  correlationId: 'corr-cancel',
  proposedAt: 2,
  taskId,
  reason: null,
});

const makeQuery = (taskId: string, include: Partial<QueryTaskRequest['include']> = {}): QueryTaskRequest => ({
  kind: 'query_task',
  conversationMessageId: null,
  correlationId: 'corr-query',
  proposedAt: 3,
  taskId,
  accountId: null,
  include: { runs: false, attempts: false, traces: false, ...include },
});

/** 组合根同构装配：真注册表 + 真编译器 + 真执行器 + 真 worker，存储/时钟/端口为假件。 */
function makeHarness(options: {
  registryOptions?: ManagedAutomationRegistryOptions;
  bindings?: Record<string, AccountBindingResolution>;
} = {}) {
  const clock = new FakeClock();
  const taskAuthority = new InMemoryTaskAuthority(clock.now);
  const runState = new InMemoryRunState(clock.now);
  const plans = new InMemoryPlanAuthority(clock.now);
  const traces = new InMemoryDecisionTrace(clock.now);
  const ledger = new InMemoryLedgerRead();
  const registry = createManagedAutomationRegistry(options.registryOptions);
  const bindings = options.bindings ?? {
    'acc-1': { envKey: 'env-1', accountBindingRevision: 'binding:acc-1->env-1' },
  };
  let idSeq = 0;
  const newId = () => `id-${(idSeq += 1)}`;
  const service = new TaskEntryService({
    taskAuthority,
    runState,
    ledger,
    decisionTrace: traces,
    compiler: new PlanCompiler({
      planAuthority: plans,
      decisionTrace: traces,
      resolveCapability: registry.resolveCapability,
      now: clock.now,
      newTraceId: newId,
    }),
    resolveTaskDefinition: registry.resolveTaskDefinition,
    // 异步解析器：验证服务层放宽后的 Promise 形态（生产事实源是 PG 查询）。
    resolveAccountBinding: async (accountId) => bindings[accountId] ?? null,
    now: clock.now,
    newId,
  });
  const edgePort = new FakeEdgeDispatchPort();
  const executor = new ResearchStepExecutor({
    edgeDispatch: edgePort,
    taskAuthority,
    resolveCapability: registry.resolveCapability,
    decisionTrace: traces,
    newTraceId: newId,
  });
  const makeWorker = (workerId: string) =>
    new TaskRunWorker({
      executionTarget: TARGET,
      runState,
      planAuthority: plans,
      executorFor: (capabilityId) => (capabilityId.startsWith('research.') ? executor : null),
      enabled: true,
      now: clock.now,
      workerId,
      leaseMs: 60_000,
      renewIntervalMs: 3_600_000,
      logger: silentLogger,
    });
  return { clock, taskAuthority, runState, plans, traces, ledger, registry, service, edgePort, executor, makeWorker };
}

async function createAccepted(h: ReturnType<typeof makeHarness>, proposal = makeCreateProposal()) {
  const result = await h.service.createTask(TARGET, proposal);
  assert.ok(result.accepted, `创建应被接受：${JSON.stringify(result)}`);
  return result;
}

test('e2e：全链路 Create → 编译 → 认领 → 四步执行 → succeeded → Query 投影', async () => {
  const h = makeHarness();
  const created = await createAccepted(h);
  assert.equal(created.runStatus, 'queued');
  assert.ok(await h.plans.getExecutionPlan(TARGET, created.executionPlanId), '编译产物应已落库');

  const worker = h.makeWorker('w-1');
  assert.equal(await worker.tick(), 1);

  // 四步按链序各派发一次；命令信封携带 run 冻结块与研究参数，超时取能力上限。
  assert.deepEqual(
    h.edgePort.calls.map((call) => call.command.nodeId),
    [...NODE_ORDER],
  );
  assert.deepEqual(
    h.edgePort.calls.map((call) => call.timeoutMs),
    [90_000, 300_000, 120_000, 120_000],
  );
  for (const call of h.edgePort.calls) {
    assert.equal(call.command.commandKind, 'research.read');
    assert.equal(call.command.envKey, 'env-1');
    assert.equal(call.command.runId, created.runId);
    assert.deepEqual(call.command.params, { keywords: ['ai agent', '浏览器自动化'], maxItems: 3 });
  }

  const run = await h.runState.getRun(TARGET, created.runId);
  assert.equal(run?.status, 'terminal');
  assert.equal(run?.terminalOutcome, 'succeeded');
  assert.equal(run?.reasonCode, null);
  assert.equal(run?.progress.confirmedCount, 4);
  assert.equal(run?.progress.attemptCount, 4);
  assert.equal(run?.currentNodeId, 'summarize');

  // 每步产出（浏览摘要等引用）与检查点写入 StepRun。
  const steps = await h.runState.listStepRunsByRun(TARGET, created.runId);
  assert.deepEqual(steps.map((step) => step.nodeId), [...NODE_ORDER]);
  for (const step of steps) {
    assert.equal(step.status, 'terminal');
    assert.equal(step.terminalOutcome, 'succeeded');
    assert.equal(step.resultRef, `edge-result:${step.nodeId}`);
    assert.equal(step.checkpointRef, `edge-ckpt:${step.nodeId}`);
  }

  // Query 投影：run 正交状态 + 进度如实透出；traces 层为空（正向链路零 denial）。
  const query = await h.service.queryTask(TARGET, makeQuery(created.taskId, { runs: true, traces: true }));
  assert.ok(query.found);
  assert.equal(query.projection.status, 'active');
  assert.equal(query.projection.runs?.length, 1);
  assert.equal(query.projection.runs?.[0].terminalOutcome, 'succeeded');
  assert.equal(query.projection.runs?.[0].progress.confirmedCount, 4);
  assert.deepEqual(query.projection.traces, []);
  assert.equal(h.traces.traces.length, 0, '正向全链路不产生任何 denial trace');
  h.runState.assertAllInvariantsHold();
});

test('e2e：第 2 步中断（崩溃 + 租约过期）→ 恢复后从检查点继续，不重做已完成步骤', async () => {
  const h = makeHarness();
  const created = await createAccepted(h);
  const worker1 = h.makeWorker('w-crash');
  let browseCalls = 0;
  h.edgePort.behaviors.set('browse', (command) => {
    browseCalls += 1;
    if (browseCalls === 1) {
      // 模拟崩溃：中断信号触发后 worker 丢弃本步结果、不再写任何状态。
      worker1.stop();
    }
    return {
      kind: 'completed',
      resultRef: `edge-result:${command.nodeId}`,
      checkpointRef: `edge-ckpt:${command.nodeId}`,
      confirmedDelta: 1,
    };
  });
  await worker1.tick();

  // 崩溃现场：第 1 步检查点已固化（run 进度 + currentNodeId），run 仍持租约挂在 running。
  const midway = await h.runState.getRun(TARGET, created.runId);
  assert.equal(midway?.status, 'running');
  assert.equal(midway?.progress.confirmedCount, 1);
  assert.equal(midway?.currentNodeId, 'search');

  // 租约过期后新 worker 回收接管。
  h.clock.advance(61_000);
  const worker2 = h.makeWorker('w-recover');
  assert.equal(await worker2.tick(), 1);

  // 第 1 步不重派发；第 2 步崩溃残留 running 被重置续跑（attemptCount 递增）。
  assert.equal(h.edgePort.callCount('search'), 1, '已完成步不得重做');
  assert.equal(h.edgePort.callCount('browse'), 2);
  assert.equal(h.edgePort.callCount('assess'), 1);
  assert.equal(h.edgePort.callCount('summarize'), 1);
  const steps = await h.runState.listStepRunsByRun(TARGET, created.runId);
  const browse = steps.find((step) => step.nodeId === 'browse');
  assert.equal(browse?.attemptCount, 2);
  assert.equal(browse?.terminalOutcome, 'succeeded');

  const run = await h.runState.getRun(TARGET, created.runId);
  assert.equal(run?.terminalOutcome, 'succeeded');
  assert.equal(run?.progress.confirmedCount, 4, '恢复续跑不重复计数');
  assert.equal(run?.progress.attemptCount, 4);
  h.runState.assertAllInvariantsHold();
});

test('e2e：第 2 步执行中取消 → 当前步完成后停，终态 cancelled/cancelled_by_user', async () => {
  const h = makeHarness();
  const created = await createAccepted(h);
  let cancelOutcome: Awaited<ReturnType<TaskEntryService['cancelTask']>> | null = null;
  h.edgePort.behaviors.set('browse', async (command) => {
    // 步执行中收到取消请求：本步照常完成，安全点（步间）再停。
    cancelOutcome = await h.service.cancelTask(TARGET, makeCancelProposal(created.taskId));
    return {
      kind: 'completed',
      resultRef: `edge-result:${command.nodeId}`,
      checkpointRef: `edge-ckpt:${command.nodeId}`,
      confirmedDelta: 1,
    };
  });
  const worker = h.makeWorker('w-cancel');
  await worker.tick();

  assert.ok(cancelOutcome !== null && (cancelOutcome as Awaited<ReturnType<TaskEntryService['cancelTask']>>).accepted);
  // 当前步执行完（终态 succeeded），后续步不再派发。
  const steps = await h.runState.listStepRunsByRun(TARGET, created.runId);
  assert.deepEqual(steps.map((step) => step.nodeId), ['search', 'browse']);
  assert.equal(steps[1].terminalOutcome, 'succeeded');
  assert.equal(h.edgePort.callCount('assess'), 0);
  assert.equal(h.edgePort.callCount('summarize'), 0);

  const run = await h.runState.getRun(TARGET, created.runId);
  assert.equal(run?.status, 'terminal');
  assert.equal(run?.terminalOutcome, 'cancelled');
  assert.equal(run?.reasonCode, 'cancelled_by_user');
  const task = await h.taskAuthority.getTask(TARGET, created.taskId);
  assert.equal(task?.status, 'cancelled');
  h.runState.assertAllInvariantsHold();
});

test('e2e：入口拒绝留痕——未知定义 unsupported、未绑定账号 invalid_task_proposal', async () => {
  const h = makeHarness();

  const unknownDef = await h.service.createTask(
    TARGET,
    makeCreateProposal({ correlationId: 'corr-unknown', taskDefinitionId: 'persona.unknown' }),
  );
  assert.ok(!unknownDef.accepted);
  assert.equal(unknownDef.reasonCode, 'unsupported');

  const unbound = await h.service.createTask(
    TARGET,
    makeCreateProposal({ correlationId: 'corr-unbound', accountId: 'acc-unbound' }),
  );
  assert.ok(!unbound.accepted);
  assert.equal(unbound.reasonCode, 'invalid_task_proposal');

  const unknownTraces = await h.traces.listByCorrelation(TARGET, 'corr-unknown');
  assert.equal(unknownTraces.length, 1);
  assert.equal(unknownTraces[0].decisionType, 'admission');
  assert.equal(unknownTraces[0].outcome, 'denied');
  assert.equal(unknownTraces[0].reasonCode, 'unsupported');
  const unboundTraces = await h.traces.listByCorrelation(TARGET, 'corr-unbound');
  assert.equal(unboundTraces.length, 1);
  assert.equal(unboundTraces[0].reasonCode, 'invalid_task_proposal');
});

test('e2e：边端空结果 → 步 skipped + run partially_succeeded，skip trace 带原因码', async () => {
  const h = makeHarness();
  const created = await createAccepted(h);
  h.edgePort.behaviors.set('search', () => ({
    kind: 'empty',
    reasonCode: 'no_qualified_target',
    detail: '搜索 0 命中',
  }));
  await h.makeWorker('w-empty').tick();

  const run = await h.runState.getRun(TARGET, created.runId);
  assert.equal(run?.terminalOutcome, 'partially_succeeded');
  assert.equal(run?.reasonCode, 'no_qualified_target');
  assert.equal(run?.progress.skippedCount, 1);
  assert.equal(run?.progress.confirmedCount, 3);

  const traces = await h.traces.listByCorrelation(TARGET, 'corr-1');
  assert.equal(traces.length, 1);
  assert.equal(traces[0].decisionType, 'skip');
  assert.equal(traces[0].outcome, 'skipped');
  assert.equal(traces[0].reasonCode, 'no_qualified_target');
  assert.equal(traces[0].runId, created.runId);
  assert.ok(traces[0].stepId, 'skip trace 必须锚到 stepRunId');
});

test('e2e：回执超时 → 步 failed(deadline_exceeded)、run 终态 failed，dispatch trace 同码', async () => {
  const h = makeHarness();
  const created = await createAccepted(h);
  h.edgePort.behaviors.set('browse', () => ({ kind: 'timeout' }));
  await h.makeWorker('w-timeout').tick();

  const run = await h.runState.getRun(TARGET, created.runId);
  assert.equal(run?.status, 'terminal');
  assert.equal(run?.terminalOutcome, 'failed');
  assert.equal(run?.reasonCode, 'deadline_exceeded');
  assert.equal(h.edgePort.callCount('assess'), 0, '失败步之后不再派发');
  const steps = await h.runState.listStepRunsByRun(TARGET, created.runId);
  const browse = steps.find((step) => step.nodeId === 'browse');
  assert.equal(browse?.terminalOutcome, 'failed');
  assert.equal(browse?.reasonCode, 'deadline_exceeded');

  const traces = await h.traces.listByCorrelation(TARGET, 'corr-1');
  assert.equal(traces.length, 1);
  assert.equal(traces[0].decisionType, 'dispatch');
  assert.equal(traces[0].outcome, 'denied');
  assert.equal(traces[0].reasonCode, 'deadline_exceeded');
  assert.equal(traces[0].stepId, browse?.stepRunId);
});

test('e2e：研究参数非法（maxItems 超硬顶）→ 首步 failed(contract_invalid)', async () => {
  // 裁量（期1）：参数解析的事实源在执行器（同 parsePersonaResearchParams）；
  // 入口不复制校验，非法参数在首步如实失败，不静默取缺省值。
  const h = makeHarness();
  const created = await createAccepted(
    h,
    makeCreateProposal({ constraints: { keywords: ['x'], maxItems: 99 } }),
  );
  await h.makeWorker('w-params').tick();
  const run = await h.runState.getRun(TARGET, created.runId);
  assert.equal(run?.terminalOutcome, 'failed');
  assert.equal(run?.reasonCode, 'contract_invalid');
  assert.equal(h.edgePort.calls.length, 0, '参数非法不得向边端派发命令');
});

const writeCapability: CapabilityDefinition = {
  capabilityId: 'interaction.like',
  version: 1,
  inputSchemaRef: 'schema:in',
  outputSchemaRef: 'schema:out',
  sideEffect: 'external_write',
  requiredEvidenceRef: 'evidence:dom',
  bounds: { maxWallClockMs: 30_000, maxExecutionAttempts: 3 },
  actionDomain: 'interaction.light',
  executionClass: 'platform_write',
};

const writeDefinition: TaskDefinition = {
  taskDefinitionId: 'persona.write-probe',
  version: 1,
  inputSchemaRef: 'schema:task-in',
  allowedTriggerTypes: ['manual'],
  executionGraph: {
    nodes: [{
      nodeId: 'like',
      capabilityId: 'interaction.like',
      capabilityVersion: 1,
      inputBindingRef: 'bind:like',
      optional: false,
    }],
    edges: [],
  },
  bounds: {
    maxNodes: 4, maxLoopIterations: 0, maxDerivationDepth: 1,
    maxExecutionAttempts: 3, maxWallClockMs: 60_000,
  },
  publishedAt: 1,
};

test('e2e：写动作提案在同一注册表下仍被拒（注册表引入没有放宽准入）', async () => {
  // 测试缝把写面定义/能力注册进同一工厂：解析成功，但编译准入闸照拒。
  const h = makeHarness({
    registryOptions: { additionalDefinitions: [writeDefinition], additionalCapabilities: [writeCapability] },
  });
  const rejected = await h.service.createTask(
    TARGET,
    makeCreateProposal({ correlationId: 'corr-write', taskDefinitionId: 'persona.write-probe' }),
  );
  assert.ok(!rejected.accepted);
  assert.equal(rejected.reasonCode, 'capability_not_available');
  assert.ok(rejected.note?.includes('期2'), '拒绝应附期2 支持说明');
  assert.ok(rejected.taskId, '编译拒绝前任务已权威化');
  const task = await h.taskAuthority.getTask(TARGET, rejected.taskId!);
  assert.equal(task?.status, 'cancelled', '编译拒绝后任务收敛 cancelled，不留僵尸 active');
  const traces = await h.traces.listByCorrelation(TARGET, 'corr-write');
  assert.ok(traces.some((trace) => trace.reasonCode === 'capability_not_available' && trace.outcome === 'denied'));

  // 生产注册表（无测试缝）解析不到写面定义：unsupported 如实拒绝。
  const prod = makeHarness();
  const unknown = await prod.service.createTask(
    TARGET,
    makeCreateProposal({ correlationId: 'corr-write-prod', taskDefinitionId: 'persona.write-probe' }),
  );
  assert.ok(!unknown.accepted);
  assert.equal(unknown.reasonCode, 'unsupported');
});

test('注册表：键冲突当场抛错；未知 ID/版本解析为 null', () => {
  assert.throws(
    () => createManagedAutomationRegistry({
      additionalDefinitions: [{
        ...writeDefinition,
        taskDefinitionId: PERSONA_RESEARCH_TASK_DEFINITION_ID,
        version: PERSONA_RESEARCH_TASK_DEFINITION_VERSION,
      }],
    }),
    /重复注册/,
  );
  const registry = createManagedAutomationRegistry();
  assert.equal(registry.resolveTaskDefinition(PERSONA_RESEARCH_TASK_DEFINITION_ID, 2), null);
  assert.equal(registry.resolveCapability('research.search', 2), null);
  assert.ok(registry.resolveCapability('research.search', 1));
});

test('执行器判别映射直测：aborted / 端口异常 / undeliverable 的诚实映射与留痕边界', async () => {
  const h = makeHarness();
  const created = await createAccepted(h);
  const claimed = await h.runState.claimNextQueued(TARGET, 'probe-token', 60_000);
  assert.ok(claimed);
  const plan = await h.plans.getExecutionPlan(TARGET, created.executionPlanId);
  assert.ok(plan);
  const baseCtx = {
    executionTarget: TARGET,
    run: claimed!.run,
    plan: plan!,
    node: plan!.nodes[0],
    checkpointRef: null,
  };

  // aborted：所有权易主——结果如实 failed(cancelled_by_system)，但不落 trace。
  h.edgePort.behaviors.set('search', () => ({ kind: 'aborted' }));
  const abortedResult = await h.executor.execute({
    ...baseCtx, stepRunId: 'step-aborted', signal: AbortSignal.abort(),
  });
  assert.deepEqual(
    { kind: abortedResult.kind, reasonCode: (abortedResult as { reasonCode?: string }).reasonCode },
    { kind: 'failed', reasonCode: 'cancelled_by_system' },
  );
  assert.equal(h.traces.traces.length, 0, 'abort 后不再代表该 run 写 trace');

  // 端口异常：executor_unavailable + trace。
  h.edgePort.behaviors.set('search', () => { throw new Error('端口炸了'); });
  const thrown = await h.executor.execute({
    ...baseCtx, stepRunId: 'step-thrown', signal: new AbortController().signal,
  });
  assert.equal(thrown.kind, 'failed');
  assert.equal((thrown as { reasonCode: string }).reasonCode, 'executor_unavailable');
  assert.equal(h.traces.traces.length, 1);

  // undeliverable：无任务态在线连接 → edge_unavailable（不伪装成功、不干等）。
  h.edgePort.behaviors.set('search', () => ({ kind: 'undeliverable' }));
  const undeliverable = await h.executor.execute({
    ...baseCtx, stepRunId: 'step-undeliverable', signal: new AbortController().signal,
  });
  assert.equal(undeliverable.kind, 'failed');
  assert.equal((undeliverable as { reasonCode: string }).reasonCode, 'edge_unavailable');
  const last = h.traces.traces[h.traces.traces.length - 1];
  assert.equal(last.decisionType, 'dispatch');
  assert.equal(last.reasonCode, 'edge_unavailable');
  assert.equal(last.runId, created.runId);
});
