/**
 * 期1-5 引擎测试的内存 fakes：结构化满足 src/managed-automation/engine/ports.ts 的端口。
 *
 * 语义对齐真实 store（真实 PG 行为由 stores-pg.integration.test.ts 盖住，这里不重复建库）：
 *   - 每次写入先过 assertOrthogonalInvariants（与 store 层同一校验点）——引擎若试图
 *     写出非法三元组，测试当场炸；
 *   - transitionRun/transitionStep 是 CAS（校验当前 status，未命中返回 false）；
 *   - claimNextQueued 最老优先、原子置 running + 租约；renewLease 仅同 token 未过期；
 *     reclaimExpiredLeases 过期放回 queued；recordRunProgress 谓词式（running + 同 token）；
 *   - 时钟可注入（租约过期测试推表）。
 */

import assert from 'node:assert/strict';
import type { ExecutionTarget } from '../../src/managed-automation/contracts/common.js';
import type { ExecutionPlan } from '../../src/managed-automation/contracts/execution-plan.js';
import type { DecisionTrace } from '../../src/managed-automation/contracts/decision-trace.js';
import type {
  OrthogonalRunState,
  RunProgress,
  RunStatus,
  StepRun,
  TaskRun,
} from '../../src/managed-automation/contracts/task-run.js';
import { assertOrthogonalInvariants } from '../../src/managed-automation/stores/index.js';
import type {
  ClaimedTaskRun,
  RunStateTransition,
  StepRunInsert,
  TaskRunInsert,
} from '../../src/managed-automation/stores/index.js';
import type { DecisionTraceInsert } from '../../src/managed-automation/stores/decision-trace-store.js';
import type { ExecutionPlanInsert } from '../../src/managed-automation/stores/task-authority-store.js';
import type {
  DecisionTracePort,
  PlanAuthorityPort,
  RunStatePort,
} from '../../src/managed-automation/engine/ports.js';
import type {
  StepExecutionContext,
  StepExecutionResult,
  StepExecutor,
} from '../../src/managed-automation/engine/step-executor.js';

interface RunRow {
  run: TaskRun;
  claimToken: string | null;
  claimExpiresAt: number | null;
}

const cloneRun = (run: TaskRun): TaskRun => structuredClone(run);
const cloneStep = (step: StepRun): StepRun => structuredClone(step);

export class InMemoryRunState implements RunStatePort {
  private readonly runs = new Map<string, RunRow>();
  private readonly steps = new Map<string, StepRun>();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private key(target: ExecutionTarget, id: string): string {
    return `${target}|${id}`;
  }

  private applyState(into: TaskRun | StepRun, next: OrthogonalRunState): void {
    assertOrthogonalInvariants(next);
    into.status = next.status;
    into.waitReason = next.waitReason;
    into.terminalOutcome = next.terminalOutcome;
    into.reasonCode = next.reasonCode;
  }

  async insertRun(executionTarget: ExecutionTarget, run: TaskRunInsert): Promise<boolean> {
    assertOrthogonalInvariants(run);
    if (this.runs.has(this.key(executionTarget, run.runId))) return false;
    for (const row of this.runs.values()) {
      if (row.run.executionTarget === executionTarget && row.run.idempotencyKey === run.idempotencyKey) return false;
    }
    this.seq += 1;
    const { targetCount, ...rest } = run;
    this.runs.set(this.key(executionTarget, run.runId), {
      run: {
        ...rest,
        executionTarget,
        progress: {
          confirmedCount: 0,
          targetCount: targetCount ?? null,
          attemptCount: 0,
          skippedCount: 0,
          failureCount: 0,
        },
        currentNodeId: null,
        supersededByRunId: null,
        aggregateVersion: 1,
        createdAt: this.seq,
        updatedAt: this.now(),
        startedAt: null,
        finishedAt: null,
      },
      claimToken: null,
      claimExpiresAt: null,
    });
    return true;
  }

  async transitionRun(
    executionTarget: ExecutionTarget,
    runId: string,
    expectedStatus: RunStatus,
    next: RunStateTransition,
    expectedAggregateVersion?: number,
  ): Promise<boolean> {
    assertOrthogonalInvariants(next);
    const row = this.runs.get(this.key(executionTarget, runId));
    if (!row || row.run.status !== expectedStatus) return false;
    if (expectedAggregateVersion !== undefined && row.run.aggregateVersion !== expectedAggregateVersion) return false;
    this.applyState(row.run, next);
    if (next.supersededByRunId != null) row.run.supersededByRunId = next.supersededByRunId;
    if (next.status !== 'running') {
      row.claimToken = null;
      row.claimExpiresAt = null;
    }
    if (next.status === 'running') row.run.startedAt ??= this.now();
    if (next.status === 'terminal') row.run.finishedAt ??= this.now();
    row.run.aggregateVersion += 1;
    row.run.updatedAt = this.now();
    return true;
  }

  async claimNextQueued(
    executionTarget: ExecutionTarget,
    claimToken: string,
    leaseMs: number,
  ): Promise<ClaimedTaskRun | null> {
    const queued = [...this.runs.values()]
      .filter((row) => row.run.executionTarget === executionTarget && row.run.status === 'queued')
      .sort((a, b) => a.run.createdAt - b.run.createdAt);
    const row = queued[0];
    if (!row) return null;
    row.run.status = 'running';
    row.run.startedAt ??= this.now();
    row.claimToken = claimToken;
    row.claimExpiresAt = this.now() + leaseMs;
    row.run.aggregateVersion += 1;
    row.run.updatedAt = this.now();
    return { run: cloneRun(row.run), claimToken, claimExpiresAt: row.claimExpiresAt };
  }

  async renewLease(
    executionTarget: ExecutionTarget,
    runId: string,
    claimToken: string,
    leaseMs: number,
  ): Promise<boolean> {
    const row = this.runs.get(this.key(executionTarget, runId));
    if (!row || row.run.status !== 'running') return false;
    if (row.claimToken !== claimToken || row.claimExpiresAt === null || row.claimExpiresAt <= this.now()) return false;
    row.claimExpiresAt = this.now() + leaseMs;
    return true;
  }

  async reclaimExpiredLeases(executionTarget: ExecutionTarget, limit = 20): Promise<string[]> {
    const expired = [...this.runs.values()]
      .filter(
        (row) =>
          row.run.executionTarget === executionTarget
          && row.run.status === 'running'
          && row.claimToken !== null
          && row.claimExpiresAt !== null
          && row.claimExpiresAt <= this.now(),
      )
      .sort((a, b) => (a.claimExpiresAt ?? 0) - (b.claimExpiresAt ?? 0))
      .slice(0, limit);
    for (const row of expired) {
      row.run.status = 'queued';
      row.claimToken = null;
      row.claimExpiresAt = null;
      row.run.aggregateVersion += 1;
      row.run.updatedAt = this.now();
    }
    return expired.map((row) => row.run.runId);
  }

  async recordRunProgress(
    executionTarget: ExecutionTarget,
    runId: string,
    claimToken: string,
    progress: RunProgress,
    currentNodeId: string | null,
  ): Promise<boolean> {
    const row = this.runs.get(this.key(executionTarget, runId));
    if (!row || row.run.status !== 'running' || row.claimToken !== claimToken) return false;
    row.run.progress = { ...progress };
    row.run.currentNodeId = currentNodeId;
    row.run.aggregateVersion += 1;
    row.run.updatedAt = this.now();
    return true;
  }

  async getRun(executionTarget: ExecutionTarget, runId: string): Promise<TaskRun | null> {
    const row = this.runs.get(this.key(executionTarget, runId));
    return row ? cloneRun(row.run) : null;
  }

  async listRunsByStatus(executionTarget: ExecutionTarget, status: RunStatus, limit = 100): Promise<TaskRun[]> {
    return [...this.runs.values()]
      .filter((row) => row.run.executionTarget === executionTarget && row.run.status === status)
      .sort((a, b) => a.run.createdAt - b.run.createdAt)
      .slice(0, limit)
      .map((row) => cloneRun(row.run));
  }

  /** 期1-4 入口操作补充（对齐真实 store listRunsByTask：按 created_at 升序）。 */
  async listRunsByTask(executionTarget: ExecutionTarget, taskId: string): Promise<TaskRun[]> {
    return [...this.runs.values()]
      .filter((row) => row.run.executionTarget === executionTarget && row.run.taskId === taskId)
      .sort((a, b) => a.run.createdAt - b.run.createdAt)
      .map((row) => cloneRun(row.run));
  }

  async insertStepRun(executionTarget: ExecutionTarget, step: StepRunInsert): Promise<boolean> {
    assertOrthogonalInvariants(step);
    if (this.steps.has(this.key(executionTarget, step.stepRunId))) return false;
    for (const existing of this.steps.values()) {
      if (
        existing.executionTarget === executionTarget
        && existing.runId === step.runId
        && existing.nodeId === step.nodeId
      ) return false;
    }
    this.seq += 1;
    this.steps.set(this.key(executionTarget, step.stepRunId), {
      ...step,
      executionTarget,
      resultRef: null,
      checkpointRef: null,
      attemptCount: 0,
      createdAt: this.seq,
      updatedAt: this.now(),
      startedAt: null,
      finishedAt: null,
    });
    return true;
  }

  async transitionStep(
    executionTarget: ExecutionTarget,
    stepRunId: string,
    expectedStatus: RunStatus,
    next: OrthogonalRunState,
  ): Promise<boolean> {
    assertOrthogonalInvariants(next);
    const step = this.steps.get(this.key(executionTarget, stepRunId));
    if (!step || step.status !== expectedStatus) return false;
    const enteringRun = next.status === 'running' && expectedStatus !== 'running';
    this.applyState(step, next);
    if (enteringRun) step.attemptCount += 1;
    if (next.status === 'running') step.startedAt ??= this.now();
    if (next.status === 'terminal') step.finishedAt ??= this.now();
    step.updatedAt = this.now();
    return true;
  }

  async recordStepCheckpoint(
    executionTarget: ExecutionTarget,
    stepRunId: string,
    checkpointRef: string | null,
    resultRef: string | null,
  ): Promise<boolean> {
    const step = this.steps.get(this.key(executionTarget, stepRunId));
    if (!step || step.status !== 'running') return false;
    step.checkpointRef = checkpointRef ?? step.checkpointRef;
    step.resultRef = resultRef ?? step.resultRef;
    step.updatedAt = this.now();
    return true;
  }

  async listStepRunsByRun(executionTarget: ExecutionTarget, runId: string): Promise<StepRun[]> {
    return [...this.steps.values()]
      .filter((step) => step.executionTarget === executionTarget && step.runId === runId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(cloneStep);
  }

  /** 测试断言用：全部行的正交不变式必须始终成立（写路径已断言，这里终检兜底）。 */
  assertAllInvariantsHold(): void {
    for (const row of this.runs.values()) {
      assertOrthogonalInvariants(row.run);
      if (row.run.status === 'terminal') assert.ok(row.run.finishedAt !== null, 'terminal run 必须有 finishedAt');
      if (row.run.status !== 'running') assert.equal(row.claimToken, null, '离开 running 必须释放租约');
    }
    for (const step of this.steps.values()) assertOrthogonalInvariants(step);
  }
}

export class InMemoryPlanAuthority implements PlanAuthorityPort {
  private readonly plans = new Map<string, ExecutionPlan>();

  constructor(private readonly now: () => number = Date.now) {}

  async insertExecutionPlan(executionTarget: ExecutionTarget, plan: ExecutionPlanInsert): Promise<boolean> {
    const key = `${executionTarget}|${plan.executionPlanId}`;
    if (this.plans.has(key)) return false;
    this.plans.set(key, structuredClone({ ...plan, executionTarget, compiledAt: this.now() }));
    return true;
  }

  async getExecutionPlan(executionTarget: ExecutionTarget, executionPlanId: string): Promise<ExecutionPlan | null> {
    const plan = this.plans.get(`${executionTarget}|${executionPlanId}`);
    return plan ? structuredClone(plan) : null;
  }

  get size(): number {
    return this.plans.size;
  }
}

export class InMemoryDecisionTrace implements DecisionTracePort {
  readonly traces: DecisionTrace[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  async append(executionTarget: ExecutionTarget, trace: DecisionTraceInsert): Promise<boolean> {
    if (this.traces.some((existing) => existing.traceId === trace.traceId)) return false;
    this.traces.push(structuredClone({ ...trace, executionTarget, createdAt: this.now() }));
    return true;
  }

  /** 期1-4 入口操作补充（对齐真实 store listByCorrelation：按写入序升序）。 */
  async listByCorrelation(
    executionTarget: ExecutionTarget,
    correlationId: string,
    limit = 200,
  ): Promise<DecisionTrace[]> {
    return this.traces
      .filter((trace) => trace.executionTarget === executionTarget && trace.correlationId === correlationId)
      .slice(0, limit)
      .map((trace) => structuredClone(trace));
  }
}

/** 可注入行为的假执行器：默认每步成功 + confirmedDelta=1，按 nodeId 覆盖行为。 */
export class FakeStepExecutor implements StepExecutor {
  readonly calls: { nodeId: string; stepRunId: string; checkpointRef: string | null }[] = [];
  readonly behaviors = new Map<
    string,
    (ctx: StepExecutionContext) => StepExecutionResult | Promise<StepExecutionResult>
  >();

  async execute(ctx: StepExecutionContext): Promise<StepExecutionResult> {
    this.calls.push({ nodeId: ctx.node.nodeId, stepRunId: ctx.stepRunId, checkpointRef: ctx.checkpointRef });
    const behavior = this.behaviors.get(ctx.node.nodeId);
    if (behavior) return behavior(ctx);
    return {
      kind: 'succeeded',
      resultRef: `result:${ctx.node.nodeId}`,
      checkpointRef: `ckpt:${ctx.node.nodeId}`,
      confirmedDelta: 1,
    };
  }

  callCount(nodeId: string): number {
    return this.calls.filter((call) => call.nodeId === nodeId).length;
  }
}

/** 可推表时钟（租约过期/接管测试用）。 */
export class FakeClock {
  private value: number;

  constructor(start = 1_000_000) {
    this.value = start;
  }

  now = (): number => this.value;

  advance(ms: number): void {
    this.value += ms;
  }
}
