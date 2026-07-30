/**
 * 引擎层（期1-5）：线性 Plan Compiler。
 *
 * 输入 TaskDefinition + Task/TaskRevision 上下文，输出**不可变**线性 ExecutionPlan，
 * 经 TaskAuthorityStore.insertExecutionPlan 落库（只 INSERT，重放读回既有产物）。
 *
 * 期1 校验规则（拒绝一律具名，绝不静默忽略/近似回退）：
 *   1. 图结构：非空、节点 ID 唯一、节点数 ≤ bounds.maxNodes、单链覆盖全部节点
 *      → 违反即 reason_code = 'contract_invalid'；
 *   2. 边类型：只编译 kind='sequential'；conditional / bounded_loop 期1 不编译
 *      → 遇到即 reason_code = 'unsupported' 明确拒绝；
 *   3. 能力解析：capabilityId@version 解析不到 → 'unsupported'（未知能力显式不支持）；
 *   4. 执行分类：任何节点（含未启用的可选节点）executionClass='platform_write' 或
 *      sideEffect='external_write' → 'capability_not_available'（期1 只放行 read_only，
 *      action-classification.ts 文件头的准入闸判据）；
 *   5. 参数完整性：能力声明 inputSchemaRef 但节点缺 inputBindingRef → 'contract_invalid'；
 *   6. CapabilityScope：必选节点越出 allow/deny 护栏 → 'capability_scope_denied'；
 *      可选节点越出 → enabled=false 编译进产物（护栏不是流程，design §4.3）。
 *
 * 每次拒绝都 append 一条 DecisionTrace（decisionType='admission'，outcome='denied'，
 * 携带 reason_code 与违规节点候选），再抛 PlanCompileError——Trace 解释原因，
 * 不替代错误传播。
 */

import { randomUUID } from 'node:crypto';
import type { ExecutionTarget } from '../contracts/common.js';
import type { RejectionReasonCode } from '../contracts/reason-codes.js';
import type { CapabilityDefinition, CapabilityId, TaskDefinition } from '../contracts/capability.js';
import type { CapabilityScope } from '../contracts/task.js';
import type { ExecutionPlan, ExecutionPlanNode, LinearExecutionEdge } from '../contracts/execution-plan.js';
import type { DecisionCandidate } from '../contracts/decision-trace.js';
import { ACTION_DOMAIN_EXECUTION_CLASS } from '../contracts/action-classification.js';
import { resolveLinearChain } from './linear-graph.js';
import type { DecisionTracePort, PlanAuthorityPort } from './ports.js';

/** 编译拒绝：reason_code 与 decision trace 同码，调用方按码分流。 */
export class PlanCompileError extends Error {
  readonly code = 'managed_automation_plan_compile_rejected';

  constructor(
    readonly reasonCode: RejectionReasonCode,
    detail: string,
  ) {
    super(`managed_automation_plan_compile_rejected(${reasonCode}): ${detail}`);
    this.name = 'PlanCompileError';
  }
}

/** 能力解析口：由注册表实现；解析不到返回 null（编译器显式拒绝，不猜版本）。 */
export type CapabilityResolver = (
  capabilityId: CapabilityId,
  version: number,
) => CapabilityDefinition | null;

/** 编译请求：TaskDefinition + 冻结所需的 Task/TaskRevision 上下文。 */
export interface CompilePlanRequest {
  executionPlanId: string;
  taskId: string;
  taskRevisionId: string;
  /** trace 归因。 */
  correlationId: string;
  causationId?: string | null;
  planId: string | null;
  planVersion: number | null;
  authorizationRef: string;
  completionConditionRef: string;
  capabilityScope: CapabilityScope;
  definition: TaskDefinition;
}

export interface PlanCompilerDeps {
  planAuthority: PlanAuthorityPort;
  decisionTrace: DecisionTracePort;
  resolveCapability: CapabilityResolver;
  now?: () => number;
  newTraceId?: () => string;
}

export class PlanCompiler {
  private readonly now: () => number;
  private readonly newTraceId: () => string;

  constructor(private readonly deps: PlanCompilerDeps) {
    this.now = deps.now ?? Date.now;
    this.newTraceId = deps.newTraceId ?? randomUUID;
  }

  /**
   * 编译并落库。executionPlanId 重放（插入未命中）时读回既有产物返回——
   * 编译产物不可变，同 ID 不存在第二个版本。
   */
  async compile(executionTarget: ExecutionTarget, request: CompilePlanRequest): Promise<ExecutionPlan> {
    const plan = await this.validate(executionTarget, request);
    const inserted = await this.deps.planAuthority.insertExecutionPlan(executionTarget, plan);
    if (inserted) return { ...plan, compiledAt: this.now() };
    const existing = await this.deps.planAuthority.getExecutionPlan(executionTarget, request.executionPlanId);
    if (!existing) {
      throw new PlanCompileError('contract_invalid', `executionPlanId=${request.executionPlanId} 插入未命中且读不回既有行`);
    }
    return existing;
  }

  private async validate(
    executionTarget: ExecutionTarget,
    request: CompilePlanRequest,
  ): Promise<Omit<ExecutionPlan, 'compiledAt'>> {
    const { definition } = request;
    const graphNodes = definition.executionGraph.nodes;
    const graphEdges = definition.executionGraph.edges;

    // 规则 2：非线性边期1 不编译——先于结构判定，报错点名边类型。
    for (const edge of graphEdges) {
      if (edge.kind !== 'sequential') {
        await this.deny(executionTarget, request, 'unsupported', [
          { candidateRef: `edge:${edge.from}->${edge.to}`, reasonCode: 'unsupported', selected: false },
        ]);
        throw new PlanCompileError(
          'unsupported',
          `期1 只编译 sequential 边；边 ${edge.from}→${edge.to} 是 '${edge.kind}'，明确拒绝而非静默忽略`,
        );
      }
    }

    // 规则 1：图结构必须是覆盖全部节点的单链。
    if (graphNodes.length > definition.bounds.maxNodes) {
      await this.deny(executionTarget, request, 'contract_invalid', []);
      throw new PlanCompileError(
        'contract_invalid',
        `节点数 ${graphNodes.length} 超出 bounds.maxNodes=${definition.bounds.maxNodes}`,
      );
    }
    const chain = resolveLinearChain(graphNodes.map((node) => node.nodeId), graphEdges);
    if (!chain.ok) {
      await this.deny(executionTarget, request, 'contract_invalid', []);
      throw new PlanCompileError('contract_invalid', `执行图不是线性链（${chain.violation}）：${chain.detail}`);
    }

    // 规则 3/4/5/6：逐节点（按链序）解析能力、卡写动作、验参数、求交护栏。
    const allow = new Set(request.capabilityScope.allow);
    const deny = new Set(request.capabilityScope.deny);
    const byNodeId = new Map(graphNodes.map((node) => [node.nodeId, node]));
    const compiledNodes: ExecutionPlanNode[] = [];
    for (const nodeId of chain.order) {
      const node = byNodeId.get(nodeId)!;
      const capability = this.deps.resolveCapability(node.capabilityId, node.capabilityVersion);
      if (!capability) {
        await this.deny(executionTarget, request, 'unsupported', [
          { candidateRef: `node:${node.nodeId}`, reasonCode: 'unsupported', selected: false },
        ]);
        throw new PlanCompileError(
          'unsupported',
          `节点 ${node.nodeId} 的能力 ${node.capabilityId}@${node.capabilityVersion} 解析不到，显式不支持`,
        );
      }
      // 期1 执行层只放行 read_only：写动作**编译即拒绝**，可选节点也不例外——
      // 「编译进产物但永不启用」仍是把写能力冻进授权面，fail-closed 一律拒。
      // 三重判据（声明分类 / 动作域冻结映射 / 副作用等级）任一命中写面即拒，防注册表误标。
      if (
        capability.executionClass !== 'read_only'
        || ACTION_DOMAIN_EXECUTION_CLASS[capability.actionDomain] !== 'read_only'
        || capability.sideEffect === 'external_write'
      ) {
        await this.deny(executionTarget, request, 'capability_not_available', [
          { candidateRef: `node:${node.nodeId}`, reasonCode: 'capability_not_available', selected: false },
        ]);
        throw new PlanCompileError(
          'capability_not_available',
          `节点 ${node.nodeId}（${node.capabilityId}@${node.capabilityVersion}）是 platform_write；期1 执行层只放行 read_only`,
        );
      }
      // 参数完整性：能力要求入参 schema 时，节点必须带冻结的绑定引用。
      if (capability.inputSchemaRef && node.inputBindingRef === null) {
        await this.deny(executionTarget, request, 'contract_invalid', [
          { candidateRef: `node:${node.nodeId}`, reasonCode: 'contract_invalid', selected: false },
        ]);
        throw new PlanCompileError(
          'contract_invalid',
          `节点 ${node.nodeId} 缺 inputBindingRef，但能力 ${node.capabilityId} 声明了 inputSchemaRef=${capability.inputSchemaRef}`,
        );
      }
      // CapabilityScope 求交：deny 优先；allow 非空即白名单。
      const inScope = !deny.has(node.capabilityId) && (allow.size === 0 || allow.has(node.capabilityId));
      if (!inScope && !node.optional) {
        await this.deny(executionTarget, request, 'capability_scope_denied', [
          { candidateRef: `node:${node.nodeId}`, reasonCode: 'capability_scope_denied', selected: false },
        ]);
        throw new PlanCompileError(
          'capability_scope_denied',
          `必选节点 ${node.nodeId} 的能力 ${node.capabilityId} 越出 Task CapabilityScope`,
        );
      }
      compiledNodes.push({
        nodeId: node.nodeId,
        capabilityId: node.capabilityId,
        capabilityVersion: node.capabilityVersion,
        inputBindingRef: node.inputBindingRef,
        enabled: inScope,
      });
    }

    const edges: LinearExecutionEdge[] = [];
    for (let i = 0; i + 1 < chain.order.length; i += 1) {
      edges.push({ kind: 'linear', from: chain.order[i], to: chain.order[i + 1] });
    }
    return {
      executionPlanId: request.executionPlanId,
      taskId: request.taskId,
      taskRevisionId: request.taskRevisionId,
      executionTarget,
      taskDefinitionId: definition.taskDefinitionId,
      taskDefinitionVersion: definition.version,
      planId: request.planId,
      planVersion: request.planVersion,
      authorizationRef: request.authorizationRef,
      nodes: compiledNodes,
      edges,
      entryNodeId: chain.order[0],
      bounds: { ...definition.bounds },
      completionConditionRef: request.completionConditionRef,
    };
  }

  private async deny(
    executionTarget: ExecutionTarget,
    request: CompilePlanRequest,
    reasonCode: RejectionReasonCode,
    candidates: DecisionCandidate[],
  ): Promise<void> {
    await this.deps.decisionTrace.append(executionTarget, {
      traceId: this.newTraceId(),
      correlationId: request.correlationId,
      causationId: request.causationId ?? null,
      executionTarget,
      versions: {
        planVersion: request.planVersion,
        taskDefinitionVersion: request.definition.version,
        personaVersion: null,
        policyRevision: null,
        approvalRevision: null,
      },
      runId: null,
      stepId: null,
      attemptId: null,
      decisionType: 'admission',
      inputRefs: [
        `task:${request.taskId}`,
        `task-revision:${request.taskRevisionId}`,
        `task-definition:${request.definition.taskDefinitionId}@${request.definition.version}`,
      ],
      candidates,
      outcome: 'denied',
      reasonCode,
      snapshotRefs: [],
    });
  }
}
