import type { EventBus } from '../event-bus/index.js';
import type { EdgePusher } from './edge-steps.js';
import {
  FacebookGroupJoinJudge,
  type FacebookGroupJoinJudgeResult,
  type FacebookGroupJoinObservation,
} from '../agents/facebook-group-join-judge.js';
import type { RoleLlmLike } from '../agents/comment-search-term-generator.js';
import {
  type FacebookGroupJoinAuditRow,
  type FacebookGroupMembershipRow,
  type FacebookGroupMembershipStatus,
  FacebookGroupJoinAuditStore,
  FacebookGroupMembershipStore,
  FacebookGroupTargetStore,
  canonicalFacebookGroupUrl,
} from './facebook-group-store.js';
import { buildFacebookGroupJoinEdgeSteps, type FacebookGroupJoinStepResult } from './facebook-group-join-edge-steps.js';
import { EdgeTaskLeaseError, type EdgeTaskLeaseClient } from '../comm/edge-task-lease-client.js';

export interface FacebookGroupJoinSchedulerDeps {
  resolveConnection: (accountId: string) => { bus: EventBus; edgeId?: string } | null;
  pusher: EdgePusher;
  edgeTaskLeases: Pick<EdgeTaskLeaseClient, 'withLease'>;
  targets: FacebookGroupTargetStore;
  memberships: FacebookGroupMembershipStore;
  audit: FacebookGroupJoinAuditStore;
  llmFor?: (accountId: string) => RoleLlmLike;
  canJoin?: (accountId: string) => boolean | Promise<boolean>;
  canUseSessionJoin?: (accountId: string, edgeId?: string) => boolean | Promise<boolean>;
  recordSessionJoin?: (accountId: string, edgeId?: string) => boolean | Promise<boolean>;
  isFacebookAccount?: (accountId: string) => boolean | Promise<boolean>;
  pauseAccount?: (accountId: string, reason: string) => Promise<void> | void;
  autoEnabled?: () => boolean;
  shadow?: () => boolean;
  retryBackoffMs?: number;
  maxAttempts?: number;
  stepTimeoutMs?: number;
  /** 网络瞬态退避抖动源（测试注入定值）；缺省 Math.random（P1-5）。 */
  random?: () => number;
  logger?: Pick<Console, 'warn' | 'log'>;
}

export interface FacebookGroupJoinTriggerResult {
  triggered: boolean;
  reason?: string;
  groupUrl?: string;
  outcome?: string;
}

function statusForEdgeReason(reason?: string): FacebookGroupMembershipStatus {
  switch (reason) {
    case 'login_required':
    case 'blocked_by_captcha':
      return 'checkpoint';
    case 'questionnaire_required':
    case 'pending':
      return 'pending';
    case 'no_button':
      return 'no_button';
    default:
      return 'failed';
  }
}

function outcomeForReason(reason?: string): FacebookGroupJoinAuditRow['outcome'] {
  switch (reason) {
    case 'login_required':
      return 'login_required';
    case 'blocked_by_captcha':
      return 'blocked_by_captcha';
    case 'questionnaire_required':
      return 'questionnaire_required';
    case 'pending':
      return 'pending';
    case 'no_button':
      return 'no_button';
    case 'nav_error':
      return 'nav_error';
    default:
      return 'join_failed';
  }
}

function isAccountTransient(reason: string): boolean {
  return reason === 'login_required' || reason === 'blocked_by_captcha';
}

// 网络/渲染瞬态短退避（change facebook-join-comment-resilience，P1-5）：边端浏览器忙/离线/掉线、导航异常、
// 就绪/点击后慢渲染（not_ready / post_not_confirmed_slow）都是快恢复的基础设施瞬态。用分钟级 + 去相关抖动的
// 短冷却（远短于账号级 6h），让被占/慢的群很快能再试；抖动防所有账号在同一 60s 心跳边界撞同一群（惊群）。
const NETWORK_TRANSIENT_BACKOFF_MIN_MS = 2 * 60_000;
const NETWORK_TRANSIENT_BACKOFF_MAX_MS = 8 * 60_000;
function networkTransientBackoffMs(random: () => number): number {
  const span = NETWORK_TRANSIENT_BACKOFF_MAX_MS - NETWORK_TRANSIENT_BACKOFF_MIN_MS;
  const r = Math.max(0, Math.min(1, random()));
  return NETWORK_TRANSIENT_BACKOFF_MIN_MS + Math.floor(r * span);
}

/** 把 withLease 抛出的租约异常映射为可重试的 lease_unavailable reason（带 code / 摘要供审计）。 */
function leaseFailureReason(err: unknown): string {
  if (err instanceof EdgeTaskLeaseError) return `lease_unavailable:${err.code}`;
  return `lease_unavailable:${err instanceof Error ? err.message.slice(0, 60) : String(err)}`;
}

// 纯网络/渲染瞬态：短退避 + **不计入尝试上限**（markTransientRetry），绝不因基础设施慢把可加入群永久 failed。
function isNetworkTransient(reason: string): boolean {
  return (
    reason === 'timeout' ||
    reason === 'no_observation' ||
    reason === 'no_post_observation' ||
    reason.startsWith('nav_error') ||
    reason.startsWith('lease_unavailable') ||
    reason.startsWith('not_ready') ||
    reason.startsWith('post_not_confirmed_slow')
  );
}


export class FacebookGroupJoinScheduler {
  private readonly running = new Set<string>();

  constructor(private readonly deps: FacebookGroupJoinSchedulerDeps) {}

  isRunning(accountId: string): boolean {
    return this.running.has(accountId);
  }

  /**
   * @param opts.manual 手动操作员命令（飞书 `/comment --join`）：**跳过节奏 / 风控配额闸**——
   *   canJoin（风控状态 restricted/frozen + 日/时/分速率配额）与 canUseSessionJoin（本场会话加群额度）均不拦。
   *   人工授权即全权（用户定案 2026-07-10：手动命令不受配额限制、硬风控状态也强行执行），与已无配额闸的手动
   *   XHS `/comment` 对齐。仍守物理 / 正确性闸：非 FB 账号 / 边端离线 / 单飞 running / 无目标 no_targets /
   *   kill switch disabled / 影子 shadow。自动巡回（triggerJoin）不传 opts → manual=false → 配额闸照旧。
   *   成功后仍照常 recordSessionJoin（账本诚实、绝不因绕闸而漏计，供自动巡回后续 pacing 取真实数）。
   */
  async triggerScheduled(accountId: string, opts?: { manual?: boolean }): Promise<FacebookGroupJoinTriggerResult> {
    const manual = opts?.manual === true;
    if (!accountId || accountId === 'default') return { triggered: false, reason: 'account_required' };
    if (this.running.has(accountId)) return { triggered: false, reason: 'running' };
    this.running.add(accountId);
    try {
      if (this.deps.isFacebookAccount && !(await this.deps.isFacebookAccount(accountId))) {
        return { triggered: false, reason: 'not_facebook_account' };
      }
      const shadow = this.deps.shadow?.() ?? false;
      const autoEnabled = this.deps.autoEnabled?.() ?? false;
      if (!shadow && !autoEnabled) return { triggered: false, reason: 'disabled' };

      const conn = this.deps.resolveConnection(accountId);
      if (!conn || !conn.edgeId) {
        await this.audit({ accountId, outcome: 'join_failed', phase: 'scheduler', reason: 'edge_offline', shadow });
        return { triggered: false, reason: 'edge_offline' };
      }

      if (shadow) return this.runShadow(accountId, conn.bus, conn.edgeId);

      // 手动命令跳过配额闸（含风控状态 + 速率 + 会话额度）；自动巡回照旧受闸。
      if (!manual) {
        if (this.deps.canJoin && !(await this.deps.canJoin(accountId))) {
          await this.audit({ accountId, outcome: 'quota_denied', phase: 'scheduler', reason: 'canDo', shadow: false });
          return { triggered: false, reason: 'quota_denied' };
        }
        if (this.deps.canUseSessionJoin && !(await this.deps.canUseSessionJoin(accountId, conn.edgeId))) {
          await this.audit({ accountId, outcome: 'quota_denied', phase: 'scheduler', reason: 'session_budget', shadow: false });
          return { triggered: false, reason: 'session_budget' };
        }
      }
      return this.runReal(accountId, conn.bus, conn.edgeId);
    } finally {
      this.running.delete(accountId);
    }
  }

  /**
   * 加入**指定 url** 的群，只归该账号（change facebook-comment-review-and-targeted-join，`/comment --join=<url>`）。
   * 守 triggerScheduled 同序物理闸：account_required / url 合法 / 单飞 running / 非 FB / kill switch(disabled) / edge_offline；
   * **绕**配额闸（canJoin 风控速率状态 + 会话额度，人工授权，与 --join manual 契约一致，成功仍照记 recordSessionJoin，账本不漏）。
   * 已是成员（账本 status='joined'）→ already_member 快路，不走边端回合。
   * url 非法 → invalid_group_url；群已归属别的账号 → owned_by_other_account（诚实，绝不冒充成员评论）。
   */
  async joinSpecificGroup(
    accountId: string,
    groupUrlInput: string,
    _opts?: { manual?: boolean },
  ): Promise<FacebookGroupJoinTriggerResult> {
    if (!accountId || accountId === 'default') return { triggered: false, reason: 'account_required' };
    const groupUrl = canonicalFacebookGroupUrl(groupUrlInput);
    if (!groupUrl) return { triggered: false, reason: 'invalid_group_url' };
    if (this.running.has(accountId)) return { triggered: false, reason: 'running' };
    this.running.add(accountId);
    try {
      if (this.deps.isFacebookAccount && !(await this.deps.isFacebookAccount(accountId))) {
        return { triggered: false, reason: 'not_facebook_account' };
      }
      const shadow = this.deps.shadow?.() ?? false;
      const autoEnabled = this.deps.autoEnabled?.() ?? false;
      if (!shadow && !autoEnabled) return { triggered: false, reason: 'disabled' };

      const conn = this.deps.resolveConnection(accountId);
      if (!conn || !conn.edgeId) {
        await this.audit({ accountId, groupUrl, outcome: 'join_failed', phase: 'scheduler', reason: 'edge_offline', shadow });
        return { triggered: false, reason: 'edge_offline' };
      }
      const bus = conn.bus;
      const edgeId = conn.edgeId;

      if (shadow) {
        const observed = await this.deps.edgeTaskLeases.withLease(
          { edgeId, kind: 'group_join', priority: 'automatic', leaseMs: 3 * 60_000 },
          (lease) => this.steps(bus, edgeId, lease.taskId).observeGroup(groupUrl),
        );
        if (!observed.observation) {
          await this.audit({ accountId, groupUrl, outcome: outcomeForReason(observed.reason), phase: 'shadow', shadow: true, reason: observed.reason ?? 'no_observation' });
          return { triggered: true, groupUrl, outcome: observed.reason ?? 'no_observation' };
        }
        const verdict = await this.judge(accountId).evaluatePreClick(observed.observation);
        return { triggered: true, groupUrl, outcome: verdict.verdict };
      }

      // 手动指定群：绕配额闸（canJoin + 会话额度），只守物理闸。先 ensureTarget（enabled=false 兜 FK、绝不外泄），再认领本账号成员行。
      await this.deps.targets.ensureTarget(groupUrl);
      const claim = await this.deps.memberships.claimSpecific(accountId, groupUrl);
      if (!claim) {
        await this.audit({ accountId, groupUrl, outcome: 'join_failed', phase: 'scheduler', reason: 'invalid_group_url', shadow: false });
        return { triggered: false, reason: 'invalid_group_url' };
      }
      if (claim.ownedByOther) {
        await this.audit({ accountId, groupUrl, outcome: 'join_failed', phase: 'scheduler', reason: 'owned_by_other_account', shadow: false });
        return { triggered: false, reason: 'owned_by_other_account' };
      }
      if (claim.row.status === 'joined') {
        await this.audit({ accountId, groupUrl, outcome: 'already_member', phase: 'pre_click', reason: 'already_joined_ledger', shadow: false });
        return { triggered: true, groupUrl, outcome: 'already_member' };
      }
      return this.runAssignedJoin(accountId, bus, edgeId, claim.row);
    } finally {
      this.running.delete(accountId);
    }
  }

  private async runShadow(accountId: string, bus: EventBus, edgeId: string): Promise<FacebookGroupJoinTriggerResult> {
    const target = await this.deps.targets.nextJoinCandidate();
    if (!target) {
      await this.audit({ accountId, outcome: 'no_targets', phase: 'shadow', shadow: true, reason: 'no_candidate' });
      return { triggered: false, reason: 'no_targets' };
    }
    const observed = await this.deps.edgeTaskLeases.withLease(
      { edgeId, kind: 'group_join', priority: 'automatic', leaseMs: 3 * 60_000 },
      (lease) => this.steps(bus, edgeId, lease.taskId).observeGroup(target.groupUrl),
    );
    const observation = observed.observation;
    if (!observation) {
      await this.audit({
        accountId,
        groupUrl: target.groupUrl,
        outcome: outcomeForReason(observed.reason),
        phase: 'shadow',
        shadow: true,
        reason: observed.reason ?? 'no_observation',
      });
      return { triggered: true, groupUrl: target.groupUrl, outcome: observed.reason ?? 'no_observation' };
    }
    const verdict = await this.judge(accountId).evaluatePreClick(observation);
    return { triggered: true, groupUrl: target.groupUrl, outcome: verdict.verdict };
  }

  private async runReal(accountId: string, bus: EventBus, edgeId: string): Promise<FacebookGroupJoinTriggerResult> {
    const assigned = (await this.deps.memberships.currentAssignment(accountId)) ?? (await this.deps.memberships.claimNext(accountId));
    if (!assigned) {
      await this.audit({ accountId, outcome: 'no_targets', phase: 'scheduler', shadow: false, reason: 'no_candidate' });
      return { triggered: false, reason: 'no_targets' };
    }
    return this.runAssignedJoin(accountId, bus, edgeId, assigned);
  }

  /**
   * 对**已确定的成员行**跑「观察 → 预判 → 点击 → 后判」加群流水线（change facebook-comment-review-and-targeted-join：
   * 从 runReal 原样抽出，行为不变）。自动巡回（runReal，库内 claimNext）与手动指定群（joinSpecificGroup）共用此段。
   */
  private async runAssignedJoin(
    accountId: string,
    bus: EventBus,
    edgeId: string,
    assigned: FacebookGroupMembershipRow,
  ): Promise<FacebookGroupJoinTriggerResult> {
    await this.audit({ accountId, groupUrl: assigned.groupUrl, outcome: 'claimed', phase: 'scheduler', shadow: false });
    await this.deps.memberships.markJoining(accountId, assigned.groupUrl);

    // P0-3：租约获取/掉线异常兜底。withLease 可抛 EdgeTaskLeaseError（edge_offline / acquire_timeout / edge_disconnected）；
    // 不接住会绕过 markEdgeFailure，把成员账本留在 'joining'（cooldown 为空）→ 每 60s 心跳又把该行捞起重试、attempts++、
    // 几次即撞上限被永久标 'failed'（真机热循环）。接住归为可重试瞬态 lease_unavailable：给短冷却 + 审计，绝不假成功。
    let observed: FacebookGroupJoinStepResult;
    try {
      observed = await this.deps.edgeTaskLeases.withLease(
        { edgeId, kind: 'group_join', priority: 'automatic', leaseMs: 3 * 60_000 },
        (lease) => this.steps(bus, edgeId, lease.taskId).observeGroup(assigned.groupUrl),
      );
    } catch (err) {
      const reason = leaseFailureReason(err);
      await this.markEdgeFailure(accountId, assigned, reason);
      return { triggered: true, groupUrl: assigned.groupUrl, outcome: reason };
    }
    if (!observed.observation) {
      await this.markEdgeFailure(accountId, assigned, observed.reason ?? 'no_observation');
      return { triggered: true, groupUrl: assigned.groupUrl, outcome: observed.reason ?? 'no_observation' };
    }
    // P1-5：把 LLM 判定挡在「最小就绪」之后——观察是网络/渲染瞬态（not_ready / nav_error / 慢）时，直接走短退避重试，
    // 绝不把「慢渲染的半成品页」喂给判定角色 → fail-closed ambiguous_skip → markOutcome('failed') 永久失败（本 change 治的主导路径）。
    if (observed.reason && isNetworkTransient(observed.reason)) {
      await this.markEdgeFailure(accountId, assigned, observed.reason);
      return { triggered: true, groupUrl: assigned.groupUrl, outcome: observed.reason };
    }
    const pre = await this.judge(accountId).evaluatePreClick(observed.observation);
    const preHandled = await this.handlePreVerdict(accountId, assigned, pre, observed.observation);
    if (preHandled) return preHandled;

    // 预判 LLM 已在租约外完成；真实点击重新申请任务租约，绝不长占浏览器。P0-3：同样兜住租约异常（此刻边端可能刚被别的任务抢占）。
    let clicked: FacebookGroupJoinStepResult;
    try {
      clicked = await this.deps.edgeTaskLeases.withLease(
        { edgeId, kind: 'group_join', priority: 'automatic', leaseMs: 3 * 60_000 },
        (lease) => this.steps(bus, edgeId, lease.taskId).clickJoin(assigned.groupUrl),
      );
    } catch (err) {
      const reason = leaseFailureReason(err);
      await this.markEdgeFailure(accountId, assigned, reason);
      return { triggered: true, groupUrl: assigned.groupUrl, outcome: reason };
    }
    const postObservation = clicked.postObservation ?? clicked.observation;
    if (!postObservation) {
      await this.markEdgeFailure(accountId, assigned, clicked.reason ?? 'no_post_observation');
      return { triggered: true, groupUrl: assigned.groupUrl, outcome: clicked.reason ?? 'no_post_observation' };
    }
    // P1-5：点击后仍是网络/渲染瞬态（post_not_confirmed_slow / nav_error）→ 短退避重试，不喂判定角色落终局失败。
    // 已成功的加入 clicked.reason 为空、走 handlePostVerdict；真失败（页面已就绪却无成员态）reason=join_failed 非瞬态、照常判定。
    if (clicked.reason && isNetworkTransient(clicked.reason)) {
      await this.markEdgeFailure(accountId, assigned, clicked.reason);
      return { triggered: true, groupUrl: assigned.groupUrl, outcome: clicked.reason };
    }
    const post = await this.judge(accountId).evaluatePostClick(postObservation);
    return this.handlePostVerdict(accountId, assigned, post, postObservation, clicked.ok, edgeId);
  }

  private async handlePreVerdict(
    accountId: string,
    assigned: FacebookGroupMembershipRow,
    verdict: FacebookGroupJoinJudgeResult,
    observation: FacebookGroupJoinObservation,
  ): Promise<FacebookGroupJoinTriggerResult | null> {
    if (verdict.phase !== 'pre_click') return null;
    if (verdict.verdict === 'instant_join') return null;
    if (verdict.verdict === 'already_member') {
      await this.deps.memberships.markJoined(accountId, assigned.groupUrl, verdict.reason);
      await this.audit({
        accountId,
        groupUrl: assigned.groupUrl,
        outcome: 'already_member',
        phase: 'pre_click',
        verdict: verdict.verdict,
        reason: verdict.reason,
        shadow: false,
        observation,
      });
      return { triggered: true, groupUrl: assigned.groupUrl, outcome: 'already_member' };
    }
    if (verdict.verdict === 'gated_skip') {
      await this.deps.memberships.markOutcome(accountId, assigned.groupUrl, 'gated', verdict.reason);
      await this.deps.targets.markJoinGating(assigned.groupUrl, 'gated');
      await this.audit({
        accountId,
        groupUrl: assigned.groupUrl,
        outcome: 'gated_skip',
        phase: 'pre_click',
        verdict: verdict.verdict,
        reason: verdict.reason,
        shadow: false,
        observation,
      });
      return { triggered: true, groupUrl: assigned.groupUrl, outcome: 'gated_skip' };
    }
    await this.deps.memberships.markOutcome(accountId, assigned.groupUrl, 'failed', verdict.reason);
    await this.audit({
      accountId,
      groupUrl: assigned.groupUrl,
      outcome: 'ambiguous_skip',
      phase: 'pre_click',
      verdict: verdict.verdict,
      reason: verdict.reason,
      shadow: false,
      observation,
    });
    return { triggered: true, groupUrl: assigned.groupUrl, outcome: 'ambiguous_skip' };
  }

  private async handlePostVerdict(
    accountId: string,
    assigned: FacebookGroupMembershipRow,
    verdict: FacebookGroupJoinJudgeResult,
    observation: FacebookGroupJoinObservation,
    edgeOk: boolean,
    edgeId: string,
  ): Promise<FacebookGroupJoinTriggerResult> {
    if (verdict.phase !== 'post_click') {
      await this.deps.memberships.markOutcome(accountId, assigned.groupUrl, 'failed', 'invalid_post_verdict');
      return { triggered: true, groupUrl: assigned.groupUrl, outcome: 'invalid_post_verdict' };
    }
    if (verdict.verdict === 'joined' && edgeOk) {
      await this.deps.memberships.markJoined(accountId, assigned.groupUrl, verdict.reason);
      await this.deps.targets.markJoinGating(assigned.groupUrl, 'instant');
      const consumed = await this.deps.recordSessionJoin?.(accountId, edgeId);
      if (consumed === false) {
        this.deps.logger?.warn?.(`[fb-group-join-scheduler] joined but session join budget was already exhausted account=${accountId}`);
      }
      await this.audit({
        accountId,
        groupUrl: assigned.groupUrl,
        outcome: 'joined',
        phase: 'post_click',
        verdict: verdict.verdict,
        reason: verdict.reason,
        shadow: false,
        observation,
      });
      return { triggered: true, groupUrl: assigned.groupUrl, outcome: 'joined' };
    }
    if (verdict.verdict === 'pending_gated') {
      await this.deps.memberships.markOutcome(accountId, assigned.groupUrl, 'pending', verdict.reason);
      await this.deps.targets.markJoinGating(assigned.groupUrl, 'gated');
      await this.audit({
        accountId,
        groupUrl: assigned.groupUrl,
        outcome: 'pending',
        phase: 'post_click',
        verdict: verdict.verdict,
        reason: verdict.reason,
        shadow: false,
        observation,
      });
      return { triggered: true, groupUrl: assigned.groupUrl, outcome: 'pending' };
    }
    await this.deps.memberships.markOutcome(accountId, assigned.groupUrl, 'failed', verdict.reason);
    await this.audit({
      accountId,
      groupUrl: assigned.groupUrl,
      outcome: 'join_failed',
      phase: 'post_click',
      verdict: verdict.verdict,
      reason: edgeOk ? `judge_failed:${verdict.reason}` : verdict.reason,
      shadow: false,
      observation,
    });
    return { triggered: true, groupUrl: assigned.groupUrl, outcome: 'join_failed' };
  }

  private async markEdgeFailure(accountId: string, assigned: FacebookGroupMembershipRow, reason: string): Promise<void> {
    // 账号级瞬态（登录/验证码）：暂停账号 + 常规长退避（默认 6h）+ 计入尝试上限。
    if (isAccountTransient(reason)) {
      await this.deps.pauseAccount?.(accountId, `facebook_group_join:${reason}`);
      const retryStatus = await this.deps.memberships.markRetryableFailure(accountId, assigned.groupUrl, reason, {
        maxAttempts: this.deps.maxAttempts ?? 3,
        backoffMs: this.deps.retryBackoffMs ?? 6 * 60 * 60 * 1000,
      });
      await this.audit({
        accountId,
        groupUrl: assigned.groupUrl,
        outcome: outcomeForReason(reason),
        phase: 'scheduler',
        reason: retryStatus === 'failed' ? `${reason}:attempt_cap` : `${reason}:retryable`,
        shadow: false,
      });
      return;
    }
    // 纯网络/渲染瞬态：分钟级抖动短退避 + **不计入尝试上限**（绝不因基础设施慢把可加入群永久 failed，本 change 治的主因）。
    if (isNetworkTransient(reason)) {
      await this.deps.memberships.markTransientRetry(accountId, assigned.groupUrl, reason, {
        backoffMs: networkTransientBackoffMs(this.deps.random ?? Math.random),
      });
      await this.audit({
        accountId,
        groupUrl: assigned.groupUrl,
        outcome: outcomeForReason(reason),
        phase: 'scheduler',
        reason: `${reason}:transient_retry`,
        shadow: false,
      });
      return;
    }
    const status = statusForEdgeReason(reason);
    await this.deps.memberships.markOutcome(
      accountId,
      assigned.groupUrl,
      status === 'left' || status === 'assigned' || status === 'joining' || status === 'joined' ? 'failed' : status,
      reason,
    );
    if (status === 'pending' || status === 'gated' || status === 'no_button') await this.deps.targets.markJoinGating(assigned.groupUrl, 'gated');
    await this.audit({
      accountId,
      groupUrl: assigned.groupUrl,
      outcome: outcomeForReason(reason),
      phase: 'scheduler',
      reason,
      shadow: false,
    });
  }

  private steps(bus: EventBus, edgeId: string, taskId: string) {
    return buildFacebookGroupJoinEdgeSteps({
      bus,
      edgeId,
      taskId,
      pusher: this.deps.pusher,
      ...(typeof this.deps.stepTimeoutMs === 'number' ? { stepTimeoutMs: this.deps.stepTimeoutMs } : {}),
      logger: this.deps.logger ?? console,
    });
  }

  private judge(accountId: string): FacebookGroupJoinJudge {
    return new FacebookGroupJoinJudge({
      llm: this.deps.llmFor?.(accountId),
      accountId,
      audit: (row) => {
        void this.audit(row);
      },
    });
  }

  private async audit(row: FacebookGroupJoinAuditRow): Promise<void> {
    try {
      await this.deps.audit.append(row);
    } catch (err) {
      this.deps.logger?.warn?.(`[fb-group-join-scheduler] audit append failed: ${(err as Error).message}`);
    }
  }
}
