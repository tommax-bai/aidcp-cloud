import { randomUUID } from 'node:crypto';
import type { DelegatedTaskStore, InterruptedClaimRecovery } from './store.js';
import type { DelegatedTask, DelegatedTaskAttempt, DelegatedVerificationKind } from './types.js';
import { honestTerminalStatus, isTerminalTaskStatus } from './types.js';
import { humanizeAttemptReason } from './reason-humanize.js';

export type DelegatedExecutionResult =
  | { kind: 'success'; verificationKind: DelegatedVerificationKind; evidenceRef: string }
  | { kind: 'waiting_approval'; evidenceRef: string; reason?: string }
  | { kind: 'cancelled'; reason: string; evidenceRef?: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string; retryable?: boolean }
  | { kind: 'submitted_unknown'; reason: string; evidenceRef?: string }
  | {
      kind: 'deferred';
      reason: string;
      retryAt: number;
      /** 仅在执行器能证明没有浏览器或平台动作被派发时为 false。 */
      attemptStarted?: boolean;
    };

export interface DelegatedTaskExecutor {
  targetKey(task: DelegatedTask): Promise<string> | string;
  execute(task: DelegatedTask, attempt: DelegatedTaskAttempt): Promise<DelegatedExecutionResult>;
  reconcileAttempt?(task: DelegatedTask, attempt: DelegatedTaskAttempt): Promise<DelegatedExecutionResult>;
  reconcileWaitingApproval?(task: DelegatedTask): Promise<DelegatedExecutionResult>;
}

export interface DelegatedTaskWorkerDeps {
  store: DelegatedTaskStore;
  executorFor: (task: DelegatedTask) => DelegatedTaskExecutor | null;
  externalBusy?: (task: DelegatedTask) => Promise<boolean> | boolean;
  platformStillMatches?: (task: DelegatedTask) => Promise<boolean> | boolean;
  onTaskUpdated?: (task: DelegatedTask) => Promise<void> | void;
  now?: () => number;
  workerId?: string;
  claimLeaseMs?: number;
  retryDelayMs?: number;
  maxConcurrent?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class DelegatedTaskWorker {
  private readonly now: () => number;
  private readonly workerId: string;
  private readonly claimLeaseMs: number;
  private readonly retryDelayMs: number;
  private readonly maxConcurrent: number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private timer: NodeJS.Timeout | null = null;
  private activeExecutions = 0;
  private admissionTail: Promise<void> = Promise.resolve();
  private interruptedRecovery: Promise<InterruptedClaimRecovery[]> | null = null;

  constructor(private readonly deps: DelegatedTaskWorkerDeps) {
    this.now = deps.now ?? Date.now;
    this.workerId = deps.workerId ?? `delegated-${randomUUID()}`;
    // Publish generation may legitimately take ten minutes. Keep the ownership
    // lease beyond that boundary so another worker cannot dispatch the same
    // task while the first process is still awaiting an honest terminal result.
    this.claimLeaseMs = Math.max(10_000, deps.claimLeaseMs ?? 15 * 60_000);
    this.retryDelayMs = Math.max(1_000, deps.retryDelayMs ?? 30_000);
    this.maxConcurrent = Math.max(1, Math.trunc(deps.maxConcurrent ?? 3));
    this.logger = deps.logger ?? console;
  }

  async start(intervalMs = 5_000): Promise<void> {
    if (this.timer) return;
    await this.recoverInterruptedClaims();
    if (this.timer) return;
    this.timer = setInterval(() => this.pump(), Math.max(500, intervalMs));
    this.timer.unref?.();
    this.pump();
  }

  /**
   * Process-start boundary only: a new worker has no surviving in-memory executions, so any
   * persisted planning/executing claim belongs to the exited process. Runtime lease expiry alone
   * is not enough evidence because publish generation can legitimately outlive the claim lease.
   */
  async recoverInterruptedClaims(): Promise<InterruptedClaimRecovery[]> {
    if (this.timer || this.activeExecutions > 0) throw new Error('interrupted_claim_recovery_after_worker_start');
    if (!this.interruptedRecovery) {
      this.interruptedRecovery = this.deps.store.recoverInterruptedClaims(this.now()).then((recovered) => {
        if (recovered.length > 0) {
          this.logger.warn(`[delegated-task] recovered ${recovered.length} interrupted claim(s) before worker start`);
          for (const item of recovered) {
            this.logger.warn(
              `[delegated-task] interrupted claim task=${item.task.id} from=${item.fromStatus} to=${item.task.status}`,
            );
          }
        }
        return recovered;
      });
    }
    return this.interruptedRecovery;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<DelegatedTask | null> {
    const releaseAdmission = await this.acquireAdmission();
    if (this.activeExecutions >= this.maxConcurrent) {
      releaseAdmission();
      return null;
    }
    this.activeExecutions += 1;
    try {
      await this.expireDueTasks();
      const task = await this.deps.store.claimNext({ workerId: this.workerId, leaseMs: this.claimLeaseMs, now: this.now() });
      if (!task || !task.claimToken) return null;
      return await this.processClaimed(task, releaseAdmission);
    } finally {
      releaseAdmission();
      this.activeExecutions -= 1;
    }
  }

  private pump(): void {
    for (let slot = 0; slot < this.maxConcurrent; slot += 1) void this.tick();
  }

  private async processClaimed(task: DelegatedTask, releaseAdmission: () => void): Promise<DelegatedTask | null> {
    const token = task.claimToken!;
    const fresh = await this.deps.store.get(task.id);
    if (!fresh || fresh.claimToken !== token) return fresh;
    if (fresh.cancelRequested) return this.finishCancelled(fresh, token);
    if (fresh.pauseRequested) {
      return this.update(await this.deps.store.releaseClaim(fresh.id, token, 'deferred', { step: 'paused_by_user', reason: 'pause_requested' }));
    }
    if (this.deps.platformStillMatches && !(await this.deps.platformStillMatches(fresh))) {
      return this.update(await this.deps.store.complete(fresh.id, token, 'failed', {
        code: 'platform_changed', message: '账号平台事实已变化，任务未路由到其他平台。',
      }));
    }
    const executor = this.deps.executorFor(fresh);
    if (!executor) {
      return this.update(await this.deps.store.complete(fresh.id, token, 'failed', {
        code: 'executor_unavailable', message: `动作 ${fresh.action} 未接入执行器，未发生平台写入。`,
      }));
    }

    if (fresh.currentStep === 'reconcile_waiting_approval') {
      if (!executor.reconcileWaitingApproval) {
        return this.deps.store.releaseWaitingApprovalClaim(fresh.id, token, this.now() + this.retryDelayMs);
      }
      releaseAdmission();
      const result = await executor.reconcileWaitingApproval(fresh);
      const unsettled = await this.deps.store.listUnsettledAttempts(fresh.id);
      return this.handleWithoutNewAttempt(fresh, token, result, unsettled[0]);
    }

    const unsettled = await this.deps.store.listUnsettledAttempts(fresh.id);
    if (unsettled.length > 0) {
      const attempt = unsettled[0];
      if (attempt.status === 'prepared') {
        await this.deps.store.discardAttemptBeforeStart(attempt.id, 'worker_restart_before_dispatch');
        return this.update(await this.deps.store.releaseClaim(fresh.id, token, 'queued', {
          nextEligibleAt: this.now(), step: 'recovered_before_dispatch', reason: 'worker_restart_before_dispatch',
        }));
      }
      if (!executor.reconcileAttempt) {
        return this.update(await this.deps.store.complete(fresh.id, token, 'failed', {
          code: 'submitted_result_unknown',
          message: '检测到已派发但未记账的尝试，缺少对账器；为防重复已停止自动重试。',
          submittedUnknown: attempt.status === 'dispatched',
        }));
      }
      releaseAdmission();
      const reconciled = await executor.reconcileAttempt(fresh, attempt);
      return this.handleAttemptResult(fresh, token, attempt, reconciled, true);
    }

    if (await this.deps.store.hasTaskOwnershipConflict(fresh)) {
      return this.update(await this.deps.store.releaseClaim(fresh.id, token, 'deferred', {
        nextEligibleAt: this.now() + this.retryDelayMs, step: 'waiting_ownership', reason: 'delegated_ownership_busy',
      }));
    }
    if (this.deps.externalBusy && await this.deps.externalBusy(fresh)) {
      return this.update(await this.deps.store.releaseClaim(fresh.id, token, 'deferred', {
        nextEligibleAt: this.now() + this.retryDelayMs, step: 'waiting_safe_slot', reason: 'scheduler_busy',
      }));
    }

    if (fresh.progress.attemptCount >= fresh.maxAttempts) return this.finishBudget(fresh, token, 'max_attempts');
    const targetKey = await executor.targetKey(fresh);
    let attempt: DelegatedTaskAttempt;
    try {
      attempt = await this.deps.store.startAttempt(fresh.id, token, targetKey);
    } catch (err) {
      if ((err as Error).message === 'duplicate_attempt_target') {
        return this.update(await this.deps.store.releaseClaim(fresh.id, token, 'deferred', {
          nextEligibleAt: this.now() + this.retryDelayMs, step: 'waiting_new_target', reason: 'duplicate_target',
        }));
      }
      throw err;
    }
    await this.deps.store.markAttemptDispatched(attempt.id);
    const executing = await this.deps.store.markExecuting(fresh.id, token, `executing:${fresh.action}`);
    if (!executing || executing.claimToken !== token) return executing;
    releaseAdmission();
    let result: DelegatedExecutionResult;
    try {
      result = await executor.execute(executing, attempt);
    } catch (err) {
      this.logger.warn(`[delegated-task] executor failed task=${fresh.id}: ${(err as Error).message}`);
      result = { kind: 'failed', reason: `executor_exception:${(err as Error).message}`, retryable: true };
    }
    return this.handleAttemptResult(executing, token, attempt, result, false);
  }

  private async acquireAdmission(): Promise<() => void> {
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const previous = this.admissionTail;
    this.admissionTail = previous.then(() => turn);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseTurn();
    };
  }

  private async handleAttemptResult(
    task: DelegatedTask,
    token: string,
    attempt: DelegatedTaskAttempt,
    result: DelegatedExecutionResult,
    reconciling: boolean,
  ): Promise<DelegatedTask | null> {
    if (result.kind === 'cancelled') {
      return this.finishExecutionCancelled(task, token, result, attempt);
    }
    if (result.kind === 'deferred') {
      if (!reconciling && result.attemptStarted === false) {
        await this.deps.store.discardAttemptBeforeStart(attempt.id, result.reason);
      } else if (!reconciling && attempt.status === 'prepared') {
        // 未显式证明零动作的一般 defer 保持旧账本语义；worker 不猜测浏览器/平台是否已被触碰。
        // `not_started` 仍区别于“跑过但未写”的 not_dispatched，供既有终态说明使用。
        await this.deps.store.finishAttempt(attempt.id, { status: 'skipped', verificationKind: 'not_started', reason: result.reason });
      }
      return this.update(await this.deps.store.releaseClaim(task.id, token, 'deferred', {
        nextEligibleAt: result.retryAt, step: 'deferred', reason: result.reason,
      }));
    }
    if (result.kind === 'waiting_approval') {
      await this.deps.store.annotateAttempt(attempt.id, 'candidate_persisted', result.evidenceRef, result.reason);
      return this.update(await this.deps.store.complete(task.id, token, 'waiting_approval', {
        code: 'waiting_approval', message: result.reason ?? '候选已持久化，等待人工审批。', evidenceRef: result.evidenceRef,
      }));
    }
    if (result.kind === 'submitted_unknown') {
      const latest = await this.deps.store.finishAttempt(attempt.id, {
        status: 'submitted_unknown', verificationKind: 'submitted_unknown', evidenceRef: result.evidenceRef, reason: result.reason,
      });
      const status = honestTerminalStatus(latest.progress, 'failure');
      return this.update(await this.deps.store.complete(latest.id, token, status, {
        code: 'submitted_result_unknown', message: result.reason, submittedUnknown: true,
      }));
    }
    const finish = result.kind === 'success'
      ? { status: 'succeeded' as const, verificationKind: result.verificationKind, evidenceRef: result.evidenceRef }
      : result.kind === 'skipped'
        ? { status: 'skipped' as const, verificationKind: 'not_dispatched' as const, reason: result.reason }
        : { status: 'failed' as const, verificationKind: 'not_dispatched' as const, reason: result.reason };
    const latest = await this.deps.store.finishAttempt(attempt.id, finish);
    return this.afterSettledAttempt(latest, token, result.kind === 'failed' && result.retryable === false ? result.reason : undefined);
  }

  private async handleWithoutNewAttempt(
    task: DelegatedTask,
    token: string,
    result: DelegatedExecutionResult,
    attempt?: DelegatedTaskAttempt,
  ): Promise<DelegatedTask | null> {
    if (result.kind === 'cancelled') {
      return this.finishExecutionCancelled(task, token, result, attempt);
    }
    if (result.kind === 'waiting_approval') {
      return this.deps.store.releaseWaitingApprovalClaim(task.id, token, this.now() + this.retryDelayMs);
    }
    if (result.kind === 'success') {
      const latest = attempt
        ? await this.deps.store.finishAttempt(attempt.id, {
            status: 'succeeded', verificationKind: result.verificationKind, evidenceRef: result.evidenceRef,
          })
        : task;
      return this.afterSettledAttempt(latest, token);
    }
    if (result.kind === 'submitted_unknown') {
      const latest = attempt
        ? await this.deps.store.finishAttempt(attempt.id, {
            status: 'submitted_unknown', verificationKind: 'submitted_unknown', evidenceRef: result.evidenceRef, reason: result.reason,
          })
        : task;
      return this.update(await this.deps.store.complete(latest.id, token, honestTerminalStatus(latest.progress, 'failure'), {
        code: 'submitted_result_unknown', message: result.reason, submittedUnknown: true,
      }));
    }
    if (result.kind === 'deferred') {
      return this.update(await this.deps.store.releaseClaim(task.id, token, 'deferred', {
        nextEligibleAt: result.retryAt, step: 'deferred', reason: result.reason,
      }));
    }
    const code = result.kind === 'skipped' ? 'approval_not_completed' : 'approval_failed';
    const latest = attempt
      ? await this.deps.store.finishAttempt(attempt.id, {
          status: result.kind === 'skipped' ? 'skipped' : 'failed', verificationKind: 'not_dispatched', reason: result.reason,
        })
      : task;
    return this.update(await this.deps.store.complete(latest.id, token, honestTerminalStatus(latest.progress, 'failure'), {
      code, message: result.reason,
    }));
  }

  private async finishExecutionCancelled(
    task: DelegatedTask,
    token: string,
    result: Extract<DelegatedExecutionResult, { kind: 'cancelled' }>,
    attempt?: DelegatedTaskAttempt,
  ): Promise<DelegatedTask | null> {
    const latest = attempt
      ? await this.deps.store.finishAttempt(attempt.id, {
          status: 'skipped',
          verificationKind: 'not_dispatched',
          evidenceRef: result.evidenceRef,
          reason: result.reason,
        })
      : task;
    return this.update(await this.deps.store.complete(
      latest.id,
      token,
      honestTerminalStatus(latest.progress, 'cancelled'),
      {
        code: 'candidate_cancelled_by_user',
        message: result.reason,
        evidenceRef: result.evidenceRef,
        remainingCount: Math.max(0, latest.targetSuccessCount - latest.progress.successCount),
      },
    ));
  }

  private async afterSettledAttempt(task: DelegatedTask, token: string, fatalReason?: string): Promise<DelegatedTask | null> {
    const fresh = await this.deps.store.get(task.id) ?? task;
    if (fresh.cancelRequested) return this.finishCancelled(fresh, token);
    if (fresh.pauseRequested) {
      return this.update(await this.deps.store.releaseClaim(fresh.id, token, 'deferred', { step: 'paused_by_user', reason: 'pause_requested' }));
    }
    if (fresh.progress.successCount >= fresh.targetSuccessCount) {
      return this.update(await this.deps.store.complete(fresh.id, token, 'completed', {
        code: 'target_reached', message: `已验证完成 ${fresh.progress.successCount}/${fresh.targetSuccessCount}。`, remainingCount: 0,
      }));
    }
    if (fatalReason) {
      // 非重试终态也要说人话：`needs_persona_setup` 这类码正是**只走这条路**（blocked → retryable:false），
      // 从不经预算终态——只在 finishBudget 接人话化，等于白名单里最常见的那几条永远吐生码给运营。
      return this.update(await this.deps.store.complete(fresh.id, token, honestTerminalStatus(fresh.progress, 'failure'), {
        code: 'non_retryable_failure', message: humanizeAttemptReason(fatalReason) || fatalReason,
      }));
    }
    if (fresh.progress.attemptCount >= fresh.maxAttempts) return this.finishBudget(fresh, token, 'max_attempts');
    if (fresh.deadlineAt <= this.now()) return this.finishBudget(fresh, token, 'deadline');
    return this.update(await this.deps.store.releaseClaim(fresh.id, token, 'queued', {
      nextEligibleAt: this.now() + 1_000, step: 'next_attempt', reason: 'goal_not_reached',
    }));
  }

  /**
   * 预算终态的记账句：「为什么停」。它**不是**失败原因——见 budgetFailureSuffix。
   */
  private budgetHeadline(task: DelegatedTask, reason: 'deadline' | 'max_attempts'): string {
    return `${reason === 'deadline' ? '已到截止时间' : '已达到最大尝试次数'}；真实完成 ${task.progress.successCount}/${task.targetSuccessCount}。`;
  }

  /**
   * 预算终态的「为什么没成」尾巴（change delegated-terminal-failure-reason）。
   *
   * 「已达到最大尝试次数」是预算耗尽的记账，不是失败原因；只给记账等同于静默失败——卡发出来了，
   * 但运营无法判断该重试、该改配置还是该等。原因在 attempt settle 时即已持久化，这里读回来。
   *
   * 取「最后一条已 settle 且带原因的非成功 attempt」。成功的 attempt 不带 reason，故该判据天然选中
   * 最后一次未成；未 settle 的（prepared / dispatched）排除在外——它们的 reason 可能只是审批中的注解。
   * 读不到原因就返回空串，由调用方保持原样，**绝不补一句「原因未知，可能是…」的推测**。
   */
  private async budgetFailureSuffix(task: DelegatedTask): Promise<string> {
    let attempts: DelegatedTaskAttempt[];
    try {
      attempts = await this.deps.store.listAttempts(task.id);
    } catch (err) {
      // 读原因失败绝不能连累终态收敛：退回「只有记账」的既有行为，如实记日志。
      this.logger.warn(`[delegated-task] 读取 attempt 原因失败 task=${task.id}: ${(err as Error).message}`);
      return '';
    }
    const settled = attempts.filter((a) => a.status !== 'prepared' && a.status !== 'dispatched');
    const lastUnsuccessful = [...settled]
      .reverse()
      .find((a) => a.status !== 'succeeded' && (a.reason ?? '').trim());
    const why = lastUnsuccessful ? humanizeAttemptReason(lastUnsuccessful.reason ?? '') : '';
    if (!why) return '';
    // 原因串的收尾标点各家不一（中文句常自带「。」，机器码 / 英文异常没有）。先剥掉尾标点再由本方法
    // 统一收句，免得拼出「…未生成稿件。（共 2 次尝试）」这种断句。
    const core = why.replace(/[。！？.!?]+$/, '');
    // 「均未真正开始」是一个**关于平台没被碰过的断言**，只能由证据支撑，不能由计数器推断：
    // `skipped` 同时覆盖「让开、执行器没跑」(not_started) 与「执行器跑了、搜了词开了页、最终判定不写」
    // (not_dispatched)，二者 skippedCount 一样。靠 `skippedCount === attemptCount` 断言等于说了拿不出
    // 证据的话（红线：绝不编造）。故判据 = 每一条已 settle 的 attempt 都留下了 not_started 证据。
    const neverStarted = settled.length > 0 && settled.every((a) => a.verificationKind === 'not_started');
    if (neverStarted) {
      return `${settled.length} 次均未真正开始：${core}。`;
    }
    // 其余一律只报最后一次未成；多于一次时标注总次数。不做原因聚类统计（YAGNI）。
    return settled.length > 1
      ? `最后一次未成原因：${core}（共 ${settled.length} 次尝试）。`
      : `最后一次未成原因：${core}。`;
  }

  private async finishBudget(task: DelegatedTask, token: string, reason: 'deadline' | 'max_attempts'): Promise<DelegatedTask | null> {
    const status = honestTerminalStatus(task.progress, reason);
    const suffix = await this.budgetFailureSuffix(task);
    return this.update(await this.deps.store.complete(task.id, token, status, {
      code: reason,
      message: `${this.budgetHeadline(task, reason)}${suffix}`,
      remainingCount: Math.max(0, task.targetSuccessCount - task.progress.successCount),
    }));
  }

  private async finishCancelled(task: DelegatedTask, token: string): Promise<DelegatedTask | null> {
    const status = honestTerminalStatus(task.progress, 'cancelled');
    return this.update(await this.deps.store.complete(task.id, token, status, {
      code: 'remaining_cancelled_by_user', message: `已取消剩余部分；保留真实完成 ${task.progress.successCount}/${task.targetSuccessCount}。`,
      remainingCount: Math.max(0, task.targetSuccessCount - task.progress.successCount),
    }));
  }

  private async expireDueTasks(): Promise<void> {
    const now = this.now();
    const tasks = await this.deps.store.list({ limit: 200 });
    for (const task of tasks) {
      if (isTerminalTaskStatus(task.status) || task.status === 'awaiting_confirmation' || task.deadlineAt > now) continue;
      if (task.claimToken && task.claimExpiresAt && task.claimExpiresAt > now) continue;
      const remainingCount = Math.max(0, task.targetSuccessCount - task.progress.successCount);
      // 派发在途、租约却已失效（进程重启 / 15min 租约过期）：那条命令**可能已经在平台上写入了**，
      // 结果未知。绝不能以「干净失败」终结、更不能叠一个来自更早尝试的、听着很确定的原因——那是
      // 反向的假确定性（红线：绝不编造）。processClaimed 对同一状态走的是 submitted_result_unknown
      // 那支（见上），expireDueTasks 从前没有对应分支——本 change 让到期终态开始发卡，这个洞就
      // 从「只脏了面板」升级成「向运营谎报失败」，故一并补。
      const inFlight = (await this.deps.store.listUnsettledAttempts(task.id)).some((a) => a.status === 'dispatched');
      if (inFlight) {
        await this.update(await this.deps.store.complete(task.id, null, honestTerminalStatus(task.progress, 'failure'), {
          code: 'submitted_result_unknown',
          message: `${this.budgetHeadline(task, 'deadline')}最后一次派发到期仍未收到结果，平台是否已写入未知；为防重复未自动重试。`,
          submittedUnknown: true,
          remainingCount,
        }));
        continue;
      }
      const suffix = await this.budgetFailureSuffix(task);
      // this.update：终态失败卡的唯一投递路径（onTaskUpdated 只由 update 触发）。从前这里裸调
      // store.complete → 到期失败**一张卡都不发**、纯静默（红线：绝不静默失败）。
      await this.update(await this.deps.store.complete(task.id, null, honestTerminalStatus(task.progress, 'deadline'), {
        code: 'deadline', message: `${this.budgetHeadline(task, 'deadline')}${suffix}`,
        remainingCount,
      }));
    }
  }

  private async update(task: DelegatedTask | null): Promise<DelegatedTask | null> {
    if (task) await this.deps.onTaskUpdated?.(task);
    return task;
  }
}
