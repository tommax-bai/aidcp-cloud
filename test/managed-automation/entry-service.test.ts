/**
 * 期1-4 入口操作服务层单测：Create 成功入队全链路 / 写动作创建被拒（原因码 + trace）/
 * Cancel 各状态（queued/running/终态 run/任务终态/不存在）/ Query 投影正确性与零副作用。
 * 全部走内存 fakes（engine-fakes.ts + entry-fakes.ts），不建库；编译走真 PlanCompiler
 * （校验语义唯一事实源在编译器，服务层不重复实现）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CapabilityDefinition,
  TaskDefinition,
  TypedCapabilityNode,
  TypedConditionalEdge,
} from '../../src/managed-automation/contracts/capability.js';
import type {
  CancelTaskProposal,
  CreateTaskProposal,
  QueryTaskRequest,
} from '../../src/managed-automation/contracts/agent-intents.js';
import { PlanCompiler } from '../../src/managed-automation/engine/index.js';
import {
  TaskEntryService,
  type AccountBindingResolution,
} from '../../src/managed-automation/service/index.js';
import { InMemoryDecisionTrace, InMemoryPlanAuthority, InMemoryRunState } from './engine-fakes.js';
import { InMemoryLedgerRead, InMemoryTaskAuthority } from './entry-fakes.js';

const makeCapability = (capabilityId: string, overrides: Partial<CapabilityDefinition> = {}): CapabilityDefinition => ({
  capabilityId,
  version: 1,
  inputSchemaRef: 'schema:in',
  outputSchemaRef: 'schema:out',
  sideEffect: 'none',
  requiredEvidenceRef: 'evidence:dom',
  bounds: { maxWallClockMs: 30_000, maxExecutionAttempts: 3 },
  actionDomain: 'research.read',
  executionClass: 'read_only',
  ...overrides,
});

const makeNode = (nodeId: string, capabilityId: string): TypedCapabilityNode => ({
  nodeId,
  capabilityId,
  capabilityVersion: 1,
  inputBindingRef: `bind:${nodeId}`,
  optional: false,
});

const seq = (from: string, to: string): TypedConditionalEdge => ({ kind: 'sequential', from, to });

const makeDefinition = (nodes: TypedCapabilityNode[], edges: TypedConditionalEdge[]): TaskDefinition => ({
  taskDefinitionId: 'def-1',
  version: 1,
  inputSchemaRef: 'schema:task-in',
  allowedTriggerTypes: ['schedule'],
  executionGraph: { nodes, edges },
  bounds: {
    maxNodes: 10, maxLoopIterations: 0, maxDerivationDepth: 1,
    maxExecutionAttempts: 3, maxWallClockMs: 60_000,
  },
  publishedAt: 1,
});

/** 合法只读线性定义（Create 成功链路的默认输入）。 */
const readOnlyDefinition = (): TaskDefinition =>
  makeDefinition([makeNode('n1', 'research.collect'), makeNode('n2', 'research.assess')], [seq('n1', 'n2')]);

/** 含 platform_write 节点的定义（编译准入必拒）。 */
const writeDefinition = (): TaskDefinition =>
  makeDefinition([makeNode('n1', 'research.collect'), makeNode('n2', 'interaction.like')], [seq('n1', 'n2')]);

const makeCreateProposal = (overrides: Partial<CreateTaskProposal> = {}): CreateTaskProposal => ({
  kind: 'create_task',
  conversationMessageId: 'msg-1',
  correlationId: 'corr-1',
  proposedAt: 1,
  accountId: 'acc-1',
  platform: 'xiaohongshu',
  taskDefinitionId: 'def-1',
  taskDefinitionVersion: 1,
  requestedCapabilityScope: { allow: [], deny: [] },
  requestedAuthorization: {},
  constraints: {},
  budgets: { platformRisk: null, executionResource: null, aiContent: null },
  schedule: { scheduledAt: 1_000, latestStartAt: 2_000, missPolicy: 'skip' },
  planId: null,
  cycleId: null,
  ...overrides,
});

const makeCancelProposal = (taskId: string, overrides: Partial<CancelTaskProposal> = {}): CancelTaskProposal => ({
  kind: 'cancel_task',
  conversationMessageId: null,
  correlationId: 'corr-cancel',
  proposedAt: 2,
  taskId,
  reason: null,
  ...overrides,
});

const makeQuery = (taskId: string | null, include: Partial<QueryTaskRequest['include']> = {}): QueryTaskRequest => ({
  kind: 'query_task',
  conversationMessageId: null,
  correlationId: 'corr-query',
  proposedAt: 3,
  taskId,
  accountId: null,
  include: { runs: false, attempts: false, traces: false, ...include },
});

function makeHarness(options: {
  capabilities?: CapabilityDefinition[];
  definitions?: TaskDefinition[];
  bindings?: Record<string, AccountBindingResolution>;
} = {}) {
  const capabilities = options.capabilities ?? [
    makeCapability('research.collect'),
    makeCapability('research.assess'),
    makeCapability('interaction.like', {
      actionDomain: 'interaction.light', executionClass: 'platform_write', sideEffect: 'external_write',
    }),
  ];
  const definitions = options.definitions ?? [readOnlyDefinition()];
  const bindings = options.bindings ?? {
    'acc-1': { envKey: 'env-1', accountBindingRevision: 'binding-rev-1' },
  };
  const capRegistry = new Map(capabilities.map((cap) => [`${cap.capabilityId}@${cap.version}`, cap]));
  const defRegistry = new Map(definitions.map((def) => [`${def.taskDefinitionId}@${def.version}`, def]));
  const taskAuthority = new InMemoryTaskAuthority(() => 42);
  const runState = new InMemoryRunState(() => 42);
  const plans = new InMemoryPlanAuthority(() => 42);
  const traces = new InMemoryDecisionTrace(() => 42);
  const ledger = new InMemoryLedgerRead();
  let idSeq = 0;
  const service = new TaskEntryService({
    taskAuthority,
    runState,
    ledger,
    decisionTrace: traces,
    compiler: new PlanCompiler({
      planAuthority: plans,
      decisionTrace: traces,
      resolveCapability: (id, version) => capRegistry.get(`${id}@${version}`) ?? null,
      now: () => 42,
    }),
    resolveTaskDefinition: (id, version) => defRegistry.get(`${id}@${version}`) ?? null,
    resolveAccountBinding: (accountId) => bindings[accountId] ?? null,
    now: () => 42,
    newId: () => `id-${++idSeq}`,
  });
  return { service, taskAuthority, runState, plans, traces, ledger };
}

// —— Create ——

test('Create：成功全链路 → 权威 Task(active) + 创建修订 + 冻结 plan + run 入队，不写 denied trace', async () => {
  const h = makeHarness();
  const out = await h.service.createTask('dev', makeCreateProposal());
  assert.ok(out.accepted, `期望 accepted，实际 ${JSON.stringify(out)}`);
  assert.equal(out.runStatus, 'queued');

  const task = await h.taskAuthority.getTask('dev', out.taskId);
  assert.ok(task);
  assert.equal(task.status, 'active');
  assert.equal(task.currentRevisionId, out.revisionId);
  assert.equal(task.envKey, 'env-1', '冻结块 envKey 必须来自账号绑定解析');
  assert.equal(task.executionTarget, 'dev');

  assert.equal(h.taskAuthority.revisions.length, 1);
  const revision = h.taskAuthority.revisions[0];
  assert.equal(revision.revisionOrdinal, 1);
  assert.equal(revision.cause, 'create');
  assert.equal(revision.supersedesRevisionId, null);
  assert.equal(revision.proposalRef, 'conversation-message:msg-1');

  assert.equal(h.plans.size, 1, '编译产物必须落库');
  const run = await h.runState.getRun('dev', out.runId);
  assert.ok(run);
  assert.equal(run.status, 'queued');
  assert.equal(run.executionPlanId, out.executionPlanId);
  assert.equal(run.accountBindingRevision, 'binding-rev-1');
  assert.equal(run.idempotencyKey, `${out.taskId}:initial`);
  assert.equal(h.traces.traces.length, 0, '成功路径不写 denied trace');
});

test('Create：platform_write 定义在编译准入即拒 → capability_not_available + trace 落笔 + 任务收敛 cancelled + 期2 note', async () => {
  const h = makeHarness({ definitions: [writeDefinition()] });
  const out = await h.service.createTask('dev', makeCreateProposal());
  if (out.accepted) assert.fail('期望编译拒绝');
  assert.equal(out.reasonCode, 'capability_not_available');
  assert.match(out.note ?? '', /期2/, '响应必须注明写动作期2 起支持');

  // trace 由编译器落（服务层不重复写）：同码 denied。
  const last = h.traces.traces.at(-1);
  assert.ok(last, '编译拒绝必须留 DecisionTrace');
  assert.equal(last.outcome, 'denied');
  assert.equal(last.reasonCode, 'capability_not_available');

  // 已权威化的任务不留僵尸 active：CAS 收敛到 cancelled；不产生 plan/run。
  assert.ok(out.taskId, '编译拒绝时任务已落库，须回其 ID');
  const task = await h.taskAuthority.getTask('dev', out.taskId!);
  assert.equal(task?.status, 'cancelled');
  assert.equal(h.plans.size, 0, '拒绝不得落库半截计划');
  assert.deepEqual(await h.runState.listRunsByTask('dev', out.taskId!), [], '拒绝不得入队 run');
});

test('Create：任务定义解析不到 → unsupported + admission denied trace，不落任何库', async () => {
  const h = makeHarness({ definitions: [] });
  const out = await h.service.createTask('dev', makeCreateProposal());
  if (out.accepted) assert.fail('期望 unsupported 拒绝');
  assert.equal(out.reasonCode, 'unsupported');
  assert.equal(out.taskId, null);
  const last = h.traces.traces.at(-1);
  assert.equal(last?.decisionType, 'admission');
  assert.equal(last?.outcome, 'denied');
  assert.equal(last?.reasonCode, 'unsupported');
  assert.equal(h.plans.size, 0);
});

test('Create：账号无绑定 → invalid_task_proposal + trace，不权威化', async () => {
  const h = makeHarness({ bindings: {} });
  const out = await h.service.createTask('dev', makeCreateProposal());
  if (out.accepted) assert.fail('期望无绑定拒绝');
  assert.equal(out.reasonCode, 'invalid_task_proposal');
  assert.equal(out.taskId, null);
  assert.equal(h.traces.traces.at(-1)?.reasonCode, 'invalid_task_proposal');
  assert.equal(await h.taskAuthority.getTask('dev', 'id-1'), null, '不得落库任务');
});

// —— Cancel ——

test('Cancel：queued run → 任务 cancelled + run 置 cancel_requested（cancelled_by_user），安全点停止归 worker', async () => {
  const h = makeHarness();
  const created = await h.service.createTask('dev', makeCreateProposal());
  assert.ok(created.accepted);
  const out = await h.service.cancelTask('dev', makeCancelProposal(created.taskId));
  assert.ok(out.accepted, `期望 accepted，实际 ${JSON.stringify(out)}`);
  assert.deepEqual(out.cancelRequestedRunIds, [created.runId]);
  assert.deepEqual(out.alreadyTerminalRunIds, []);
  const run = await h.runState.getRun('dev', created.runId);
  assert.equal(run?.status, 'cancel_requested');
  assert.equal(run?.reasonCode, 'cancelled_by_user');
  assert.equal(run?.terminalOutcome, null, '本层不终态化：终态收敛由 worker 在安全点完成');
  const task = await h.taskAuthority.getTask('dev', created.taskId);
  assert.equal(task?.status, 'cancelled');
});

test('Cancel：running run（已被 worker 认领）同样置 cancel_requested', async () => {
  const h = makeHarness();
  const created = await h.service.createTask('dev', makeCreateProposal());
  assert.ok(created.accepted);
  const claimed = await h.runState.claimNextQueued('dev', 'worker-1', 60_000);
  assert.equal(claimed?.run.runId, created.runId);
  const out = await h.service.cancelTask('dev', makeCancelProposal(created.taskId));
  assert.ok(out.accepted);
  assert.deepEqual(out.cancelRequestedRunIds, [created.runId]);
  assert.equal((await h.runState.getRun('dev', created.runId))?.status, 'cancel_requested');
});

test('Cancel：已终态 run 不覆盖（前向语义），归入 alreadyTerminalRunIds', async () => {
  const h = makeHarness();
  const created = await h.service.createTask('dev', makeCreateProposal());
  assert.ok(created.accepted);
  const done = await h.runState.transitionRun('dev', created.runId, 'queued', {
    status: 'terminal', waitReason: null, terminalOutcome: 'succeeded', reasonCode: null,
  });
  assert.ok(done);
  const out = await h.service.cancelTask('dev', makeCancelProposal(created.taskId));
  assert.ok(out.accepted);
  assert.deepEqual(out.cancelRequestedRunIds, []);
  assert.deepEqual(out.alreadyTerminalRunIds, [created.runId]);
  const run = await h.runState.getRun('dev', created.runId);
  assert.equal(run?.terminalOutcome, 'succeeded', '真实平台结果不得被取消覆盖');
});

test('Cancel：任务已处终态 → stale_target + 真实当前状态 + denial trace', async () => {
  const h = makeHarness();
  const created = await h.service.createTask('dev', makeCreateProposal());
  assert.ok(created.accepted);
  assert.ok((await h.service.cancelTask('dev', makeCancelProposal(created.taskId))).accepted);
  const again = await h.service.cancelTask('dev', makeCancelProposal(created.taskId));
  if (again.accepted) assert.fail('期望重复取消被拒');
  assert.equal(again.reasonCode, 'stale_target');
  assert.equal(again.currentStatus, 'cancelled');
  const last = h.traces.traces.at(-1);
  assert.equal(last?.decisionType, 'denial');
  assert.equal(last?.reasonCode, 'stale_target');
});

test('Cancel：任务不存在 → invalid_task_proposal（如实返回，不伪装成功）+ trace', async () => {
  const h = makeHarness();
  const out = await h.service.cancelTask('dev', makeCancelProposal('no-such-task'));
  if (out.accepted) assert.fail('期望不存在任务被拒');
  assert.equal(out.reasonCode, 'invalid_task_proposal');
  assert.equal(out.currentStatus, null);
  assert.equal(h.traces.traces.at(-1)?.reasonCode, 'invalid_task_proposal');
});

// —— Query ——

test('Query：include 全开 → Task + run 正交状态 + attempt + trace 摘要逐层正确', async () => {
  const h = makeHarness({ definitions: [writeDefinition()] });
  // 用一次写动作拒绝制造同 correlation 的 denied trace（trace 层数据源）。
  const rejected = await h.service.createTask('dev', makeCreateProposal());
  assert.ok(!rejected.accepted && rejected.taskId, '前置：编译拒绝且任务已权威化');
  const taskId = rejected.taskId!;
  const task = await h.taskAuthority.getTask('dev', taskId);
  assert.ok(task);
  // 播种一条 run + ledger intent/attempt（读侧投影数据源；写侧属引擎，不在本测仿真）。
  await h.runState.insertRun('dev', {
    runId: 'run-q', taskId, taskRevisionId: task.currentRevisionId, executionPlanId: 'plan-q',
    cycleId: null, executionTarget: 'dev', correlationId: task.correlationId, planId: null, planVersion: null,
    taskDefinitionId: task.taskDefinitionId, taskDefinitionVersion: task.taskDefinitionVersion,
    personaVersion: null, accountId: task.accountId, envKey: task.envKey, platform: task.platform,
    accountBindingRevision: 'binding-rev-1', candidateVersionId: null, contentVersion: null,
    approvalRevision: null, schedule: task.schedule, budgets: task.budgets, idempotencyKey: 'run-q:key',
    status: 'queued', waitReason: null, terminalOutcome: null, reasonCode: null,
  });
  h.ledger.intents.push({
    intentId: 'intent-1', accountId: task.accountId, envKey: task.envKey, executionTarget: 'dev',
    bindingRevision: 'binding-rev-1', actionType: 'research.collect', actionDomain: 'research.read',
    executionClass: 'read_only', targetStableId: null, contentVersion: null, approvalRevision: null,
    scheduledAt: 1_000, latestStartAt: 2_000, missPolicy: 'skip', requiredCapability: 'research.collect',
    protocolVersion: 'v1', idempotencyKey: 'intent-1:key', correlationId: task.correlationId,
    runId: 'run-q', stepId: 'step-1', createdAt: 42,
  });
  h.ledger.attempts.push({
    attemptId: 'attempt-1', intentId: 'intent-1', runId: 'run-q', stepId: 'step-1', executionTarget: 'dev',
    ordinal: 1, status: 'platform_confirmed', nonStartReason: null, confirmedNotAppliedKind: null,
    reasonCode: null, evidenceRef: 'evidence:url', strongestProgressEvidenceRef: null,
    reconciliationCount: 0, preparedAt: 42, dispatchedAt: 42, settledAt: 42,
  });

  const out = await h.service.queryTask('dev', makeQuery(taskId, { runs: true, attempts: true, traces: true }));
  assert.ok(out.found, `期望 found，实际 ${JSON.stringify(out)}`);
  const projection = out.projection;
  assert.equal(projection.taskId, taskId);
  assert.equal(projection.status, 'cancelled', '编译拒绝后任务已收敛 cancelled');
  assert.equal(projection.currentRevisionId, task.currentRevisionId);
  assert.equal(projection.runs?.length, 1);
  assert.equal(projection.runs?.[0].status, 'queued');
  assert.equal(projection.runs?.[0].waitReason, null);
  assert.equal(projection.attempts?.length, 1);
  assert.equal(projection.attempts?.[0].status, 'platform_confirmed');
  assert.equal(projection.attempts?.[0].evidenceRef, 'evidence:url');
  assert.ok((projection.traces?.length ?? 0) >= 1, '同 correlation 的 denied trace 必须可见');
  assert.equal(projection.traces?.[0].reasonCode, 'capability_not_available');
  assert.equal(projection.projectedAt, 42);
});

test('Query：include 全关 → 三层为 null（区别于空数组）；查询前后零副作用', async () => {
  const h = makeHarness();
  const created = await h.service.createTask('dev', makeCreateProposal());
  assert.ok(created.accepted);
  const tracesBefore = h.traces.traces.length;
  const out = await h.service.queryTask('dev', makeQuery(created.taskId));
  assert.ok(out.found);
  assert.equal(out.projection.runs, null);
  assert.equal(out.projection.attempts, null);
  assert.equal(out.projection.traces, null);
  assert.equal(h.traces.traces.length, tracesBefore, '查询不得写 trace');
  assert.equal((await h.taskAuthority.getTask('dev', created.taskId))?.status, 'active', '查询不得改状态');
});

test('Query：taskId 缺失或不存在 → found=false（读未命中，不写 trace）', async () => {
  const h = makeHarness();
  const missingId = await h.service.queryTask('dev', makeQuery('no-such-task', { runs: true }));
  if (missingId.found) assert.fail('期望读未命中');
  assert.equal(missingId.reasonCode, 'invalid_task_proposal');
  const nullId = await h.service.queryTask('dev', makeQuery(null));
  assert.ok(!nullId.found);
  assert.equal(h.traces.traces.length, 0, '读未命中不写 trace');
});
