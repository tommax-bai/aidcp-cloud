import { createHash, randomUUID } from 'node:crypto';
import { makeEnvelope } from '../comm/protocol.js';
import type { EdgePusher } from '../comm/ws-server.js';
import { automaticReplyContentEligible } from './reply-auto-send.js';
import { readJobConfig, type ReplyConfigReader } from '../kernel/interaction-reply-contract.js';
import { validateFinalReplyText } from '../kernel/interaction-reply-contract.js';
import type { InteractionStore } from './interaction-store.js';
import type { InteractionMetrics } from './metrics.js';
import type { ReplyPreviewResult } from './reply-workflow.js';
import {
  INTERACTION_PLATFORM,
  INTERACTION_BROWSER_CONTROL_CAPABILITY,
  INTERACTION_TEST_DATA_RESET_CAPABILITY,
  InteractionError,
  type InteractionAuthReopenPayload,
  type InteractionBrowserControlPayload,
  type InteractionChannel,
  type InteractionSyncRequestPayload,
  type ReplyConfigSnapshot,
  type RuntimeControls,
  type ScopedJobContext,
} from '../kernel/interaction-types.js';

export interface InteractionRiskController {
  explain(action: 'comment' | 'dm_reply'): { allowed: boolean; reason?: string };
  record(action: 'comment' | 'dm_reply'): Promise<boolean>;
}

function enabled(value: string | undefined): boolean {
  return value?.trim().toLocaleLowerCase() === 'true';
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function replyIdempotencyKey(context: ScopedJobContext): string {
  const finalText = context.job.finalText;
  if (!finalText) throw new InteractionError('INTERACTION_VALIDATION_FAILED', '回复内容为空。', 422);
  const finalTextSha256 = sha256(finalText);
  return sha256(`${INTERACTION_PLATFORM}|${context.thread.accountId}|${context.message.id}|${context.job.id}|${finalTextSha256}`);
}

interface GateResult {
  context: ScopedJobContext;
  snapshot: ReplyConfigSnapshot;
  controls: RuntimeControls;
  action: 'comment' | 'dm_reply';
}

function interactionRiskBlocked(result: { allowed: boolean; reason?: string }): boolean {
  return !result.allowed && !result.reason?.startsWith('quota:');
}

export class InteractionSendOrchestrator {
  private readonly globalWriteEnabled: boolean;
  private readonly clock: () => number;

  constructor(private readonly deps: {
    store: InteractionStore;
    configs: ReplyConfigReader;
    pusher: EdgePusher;
    isEdgePaused?: (edgeId: string) => boolean;
    controllerFor: (accountId: string) => InteractionRiskController | undefined | Promise<InteractionRiskController | undefined>;
    metrics: InteractionMetrics;
    globalWriteEnabled?: boolean;
    env?: NodeJS.ProcessEnv;
    clock?: () => number;
  }) {
    const env = deps.env ?? process.env;
    this.globalWriteEnabled = deps.globalWriteEnabled ?? enabled(env.AIDCP_INTERACTION_WRITE_ENABLED);
    this.clock = deps.clock ?? Date.now;
  }

  private blocked(code: ConstructorParameters<typeof InteractionError>[0], message: string, status = 409): never {
    this.deps.metrics.increment('interaction_send_blocked_total', { code });
    throw new InteractionError(code, message, status);
  }

  /** 生成阶段的 auto_safe 完整门禁；任一未知/失败均降级人工审批，不抛给同步链。 */
  async canAutoQueueDraft(
    context: ScopedJobContext,
    snapshot: ReplyConfigSnapshot,
    preview: ReplyPreviewResult,
  ): Promise<boolean> {
    const downgrade = (reason: string): false => {
      this.deps.metrics.increment('interaction_auto_downgrade_total', { reason, channel: context.thread.channel });
      return false;
    };
    try {
      if (!this.globalWriteEnabled) return downgrade('global_write_disabled');
      if (snapshot.state !== 'published' || snapshot.policy.mode !== 'auto_safe' || !snapshot.policy.sendReplies ||
          !snapshot.policy.channels[context.thread.channel].enabled ||
          !snapshot.policy.channels[context.thread.channel].allowAutoSend) return downgrade('policy');
      const rule = snapshot.rules.find((item) => item.ruleId === preview.matchedRuleId &&
        item.channel === context.thread.channel) ?? null;
      const profile = snapshot.profiles.find((item) => item.channel === context.thread.channel) ?? null;
      if (preview.requiresApproval || preview.fallbacks.classifier !== 'none' ||
          preview.fallbacks.polisher !== 'none' || preview.fallbacks.reviewer !== 'none' ||
          !automaticReplyContentEligible({
            rule,
            profile,
            aiPolishEnabled: snapshot.policy.channels[context.thread.channel].aiPolishEnabled,
            inboundText: context.message.contentText,
            evidence: preview,
          })) {
        return downgrade('risk');
      }
      const controls = await this.deps.store.getRuntimeControls(context.thread.accountId);
      if (controls.envKey !== context.thread.envKey || controls.writePaused || controls.circuitOpenedAt !== null) {
        return downgrade('runtime_controls');
      }
      if (context.thread.channel === 'comment' ? !controls.commentsReplyEnabled : !controls.dmSendTextEnabled) {
        return downgrade('channel_disabled');
      }
      const authGate = await this.deps.store.getSendAuthGate(context.thread.accountId, context.thread.envKey);
      if (!authGate || authGate.auth.status !== 'active' || !authGate.auth.identity) return downgrade('auth');
      const capability = context.thread.channel === 'comment'
        ? authGate.auth.capabilities.commentsReply : authGate.auth.capabilities.dmSendText;
      if (!capability) return downgrade('capability');
      if (authGate.activeSince === null ||
          this.clock() - authGate.activeSince < snapshot.policy.rateLimits.newLoginCooldownSeconds * 1_000) {
        return downgrade('login_cooldown');
      }
      const action = context.thread.channel === 'comment' ? 'comment' : 'dm_reply';
      const controller = await this.deps.controllerFor(context.thread.accountId);
      if (!controller || interactionRiskBlocked(controller.explain(action))) return downgrade('risk_controller');
      const limits = snapshot.policy.rateLimits;
      const counts = await this.deps.store.sendWindowCounts(context.thread.accountId, context.thread.id, this.clock());
      if (limits.accountPerMinute <= 0 || counts.minute >= limits.accountPerMinute ||
          limits.accountPerHour <= 0 || counts.hour >= limits.accountPerHour ||
          limits.accountPerDay <= 0 || counts.day >= limits.accountPerDay) return downgrade('rate_limit');
      if (counts.lastThreadSendAt !== null &&
          this.clock() - counts.lastThreadSendAt < limits.threadCooldownSeconds * 1_000) return downgrade('thread_cooldown');
      return true;
    } catch {
      return downgrade('unknown');
    }
  }

  private async gate(accountId: string, envKey: string, jobId: string): Promise<GateResult> {
    if (!this.globalWriteEnabled) this.blocked('INTERACTION_FEATURE_DISABLED', '互动写总开关未开启。', 503);
    const context = await this.deps.store.getJobContext(accountId, envKey, jobId);
    if (!context) this.blocked('INTERACTION_NOT_FOUND', '回复任务不存在。', 404);
    if (!context.job.finalText?.trim() || context.message.messageType !== 'text' || context.message.lifecycle !== 'active') {
      this.blocked('INTERACTION_VALIDATION_FAILED', '回复文本或原消息状态不允许发送。', 422);
    }
    const snapshot = context.job.configVersion === null ? null : await readJobConfig(this.deps.configs,
      accountId, context.job.configScopeId, context.job.configVersion,
    );
    if (!snapshot || snapshot.state !== 'published' || !snapshot.policy.sendReplies ||
        !snapshot.policy.channels[context.thread.channel].enabled) {
      this.blocked('INTERACTION_CONFIG_MISSING', '已发布回复配置缺失或发送未开启。', 422);
    }
    const profile = snapshot.profiles.find((item) => item.channel === context.thread.channel);
    if (!profile || validateFinalReplyText(profile, context.job.finalText).length) {
      this.blocked('INTERACTION_VALIDATION_FAILED', '最终回复未通过账号 profile 确定性门禁。', 422);
    }
    const controls = await this.deps.store.getRuntimeControls(accountId);
    if (controls.envKey !== envKey || controls.writePaused || controls.circuitOpenedAt !== null) {
      this.blocked('INTERACTION_FEATURE_DISABLED', '账号写入已暂停或熔断。', 503);
    }
    const channelAllowed = context.thread.channel === 'comment'
      ? controls.commentsReplyEnabled
      : controls.dmSendTextEnabled;
    if (!channelAllowed) this.blocked('INTERACTION_FEATURE_DISABLED', '渠道写开关未开启。', 503);
    const authGate = await this.deps.store.getSendAuthGate(accountId, envKey);
    if (!authGate || authGate.auth.status !== 'active' || !authGate.auth.identity) {
      this.blocked('INTERACTION_AUTH_REQUIRED', '平台登录态不可用于回复。', 409);
    }
    const capability = context.thread.channel === 'comment'
      ? authGate.auth.capabilities.commentsReply
      : authGate.auth.capabilities.dmSendText;
    if (!capability) this.blocked('INTERACTION_PERMISSION_DENIED', '平台当前未确认回复能力。', 403);
    const auto = context.job.approvalActor === null;
    const cooldownMs = snapshot.policy.rateLimits.newLoginCooldownSeconds * 1_000;
    if (auto && (
      authGate.activeSince === null || this.clock() - authGate.activeSince < cooldownMs
    )) {
      this.blocked('INTERACTION_RATE_LIMITED', '登录冷却尚未结束。', 429);
    }
    const matchedRule = snapshot.rules.find((item) => item.ruleId === context.job.matchedRuleId &&
      item.channel === context.thread.channel) ?? null;
    if (auto && (snapshot.policy.mode !== 'auto_safe' ||
        !snapshot.policy.channels[context.thread.channel].allowAutoSend ||
        !automaticReplyContentEligible({
          rule: matchedRule,
          profile,
          aiPolishEnabled: snapshot.policy.channels[context.thread.channel].aiPolishEnabled,
          inboundText: context.message.contentText,
          evidence: context.job,
        }))) {
      this.blocked('INTERACTION_APPROVAL_REQUIRED', '自动发送条件未全部满足。', 409);
    }
    const action = context.thread.channel === 'comment' ? 'comment' : 'dm_reply';
    const controller = await this.deps.controllerFor(accountId);
    if (!controller) this.blocked('INTERACTION_UPSTREAM_UNAVAILABLE', '风险控制器不可用。', 503);
    const risk = controller.explain(action);
    if (interactionRiskBlocked(risk)) {
      this.blocked('INTERACTION_RATE_LIMITED', '风险状态不允许本次回复。', 429);
    }
    const limits = snapshot.policy.rateLimits;
    const counts = await this.deps.store.sendWindowCounts(accountId, context.thread.id, this.clock());
    if (limits.accountPerMinute <= 0 || counts.minute >= limits.accountPerMinute ||
        limits.accountPerHour <= 0 || counts.hour >= limits.accountPerHour ||
        limits.accountPerDay <= 0 || counts.day >= limits.accountPerDay) {
      this.blocked('INTERACTION_RATE_LIMITED', '账号回复限额已达到。', 429);
    }
    if (counts.lastThreadSendAt !== null &&
        this.clock() - counts.lastThreadSendAt < limits.threadCooldownSeconds * 1_000) {
      this.blocked('INTERACTION_RATE_LIMITED', '会话回复冷却尚未结束。', 429);
    }
    return { context, snapshot, controls, action };
  }

  /** Customer send 只把 approved CAS 推到 queued；2xx 绝不冒充平台 sent。 */
  async queueApproved(input: {
    accountId: string; envKey: string; jobId: string; expectedVersion: number; actor: string;
  }): Promise<ScopedJobContext['job']> {
    await this.gate(input.accountId, input.envKey, input.jobId);
    const job = await this.deps.store.transitionJob({ ...input, from: ['approved'], to: 'queued' });
    await this.deps.store.recordAudit({ accountId: input.accountId, envKey: input.envKey, actor: input.actor,
      action: 'reply_queued', entityType: 'reply_job', entityId: input.jobId,
      summary: 'reply queued', labels: { state: job.state } });
    return job;
  }

  /** Worker 路径：再次复核全部门禁后才创建唯一 attempt 并定向下发。 */
  async dispatchQueued(input: {
    accountId: string; envKey: string; jobId: string; expectedVersion: number;
  }): Promise<{ job: ScopedJobContext['job']; attemptId: string }> {
    const gated = await this.gate(input.accountId, input.envKey, input.jobId);
    if (gated.context.job.state !== 'queued') {
      this.blocked('INTERACTION_STATE_CONFLICT', '任务未处于 queued。', 409);
    }
    const idempotencyKey = replyIdempotencyKey(gated.context);
    const edgeId = this.deps.pusher.resolveEdgeIdForAccount?.(input.accountId) ?? null;
    if (!edgeId) {
      this.deps.metrics.increment('interaction_send_blocked_total', { code: 'INTERACTION_UPSTREAM_UNAVAILABLE', reason: 'edge_offline' });
      throw new InteractionError('INTERACTION_UPSTREAM_UNAVAILABLE', '账号当前没有在线 Edge。', 503, true);
    }
    if (this.deps.isEdgePaused?.(edgeId)) {
      this.deps.metrics.increment('interaction_send_blocked_total', { code: 'INTERACTION_UPSTREAM_UNAVAILABLE', reason: 'edge_paused' });
      throw new InteractionError('INTERACTION_UPSTREAM_UNAVAILABLE', '账号 Edge 正处于验证码暂停，稍后自动重试。', 503, true);
    }
    const now = this.clock();
    const created = await this.deps.store.createAttempt({
      ...input, idempotencyKey, rateLimits: gated.snapshot.policy.rateLimits, now,
    });
    const payload = {
      jobId: input.jobId,
      attemptId: created.attempt.id,
      idempotencyKey,
      envKey: input.envKey,
      accountId: input.accountId,
      platform: INTERACTION_PLATFORM,
      channel: gated.context.thread.channel,
      target: {
        threadExternalId: gated.context.thread.externalThreadId,
        inboundMessageExternalId: gated.context.message.externalMessageId,
        parentExternalId: gated.context.message.externalParentId,
      },
      content: { type: 'text' as const, text: gated.context.job.finalText! },
      expiresAt: now + 120_000,
    };
    let sent: number;
    try {
      sent = this.deps.pusher.pushToEdges(
        makeEnvelope('interaction.reply.send', created.attempt.id, now, payload), edgeId,
      );
    } catch {
      await this.deps.store.markDispatchAmbiguous(input.accountId, input.envKey, created.attempt.id,
        'INTERACTION_UPSTREAM_UNAVAILABLE');
      this.deps.metrics.increment('interaction_send_attempt_total', { status: 'ambiguous', reason: 'dispatch_exception' });
      throw new InteractionError('INTERACTION_SEND_AMBIGUOUS', '回复命令下发结果不确定，已停止自动重试。', 409);
    }
    if (sent === 0) {
      await this.deps.store.markDispatchDeferred(input.accountId, input.envKey, created.attempt.id, 'INTERACTION_UPSTREAM_UNAVAILABLE');
      this.deps.metrics.increment('interaction_send_attempt_total', { status: 'deferred', reason: 'not_delivered' });
      throw new InteractionError('INTERACTION_UPSTREAM_UNAVAILABLE', '回复命令未送达唯一 Edge。', 503, true);
    }
    if (sent !== 1) {
      await this.deps.store.markDispatchAmbiguous(input.accountId, input.envKey, created.attempt.id,
        'INTERACTION_UPSTREAM_UNAVAILABLE');
      this.deps.metrics.increment('interaction_send_attempt_total', { status: 'ambiguous', reason: 'multiple_delivery' });
      throw new InteractionError('INTERACTION_SEND_AMBIGUOUS', '回复命令送达数量异常，已停止自动重试。', 409);
    }
    await this.deps.store.markAttemptDispatched(input.accountId, input.envKey, created.attempt.id);
    this.deps.metrics.increment('interaction_send_attempt_total', { status: 'dispatched', channel: gated.context.thread.channel });
    return { job: created.job, attemptId: created.attempt.id };
  }

  /** Reconcile only carries existing attempt identities to Edge's verification-only route. */
  async reconcileRecoverable(accountId: string, edgeId: string): Promise<number> {
    const refs = await this.deps.store.recoverableAttempts(accountId, 100);
    let dispatched = 0;
    const byEnv = new Map<string, typeof refs>();
    for (const ref of refs) byEnv.set(ref.envKey, [...(byEnv.get(ref.envKey) ?? []), ref]);
    for (const [envKey, scoped] of byEnv) {
      const reconcileId = randomUUID();
      const sent = this.deps.pusher.pushToEdges(makeEnvelope('interaction.reply.reconcile', reconcileId, this.clock(), {
        reconcileId, envKey, accountId, platform: INTERACTION_PLATFORM,
        attempts: scoped.map((ref) => ({ cloudStatus: ref.status, command: ref.command })),
        requestedAt: this.clock(),
      }), edgeId);
      if (sent === 1) dispatched += scoped.length;
      this.deps.metrics.increment('interaction_reply_reconcile_dispatch_total', {
        status: sent === 1 ? 'dispatched' : 'deferred', count: String(scoped.length),
      });
    }
    return dispatched;
  }

  async requestSync(
    input: Omit<InteractionSyncRequestPayload, 'requestId' | 'requestedAt' | 'platform'>,
    options?: { beforeDispatch?: () => Promise<void> },
  ): Promise<string> {
    const [controls, auth] = await Promise.all([
      this.deps.store.getRuntimeControls(input.accountId),
      this.deps.store.getAuth(input.accountId, input.envKey),
    ]);
    if (controls.envKey !== input.envKey) {
      throw new InteractionError('INTERACTION_SCOPE_MISMATCH', '环境与账号运行控制不匹配。', 409);
    }
    const enabledForChannel = input.channel === 'comment' ? controls.commentsReadEnabled : controls.dmReadEnabled;
    if (!enabledForChannel) throw new InteractionError('INTERACTION_FEATURE_DISABLED', '渠道入站同步未开启。', 503);
    if (!auth || auth.status !== 'active' || !auth.identity) {
      throw new InteractionError('INTERACTION_AUTH_REQUIRED', '平台登录态不可用于入站同步。', 409);
    }
    const capable = input.channel === 'comment' ? auth.capabilities.commentsRead : auth.capabilities.dmRead;
    if (!capable) throw new InteractionError('INTERACTION_PERMISSION_DENIED', '平台当前未确认渠道读取能力。', 403);
    const requestId = randomUUID();
    const requiredCapability = input.reason === 'test_reset' ? INTERACTION_TEST_DATA_RESET_CAPABILITY : undefined;
    const edgeId = this.deps.pusher.resolveEdgeIdForAccount?.(input.accountId, requiredCapability) ?? null;
    if (!edgeId) throw new InteractionError('INTERACTION_UPSTREAM_UNAVAILABLE', '账号当前没有在线 Edge。', 503, true);
    const payload: InteractionSyncRequestPayload = { ...input, requestId, platform: INTERACTION_PLATFORM, requestedAt: this.clock() };
    await options?.beforeDispatch?.();
    if (this.deps.pusher.pushToEdges(makeEnvelope('interaction.sync.request', requestId, this.clock(), payload), edgeId) !== 1) {
      throw new InteractionError('INTERACTION_UPSTREAM_UNAVAILABLE', '同步请求未送达唯一 Edge。', 503, true);
    }
    return requestId;
  }

  // 下面两个方法**签名恒异步**（本地实现里没有一个 await，这是正常的）：同一个端口在拆进程后
  // 会由一个必须过网络的实现满足，若这里留成同步，端口就只能写成「同步或异步」——那让调用方
  // 有机会漏掉 await 而把一个 Promise 当 requestId 写进台账，且不报错。见 kernel 端口注释。
  async requestAuthReopen(
    input: Omit<InteractionAuthReopenPayload, 'requestId' | 'requestedAt' | 'platform'>,
  ): Promise<string> {
    const requestId = randomUUID();
    const edgeId = this.deps.pusher.resolveEdgeIdForAccount?.(input.accountId) ?? null;
    if (!edgeId) throw new InteractionError('INTERACTION_UPSTREAM_UNAVAILABLE', '账号当前没有在线 Edge。', 503, true);
    const payload: InteractionAuthReopenPayload = { ...input, requestId, platform: INTERACTION_PLATFORM, requestedAt: this.clock() };
    if (this.deps.pusher.pushToEdges(makeEnvelope('interaction.auth.reopen', requestId, this.clock(), payload), edgeId) !== 1) {
      throw new InteractionError('INTERACTION_UPSTREAM_UNAVAILABLE', '登录重开请求未送达唯一 Edge。', 503, true);
    }
    return requestId;
  }

  async requestBrowserControl(
    input: Omit<InteractionBrowserControlPayload, 'requestId' | 'requestedAt' | 'platform'>,
  ): Promise<string> {
    const requestId = randomUUID();
    const edgeId = this.deps.pusher.resolveEdgeIdForAccount?.(
      input.accountId,
      INTERACTION_BROWSER_CONTROL_CAPABILITY,
    ) ?? null;
    if (!edgeId) {
      throw new InteractionError(
        'INTERACTION_UPSTREAM_UNAVAILABLE',
        '账号当前没有支持浏览器前台控制的在线 Edge。',
        503,
        true,
      );
    }
    const payload: InteractionBrowserControlPayload = {
      ...input,
      requestId,
      platform: INTERACTION_PLATFORM,
      requestedAt: this.clock(),
    };
    if (this.deps.pusher.pushToEdges(makeEnvelope('interaction.browser.control', requestId, this.clock(), payload), edgeId) !== 1) {
      throw new InteractionError('INTERACTION_UPSTREAM_UNAVAILABLE', '浏览器控制请求未送达唯一 Edge。', 503, true);
    }
    return requestId;
  }
}

export function riskActionForChannel(channel: InteractionChannel): 'comment' | 'dm_reply' {
  return channel === 'comment' ? 'comment' : 'dm_reply';
}
