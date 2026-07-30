/**
 * 引擎层（期1-5）：TaskRun 队列 worker——落库 + 唤醒 + 扫表保底循环。
 *
 * 节奏与生命周期沿用 src/delegated-task/worker.ts 的既有先例（setInterval 保底扫表
 * + 事件唤醒 + claim/lease 所有权），但状态面走期1 的正交三元组与 RunStateStore：
 *   - claimNextQueued 原子认领（FOR UPDATE SKIP LOCKED），执行期间按租约 1/3 周期续租；
 *   - 崩溃后由任意 worker 的 reclaimExpiredLeases 把过期 running 放回 queued 接管；
 *   - 每步完成写检查点（StepRun 终态 + recordRunProgress），恢复时以 step_runs 终态
 *     为真相从最后检查点继续，不重复执行已完成节点、不重复计数；
 *   - cancel_requested 在**步间安全点**生效：当前步执行完即停，run 落 terminal/cancelled；
 *   - 续租失败区分「取消」与「租约易主」：前者继续执行到安全点，后者 abort 当前步
 *     且此后不再代表该 run 写任何状态（新 owner 已接管）。
 *
 * 总开关（默认关闭）：AIDCP_MANAGED_AUTOMATION_WORKER_ENABLED === 'true' 才启动。
 * 期1-3 的任务模式会话开关是另一位工程师的交付；本 worker 用独立子开关，
 * 后续接线时可在组合根把两者 AND 起来，开关语义互不覆盖。
 */

import { randomUUID } from 'node:crypto';
import type { ExecutionTarget } from '../contracts/common.js';
import type { CapabilityId } from '../contracts/capability.js';
import type { ReasonCode, TerminalReasonCode } from '../contracts/reason-codes.js';
import type { RunProgress, RunTerminalOutcome, TaskRun } from '../contracts/task-run.js';
import type { ClaimedTaskRun, TaskRunInsert } from '../stores/run-state-store.js';
import { resolveLinearChain } from './linear-graph.js';
import type { PlanAuthorityPort, RunStatePort } from './ports.js';
import type { StepExecutionResult, StepExecutor } from './step-executor.js';

/** 总开关环境变量名。默认关闭：仅显式 'true' 启动（fail-closed，与任务要求一致）。 */
export const MANAGED_AUTOMATION_WORKER_ENV = 'AIDCP_MANAGED_AUTOMATION_WORKER_ENABLED';

export function isManagedAutomationWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MANAGED_AUTOMATION_WORKER_ENV] === 'true';
}

export interface TaskRunWorkerDeps {
  executionTarget: ExecutionTarget;
  runState: RunStatePort;
  planAuthority: PlanAuthorityPort;
  /** 能力 → 执行器路由；解析不到即 run 诚实终态 failed(capability_not_available)。 */
  executorFor: (capabilityId: CapabilityId) => StepExecutor | null;
  /** 缺省从环境开关读取；测试可显式注入。 */
  enabled?: boolean;
  now?: () => number;
  workerId?: string;
  leaseMs?: number;
  renewIntervalMs?: number;
  /** 单次 tick 最多认领的 run 数（保底扫表的批量上限）。 */
  maxRunsPerTick?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/** 单步终态记录（run 终态聚合的输入）。 */
export interface StepOutcomeRecord {
  outcome: RunTerminalOutcome;
  reasonCode: ReasonCode | null;
}

const ORTHOGONAL_NULLS = { waitReason: null, terminalOutcome: null } as const;

export class TaskRunWorker {
  private readonly enabled: boolean;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly renewIntervalMs: number;
  private readonly maxRunsPerTick: number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private timer: NodeJS.Timeout | null = null;
  private pumping = false;
  private wakePending = false;
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(private readonly deps: TaskRunWorkerDeps) {
    this.enabled = deps.enabled ?? isManagedAutomationWorkerEnabled();
    this.workerId = deps.workerId ?? `managed-run-${randomUUID()}`;
    this.leaseMs = Math.max(5_000, deps.leaseMs ?? 5 * 60_000);
    this.renewIntervalMs = Math.max(500, deps.renewIntervalMs ?? Math.floor(this.leaseMs / 3));
    this.maxRunsPerTick = Math.max(1, Math.trunc(deps.maxRunsPerTick ?? 5));
    this.logger = deps.logger ?? console;
  }

  /** 开关关闭即拒绝启动（返回 false），绝不静默空转。 */
  start(intervalMs = 5_000): boolean {
    if (!this.enabled) {
      this.logger.log(
        `[managed-automation] TaskRun worker 未启动：${MANAGED_AUTOMATION_WORKER_ENV} 未显式开启（默认关闭）`,
      );
      return false;
    }
    if (this.timer) return true;
    this.timer = setInterval(() => this.wake(), Math.max(500, intervalMs));
    this.timer.unref?.();
    this.wake();
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const abort of this.activeRuns.values()) abort.abort(new Error('worker_stopped'));
  }

  /** 落库 + 唤醒：insertRun 幂等（重放返回 false），随后立刻踢一次扫表。 */
  async enqueue(run: TaskRunInsert): Promise<boolean> {
    const inserted = await this.deps.runState.insertRun(this.deps.executionTarget, run);
    this.wake();
    return inserted;
  }

  /** 事件唤醒入口；未 start（含开关关闭）时不做任何事。 */
  wake(): void {
    if (!this.timer) return;
    if (this.pumping) {
      this.wakePending = true;
      return;
    }
    this.pumping = true;
    void this.tick()
      .catch((err) => this.logger.error(`[managed-automation] tick 异常：${(err as Error).message}`))
      .finally(() => {
        this.pumping = false;
        if (this.wakePending) {
          this.wakePending = false;
          this.wake();
        }
      });
  }

  /**
   * 单轮维护：回收过期租约 → 收敛无主的 cancel_requested → 认领并执行 queued。
   * 测试直接 await tick()，不依赖定时器。
   */
  async tick(): Promise<number> {
    const target = this.deps.executionTarget;
    const reclaimed = await this.deps.runState.reclaimExpiredLeases(target);
    if (reclaimed.length > 0) {
      this.logger.warn(`[managed-automation] 回收过期租约 ${reclaimed.length} 条：${reclaimed.join(', ')}`);
    }
    // cancel_requested 行不持租约（CAS 离开 running 即清 claim），queued 期被取消的
    // run 永远不会被 claim——这里保底收敛终态。本进程正在执行的 run 留给步间安全点。
    const cancels = await this.deps.runState.listRunsByStatus(target, 'cancel_requested', 20);
    for (const run of cancels) {
      if (this.activeRuns.has(run.runId)) continue;
      await this.finalizeCancelled(run);
    }
    let processed = 0;
    while (processed < this.maxRunsPerTick) {
      const claimed = await this.deps.runState.claimNextQueued(
        target,
        `${this.workerId}:${randomUUID()}`,
        this.leaseMs,
      );
      if (!claimed) break;
      processed += 1;
      await this.processClaimed(claimed);
    }
    return processed;
  }

  private async processClaimed(claimed: ClaimedTaskRun): Promise<void> {
    const target = this.deps.executionTarget;
    const { run, claimToken } = claimed;
    const abort = new AbortController();
    this.activeRuns.set(run.runId, abort);
    // 续租失败 ≠ 一律中断：取消清租约但要求「当前步执行完即停」，只有真正易主才 abort。
    const renewTimer = setInterval(() => {
      void (async () => {
        const renewed = await this.deps.runState
          .renewLease(target, run.runId, claimToken, this.leaseMs)
          .catch(() => false);
        if (renewed || abort.signal.aborted) return;
        const fresh = await this.deps.runState.getRun(target, run.runId).catch(() => null);
        if (fresh?.status === 'cancel_requested') return;
        abort.abort(new Error('lease_lost'));
      })();
    }, this.renewIntervalMs);
    renewTimer.unref?.();
    try {
      await this.executeRun(run, claimToken, abort.signal);
    } finally {
      clearInterval(renewTimer);
      this.activeRuns.delete(run.runId);
    }
  }

  private async executeRun(run: TaskRun, claimToken: string, signal: AbortSignal): Promise<void> {
    const target = this.deps.executionTarget;
    const plan = await this.deps.planAuthority.getExecutionPlan(target, run.executionPlanId);
    if (!plan) {
      await this.terminalRun(run.runId, 'failed', 'contract_invalid');
      return;
    }
    const chain = resolveLinearChain(plan.nodes.map((node) => node.nodeId), plan.edges);
    if (!chain.ok || chain.order[0] !== plan.entryNodeId) {
      // 编译产物本应保证线性；读回非法即诚实失败，绝不猜执行顺序。
      await this.terminalRun(run.runId, 'failed', 'contract_invalid');
      return;
    }
    const nodeById = new Map(plan.nodes.map((node) => [node.nodeId, node]));
    const existingSteps = await this.deps.runState.listStepRunsByRun(target, run.runId);
    const stepByNode = new Map(existingSteps.map((step) => [step.nodeId, step]));
    const progress: RunProgress = { ...run.progress };
    const outcomes: StepOutcomeRecord[] = [];

    for (const nodeId of chain.order) {
      const node = nodeById.get(nodeId)!;
      if (!node.enabled) continue;

      // 恢复：已终态的步是检查点真相，不重复执行、不重复计数。
      const existing = stepByNode.get(nodeId);
      if (existing?.status === 'terminal') {
        if (existing.terminalOutcome === 'failed') {
          // 理论上不可达（失败步当场终结 run）；读到即如实终结，不重跑失败步。
          await this.terminalRun(run.runId, 'failed', existing.reasonCode);
          return;
        }
        outcomes.push({ outcome: existing.terminalOutcome!, reasonCode: existing.reasonCode });
        continue;
      }

      // —— 步间安全点：取消 / 所有权变化在这里生效 ——
      if (signal.aborted) return;
      const fresh = await this.deps.runState.getRun(target, run.runId);
      if (!fresh) return;
      if (fresh.status === 'cancel_requested') {
        await this.finalizeCancelled(fresh);
        return;
      }
      if (fresh.status !== 'running') return; // 已被回收/接管/终态，立即让位

      const executor = this.deps.executorFor(node.capabilityId);
      if (!executor) {
        await this.terminalRun(run.runId, 'failed', 'capability_not_available');
        return;
      }

      let stepRunId: string;
      let checkpointRef: string | null = null;
      if (existing) {
        stepRunId = existing.stepRunId;
        checkpointRef = existing.checkpointRef;
        if (existing.status === 'running') {
          // 崩溃残留的 running 步：重置回 queued，经正常起步路径续跑（attempt_count 递增）。
          await this.deps.runState.transitionStep(target, stepRunId, 'running', {
            status: 'queued', reasonCode: null, ...ORTHOGONAL_NULLS,
          });
        }
      } else {
        stepRunId = randomUUID();
        await this.deps.runState.insertStepRun(target, {
          stepRunId,
          runId: run.runId,
          nodeId: node.nodeId,
          capabilityId: node.capabilityId,
          capabilityVersion: node.capabilityVersion,
          executionTarget: target,
          inputRef: node.inputBindingRef,
          status: 'queued',
          reasonCode: null,
          ...ORTHOGONAL_NULLS,
        });
      }
      const started = await this.deps.runState.transitionStep(target, stepRunId, 'queued', {
        status: 'running', reasonCode: null, ...ORTHOGONAL_NULLS,
      });
      if (!started) return; // 步状态不在预期（并发接管等），让位

      let result: StepExecutionResult;
      try {
        result = await executor.execute({
          executionTarget: target,
          run: fresh,
          plan,
          node,
          stepRunId,
          checkpointRef,
          signal,
        });
      } catch (err) {
        result = { kind: 'failed', reasonCode: 'executor_unavailable', detail: (err as Error).message };
      }
      if (signal.aborted) return; // 租约已易主/停机：不再代表该 run 写任何状态

      progress.attemptCount += 1;
      if (result.kind === 'succeeded') {
        if (result.checkpointRef !== null || result.resultRef !== null) {
          await this.deps.runState.recordStepCheckpoint(target, stepRunId, result.checkpointRef, result.resultRef);
        }
        await this.deps.runState.transitionStep(target, stepRunId, 'running', {
          status: 'terminal', waitReason: null, terminalOutcome: 'succeeded', reasonCode: null,
        });
        progress.confirmedCount += Math.max(0, result.confirmedDelta);
        outcomes.push({ outcome: 'succeeded', reasonCode: null });
      } else if (result.kind === 'skipped') {
        await this.deps.runState.transitionStep(target, stepRunId, 'running', {
          status: 'terminal', waitReason: null, terminalOutcome: 'skipped', reasonCode: result.reasonCode,
        });
        progress.skippedCount += 1;
        outcomes.push({ outcome: 'skipped', reasonCode: result.reasonCode });
      } else {
        await this.deps.runState.transitionStep(target, stepRunId, 'running', {
          status: 'terminal', waitReason: null, terminalOutcome: 'failed', reasonCode: result.reasonCode,
        });
        progress.failureCount += 1;
        await this.deps.runState.recordRunProgress(target, run.runId, claimToken, progress, nodeId);
        await this.terminalRun(run.runId, 'failed', result.reasonCode);
        return;
      }
      // 每步完成写检查点：进度计数 + currentNodeId（谓词式，取消/易主后写不进即忽略）。
      await this.deps.runState.recordRunProgress(target, run.runId, claimToken, progress, nodeId);
    }

    // 链走完：末位安全点再看一次取消，然后按步结果聚合诚实终态。
    const fresh = await this.deps.runState.getRun(target, run.runId);
    if (!fresh) return;
    if (fresh.status === 'cancel_requested') {
      await this.finalizeCancelled(fresh);
      return;
    }
    if (fresh.status !== 'running') return;
    const aggregate = aggregateRunOutcome(outcomes);
    await this.terminalRun(run.runId, aggregate.outcome, aggregate.reasonCode);
  }

  /**
   * cancel_requested → terminal/cancelled（取消来源码若已写在 run 上则保留）。
   * CAS 未命中即让位——别处（执行方安全点或另一 worker 保底）已经收敛。
   */
  private async finalizeCancelled(run: TaskRun): Promise<void> {
    const reasonCode: TerminalReasonCode =
      run.reasonCode === 'cancelled_by_system' ? 'cancelled_by_system' : 'cancelled_by_user';
    await this.deps.runState.transitionRun(this.deps.executionTarget, run.runId, 'cancel_requested', {
      status: 'terminal', waitReason: null, terminalOutcome: 'cancelled', reasonCode,
    });
  }

  /**
   * running → terminal 的 CAS 收尾。未命中时读回现状：若已是 cancel_requested
   * （终结与取消赛跑），转交取消收敛；其余情况让位并如实记日志。
   */
  private async terminalRun(
    runId: string,
    terminalOutcome: RunTerminalOutcome,
    reasonCode: ReasonCode | null,
  ): Promise<void> {
    const target = this.deps.executionTarget;
    const done = await this.deps.runState.transitionRun(target, runId, 'running', {
      status: 'terminal', waitReason: null, terminalOutcome, reasonCode,
    });
    if (done) return;
    const fresh = await this.deps.runState.getRun(target, runId);
    if (fresh?.status === 'cancel_requested') {
      await this.finalizeCancelled(fresh);
      return;
    }
    this.logger.warn(
      `[managed-automation] run=${runId} 终态 CAS 未命中（现状 ${fresh?.status ?? '不存在'}），让位不覆盖`,
    );
  }
}

/**
 * 步结果 → run 终态聚合（诚实口径，design §16/§17）：
 *   全部成功 → succeeded；全部跳过 → skipped；有成有跳 → partially_succeeded；
 *   reasonCode 取最后一个跳过步的原因码原样传播，绝不猜测或改写。
 *   全部节点被禁用（零工作被授权执行）按 succeeded 空洞成立处理。
 */
export function aggregateRunOutcome(outcomes: readonly StepOutcomeRecord[]): StepOutcomeRecord {
  const skipped = outcomes.filter((record) => record.outcome === 'skipped');
  if (skipped.length === 0) return { outcome: 'succeeded', reasonCode: null };
  const lastSkipReason = skipped[skipped.length - 1].reasonCode;
  if (skipped.length === outcomes.length) return { outcome: 'skipped', reasonCode: lastSkipReason };
  return { outcome: 'partially_succeeded', reasonCode: lastSkipReason };
}
