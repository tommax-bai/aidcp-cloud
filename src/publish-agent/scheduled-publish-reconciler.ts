import type { EdgeTaskLeaseClient } from '../comm/edge-task-lease-client.js';
import type { CommandSequencer, ScheduledReconciliationResult } from './command-sequencer.js';
import type { ScheduledPublishRecord, ScheduledPublishStore } from '../kernel/publish-draft-contract.js';

const BACKOFF_MS = [15, 30, 60, 120, 240, 360, 360, 360].map((minutes) => minutes * 60_000);

export interface ScheduledPublishReconcilerDeps {
  store: ScheduledPublishStore;
  sequencer: Pick<CommandSequencer, 'executeScheduledReconciliation'>;
  edgeTaskLeases: Pick<EdgeTaskLeaseClient, 'withLease'>;
  resolveEdgeIdForAccount: (accountId: string) => string | null;
  isEdgePaused?: (edgeId: string) => boolean;
  recordPublish?: (accountId: string) => Promise<void>;
  clock?: () => number;
  intervalMs?: number;
  maxAttempts?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/**
 * XHS 原生定时稿到期对账。它只核验平台事实，不触发新发布；公开确认前不记发布次数。
 */
export class ScheduledPublishReconciler {
  private readonly clock: () => number;
  private readonly intervalMs: number;
  private readonly maxAttempts: number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: ScheduledPublishReconcilerDeps) {
    this.clock = deps.clock ?? Date.now;
    this.intervalMs = Math.max(10_000, deps.intervalMs ?? 60_000);
    this.maxAttempts = Math.max(1, deps.maxAttempts ?? 8);
    this.logger = deps.logger ?? console;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = await this.deps.store.listDueScheduled(20, this.clock());
      let processed = 0;
      // 串行处理，避免同一进程同时争夺多个账号的唯一浏览器页面。
      for (const record of due) {
        await this.reconcileOne(record);
        processed++;
      }
      return processed;
    } catch (err) {
      this.logger.warn(`[ScheduledPublishReconciler] 扫描失败：${err instanceof Error ? err.message : String(err)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private nextAt(record: ScheduledPublishRecord): number {
    const index = Math.min(record.reconcileAttempts, BACKOFF_MS.length - 1);
    return this.clock() + BACKOFF_MS[index];
  }

  private async defer(record: ScheduledPublishRecord, error: string): Promise<void> {
    const updated = await this.deps.store.deferScheduledReconcile(
      record.recordId,
      error,
      this.nextAt(record),
      this.maxAttempts,
    );
    if (updated?.status === 'needs_review') {
      this.logger.warn(
        `[ScheduledPublishReconciler] recordId=${record.recordId} 对账 ${updated.attempts} 次仍未确认公开 → needs_review (${error})`,
      );
    }
  }

  private async reconcileOne(record: ScheduledPublishRecord): Promise<void> {
    if (!record.title || !Number.isFinite(record.scheduledAt)) {
      await this.defer(record, 'scheduled_identity_invalid');
      return;
    }
    const edgeId = this.deps.resolveEdgeIdForAccount(record.accountId);
    if (!edgeId) {
      await this.defer(record, 'scheduled_reconcile_edge_offline');
      return;
    }
    if (this.deps.isEdgePaused?.(edgeId)) {
      await this.defer(record, 'scheduled_reconcile_edge_paused');
      return;
    }

    let result: ScheduledReconciliationResult;
    try {
      result = await this.deps.edgeTaskLeases.withLease(
        { edgeId, kind: 'publish', priority: 'automatic', leaseMs: 3 * 60_000 },
        (lease) => this.deps.sequencer.executeScheduledReconciliation({
          taskId: lease.taskId,
          recordId: record.recordId,
          edgeId,
          title: record.title,
          publishTime: record.scheduledAt,
          scheduledPlatformId: record.scheduledPlatformId,
          attempt: record.reconcileAttempts + 1,
        }),
      );
    } catch (err) {
      await this.defer(record, err instanceof Error ? err.message : String(err));
      return;
    }

    if (result.state === 'pending') {
      await this.defer(record, result.error);
      return;
    }

    // 原子 scheduled→published 是唯一记账凭证；重复/并发确认不双记。
    const firstConfirmation = await this.deps.store.confirmScheduledPublished(
      record.recordId,
      result.postId,
      result.postUrl,
    );
    if (!firstConfirmation) return;
    try {
      await this.deps.recordPublish?.(record.accountId);
    } catch (err) {
      // 事后账失败不能改写已确认的公开事实；只告警，与立即发布记账边界一致。
      this.logger.warn(
        `[ScheduledPublishReconciler] recordId=${record.recordId} 已确认公开但风控记账失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.logger.log(`[ScheduledPublishReconciler] recordId=${record.recordId} published postId=${result.postId}`);
  }
}

