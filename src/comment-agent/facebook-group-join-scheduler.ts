import { randomUUID } from 'node:crypto';

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
  type FacebookGroupJoinTriggerSource,
  type FacebookGroupMembershipRow,
  type FacebookGroupMembershipStatus,
  FacebookGroupJoinAuditStore,
  FacebookGroupMembershipStore,
  FacebookGroupTargetStore,
  canonicalFacebookGroupUrl,
} from './facebook-group-store.js';
import { buildFacebookGroupJoinEdgeSteps, type FacebookGroupJoinStepResult } from './facebook-group-join-edge-steps.js';
import { EdgeTaskLeaseError, type EdgeTaskLeaseClient } from '../comm/edge-task-lease-client.js';
import type { EdgeTaskPriority } from '../comm/protocol.js';

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
  retryBackoffMs?: number;
  maxAttempts?: number;
  stepTimeoutMs?: number;
  logger?: Pick<Console, 'warn' | 'log'>;
}

export interface FacebookGroupJoinTriggerResult {
  triggered: boolean;
  reason?: string;
  groupUrl?: string;
  outcome?: string;
}

export interface FacebookGroupJoinModeAssignment {
  accountId: string;
  groupUrl: string;
  source: 'consumption';
}

export interface FacebookGroupJoinModeTriggerOptions {
  source: 'consumption';
  /** Reports every mode-owned page lease release; the coordinator uses the last value at root settlement. */
  onPageLeaseSettled?: (acknowledged: boolean, edgeId: string) => void;
  /**
   * Called after the scheduler has selected and scope-revalidated the exact
   * membership row, but before it advances that row to joining.
   */
  onAssigned: (
    assignment: FacebookGroupJoinModeAssignment,
  ) => boolean | void | Promise<boolean | void>;
  /**
   * Called after markJoining succeeds and immediately before the first Edge
   * navigation. The caller uses this boundary to durably mark its action
   * dispatched. Returning false or throwing suppresses every platform action.
   */
  onBeforeDispatch: (
    assignment: FacebookGroupJoinModeAssignment,
  ) => boolean | void | Promise<boolean | void>;
}

export interface FacebookGroupJoinModeReconcileOptions {
  source: 'consumption';
  onPageLeaseSettled?: (acknowledged: boolean, edgeId: string) => void;
}

export type FacebookGroupJoinModeReconcileResult =
  | {
      reconciled: true;
      groupUrl: string;
      outcome: 'confirmed_member';
      reason: string;
      observation: FacebookGroupJoinObservation;
    }
  | {
      reconciled: false;
      groupUrl?: string;
      outcome: 'still_pending' | 'unknown';
      reason: string;
      observation?: FacebookGroupJoinObservation;
    };

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
  if (reason?.startsWith('nav_error')) return 'nav_error';
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
    default:
      return 'join_failed';
  }
}

function isAccountTransient(reason: string): boolean {
  return reason === 'login_required' || reason === 'blocked_by_captcha';
}

/** 把 withLease 抛出的租约异常映射为具体 lease_unavailable reason（带 code / 摘要供审计）。 */
function leaseFailureReason(err: unknown): string {
  if (err instanceof EdgeTaskLeaseError) return `lease_unavailable:${err.code}`;
  return `lease_unavailable:${err instanceof Error ? err.message.slice(0, 60) : String(err)}`;
}

// 尚未加入阶段的执行失败：有界 no-click 页面恢复耗尽后，本目标立即失败且不写数据库冷却。
function isJoinExecutionFailure(reason: string): boolean {
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

function isNoClickReadinessFailure(result: FacebookGroupJoinStepResult): boolean {
  if (result.clicked === true || !result.reason) return false;
  return result.reason.startsWith('not_ready') || result.reason.startsWith('nav_error');
}

export class FacebookGroupJoinScheduler {
  private readonly running = new Set<string>();
  private readonly triggerSources = new Map<string, FacebookGroupJoinTriggerSource>();

  constructor(private readonly deps: FacebookGroupJoinSchedulerDeps) {}

  isRunning(accountId: string): boolean {
    return this.running.has(accountId);
  }

  /**
   * @param opts.manual 手动操作员命令（飞书 `/comment --join`）：**跳过节奏 / 风控配额闸**——
   *   canJoin（风控状态 restricted/frozen + 日/时/分速率配额）与 canUseSessionJoin（本场会话加群额度）均不拦。
   *   人工授权即全权（用户定案 2026-07-10：手动命令不受配额限制、硬风控状态也强行执行），与已无配额闸的手动
   *   XHS `/comment` 对齐。仍守物理 / 正确性闸：非 FB 账号 / 边端离线 / 单飞 running / 无目标 no_targets。
   *   自动巡回（triggerJoin）不传 opts → manual=false → 配额闸照旧。
   *   成功后仍照常 recordSessionJoin（账本诚实、绝不因绕闸而漏计，供自动巡回后续 pacing 取真实数）。
   */
  async triggerScheduled(accountId: string, opts?: { manual?: boolean }): Promise<FacebookGroupJoinTriggerResult> {
    const manual = opts?.manual === true;
    // 7.11：人工触发的加群把档位一路传下去——严格三档下运营手动敲的加群若停在 automatic，会被另一条 human 任务抢占。
    const gear: EdgeTaskPriority = manual ? 'human' : 'automatic';
    if (!accountId || accountId === 'default') return { triggered: false, reason: 'account_required' };
    if (this.running.has(accountId)) return { triggered: false, reason: 'running' };
    this.running.add(accountId);
    try {
      if (this.deps.isFacebookAccount && !(await this.deps.isFacebookAccount(accountId))) {
        return { triggered: false, reason: 'not_facebook_account' };
      }
      this.triggerSources.set(accountId, manual ? 'manual_pool' : 'scheduled');

      const conn = this.deps.resolveConnection(accountId);
      if (!conn || !conn.edgeId) {
        await this.audit({ accountId, outcome: 'join_failed', phase: 'scheduler', reason: 'edge_offline', shadow: false });
        return { triggered: false, reason: 'edge_offline' };
      }

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
      return await this.runReal(accountId, conn.bus, conn.edgeId, gear);
    } finally {
      this.triggerSources.delete(accountId);
      this.running.delete(accountId);
    }
  }

  /**
   * Mode-owned automatic join entry. It intentionally has no ContentScheduler
   * persona hour-cell semantics, while retaining the scheduler's account
   * single-flight, platform/connection checks, risk and session admission,
   * scoped target claim, judge, receipt, and membership accounting.
   *
   * The two callbacks form the consumption runner's durable hand-off:
   * onAssigned binds the exact target; onBeforeDispatch marks the action
   * dispatched. Neither callback may be skipped, and either can veto before
   * the first Edge navigation/click.
   */
  async triggerForMode(
    accountId: string,
    options: FacebookGroupJoinModeTriggerOptions,
  ): Promise<FacebookGroupJoinTriggerResult> {
    if (!accountId || accountId === 'default') {
      return { triggered: false, reason: 'account_required' };
    }
    if (options.source !== 'consumption') {
      return { triggered: false, reason: 'unsupported_mode_source' };
    }
    if (this.running.has(accountId)) return { triggered: false, reason: 'running' };
    this.running.add(accountId);
    this.triggerSources.set(accountId, 'consumption');
    try {
      if (this.deps.isFacebookAccount && !(await this.deps.isFacebookAccount(accountId))) {
        return { triggered: false, reason: 'not_facebook_account' };
      }
      const conn = this.deps.resolveConnection(accountId);
      if (!conn || !conn.edgeId) {
        await this.audit({
          accountId,
          outcome: 'join_failed',
          phase: 'scheduler',
          reason: 'edge_offline',
          shadow: false,
        });
        return { triggered: false, reason: 'edge_offline' };
      }
      if (this.deps.canJoin && !(await this.deps.canJoin(accountId))) {
        await this.audit({
          accountId,
          outcome: 'quota_denied',
          phase: 'scheduler',
          reason: 'canDo',
          shadow: false,
        });
        return { triggered: false, reason: 'quota_denied' };
      }
      if (
        this.deps.canUseSessionJoin
        && !(await this.deps.canUseSessionJoin(accountId, conn.edgeId))
      ) {
        await this.audit({
          accountId,
          outcome: 'quota_denied',
          phase: 'scheduler',
          reason: 'session_budget',
          shadow: false,
        });
        return { triggered: false, reason: 'session_budget' };
      }
      return await this.runReal(
        accountId,
        conn.bus,
        conn.edgeId,
        'automatic',
        options,
      );
    } finally {
      this.triggerSources.delete(accountId);
      this.running.delete(accountId);
    }
  }

  /**
   * Read-only reconciliation for a mode action that was durably dispatched but
   * whose join receipt remained pending across a restart.
   *
   * The exact canonical group is observed once with `group.join(click:false)`.
   * Only an explicit pre-click `already_member` verdict may repair the joined
   * membership projection. Every other verdict remains pending/unknown and
   * this method never calls clickJoin, quota admission, or session accounting.
   */
  async reconcileForMode(
    accountId: string,
    groupUrlInput: string,
    options: FacebookGroupJoinModeReconcileOptions,
  ): Promise<FacebookGroupJoinModeReconcileResult> {
    if (!accountId || accountId === 'default') {
      return {
        reconciled: false,
        outcome: 'unknown',
        reason: 'account_required',
      };
    }
    if (options.source !== 'consumption') {
      return {
        reconciled: false,
        outcome: 'unknown',
        reason: 'unsupported_mode_source',
      };
    }
    const groupUrl = canonicalFacebookGroupUrl(groupUrlInput);
    if (!groupUrl) {
      return {
        reconciled: false,
        outcome: 'unknown',
        reason: 'invalid_group_url',
      };
    }
    if (this.running.has(accountId)) {
      return {
        reconciled: false,
        groupUrl,
        outcome: 'still_pending',
        reason: 'running',
      };
    }
    this.running.add(accountId);
    this.triggerSources.set(accountId, 'consumption');
    try {
      if (
        this.deps.isFacebookAccount
        && !(await this.deps.isFacebookAccount(accountId))
      ) {
        return {
          reconciled: false,
          groupUrl,
          outcome: 'unknown',
          reason: 'not_facebook_account',
        };
      }
      const conn = this.deps.resolveConnection(accountId);
      if (!conn?.edgeId) {
        await this.audit({
          accountId,
          groupUrl,
          outcome: 'join_failed',
          phase: 'scheduler',
          reason: 'reconciliation_edge_offline',
          shadow: false,
        });
        return {
          reconciled: false,
          groupUrl,
          outcome: 'unknown',
          reason: 'edge_offline',
        };
      }

      let observed: FacebookGroupJoinStepResult;
      try {
        observed = await this.deps.edgeTaskLeases.withLease(
          {
            edgeId: conn.edgeId,
            kind: 'group_join',
            priority: 'automatic',
            leaseMs: 270_000,
          },
          (lease) => this.steps(
            conn.bus,
            conn.edgeId!,
            lease.taskId,
          ).observeGroup(groupUrl),
          {
            onReleaseSettled: ({ acknowledged, lease }) =>
              options.onPageLeaseSettled?.(acknowledged, lease.edgeId),
          },
        );
      } catch (error) {
        const reason = leaseFailureReason(error);
        await this.audit({
          accountId,
          groupUrl,
          outcome: 'join_failed',
          phase: 'scheduler',
          reason: `reconciliation_${reason}`,
          shadow: false,
        });
        return {
          reconciled: false,
          groupUrl,
          outcome: 'unknown',
          reason,
        };
      }

      const observation = observed.observation;
      if (!observation) {
        return {
          reconciled: false,
          groupUrl,
          outcome: 'unknown',
          reason: observed.reason ?? 'no_observation',
        };
      }
      if (observed.clicked === true) {
        await this.audit({
          accountId,
          groupUrl,
          outcome: 'join_failed',
          phase: 'scheduler',
          reason: 'reconciliation_observation_reported_click',
          shadow: false,
          observation,
        });
        return {
          reconciled: false,
          groupUrl,
          outcome: 'unknown',
          reason: 'observation_reported_click',
          observation,
        };
      }
      const observedGroupUrl = canonicalFacebookGroupUrl(
        observation.groupUrl ?? observation.pageUrl ?? observed.groupUrl ?? '',
      );
      if (observedGroupUrl !== groupUrl) {
        await this.audit({
          accountId,
          groupUrl,
          outcome: 'join_failed',
          phase: 'scheduler',
          reason: 'reconciliation_target_mismatch',
          shadow: false,
          observation,
        });
        return {
          reconciled: false,
          groupUrl,
          outcome: 'unknown',
          reason: 'target_mismatch',
          observation,
        };
      }

      const verdict = await this.judge(accountId).evaluatePreClick(observation);
      if (verdict.phase === 'pre_click' && verdict.verdict === 'already_member') {
        await this.deps.memberships.markJoined(
          accountId,
          groupUrl,
          `reconciled:${verdict.reason}`,
        );
        await this.audit({
          accountId,
          groupUrl,
          outcome: 'already_member',
          phase: 'pre_click',
          verdict: verdict.verdict,
          reason: `reconciled:${verdict.reason}`,
          shadow: false,
          observation,
        });
        return {
          reconciled: true,
          groupUrl,
          outcome: 'confirmed_member',
          reason: verdict.reason,
          observation,
        };
      }

      const stillPending = verdict.phase === 'pre_click'
        && (
          verdict.verdict === 'instant_join'
          || verdict.verdict === 'gated_skip'
        );
      await this.audit({
        accountId,
        groupUrl,
        outcome: stillPending ? 'pending' : 'ambiguous_skip',
        phase: 'pre_click',
        verdict: verdict.verdict,
        reason: `reconciliation_${verdict.reason}`,
        shadow: false,
        observation,
      });
      return {
        reconciled: false,
        groupUrl,
        outcome: stillPending ? 'still_pending' : 'unknown',
        reason: verdict.reason,
        observation,
      };
    } finally {
      this.triggerSources.delete(accountId);
      this.running.delete(accountId);
    }
  }

  /**
   * 加入**指定 url** 的群，只归该账号（change facebook-comment-review-and-targeted-join，`/comment --join=<url>`）。
   * 守 triggerScheduled 同序物理闸：account_required / url 合法 / 单飞 running / 非 FB / edge_offline；
   * **绕**配额闸（canJoin 风控速率状态 + 会话额度，人工授权，与 --join manual 契约一致，成功仍照记 recordSessionJoin，账本不漏）。
   * 已是成员（账本 status='joined'）→ already_member 快路，不走边端回合。
   * url 非法 → invalid_group_url；群已归属别的账号 → owned_by_other_account（诚实，绝不冒充成员评论）。
   */
  async joinSpecificGroup(
    accountId: string,
    groupUrlInput: string,
    opts?: { manual?: boolean },
  ): Promise<FacebookGroupJoinTriggerResult> {
    // 7.11：手动指定群（/comment --join=<url>）把 human 档一路传到租约——否则运营手动加群仍停 automatic，会被别的 human 任务抢占。
    const gear: EdgeTaskPriority = opts?.manual === true ? 'human' : 'automatic';
    if (!accountId || accountId === 'default') return { triggered: false, reason: 'account_required' };
    const groupUrl = canonicalFacebookGroupUrl(groupUrlInput);
    if (!groupUrl) return { triggered: false, reason: 'invalid_group_url' };
    if (this.running.has(accountId)) return { triggered: false, reason: 'running' };
    this.running.add(accountId);
    try {
      if (this.deps.isFacebookAccount && !(await this.deps.isFacebookAccount(accountId))) {
        return { triggered: false, reason: 'not_facebook_account' };
      }
      this.triggerSources.set(accountId, 'manual_specific');

      const conn = this.deps.resolveConnection(accountId);
      if (!conn || !conn.edgeId) {
        await this.audit({ accountId, groupUrl, outcome: 'join_failed', phase: 'scheduler', reason: 'edge_offline', shadow: false });
        return { triggered: false, reason: 'edge_offline' };
      }
      const bus = conn.bus;
      const edgeId = conn.edgeId;

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
      return await this.runAssignedJoin(accountId, bus, edgeId, claim.row, gear, false);
    } finally {
      this.triggerSources.delete(accountId);
      this.running.delete(accountId);
    }
  }

  private async runReal(
    accountId: string,
    bus: EventBus,
    edgeId: string,
    gear: EdgeTaskPriority,
    modeHooks?: FacebookGroupJoinModeTriggerOptions,
  ): Promise<FacebookGroupJoinTriggerResult> {
    const assigned = (await this.deps.memberships.currentAssignment(accountId)) ?? (await this.deps.memberships.claimNext(accountId));
    if (!assigned) {
      await this.audit({ accountId, outcome: 'no_targets', phase: 'scheduler', shadow: false, reason: 'no_candidate' });
      return { triggered: false, reason: 'no_targets' };
    }
    return this.runAssignedJoin(accountId, bus, edgeId, assigned, gear, true, modeHooks);
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
    gear: EdgeTaskPriority,
    revalidateScope: boolean,
    modeHooks?: FacebookGroupJoinModeTriggerOptions,
  ): Promise<FacebookGroupJoinTriggerResult> {
    await this.audit({ accountId, groupUrl: assigned.groupUrl, outcome: 'claimed', phase: 'scheduler', shadow: false });
    if (revalidateScope) {
      const eligibility = await this.deps.memberships.revalidateScopedAssignment(accountId, assigned.groupUrl);
      if (eligibility !== 'eligible') {
        // 'projection_stale' = 账号守卫投影陈旧，这次**说不准**这个 assignment 还该不该执行。
        // 报成一条具名的拒绝，MUST NOT 混进 'assignment_not_executable'（那是「这行确实不可执行」的
        // 结论，是另一件事），更 MUST NOT 当成可以继续。
        const reason = eligibility === 'scope_mismatch'
          ? 'scope_mismatch'
          : eligibility === 'projection_stale'
            ? 'account_projection_stale'
            : 'assignment_not_executable';
        await this.audit({
          accountId,
          groupUrl: assigned.groupUrl,
          outcome: eligibility === 'scope_mismatch' ? 'scope_mismatch' : 'join_failed',
          phase: 'scheduler',
          reason,
          shadow: false,
        });
        return { triggered: false, groupUrl: assigned.groupUrl, reason };
      }
    }
    const modeAssignment = modeHooks
      ? {
          accountId,
          groupUrl: assigned.groupUrl,
          source: modeHooks.source,
        } satisfies FacebookGroupJoinModeAssignment
      : null;
    if (
      modeHooks
      && !(await this.acceptModeCallback(
        modeHooks.onAssigned,
        modeAssignment!,
        'assigned',
      ))
    ) {
      return {
        triggered: false,
        groupUrl: assigned.groupUrl,
        reason: 'dispatch_suppressed:assigned_callback_rejected',
      };
    }
    const modeAttemptReason = modeHooks
      ? `mode:${modeHooks.source}:${randomUUID()}`
      : undefined;
    const marked = await this.deps.memberships.markJoining(
      accountId,
      assigned.groupUrl,
      modeAttemptReason ?? 'attempting',
    );
    if (!marked) {
      await this.audit({
        accountId,
        groupUrl: assigned.groupUrl,
        outcome: 'join_failed',
        phase: 'scheduler',
        reason: 'assignment_not_executable',
        shadow: false,
      });
      return { triggered: false, groupUrl: assigned.groupUrl, reason: 'assignment_not_executable' };
    }
    if (
      modeHooks
      && !(await this.acceptModeCallback(
        modeHooks.onBeforeDispatch,
        modeAssignment!,
        'before_dispatch',
      ))
    ) {
      const released = await this.deps.memberships.releaseModeJoining(
        accountId,
        assigned.groupUrl,
        modeAttemptReason!,
        'dispatch_suppressed:before_dispatch_callback_rejected',
      );
      await this.audit({
        accountId,
        groupUrl: assigned.groupUrl,
        outcome: 'join_failed',
        phase: 'scheduler',
        reason: released
          ? 'dispatch_suppressed:before_dispatch_callback_rejected'
          : 'dispatch_suppressed:before_dispatch_callback_rejected:membership_release_conflict',
        shadow: false,
      });
      return {
        triggered: false,
        groupUrl: assigned.groupUrl,
        reason: released
          ? 'dispatch_suppressed:before_dispatch_callback_rejected'
          : 'dispatch_suppressed:before_dispatch_callback_rejected:membership_release_conflict',
      };
    }

    // 租约异常必须在本次目标上诚实收敛，否则成员账本会留在 joining。慢页面恢复只覆盖明确未点击的
    // not_ready/nav_error：第二次仍走 observe（无条件导航）取得一份干净页面，不恢复旧的数据库冷却占位。
    let observed: FacebookGroupJoinStepResult;
    try {
      const observeOnce = (): Promise<FacebookGroupJoinStepResult> => this.deps.edgeTaskLeases.withLease(
        { edgeId, kind: 'group_join', priority: gear, leaseMs: 270_000 },
        (lease) => this.steps(bus, edgeId, lease.taskId).observeGroup(assigned.groupUrl),
        {
          onReleaseSettled: ({ acknowledged, lease }) =>
            modeHooks?.onPageLeaseSettled?.(acknowledged, lease.edgeId),
        },
      );
      observed = await observeOnce();
      if (isNoClickReadinessFailure(observed)) {
        await this.audit({
          accountId,
          groupUrl: assigned.groupUrl,
          outcome: 'claimed',
          phase: 'scheduler',
          reason: `bounded_reobserve:${observed.reason}`,
          shadow: false,
          ...(observed.observation ? { observation: observed.observation } : {}),
        });
        observed = await observeOnce();
      }
    } catch (err) {
      const reason = leaseFailureReason(err);
      await this.markEdgeFailure(accountId, assigned, reason);
      return { triggered: true, groupUrl: assigned.groupUrl, outcome: reason };
    }
    if (!observed.observation) {
      await this.markEdgeFailure(accountId, assigned, observed.reason ?? 'no_observation');
      return { triggered: true, groupUrl: assigned.groupUrl, outcome: observed.reason ?? 'no_observation' };
    }
    // 把 LLM 判定挡在「最小就绪」之后——观察未就绪/导航失败时直接诚实结束本目标，
    // 绝不把「慢渲染的半成品页」喂给判定角色，也不写隐藏冷却。
    if (observed.reason && isJoinExecutionFailure(observed.reason)) {
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
        { edgeId, kind: 'group_join', priority: gear, leaseMs: 270_000 },
        (lease) => this.steps(bus, edgeId, lease.taskId).clickJoin(assigned.groupUrl),
        {
          onReleaseSettled: ({ acknowledged, lease }) =>
            modeHooks?.onPageLeaseSettled?.(acknowledged, lease.edgeId),
        },
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
    // 点击后仍是页面/网络失败（post_not_confirmed_slow / nav_error）→ 本目标直接失败，不喂判定角色。
    // 已成功的加入 clicked.reason 为空、走 handlePostVerdict；真失败（页面已就绪却无成员态）reason=join_failed 非瞬态、照常判定。
    if (clicked.reason && isJoinExecutionFailure(clicked.reason)) {
      await this.markEdgeFailure(accountId, assigned, clicked.reason);
      return { triggered: true, groupUrl: assigned.groupUrl, outcome: clicked.reason };
    }
    // L3：把同一次 click 的点前观测 clicked.observation 一并喂给裁判，供「跃迁」判据（composer 点前无、点后有）。
    // postObservation 若回落为 clicked.observation（无 post），则 pre===post、跃迁不成立、结构不误 joined。
    const post = await this.judge(accountId).evaluatePostClick(postObservation, clicked.observation);
    return this.handlePostVerdict(accountId, assigned, post, postObservation, clicked.ok, edgeId);
  }

  private async acceptModeCallback(
    callback: (
      assignment: FacebookGroupJoinModeAssignment,
    ) => boolean | void | Promise<boolean | void>,
    assignment: FacebookGroupJoinModeAssignment,
    phase: 'assigned' | 'before_dispatch',
  ): Promise<boolean> {
    try {
      return (await callback(assignment)) !== false;
    } catch (error) {
      this.deps.logger?.warn?.(
        `[fb-group-join-scheduler] mode callback rejected phase=${phase} account=${assignment.accountId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
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
    // 页面、网络、渲染或租约失败就是本目标的真实终态失败：不写冷却，不保留 assigned/joining 占位。
    // 下一次触发可从同一账号分组池选择其它目标；显式 --join=<url> 仍可按人工意图重试本目标。
    if (isJoinExecutionFailure(reason)) {
      await this.deps.memberships.markOutcome(accountId, assigned.groupUrl, 'failed', reason);
      await this.audit({
        accountId,
        groupUrl: assigned.groupUrl,
        outcome: outcomeForReason(reason),
        phase: 'scheduler',
        reason,
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
    const triggerSource = this.triggerSources.get(accountId);
    return new FacebookGroupJoinJudge({
      llm: this.deps.llmFor?.(accountId),
      accountId,
      audit: (row) => {
        void this.audit({ ...row, triggerSource: row.triggerSource ?? triggerSource });
      },
    });
  }

  private async audit(row: FacebookGroupJoinAuditRow): Promise<void> {
    try {
      await this.deps.audit.append({
        ...row,
        triggerSource: row.triggerSource ?? this.triggerSources.get(row.accountId),
      });
    } catch (err) {
      this.deps.logger?.warn?.(`[fb-group-join-scheduler] audit append failed: ${(err as Error).message}`);
    }
  }
}
