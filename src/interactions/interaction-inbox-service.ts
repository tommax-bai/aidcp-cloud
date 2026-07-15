import type { InteractionStore } from './interaction-store.js';
import type { InteractionMetrics } from './metrics.js';
import { riskActionForChannel, type InteractionRiskController } from './send-orchestrator.js';
import type { ReplyWorkflow } from './reply-workflow.js';
import type { ReplyConfigStore } from './reply-config-store.js';
import type {
  InteractionChannel,
  InteractionAuthStatusPayload,
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

  async onReplyResult(payload: InteractionReplyResultPayload): Promise<void> {
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
          const recorded = await (await this.deps.controllerFor(payload.accountId))?.record(riskActionForChannel(payload.channel));
          if (!recorded) {
            await this.deps.store.releaseRiskRecordClaim(payload.attemptId);
            this.deps.metrics.increment('interaction_risk_record_total', { status: 'denied', channel: payload.channel });
          } else {
            this.deps.metrics.increment('interaction_risk_record_total', { status: 'recorded', channel: payload.channel });
          }
        } catch {
          await this.deps.store.releaseRiskRecordClaim(payload.attemptId);
          this.deps.metrics.increment('interaction_risk_record_total', { status: 'failed', channel: payload.channel });
        }
      }
    } else if (payload.status === 'failed' && !applied.duplicate) {
      await this.deps.store.noteSendOutcome(payload.accountId, false, failureLimit);
    }
  }
}
