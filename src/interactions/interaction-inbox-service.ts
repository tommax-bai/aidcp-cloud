import type { InteractionStore } from './interaction-store.js';
import type { InteractionMetrics } from './metrics.js';
import { riskActionForChannel, type InteractionRiskController } from './send-orchestrator.js';
import type { ReplyWorkflow } from './reply-workflow.js';
import type { ReplyConfigStore } from './reply-config-store.js';
import type {
  InteractionChannel,
  InteractionAuthStatusPayload,
  InteractionOffboardResultPayload,
  InteractionReplyReconcileResultPayload,
  InteractionReplyResultPayload,
  InteractionSyncAckPayload,
  InteractionSyncBatchPayload,
} from './types.js';
import { InteractionError } from './types.js';

export class InteractionInboxService {
  constructor(private readonly deps: {
    store: InteractionStore;
    workflow: ReplyWorkflow;
    configs: ReplyConfigStore;
    controllerFor: (accountId: string) => InteractionRiskController | undefined | Promise<InteractionRiskController | undefined>;
    metrics: InteractionMetrics;
    dispatchAuto?: (input: { accountId: string; envKey: string; jobId: string; expectedVersion: number }) => Promise<unknown>;
    getNickname?: (accountId: string) => string | null | undefined;
    setNickname?: (accountId: string, nickname: string) => Promise<void> | void;
    logger?: Pick<Console, 'warn'>;
  }) {}

  private async ensureReadable(accountId: string, envKey: string, channel: InteractionChannel): Promise<void> {
    const [controls, auth] = await Promise.all([
      this.deps.store.getRuntimeControls(accountId),
      this.deps.store.getAuth(accountId, envKey),
    ]);
    if (controls.envKey !== envKey) {
      throw new InteractionError('INTERACTION_SCOPE_MISMATCH', '环境与账号运行控制不匹配。', 409);
    }
    const readEnabled = channel === 'comment' ? controls.commentsReadEnabled : controls.dmReadEnabled;
    if (!readEnabled) throw new InteractionError('INTERACTION_FEATURE_DISABLED', '渠道入站同步未开启。', 503);
    if (!auth || auth.status !== 'active' || !auth.identity) {
      throw new InteractionError('INTERACTION_AUTH_REQUIRED', '平台登录态不可用于入站同步。', 409);
    }
    const capable = channel === 'comment' ? auth.capabilities.commentsRead : auth.capabilities.dmRead;
    if (!capable) throw new InteractionError('INTERACTION_PERMISSION_DENIED', '平台当前未确认渠道读取能力。', 403);
  }

  async onAuthStatus(payload: InteractionAuthStatusPayload): Promise<void> {
    await this.deps.store.upsertAuthStatus(payload);
    this.deps.metrics.increment('interaction_auth_status_total', { status: payload.status });

    const nickname = payload.status === 'active' ? payload.identity?.displayName.trim() : '';
    if (!nickname || !this.deps.setNickname) return;
    if (this.deps.getNickname?.(payload.accountId)?.trim() === nickname) return;

    try {
      await Promise.resolve(this.deps.setNickname(payload.accountId, nickname));
      this.deps.metrics.increment('interaction_account_nickname_total', { status: 'updated' });
    } catch (error) {
      this.deps.metrics.increment('interaction_account_nickname_total', { status: 'failed' });
      this.deps.logger?.warn(
        `[interaction] account nickname enrichment failed account=${payload.accountId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async onSyncBatch(payload: InteractionSyncBatchPayload): Promise<InteractionSyncAckPayload> {
    // 入站读取门禁与草稿/发布配置解耦：坏配置不影响已授权同步，读取开关和 auth 仍 fail closed。
    await this.ensureReadable(payload.accountId, payload.envKey, payload.channel);
    const result = await this.deps.store.ingestBatch(payload);
    this.deps.metrics.increment('interaction_sync_batch_total', { channel: payload.channel, status: result.ack.status });
    // ack 只依赖事务持久化；生成失败不会反向否定已接受的 batch/cursor。
    for (const jobId of result.newJobIds) {
      void this.deps.workflow.generate({
        accountId: payload.accountId, envKey: payload.envKey, jobId, expectedVersion: 0, actor: 'system',
      }).then((job) => job.state === 'queued' && this.deps.dispatchAuto
        ? this.deps.dispatchAuto({ accountId: payload.accountId, envKey: payload.envKey, jobId, expectedVersion: job.version })
        : undefined).catch((error) => {
        this.deps.metrics.increment('interaction_draft_generation_total', {
          status: 'failed', code: error instanceof Error ? error.name : 'unknown',
        });
      });
    }
    return result.ack;
  }

  async onReplyResult(payload: InteractionReplyResultPayload): Promise<{ duplicate: boolean }> {
    const applied = await this.deps.store.applyReplyResult(payload);
    this.deps.metrics.increment('interaction_reply_result_total', { channel: payload.channel, status: payload.status });
    const context = await this.deps.store.getJobContext(payload.accountId, payload.envKey, payload.jobId);
    const config = context?.job.configVersion == null ? null :
      await this.deps.configs.getSnapshot(payload.accountId, context.job.configVersion);
    const failureLimit = Math.max(1, config?.policy.rateLimits.consecutiveFailureLimit ?? 3);
    if (payload.status === 'confirmed') {
      await this.deps.store.noteSendOutcome(payload.accountId, true, failureLimit);
      if (applied.confirmedNeedsRiskRecord && await this.deps.store.claimRiskRecord(payload.attemptId)) {
        try {
          // 此处是 `status === 'confirmed'`——**平台已确认这条回复发出去了**。它已经发生，故必须记下。
          // 占位（claim）的释放判据是「**有没有写成**」，MUST NOT 是「策略允不允许」（change
          // risk-record-actuated-facts）：record 现在无条件写入既成事实，其返回值只答「在不在策略内」。
          // 若照旧按返回值释放占位，重放会**再写一次** ⇒ 真实重复计数。
          const controller = await this.deps.controllerFor(payload.accountId);
          if (!controller) {
            // 没拿到 controller ⇒ 什么都没写 ⇒ 释放占位、留给重放（这才是真故障）。
            await this.deps.store.releaseRiskRecordClaim(payload.attemptId);
            this.deps.metrics.increment('interaction_risk_record_total', { status: 'failed', channel: payload.channel });
          } else {
            const withinPolicy = await controller.record(riskActionForChannel(payload.channel));
            // 写已经发生 ⇒ 占位保留（绝不释放）。返回值只用来分辨这条回复是否超了策略——
            // 那是**观测**，不是「没记下」。注：`dm_reply` 三档配额默认 0（占位而非真上限，
            // quota_config 覆盖是其唯一启用路径）⇒ 该标签今天预期恒为 over_policy。
            this.deps.metrics.increment('interaction_risk_record_total', {
              status: withinPolicy ? 'recorded' : 'recorded_over_policy',
              channel: payload.channel,
            });
          }
        } catch {
          // 真抛错才释放占位（PG 故障等）——与「策略拒绝」是两回事，此前二者被收敛成同一处理、下游分不出。
          await this.deps.store.releaseRiskRecordClaim(payload.attemptId);
          this.deps.metrics.increment('interaction_risk_record_total', { status: 'failed', channel: payload.channel });
        }
      }
    } else if (payload.status === 'failed' && !applied.duplicate) {
      await this.deps.store.noteSendOutcome(payload.accountId, false, failureLimit);
    }
    return { duplicate: applied.duplicate };
  }

  async onReplyReconcileResult(payload: InteractionReplyReconcileResultPayload): Promise<void> {
    await this.deps.store.applyReplyReconcileResult(payload);
    for (const observation of payload.attempts) {
      this.deps.metrics.increment('interaction_reply_reconcile_total', { state: observation.state });
    }
  }

  async onOffboardResult(payload: InteractionOffboardResultPayload): Promise<{ duplicate: boolean }> {
    const applied = await this.deps.store.applyOffboardResult(payload);
    this.deps.metrics.increment('interaction_offboard_result_total', { status: payload.status });
    return applied;
  }

  async hasPendingOffboard(accountId: string): Promise<boolean> {
    return (await this.deps.store.pendingOffboards(accountId, 1)).length > 0;
  }
}
