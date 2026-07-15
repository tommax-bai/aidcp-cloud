import { randomUUID } from 'node:crypto';
import type { DelegatedTaskStore } from './store.js';
import type { DelegatedTask, DelegatedTaskAttempt, DelegatedVerificationKind } from './types.js';
import { honestTerminalStatus, isTerminalTaskStatus } from './types.js';

export type DelegatedExecutionResult =
  | { kind: 'success'; verificationKind: DelegatedVerificationKind; evidenceRef: string }
  | { kind: 'waiting_approval'; evidenceRef: string; reason?: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string; retryable?: boolean }
  | { kind: 'submitted_unknown'; reason: string; evidenceRef?: string }
  | { kind: 'deferred'; reason: string; retryAt: number };

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
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class DelegatedTaskWorker {
  private readonly now: () => number;
  private readonly workerId: string;
  private readonly claimLeaseMs: number;
  private readonly retryDelayMs: number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly deps: DelegatedTaskWorkerDeps) {
    this.now = deps.now ?? Date.now;
    this.workerId = deps.workerId ?? `delegated-${randomUUID()}`;
    // Publish generation may legitimately take ten minutes. Keep the ownership
    // lease beyond that boundary so another worker cannot dispatch the same
    // task while the first process is still awaiting an honest terminal result.
    this.claimLeaseMs = Math.max(10_000, deps.claimLeaseMs ?? 15 * 60_000);
    this.retryDelayMs = Math.max(1_000, deps.retryDelayMs ?? 30_000);
    this.logger = deps.logger ?? console;
  }

  start(intervalMs = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), Math.max(500, intervalMs));
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<DelegatedTask | null> {
    if (this.ticking) return null;
    this.ticking = true;
    try {
      await this.expireDueTasks();
      const task = await this.deps.store.claimNext({ workerId: this.workerId, leaseMs: this.claimLeaseMs, now: this.now() });
      if (!task || !task.claimToken) return null;
      return await this.processClaimed(task);
    } finally {
      this.ticking = false;
    }
  }

  private async processClaimed(task: DelegatedTask): Promise<DelegatedTask | null> {
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
    if (await this.deps.store.hasActiveOwnership(fresh.accountId, fresh.actionFamily, fresh.id)) {
      return this.update(await this.deps.store.releaseClaim(fresh.id, token, 'deferred', {
        nextEligibleAt: this.now() + this.retryDelayMs, step: 'waiting_ownership', reason: 'delegated_ownership_busy',
      }));
    }
    if (this.deps.externalBusy && await this.deps.externalBusy(fresh)) {
      return this.update(await this.deps.store.releaseClaim(fresh.id, token, 'deferred', {
        nextEligibleAt: this.now() + this.retryDelayMs, step: 'waiting_safe_slot', reason: 'scheduler_busy',
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
        return this.update(await this.deps.store.releaseClaim(fresh.id, token, 'waiting_approval', {
          nextEligibleAt: this.now() + this.retryDelayMs, step: 'waiting_approval', reason: 'approval_still_pending',
        }));
      }
      const result = await executor.reconcileWaitingApproval(fresh);
      const unsettled = await this.deps.store.listUnsettledAttempts(fresh.id);
      return this.handleWithoutNewAttempt(fresh, token, result, unsettled[0]);
    }

    const unsettled = await this.deps.store.listUnsettledAttempts(fresh.id);
    if (unsettled.length > 0) {
      const attempt = unsettled[0];
      if (!executor.reconcileAttempt) {
        return this.update(await this.deps.store.complete(fresh.id, token, 'failed', {
          code: 'submitted_result_unknown',
          message: '检测到已派发但未记账的尝试，缺少对账器；为防重复已停止自动重试。',
          submittedUnknown: attempt.status === 'dispatched',
        }));
      }
      const reconciled = await executor.reconcileAttempt(fresh, attempt);
      return this.handleAttemptResult(fresh, token, attempt, reconciled, true);
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
    let result: DelegatedExecutionResult;
    try {
      result = await executor.execute(executing, attempt);
    } catch (err) {
      this.logger.warn(`[delegated-task] executor failed task=${fresh.id}: ${(err as Error).message}`);
      result = { kind: 'failed', reason: `executor_exception:${(err as Error).message}`, retryable: true };
    }
    return this.handleAttemptResult(executing, token, attempt, result, false);
  }

  private async handleAttemptResult(
    task: DelegatedTask,
    token: string,
    attempt: DelegatedTaskAttempt,
    result: DelegatedExecutionResult,
    reconciling: boolean,
  ): Promise<DelegatedTask | null> {
    if (result.kind === 'deferred') {
      if (!reconciling && attempt.status === 'prepared') {
        await this.deps.store.finishAttempt(attempt.id, { status: 'skipped', verificationKind: 'not_dispatched', reason: result.reason });
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
    if (result.kind === 'waiting_approval') {
      return this.update(await this.deps.store.releaseClaim(task.id, token, 'waiting_approval', {
        nextEligibleAt: this.now() + this.retryDelayMs, step: 'waiting_approval', reason: result.reason,
      }));
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
      return this.update(await this.deps.store.complete(fresh.id, token, honestTerminalStatus(fresh.progress, 'failure'), {
        code: 'non_retryable_failure', message: fatalReason,
      }));
    }
    if (fresh.progress.attemptCount >= fresh.maxAttempts) return this.finishBudget(fresh, token, 'max_attempts');
    if (fresh.deadlineAt <= this.now()) return this.finishBudget(fresh, token, 'deadline');
    return this.update(await this.deps.store.releaseClaim(fresh.id, token, 'queued', {
      nextEligibleAt: this.now() + 1_000, step: 'next_attempt', reason: 'goal_not_reached',
    }));
  }

  private async finishBudget(task: DelegatedTask, token: string, reason: 'deadline' | 'max_attempts'): Promise<DelegatedTask | null> {
    const status = honestTerminalStatus(task.progress, reason);
    return this.update(await this.deps.store.complete(task.id, token, status, {
      code: reason,
      message: `${reason === 'deadline' ? '已到截止时间' : '已达到最大尝试次数'}；真实完成 ${task.progress.successCount}/${task.targetSuccessCount}。`,
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
      await this.deps.store.complete(task.id, null, honestTerminalStatus(task.progress, 'deadline'), {
        code: 'deadline', message: `已到截止时间；真实完成 ${task.progress.successCount}/${task.targetSuccessCount}。`,
        remainingCount: Math.max(0, task.targetSuccessCount - task.progress.successCount),
      });
    }
  }

  private async update(task: DelegatedTask | null): Promise<DelegatedTask | null> {
    if (task) await this.deps.onTaskUpdated?.(task);
    return task;
  }
}
