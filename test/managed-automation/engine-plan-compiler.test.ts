/**
 * 期1-5 Plan Compiler 单测：合法线性图编译 / 写动作拒绝 / 非线性边拒绝 / 参数校验 /
 * 护栏求交 / 重放不可变。全部走内存 fakes（engine-fakes.ts），不建库。
 *
 * 拒绝断言三件套：抛 PlanCompileError（带 reason_code）+ DecisionTrace 落 denied
 * 同码 + 计划**不落库**（拒绝绝不产生半截产物）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { CapabilityDefinition, TaskDefinition, TypedCapabilityNode, TypedConditionalEdge } from '../../src/managed-automation/contracts/capability.js';
import {
  PlanCompileError,
  PlanCompiler,
  type CompilePlanRequest,
} from '../../src/managed-automation/engine/index.js';
import { InMemoryDecisionTrace, InMemoryPlanAuthority } from './engine-fakes.js';

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

const makeNode = (nodeId: string, capabilityId: string, overrides: Partial<TypedCapabilityNode> = {}): TypedCapabilityNode => ({
  nodeId,
  capabilityId,
  capabilityVersion: 1,
  inputBindingRef: `bind:${nodeId}`,
  optional: false,
  ...overrides,
});

const seq = (from: string, to: string): TypedConditionalEdge => ({ kind: 'sequential', from, to });

const makeDefinition = (
  nodes: TypedCapabilityNode[],
  edges: TypedConditionalEdge[],
  bounds: Partial<TaskDefinition['bounds']> = {},
): TaskDefinition => ({
  taskDefinitionId: 'def-1',
  version: 1,
  inputSchemaRef: 'schema:task-in',
  allowedTriggerTypes: ['schedule'],
  executionGraph: { nodes, edges },
  bounds: {
    maxNodes: 10, maxLoopIterations: 0, maxDerivationDepth: 1,
    maxExecutionAttempts: 3, maxWallClockMs: 60_000,
    ...bounds,
  },
  publishedAt: 1,
});

const makeRequest = (definition: TaskDefinition, overrides: Partial<CompilePlanRequest> = {}): CompilePlanRequest => ({
  executionPlanId: 'plan-1',
  taskId: 'task-1',
  taskRevisionId: 'rev-1',
  correlationId: 'corr-1',
  planId: null,
  planVersion: null,
  authorizationRef: 'auth:none',
  completionConditionRef: 'complete:all-steps',
  capabilityScope: { allow: [], deny: [] },
  definition,
  ...overrides,
});

function makeHarness(capabilities: CapabilityDefinition[]) {
  const registry = new Map(capabilities.map((cap) => [`${cap.capabilityId}@${cap.version}`, cap]));
  const plans = new InMemoryPlanAuthority(() => 42);
  const traces = new InMemoryDecisionTrace(() => 42);
  const compiler = new PlanCompiler({
    planAuthority: plans,
    decisionTrace: traces,
    resolveCapability: (id, version) => registry.get(`${id}@${version}`) ?? null,
    now: () => 42,
  });
  return { compiler, plans, traces };
}

/** 拒绝断言三件套。 */
async function assertRejects(
  harness: ReturnType<typeof makeHarness>,
  request: CompilePlanRequest,
  reasonCode: string,
): Promise<void> {
  await assert.rejects(
    harness.compiler.compile('dev', request),
    (err: unknown) => {
      assert.ok(err instanceof PlanCompileError, `期望 PlanCompileError，实际 ${String(err)}`);
      assert.equal(err.reasonCode, reasonCode);
      return true;
    },
  );
  assert.equal(harness.plans.size, 0, '拒绝不得落库半截计划');
  const last = harness.traces.traces.at(-1);
  assert.ok(last, '拒绝必须留 DecisionTrace');
  assert.equal(last.decisionType, 'admission');
  assert.equal(last.outcome, 'denied');
  assert.equal(last.reasonCode, reasonCode);
}

test('编译器：合法线性图 → 冻结线性 plan，护栏外可选节点 enabled=false', async () => {
  const harness = makeHarness([
    makeCapability('research.collect'),
    makeCapability('research.deep-read'),
    makeCapability('research.assess'),
  ]);
  const definition = makeDefinition(
    [
      makeNode('n1', 'research.collect'),
      makeNode('n2', 'research.deep-read'),
      makeNode('n3', 'research.assess', { optional: true }),
    ],
    [seq('n1', 'n2'), seq('n2', 'n3')],
  );
  const request = makeRequest(definition, {
    capabilityScope: { allow: [], deny: ['research.assess'] },
  });

  const plan = await harness.compiler.compile('dev', request);
  assert.equal(plan.executionPlanId, 'plan-1');
  assert.equal(plan.entryNodeId, 'n1');
  assert.deepEqual(plan.nodes.map((n) => n.nodeId), ['n1', 'n2', 'n3']);
  assert.deepEqual(plan.nodes.map((n) => n.enabled), [true, true, false], 'deny 护栏内的可选节点必须 enabled=false');
  assert.deepEqual(plan.edges, [
    { kind: 'linear', from: 'n1', to: 'n2' },
    { kind: 'linear', from: 'n2', to: 'n3' },
  ]);
  assert.equal(plan.taskDefinitionVersion, 1);
  assert.deepEqual(plan.bounds, definition.bounds);
  assert.equal(harness.plans.size, 1);
  assert.equal(harness.traces.traces.length, 0, '通过编译不写 denied trace');
});

test('编译器：同 executionPlanId 重放 → 读回既有产物，不产生第二版本', async () => {
  const harness = makeHarness([makeCapability('research.collect')]);
  const request = makeRequest(makeDefinition([makeNode('n1', 'research.collect')], []));
  const first = await harness.compiler.compile('dev', request);
  const replay = await harness.compiler.compile('dev', request);
  assert.equal(harness.plans.size, 1, '重放不得插入第二行');
  assert.deepEqual(replay.nodes, first.nodes);
  assert.equal(replay.executionPlanId, first.executionPlanId);
});

test('编译器：乱序输入的线性图按链序输出（编译产物顺序 = 图序，非声明序）', async () => {
  const harness = makeHarness([makeCapability('research.collect'), makeCapability('research.assess')]);
  const definition = makeDefinition(
    [makeNode('n2', 'research.assess'), makeNode('n1', 'research.collect')],
    [seq('n1', 'n2')],
  );
  const plan = await harness.compiler.compile('dev', makeRequest(definition));
  assert.equal(plan.entryNodeId, 'n1');
  assert.deepEqual(plan.nodes.map((n) => n.nodeId), ['n1', 'n2']);
});

test('编译器：platform_write 编译即拒绝 → capability_not_available + denied trace', async () => {
  const harness = makeHarness([
    makeCapability('research.collect'),
    makeCapability('interaction.like', {
      actionDomain: 'interaction.light', executionClass: 'platform_write', sideEffect: 'external_write',
    }),
  ]);
  const definition = makeDefinition(
    [makeNode('n1', 'research.collect'), makeNode('n2', 'interaction.like')],
    [seq('n1', 'n2')],
  );
  await assertRejects(harness, makeRequest(definition), 'capability_not_available');
});

test('编译器：写动作三重判据——注册表误标 read_only 但 sideEffect=external_write 仍拒', async () => {
  const harness = makeHarness([
    makeCapability('publish.sneaky', {
      actionDomain: 'research.read', executionClass: 'read_only', sideEffect: 'external_write',
    }),
  ]);
  const definition = makeDefinition([makeNode('n1', 'publish.sneaky')], []);
  await assertRejects(harness, makeRequest(definition), 'capability_not_available');
});

test('编译器：可选写节点也拒绝——不存在「编进产物但禁用」的写能力', async () => {
  const harness = makeHarness([
    makeCapability('research.collect'),
    makeCapability('interaction.like', {
      actionDomain: 'interaction.light', executionClass: 'platform_write', sideEffect: 'external_write',
    }),
  ]);
  const definition = makeDefinition(
    [makeNode('n1', 'research.collect'), makeNode('n2', 'interaction.like', { optional: true })],
    [seq('n1', 'n2')],
  );
  // 可选节点即使会被护栏禁用，写能力照样编译即拒（fail-closed）。
  await assertRejects(
    harness,
    makeRequest(definition, { capabilityScope: { allow: [], deny: ['interaction.like'] } }),
    'capability_not_available',
  );
});

test('编译器：conditional 边期1 明确拒绝 → unsupported', async () => {
  const harness = makeHarness([makeCapability('research.collect'), makeCapability('research.assess')]);
  const definition = makeDefinition(
    [makeNode('n1', 'research.collect'), makeNode('n2', 'research.assess')],
    [{ kind: 'conditional', from: 'n1', to: 'n2', conditionRef: 'assessment.value == high' }],
  );
  await assertRejects(harness, makeRequest(definition), 'unsupported');
});

test('编译器：bounded_loop 边期1 明确拒绝 → unsupported', async () => {
  const harness = makeHarness([makeCapability('research.collect'), makeCapability('research.assess')]);
  const definition = makeDefinition(
    [makeNode('n1', 'research.collect'), makeNode('n2', 'research.assess')],
    [{ kind: 'bounded_loop', from: 'n1', to: 'n2', completionConditionRef: 'unique_verified_content = 20', maxIterations: 20 }],
  );
  await assertRejects(harness, makeRequest(definition), 'unsupported');
});

test('编译器：分叉 / 环 / 断链都不是线性链 → contract_invalid', async () => {
  const caps = [
    makeCapability('research.collect'),
    makeCapability('research.deep-read'),
    makeCapability('research.assess'),
  ];
  const nodes = [
    makeNode('n1', 'research.collect'),
    makeNode('n2', 'research.deep-read'),
    makeNode('n3', 'research.assess'),
  ];
  // 分叉：n1 有两条出边。
  await assertRejects(
    makeHarness(caps),
    makeRequest(makeDefinition(nodes, [seq('n1', 'n2'), seq('n1', 'n3')])),
    'contract_invalid',
  );
  // 环：n1→n2→n1，无唯一链头。
  await assertRejects(
    makeHarness(caps),
    makeRequest(makeDefinition(nodes.slice(0, 2), [seq('n1', 'n2'), seq('n2', 'n1')])),
    'contract_invalid',
  );
  // 断链：3 节点只有 1 条边，链覆盖不到全部节点。
  await assertRejects(
    makeHarness(caps),
    makeRequest(makeDefinition(nodes, [seq('n1', 'n2')])),
    'contract_invalid',
  );
});

test('编译器：节点数超出 bounds.maxNodes → contract_invalid', async () => {
  const harness = makeHarness([makeCapability('research.collect'), makeCapability('research.assess')]);
  const definition = makeDefinition(
    [makeNode('n1', 'research.collect'), makeNode('n2', 'research.assess')],
    [seq('n1', 'n2')],
    { maxNodes: 1 },
  );
  await assertRejects(harness, makeRequest(definition), 'contract_invalid');
});

test('编译器：能力声明 inputSchemaRef 但节点缺 inputBindingRef → contract_invalid', async () => {
  const harness = makeHarness([makeCapability('research.collect')]);
  const definition = makeDefinition([makeNode('n1', 'research.collect', { inputBindingRef: null })], []);
  await assertRejects(harness, makeRequest(definition), 'contract_invalid');
});

test('编译器：能力解析不到 → unsupported（不猜版本）', async () => {
  const harness = makeHarness([makeCapability('research.collect')]);
  const definition = makeDefinition([makeNode('n1', 'research.collect', { capabilityVersion: 2 })], []);
  await assertRejects(harness, makeRequest(definition), 'unsupported');
});

test('编译器：必选节点越出 CapabilityScope → capability_scope_denied', async () => {
  const harness = makeHarness([makeCapability('research.collect'), makeCapability('research.assess')]);
  const definition = makeDefinition(
    [makeNode('n1', 'research.collect'), makeNode('n2', 'research.assess')],
    [seq('n1', 'n2')],
  );
  // allow 非空即白名单：n2 的能力不在其中且非 optional → 拒绝。
  await assertRejects(
    harness,
    makeRequest(definition, { capabilityScope: { allow: ['research.collect'], deny: [] } }),
    'capability_scope_denied',
  );
});
