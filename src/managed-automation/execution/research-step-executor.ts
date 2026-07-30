/**
 * 执行层（期1-6）：ResearchStepExecutor —— persona 只读研究四步的 StepExecutor 实现。
 *
 * 端口 + 适配器：核心逻辑只依赖 EdgeDispatchPort（发只读命令、等回执、超时/中断），
 * 不知道 comm 层长什么样。诚实映射（任务红线：绝不把超时或未知伪装成成功）：
 *
 *   端口结果          →  StepExecutionResult          →  run 走向（worker 既有语义）
 *   completed            succeeded(resultRef/ckpt)       继续下一步；产出经 worker 写
 *                                                        recordStepCheckpoint + recordRunProgress
 *   empty                skipped(原因码原样)             继续下一步，聚合期如实计跳过
 *   failed               failed(原因码原样)              run 就地终态 failed
 *   timeout              failed('deadline_exceeded')     同上
 *   undeliverable        failed('edge_unavailable')      同上（期1 无步内有界等待，
 *                                                        投递不达即失败，不占着 run 干等）
 *   aborted              failed('cancelled_by_system')   worker 在 signal.aborted 后丢弃
 *                                                        结果、不再写状态（所有权已易主）
 *
 * 留痕：负向落定（skip / 失败 / 超时 / 不可投递）各追加一条 DecisionTrace
 * （skip → decisionType='skip'，其余 → 'dispatch' + outcome='denied'），带 runId/stepId
 * 与具名原因码；abort 后不追加——不再代表该 run 写任何东西。正向里程碑
 * （步成功、run 终态）由权威状态行承载（DecisionTrace.reasonCode 非空且全集为
 * 负向/等待语义，没有可诚实使用的「成功码」，不编造）。
 */

import { randomUUID } from 'node:crypto';
import type { ReasonCode, TerminalReasonCode } from '../contracts/reason-codes.js';
import type { DecisionType } from '../contracts/decision-trace.js';
import type { CapabilityResolver } from '../engine/plan-compiler.js';
import type {
  StepExecutionContext,
  StepExecutionResult,
  StepExecutor,
} from '../engine/step-executor.js';
import { ACTION_DOMAIN_EXECUTION_CLASS } from '../contracts/action-classification.js';
import type { TaskAuthorityStore } from '../stores/task-authority-store.js';
import type { DecisionTraceStore } from '../stores/decision-trace-store.js';
import { parsePersonaResearchParams } from '../registry/persona-research.js';
import type { EdgeDispatchPort } from './edge-dispatch-port.js';

/** 执行器对 stores 的端口（同 engine/ports.ts 纪律：Pick<真实 store>）。 */
export type TaskReadPort = Pick<TaskAuthorityStore, 'getTask'>;
export type StepTracePort = Pick<DecisionTraceStore, 'append'>;

export interface ResearchStepExecutorDeps {
  edgeDispatch: EdgeDispatchPort;
  /** 研究参数事实源：按 run.taskId 读 Task.constraints（run 冻结块不含约束袋）。 */
  taskAuthority: TaskReadPort;
  /** 步级超时事实源：能力 bounds.maxWallClockMs（与编译期同一注册表）。 */
  resolveCapability: CapabilityResolver;
  decisionTrace: StepTracePort;
  newTraceId?: () => string;
}

export class ResearchStepExecutor implements StepExecutor {
  private readonly newTraceId: () => string;

  constructor(private readonly deps: ResearchStepExecutorDeps) {
    this.newTraceId = deps.newTraceId ?? randomUUID;
  }

  async execute(ctx: StepExecutionContext): Promise<StepExecutionResult> {
    const { node } = ctx;
    const capability = this.deps.resolveCapability(node.capabilityId, node.capabilityVersion);
    if (!capability) {
      // 编译期解析过的能力执行期解析不到 = 注册表漂移，如实失败。
      return this.failed(ctx, 'capability_not_available',
        `能力 ${node.capabilityId}@${node.capabilityVersion} 执行期解析不到（注册表漂移）`);
    }
    // 纵深防御：与编译准入闸同三重判据。编译产物本应只含 read_only，
    // 读到写面能力即注册表/产物被污染，拒发命令。
    if (
      capability.executionClass !== 'read_only'
      || ACTION_DOMAIN_EXECUTION_CLASS[capability.actionDomain] !== 'read_only'
      || capability.sideEffect === 'external_write'
    ) {
      return this.failed(ctx, 'capability_not_available',
        `能力 ${node.capabilityId}@${node.capabilityVersion} 非 read_only，执行器拒绝派发`);
    }
    const task = await this.deps.taskAuthority.getTask(ctx.executionTarget, ctx.run.taskId);
    if (!task) {
      return this.failed(ctx, 'contract_invalid', `task_id=${ctx.run.taskId} 读不回，研究参数无事实源`);
    }
    const parsed = parsePersonaResearchParams(task.constraints);
    if (!parsed.ok) {
      return this.failed(ctx, 'contract_invalid', `研究参数非法：${parsed.detail}`);
    }

    let outcome;
    try {
      outcome = await this.deps.edgeDispatch.dispatchReadOnly(
        {
          commandKind: 'research.read',
          capabilityId: node.capabilityId,
          capabilityVersion: node.capabilityVersion,
          executionTarget: ctx.executionTarget,
          envKey: ctx.run.envKey,
          accountId: ctx.run.accountId,
          platform: ctx.run.platform,
          runId: ctx.run.runId,
          stepRunId: ctx.stepRunId,
          nodeId: node.nodeId,
          inputBindingRef: node.inputBindingRef,
          checkpointRef: ctx.checkpointRef,
          params: { keywords: parsed.params.keywords, maxItems: parsed.params.maxItems },
        },
        { timeoutMs: capability.bounds.maxWallClockMs, signal: ctx.signal },
      );
    } catch (err) {
      return this.failed(ctx, 'executor_unavailable', `派发端口异常：${(err as Error).message}`);
    }

    switch (outcome.kind) {
      case 'completed':
        return {
          kind: 'succeeded',
          resultRef: outcome.resultRef,
          checkpointRef: outcome.checkpointRef,
          confirmedDelta: Math.max(0, outcome.confirmedDelta),
        };
      case 'empty':
        return this.skipped(ctx, outcome.reasonCode, outcome.detail);
      case 'failed':
        return this.failed(ctx, outcome.reasonCode, outcome.detail ?? '边端如实回报失败');
      case 'timeout':
        return this.failed(ctx, 'deadline_exceeded',
          outcome.detail ?? `回执等待超过能力上限 ${capability.bounds.maxWallClockMs}ms`);
      case 'undeliverable':
        return this.failed(ctx, 'edge_unavailable',
          outcome.detail ?? `env=${ctx.run.envKey} 无任务态在线连接，命令未投递`);
      case 'aborted':
        // 所有权已经/即将易主：不落 trace（不再代表该 run 写任何东西），
        // 结果由 worker 在 signal.aborted 分支丢弃。
        return { kind: 'failed', reasonCode: 'cancelled_by_system', detail: '派发被 worker 中断信号终止' };
    }
  }

  private async skipped(
    ctx: StepExecutionContext,
    reasonCode: TerminalReasonCode,
    detail?: string,
  ): Promise<StepExecutionResult> {
    await this.trace(ctx, 'skip', 'skipped', reasonCode);
    return { kind: 'skipped', reasonCode, detail };
  }

  private async failed(
    ctx: StepExecutionContext,
    reasonCode: ReasonCode,
    detail: string,
  ): Promise<StepExecutionResult> {
    await this.trace(ctx, 'dispatch', 'denied', reasonCode);
    return { kind: 'failed', reasonCode, detail };
  }

  /** 负向落定留痕（原因码与执行结果同码；trace 解释原因，不成为状态真相）。 */
  private async trace(
    ctx: StepExecutionContext,
    decisionType: DecisionType,
    outcome: 'denied' | 'skipped',
    reasonCode: ReasonCode,
  ): Promise<void> {
    await this.deps.decisionTrace.append(ctx.executionTarget, {
      traceId: this.newTraceId(),
      correlationId: ctx.run.correlationId,
      causationId: null,
      executionTarget: ctx.executionTarget,
      versions: {
        planVersion: ctx.run.planVersion,
        taskDefinitionVersion: ctx.run.taskDefinitionVersion,
        personaVersion: ctx.run.personaVersion,
        policyRevision: null,
        approvalRevision: null,
      },
      runId: ctx.run.runId,
      stepId: ctx.stepRunId,
      attemptId: null,
      decisionType,
      inputRefs: [
        `step-run:${ctx.stepRunId}`,
        `node:${ctx.node.nodeId}`,
        `capability:${ctx.node.capabilityId}@${ctx.node.capabilityVersion}`,
      ],
      candidates: [],
      outcome,
      reasonCode,
      snapshotRefs: [],
    });
  }
}
