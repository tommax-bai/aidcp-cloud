import { randomUUID } from 'node:crypto';

import type {
  FacebookCommentModeExactTarget,
  FacebookCommentModeTriggerOptions,
  FacebookCommentModeTriggerResult,
  FacebookCommentRunResult,
} from '../comment-agent/comment-scheduler.js';
import {
  canonicalFacebookGroupUrl,
  type FacebookGroupCoverageCandidateOptions,
  type FacebookGroupMembershipRow,
} from '../comment-agent/facebook-group-store.js';
import type {
  FacebookGroupJoinModeReconcileResult,
  FacebookGroupJoinModeTriggerOptions,
  FacebookGroupJoinTriggerResult,
} from '../comment-agent/facebook-group-join-scheduler.js';
import { classifyFacebookConsumptionJoinReceipt } from './facebook-consumption-mode.js';
import type {
  BindFacebookConsumptionActionTargetInput,
  SetFacebookConsumptionPreDispatchStateInput,
} from './facebook-consumption-mode-runtime-store.js';
import type {
  ClaimFacebookConsumptionActionResult,
  FacebookConsumptionActionReceiptInput,
  FacebookConsumptionActionTarget,
  FacebookConsumptionActionView,
  FacebookConsumptionEffectiveMode,
  FacebookConsumptionOutcome,
  FacebookConsumptionTargetEvidence,
  MutateFacebookConsumptionActionResult,
  SettleFacebookConsumptionActionResult,
} from './facebook-consumption-mode-types.js';

const DEFAULT_ACTION_LEASE_MS = 15 * 60_000;
const FIRST_COMMENTABLE_GROUP_POST = 'first_commentable_group_post' as const;

/**
 * Consumer-owned projection of the API policy authority. Keeping this narrow
 * avoids coupling the automation coordinator to the API store implementation.
 */
export interface FacebookConsumptionGroupCommentPolicyView {
  joinToFirstCommentHours: number;
  revision: number | null;
  source: 'db' | 'legacy_env' | 'default';
  sameGroupRecommentCooldownHours: number | null;
}

export interface FacebookConsumptionCoordinatorRuntimePort {
  listActiveActions(limit?: number): Promise<FacebookConsumptionActionView[]>;
  claimAction(input: {
    actionId: string;
    accountId: string;
    policyRevision: number;
    ownerId: string;
    leaseMs: number;
  }): Promise<ClaimFacebookConsumptionActionResult>;
  bindActionTarget(
    input: BindFacebookConsumptionActionTargetInput,
  ): Promise<MutateFacebookConsumptionActionResult>;
  bindTargetAndMarkDispatched(
    input: BindFacebookConsumptionActionTargetInput,
  ): Promise<MutateFacebookConsumptionActionResult>;
  markActionWaitingTarget(
    input: SetFacebookConsumptionPreDispatchStateInput,
  ): Promise<MutateFacebookConsumptionActionResult>;
  markActionWaitingGate(
    input: SetFacebookConsumptionPreDispatchStateInput,
  ): Promise<MutateFacebookConsumptionActionResult>;
  releaseActionClaim(input: {
    actionId: string;
    accountId: string;
    policyRevision: number;
    ownerId: string;
    expectedVersion: number;
  }): Promise<MutateFacebookConsumptionActionResult>;
  settleAction(
    input: FacebookConsumptionActionReceiptInput,
  ): Promise<SettleFacebookConsumptionActionResult>;
  supersedeAccount(input: {
    accountId: string;
    keepPolicyRevision?: number | null;
    reason?: string;
  }): Promise<FacebookConsumptionActionView[]>;
}

export interface FacebookConsumptionJoinExecutorPort {
  triggerForMode(
    accountId: string,
    options: FacebookGroupJoinModeTriggerOptions,
  ): Promise<FacebookGroupJoinTriggerResult>;
  reconcileForMode(
    accountId: string,
    groupUrl: string,
    options: {
      source: 'consumption';
      onPageLeaseSettled?: (acknowledged: boolean, edgeId: string) => void;
    },
  ): Promise<FacebookGroupJoinModeReconcileResult>;
}

export interface FacebookConsumptionCommentExecutorPort {
  triggerForMode(
    accountId: string,
    options: FacebookCommentModeTriggerOptions,
  ): Promise<FacebookCommentModeTriggerResult>;
}

export interface FacebookConsumptionHistoricalGroupTarget {
  groupKey: string;
  groupUrl: string;
  evidence: FacebookConsumptionTargetEvidence;
}

export type FacebookConsumptionHistoricalGroupSelection =
  | {
      kind: 'selected';
      target: FacebookConsumptionHistoricalGroupTarget;
    }
  | { kind: 'no_target'; blocker: string }
  | { kind: 'waiting_gate'; blocker: string };

export interface FacebookConsumptionCoordinatorDeps {
  runtimeStore: FacebookConsumptionCoordinatorRuntimePort;
  joinExecutor: FacebookConsumptionJoinExecutorPort;
  commentExecutor: FacebookConsumptionCommentExecutorPort;
  selectHistoricalGroup: (
    accountId: string,
  ) => Promise<FacebookConsumptionHistoricalGroupSelection>;
  resolveOperationPolicy: (
    accountId: string,
  ) => Promise<{
    effectiveMode: FacebookConsumptionEffectiveMode;
    policyRevision: number | null;
    blocker?: string;
  }> | {
    effectiveMode: FacebookConsumptionEffectiveMode;
    policyRevision: number | null;
    blocker?: string;
  };
  /** RiskController-backed final comment gate, re-read after approval. */
  commentActionGate: (
    accountId: string,
  ) => { allowed: boolean; reason?: string };
  /** Current timing authority, re-read only after a verified platform comment. */
  resolveGroupCommentPolicy: () => FacebookConsumptionGroupCommentPolicyView | null;
  readGroupMembership: (
    accountId: string,
    groupUrl: string,
  ) => Promise<FacebookGroupMembershipRow | null>;
  /**
   * Must update and return the exact joined membership row. Returning null
   * means the cooldown projection was not durably recorded.
   */
  recordConfirmedComment: (
    accountId: string,
    groupUrl: string,
    options: { cooldownMs: number; reason: string },
  ) => Promise<FacebookGroupMembershipRow | null>;
  /** Sends the unified browse redrive through the live account runtime. */
  redriveBrowse?: (
    accountId: string,
    edgeId: string,
  ) => number | void | Promise<number | void>;
  ownerId?: string;
  actionLeaseMs?: number;
  clock?: () => number;
  logger?: Pick<Console, 'warn' | 'log'>;
}

export type FacebookConsumptionCoordinatorResult =
  | { kind: 'settled'; action: FacebookConsumptionActionView }
  | { kind: 'pending'; action: FacebookConsumptionActionView }
  | { kind: 'waiting_target'; action: FacebookConsumptionActionView }
  | { kind: 'waiting_gate'; action: FacebookConsumptionActionView }
  | {
      kind: 'awaiting_reconciliation';
      action: FacebookConsumptionActionView;
      blocker: string;
    }
  | { kind: 'owned_elsewhere'; action: FacebookConsumptionActionView }
  | { kind: 'coordination_conflict'; action?: FacebookConsumptionActionView; reason: string }
  | { kind: 'not_found'; reason: string }
  | { kind: 'unsupported_action'; action: FacebookConsumptionActionView };

export interface FacebookConsumptionRecoveryResult {
  scanned: number;
  driven: number;
  results: FacebookConsumptionCoordinatorResult[];
}

export interface StrictFacebookConsumptionGroupSelectorDeps {
  commentPolicy: { get(): FacebookConsumptionGroupCommentPolicyView | null };
  memberships: {
    coverageCandidates(
      accountId: string,
      options?: FacebookGroupCoverageCandidateOptions,
    ): Promise<FacebookGroupMembershipRow[]>;
    coverageProjectionState?(
      accountId: string,
    ): Promise<'ready' | 'projection_stale' | 'account_missing'>;
  };
  clock?: () => number;
}

/**
 * Creates the composition-root selector for consumption comments.
 *
 * It deliberately calls only the strict coverage query: no `relaxed` option,
 * no exclusion for groups joined in the current consumption cycle, and the
 * current timing-policy revision is pinned into target evidence.
 */
export function createStrictFacebookConsumptionGroupSelector(
  deps: StrictFacebookConsumptionGroupSelectorDeps,
): (
  accountId: string,
) => Promise<FacebookConsumptionHistoricalGroupSelection> {
  const clock = deps.clock ?? Date.now;
  return async (accountId) => {
    const policy = deps.commentPolicy.get();
    if (
      !policy
      || !Number.isFinite(policy.joinToFirstCommentHours)
      || policy.joinToFirstCommentHours < 0
      || !Number.isFinite(policy.sameGroupRecommentCooldownHours)
      || (policy.sameGroupRecommentCooldownHours ?? -1) < 0
    ) {
      return {
        kind: 'waiting_gate',
        blocker: 'facebook_group_comment_policy_unavailable',
      };
    }
    const projectionState = await deps.memberships.coverageProjectionState?.(
      accountId,
    );
    if (projectionState === 'projection_stale') {
      return {
        kind: 'waiting_gate',
        blocker: 'automation_account_projection_stale',
      };
    }
    if (projectionState === 'account_missing') {
      return {
        kind: 'waiting_gate',
        blocker: 'automation_account_projection_account_missing',
      };
    }
    const candidates = await deps.memberships.coverageCandidates(accountId, {
      limit: 1,
      warmupMs: policy.joinToFirstCommentHours * 60 * 60 * 1000,
      cooldownMs: policy.sameGroupRecommentCooldownHours! * 60 * 60 * 1000,
    });
    const candidate = candidates[0];
    if (!candidate) {
      return {
        kind: 'no_target',
        blocker: 'no_strict_eligible_historical_group',
      };
    }
    const groupUrl = canonicalFacebookGroupUrl(candidate.groupUrl);
    if (!groupUrl || candidate.status !== 'joined' || !candidate.joinedAt) {
      return {
        kind: 'waiting_gate',
        blocker: 'historical_group_projection_invalid',
      };
    }
    return {
      kind: 'selected',
      target: {
        groupKey: groupUrl,
        groupUrl,
        evidence: {
          selectedAt: new Date(clock()).toISOString(),
          joinedAt: candidate.joinedAt,
          lastConfirmedCommentAt: candidate.lastCommentedAt,
          ...(policy.revision === null
            ? {}
            : { groupCommentPolicyRevision: policy.revision }),
          joinToFirstCommentHours: policy.joinToFirstCommentHours,
          recommentCooldownHours: policy.sameGroupRecommentCooldownHours!,
          groupCommentPolicySource: policy.source,
        },
      },
    };
  };
}

function targetMatches(
  action: FacebookConsumptionActionView,
  expected: Partial<FacebookConsumptionActionTarget>,
): boolean {
  return Object.entries(expected).every(
    ([key, value]) => action.target[key as keyof FacebookConsumptionActionTarget] === value,
  );
}

function transientPreDispatchReason(reason: string | undefined): boolean {
  const normalized = reason?.trim().toLowerCase() ?? '';
  return normalized === 'running'
    || normalized === 'edge_offline'
    || normalized === 'comment_runtime_exception'
    || normalized.startsWith('edge_lease_')
    || normalized.startsWith('lease_unavailable');
}

function commentResultOutcome(
  result: FacebookCommentRunResult,
): FacebookConsumptionOutcome {
  switch (result.outcome) {
    case 'commented':
      return 'confirmed_comment';
    case 'verification_ambiguous':
      return 'ambiguous';
    case 'pending_group_approval':
      return 'pending';
    case 'comment_rejected':
      return 'rejected';
    case 'quota_denied':
    case 'cooldown_denied':
    case 'login_required':
      return 'gated';
    case 'compose_skipped':
      return result.reason?.includes('approval_rejected') ? 'gated' : 'rejected';
    case 'no_strong_candidate':
      return result.reason === 'all_deduped' ? 'rejected' : 'structural';
    case 'no_targets':
      return 'structural';
    case 'submit_failed':
    case 'not_wired':
    case 'shadow_ok':
    default:
      return 'failed';
  }
}

type OperationPolicyCheck =
  | { kind: 'active' }
  | {
      kind: 'superseded';
      blocker: string;
      keepPolicyRevision: number | null;
    }
  | { kind: 'waiting_gate'; blocker: string };

/**
 * Durable coordinator for the non-like legs of consumption mode.
 *
 * RoleDispatcher owns the exact-content like. This coordinator owns join and
 * historical-group comment, recursively driving a transactionally-created
 * nextAction while retaining one in-memory single flight per account.
 */
export class FacebookConsumptionModeCoordinator {
  private readonly ownerId: string;
  private readonly actionLeaseMs: number;
  private readonly clock: () => number;
  private readonly inFlight = new Map<
    string,
    Promise<FacebookConsumptionCoordinatorResult>
  >();
  private readonly browseResumeContexts = new Map<
    string,
    { lastPageLeaseAcknowledged: boolean | null; edgeId: string | null }
  >();

  constructor(private readonly deps: FacebookConsumptionCoordinatorDeps) {
    this.ownerId = deps.ownerId?.trim()
      || `facebook-consumption-coordinator:${randomUUID()}`;
    this.actionLeaseMs = deps.actionLeaseMs ?? DEFAULT_ACTION_LEASE_MS;
    this.clock = deps.clock ?? Date.now;
  }

  trigger(
    action: FacebookConsumptionActionView,
  ): Promise<FacebookConsumptionCoordinatorResult> {
    const active = this.inFlight.get(action.accountId);
    if (active) return active;
    const resumeContext = {
      lastPageLeaseAcknowledged: null as boolean | null,
      edgeId: null as string | null,
    };
    this.browseResumeContexts.set(action.accountId, resumeContext);
    const run = this.drive(action).then(async (result) => {
      if (
        resumeContext.lastPageLeaseAcknowledged === true
        && resumeContext.edgeId
      ) {
        try {
          await this.deps.redriveBrowse?.(action.accountId, resumeContext.edgeId);
        } catch (error) {
          this.deps.logger?.warn?.(
            `[facebook-consumption] post-task browse redrive failed account=${action.accountId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      return result;
    }).finally(() => {
      if (this.inFlight.get(action.accountId) === run) {
        this.inFlight.delete(action.accountId);
      }
      if (this.browseResumeContexts.get(action.accountId) === resumeContext) {
        this.browseResumeContexts.delete(action.accountId);
      }
    });
    this.inFlight.set(action.accountId, run);
    return run;
  }

  isRunning(accountId: string): boolean {
    return this.inFlight.has(accountId);
  }

  private notePageLeaseSettlement(
    accountId: string,
    acknowledged: boolean,
    edgeId: string,
  ): void {
    const context = this.browseResumeContexts.get(accountId);
    if (context) {
      context.lastPageLeaseAcknowledged = acknowledged;
      context.edgeId = edgeId;
    }
  }

  /**
   * Bounded restart/tick recovery. Coordinator-owned join/comment legs are
   * driven, and an expired-owner dispatched like is closed as ambiguous.
   * Dispatched work is never replayed: joins use an exact-group no-click
   * observation, while comments require a durable membership last-commented
   * proof.
   */
  async recoverActiveActions(limit = 100): Promise<FacebookConsumptionRecoveryResult> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
    const active = await this.deps.runtimeStore.listActiveActions(boundedLimit);
    const recoverable = active.filter(
      (action) =>
        action.actionType === 'join'
        || action.actionType === 'comment'
        || (
          action.actionType === 'like'
          && action.dispatchPhase === 'dispatched'
        ),
    );
    const results = await Promise.all(
      recoverable.map((action) => this.trigger(action)),
    );
    return {
      scanned: active.length,
      driven: recoverable.length,
      results,
    };
  }

  private async drive(
    action: FacebookConsumptionActionView,
  ): Promise<FacebookConsumptionCoordinatorResult> {
    if (
      action.actionType === 'like'
      && action.dispatchPhase === 'dispatched'
    ) {
      return this.reconcileOrphanedDispatchedLike(action);
    }
    if (action.dispatchPhase === 'dispatched') {
      return this.reconcileDispatched(action);
    }
    if (action.actionType === 'join') return this.runJoin(action);
    if (action.actionType === 'comment') return this.runComment(action);
    return { kind: 'unsupported_action', action };
  }

  private async reconcileOrphanedDispatchedLike(
    action: FacebookConsumptionActionView,
  ): Promise<FacebookConsumptionCoordinatorResult> {
    const ownerExpiresAt = action.ownerExpiresAt
      ? Date.parse(action.ownerExpiresAt)
      : Number.NaN;
    if (Number.isFinite(ownerExpiresAt) && ownerExpiresAt > this.clock()) {
      return this.awaitingReconciliation(
        action,
        'like_receipt_owner_lease_active',
      );
    }
    if (
      !action.dispatchedAt
      || !action.target.contentKey
      || !action.target.contentUrl
    ) {
      return this.awaitingReconciliation(
        action,
        'like_reconciliation_exact_target_or_dispatch_time_missing',
      );
    }
    // Once the dispatch owner's lease expires there is no longer a correlated
    // in-process receipt that can prove a newly produced like. Close the
    // obligation as ambiguous, consume no success counter, and never replay
    // the platform write.
    return this.settleAndContinue(action, {
      sourceDedupeKey: `${action.actionId}:edge-like`,
      outcome: 'ambiguous',
      expectedContentKey: action.target.contentKey,
      expectedContentUrl: action.target.contentUrl,
      evidence: {
        reconciliation: 'expired_dispatch_owner_without_correlated_receipt',
        ownerExpiresAt: action.ownerExpiresAt,
        dispatchedAt: action.dispatchedAt,
      },
    });
  }

  private awaitingReconciliation(
    action: FacebookConsumptionActionView,
    blocker: string,
  ): FacebookConsumptionCoordinatorResult {
    return {
      kind: 'awaiting_reconciliation',
      action,
      blocker,
    };
  }

  private async reconcileDispatched(
    inputAction: FacebookConsumptionActionView,
  ): Promise<FacebookConsumptionCoordinatorResult> {
    const ownerExpiresAt = inputAction.ownerExpiresAt
      ? Date.parse(inputAction.ownerExpiresAt)
      : Number.NaN;
    if (Number.isFinite(ownerExpiresAt) && ownerExpiresAt > this.clock()) {
      return this.awaitingReconciliation(
        inputAction,
        'action_receipt_owner_lease_active',
      );
    }
    const policy = await this.operationPolicyCheck(inputAction);
    if (policy.kind === 'waiting_gate') {
      return this.awaitingReconciliation(
        inputAction,
        `reconciliation_${policy.blocker}`,
      );
    }

    let action = inputAction;
    if (policy.kind === 'superseded') {
      try {
        const superseded = await this.deps.runtimeStore.supersedeAccount({
          accountId: action.accountId,
          keepPolicyRevision: policy.keepPolicyRevision,
          reason: policy.blocker,
        });
        const refreshed = superseded.find(
          (candidate) => candidate.actionId === action.actionId,
        );
        if (!refreshed || refreshed.downstreamEnabled) {
          return this.awaitingReconciliation(
            action,
            'reconciliation_policy_supersede_not_persisted',
          );
        }
        action = refreshed;
      } catch (error) {
        return this.awaitingReconciliation(
          action,
          `reconciliation_policy_supersede_failed:${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (action.actionType === 'join') {
      return this.reconcileDispatchedJoin(action, policy.kind);
    }
    if (action.actionType === 'comment') {
      return this.reconcileDispatchedComment(action, policy.kind);
    }
    return { kind: 'unsupported_action', action };
  }

  private async reconcileDispatchedJoin(
    action: FacebookConsumptionActionView,
    policyState: 'active' | 'superseded',
  ): Promise<FacebookConsumptionCoordinatorResult> {
    const groupUrl = action.target.groupUrl
      ? canonicalFacebookGroupUrl(action.target.groupUrl)
      : null;
    if (!groupUrl || groupUrl !== action.target.groupUrl) {
      return this.awaitingReconciliation(
        action,
        'join_reconciliation_exact_group_missing',
      );
    }

    let result: FacebookGroupJoinModeReconcileResult;
    try {
      result = await this.deps.joinExecutor.reconcileForMode(
        action.accountId,
        groupUrl,
        {
          source: 'consumption',
          onPageLeaseSettled: (acknowledged, edgeId) =>
            this.notePageLeaseSettlement(action.accountId, acknowledged, edgeId),
        },
      );
    } catch (error) {
      return this.awaitingReconciliation(
        action,
        `join_reconciliation_exception:${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!result.reconciled) {
      return this.awaitingReconciliation(
        action,
        `join_reconciliation_${result.outcome}:${result.reason}`,
      );
    }
    if (result.groupUrl !== groupUrl) {
      return this.awaitingReconciliation(
        action,
        'join_reconciliation_target_mismatch',
      );
    }
    return this.settleAndContinue(action, {
      // Same key as the original pending receipt: the runtime upgrades that
      // exact fact from pending to terminal rather than creating a second fact.
      sourceDedupeKey: `${action.idempotencyKey}:join-platform`,
      // A later read can prove only current membership. It cannot prove that
      // this dispatched attempt newly created that membership rather than
      // observing an already-member state or an unrelated external join.
      outcome: 'already_member',
      expectedGroupKey: action.target.groupKey,
      expectedGroupUrl: groupUrl,
      evidence: {
        reconciliation: 'exact_group_no_click_observation',
        reconciliationReason: result.reason,
        newlyJoinedByAction: false,
        operationPolicyState: policyState,
      },
    });
  }

  private async reconcileDispatchedComment(
    action: FacebookConsumptionActionView,
    policyState: 'active' | 'superseded',
  ): Promise<FacebookConsumptionCoordinatorResult> {
    const proof = await this.readConfirmedCommentMembershipProof(action);
    if (proof.kind === 'blocked') {
      if (
        proof.blocker.startsWith('comment_reconciliation_membership_read_failed:')
        || proof.blocker
          === 'comment_reconciliation_exact_target_or_dispatch_time_missing'
      ) {
        return this.awaitingReconciliation(action, proof.blocker);
      }
      return this.settleAndContinue(action, {
        sourceDedupeKey: `${action.idempotencyKey}:comment-platform`,
        outcome: 'ambiguous',
        expectedGroupKey: action.target.groupKey,
        expectedGroupUrl: action.target.groupUrl,
        expectedContentKey: action.target.contentKey,
        expectedContentUrl: action.target.contentUrl,
        evidence: {
          reconciliation:
            'expired_dispatch_owner_without_action_correlated_receipt',
          blocker: proof.blocker,
          operationPolicyState: policyState,
        },
      });
    }
    return this.settleAndContinue(action, {
      sourceDedupeKey: `${action.idempotencyKey}:comment-platform`,
      outcome: 'confirmed_comment',
      expectedGroupKey: action.target.groupKey,
      expectedGroupUrl: action.target.groupUrl,
      expectedContentKey: action.target.contentKey,
      expectedContentUrl: action.target.contentUrl,
      evidence: {
        reconciliation: 'membership_last_commented_at',
        membershipLastCommentedAt: proof.membership.lastCommentedAt,
        membershipCooldownUntil: proof.membership.cooldownUntil,
        operationPolicyState: policyState,
      },
    });
  }

  private async claim(
    action: FacebookConsumptionActionView,
  ): Promise<
    | { kind: 'owned'; action: FacebookConsumptionActionView }
    | FacebookConsumptionCoordinatorResult
  > {
    if (action.dispatchPhase === 'dispatched') {
      return this.awaitingReconciliation(
        action,
        'action_already_dispatched',
      );
    }
    const policy = await this.operationPolicyCheck(action);
    if (policy.kind !== 'active') {
      return this.stopForOperationPolicy(action, policy, false);
    }
    const claimed = await this.deps.runtimeStore.claimAction({
      actionId: action.actionId,
      accountId: action.accountId,
      policyRevision: action.policyRevision,
      ownerId: this.ownerId,
      leaseMs: this.actionLeaseMs,
    });
    if (claimed.kind === 'not_found') {
      return { kind: 'not_found', reason: 'action_not_claimable' };
    }
    if (claimed.kind === 'owned_elsewhere') {
      return { kind: 'owned_elsewhere', action: claimed.action };
    }
    if (claimed.action.dispatchPhase === 'dispatched') {
      return this.awaitingReconciliation(
        claimed.action,
        'action_became_dispatched_while_claiming',
      );
    }
    return { kind: 'owned', action: claimed.action };
  }

  private async runJoin(
    inputAction: FacebookConsumptionActionView,
  ): Promise<FacebookConsumptionCoordinatorResult> {
    const claim = await this.claim(inputAction);
    if (claim.kind !== 'owned') return claim;
    let action = claim.action;
    let assignedTarget: {
      groupKey: string;
      groupUrl: string;
      evidence: FacebookConsumptionTargetEvidence;
    } | null = null;
    let dispatchAuthorized = false;
    let coordinationFailure:
      | { reason: string; result?: MutateFacebookConsumptionActionResult }
      | null = null;

    const result = await this.deps.joinExecutor.triggerForMode(action.accountId, {
      source: 'consumption',
      onPageLeaseSettled: (acknowledged, edgeId) =>
        this.notePageLeaseSettlement(action.accountId, acknowledged, edgeId),
      onAssigned: async (assignment) => {
        const policy = await this.operationPolicyCheck(action);
        if (policy.kind !== 'active') {
          coordinationFailure = {
            reason: `operation_policy_${policy.kind}:${policy.blocker}`,
          };
          return false;
        }
        const groupUrl = canonicalFacebookGroupUrl(assignment.groupUrl);
        if (!groupUrl || assignment.accountId !== action.accountId) {
          coordinationFailure = { reason: 'invalid_join_assignment' };
          return false;
        }
        const evidence = action.target.evidence ?? {
          selectedAt: new Date(this.clock()).toISOString(),
          selectionSource: 'facebook_group_join_scheduler',
          schedulerSource: assignment.source,
        };
        const groupKey = action.target.groupKey ?? groupUrl;
        const bound = await this.deps.runtimeStore.bindActionTarget({
          actionId: action.actionId,
          accountId: action.accountId,
          policyRevision: action.policyRevision,
          ownerId: this.ownerId,
          expectedVersion: action.version,
          target: { groupKey, groupUrl, evidence },
        });
        if (
          (bound.kind !== 'updated' && bound.kind !== 'unchanged')
          || !targetMatches(bound.action, { groupKey, groupUrl })
        ) {
          coordinationFailure = {
            reason: `join_target_bind_${bound.kind}`,
            result: bound,
          };
          return false;
        }
        action = bound.action;
        assignedTarget = { groupKey, groupUrl, evidence };
        return true;
      },
      onBeforeDispatch: async (assignment) => {
        const policy = await this.operationPolicyCheck(action);
        if (policy.kind !== 'active') {
          coordinationFailure = {
            reason: `operation_policy_${policy.kind}:${policy.blocker}`,
          };
          return false;
        }
        if (!assignedTarget || assignment.groupUrl !== assignedTarget.groupUrl) {
          coordinationFailure = { reason: 'join_assignment_changed' };
          return false;
        }
        const dispatched = await this.deps.runtimeStore.bindTargetAndMarkDispatched({
          actionId: action.actionId,
          accountId: action.accountId,
          policyRevision: action.policyRevision,
          ownerId: this.ownerId,
          expectedVersion: action.version,
          target: assignedTarget,
        });
        if (dispatched.kind !== 'updated') {
          coordinationFailure = {
            reason: `join_dispatch_${dispatched.kind}`,
            result: dispatched,
          };
          return false;
        }
        action = dispatched.action;
        dispatchAuthorized = true;
        return true;
      },
    });

    const failureAfterJoin = coordinationFailure as {
      reason: string;
      result?: MutateFacebookConsumptionActionResult;
    } | null;
    if (failureAfterJoin) {
      const policyStop = this.operationPolicyFailure(failureAfterJoin.reason);
      if (policyStop) return this.stopForOperationPolicy(action, policyStop, true);
      return this.coordinationFailureResult(failureAfterJoin);
    }
    if (!result.triggered && result.reason === 'no_targets') {
      return this.waitAndRelease(action, 'target', 'no_join_target');
    }
    if (!result.triggered && transientPreDispatchReason(result.reason)) {
      return this.waitAndRelease(
        action,
        'gate',
        `join_${result.reason ?? 'temporarily_unavailable'}`,
      );
    }
    const outcome = classifyFacebookConsumptionJoinReceipt(result);
    if (outcome === 'no_target') {
      return this.waitAndRelease(action, 'target', 'no_join_target');
    }
    if (
      (outcome === 'confirmed_new_join'
        || outcome === 'pending'
        || outcome === 'ambiguous')
      && !dispatchAuthorized
    ) {
      return {
        kind: 'coordination_conflict',
        action,
        reason: 'join_receipt_without_dispatch_authorization',
      };
    }
    const normalizedOutcome = !result.triggered
      && (result.reason === 'quota_denied' || result.reason === 'session_budget')
      ? 'gated'
      : outcome;
    return this.settleAndContinue(action, {
      sourceDedupeKey: `${action.idempotencyKey}:join-platform`,
      outcome: normalizedOutcome,
      ...(action.target.groupKey
        ? { expectedGroupKey: action.target.groupKey }
        : {}),
      ...(action.target.groupUrl
        ? { expectedGroupUrl: action.target.groupUrl }
        : {}),
      evidence: {
        triggered: result.triggered,
        rawOutcome: result.outcome ?? null,
        rawReason: result.reason ?? null,
        dispatchAuthorized,
      },
    });
  }

  private async runComment(
    inputAction: FacebookConsumptionActionView,
  ): Promise<FacebookConsumptionCoordinatorResult> {
    const claim = await this.claim(inputAction);
    if (claim.kind !== 'owned') return claim;
    let action = claim.action;

    let selected: FacebookConsumptionHistoricalGroupTarget;
    if (action.target.groupKey && action.target.groupUrl && action.target.evidence) {
      selected = {
        groupKey: action.target.groupKey,
        groupUrl: action.target.groupUrl,
        evidence: action.target.evidence,
      };
    } else {
      const selection = await this.deps.selectHistoricalGroup(action.accountId);
      if (selection.kind === 'no_target') {
        return this.waitAndRelease(action, 'target', selection.blocker);
      }
      if (selection.kind === 'waiting_gate') {
        return this.waitAndRelease(action, 'gate', selection.blocker);
      }
      selected = selection.target;
    }

    const groupBindPolicy = await this.operationPolicyCheck(action);
    if (groupBindPolicy.kind !== 'active') {
      return this.stopForOperationPolicy(action, groupBindPolicy, true);
    }
    const groupBound = await this.deps.runtimeStore.bindActionTarget({
      actionId: action.actionId,
      accountId: action.accountId,
      policyRevision: action.policyRevision,
      ownerId: this.ownerId,
      expectedVersion: action.version,
      target: {
        groupKey: selected.groupKey,
        groupUrl: selected.groupUrl,
        selection: FIRST_COMMENTABLE_GROUP_POST,
        evidence: selected.evidence,
      },
    });
    if (
      (groupBound.kind !== 'updated' && groupBound.kind !== 'unchanged')
      || !targetMatches(groupBound.action, {
        groupKey: selected.groupKey,
        groupUrl: selected.groupUrl,
        selection: FIRST_COMMENTABLE_GROUP_POST,
      })
    ) {
      return this.coordinationFailureResult({
        reason: `comment_group_bind_${groupBound.kind}`,
        result: groupBound,
      });
    }
    action = groupBound.action;

    let exactTarget: FacebookCommentModeExactTarget | null = null;
    let dispatchAuthorized = false;
    let coordinationFailure:
      | { reason: string; result?: MutateFacebookConsumptionActionResult }
      | null = null;
    const result = await this.deps.commentExecutor.triggerForMode(action.accountId, {
      source: 'consumption',
      onPageLeaseSettled: (acknowledged, edgeId) =>
        this.notePageLeaseSettlement(action.accountId, acknowledged, edgeId),
      groupUrl: selected.groupUrl,
      selection: FIRST_COMMENTABLE_GROUP_POST,
      actionGate: () => this.deps.commentActionGate(action.accountId),
      onTargetSelected: async (target) => {
        const policy = await this.operationPolicyCheck(action);
        if (policy.kind !== 'active') {
          coordinationFailure = {
            reason: `operation_policy_${policy.kind}:${policy.blocker}`,
          };
          return false;
        }
        if (
          target.accountId !== action.accountId
          || target.groupUrl !== selected.groupUrl
          || target.selection !== FIRST_COMMENTABLE_GROUP_POST
          || !target.contentKey.trim()
          || !target.contentUrl.trim()
        ) {
          coordinationFailure = { reason: 'invalid_comment_exact_target' };
          return false;
        }
        const bound = await this.deps.runtimeStore.bindActionTarget({
          actionId: action.actionId,
          accountId: action.accountId,
          policyRevision: action.policyRevision,
          ownerId: this.ownerId,
          expectedVersion: action.version,
          target: {
            groupKey: selected.groupKey,
            groupUrl: selected.groupUrl,
            contentKey: target.contentKey,
            contentUrl: target.contentUrl,
            selection: target.selection,
            evidence: selected.evidence,
          },
        });
        if (
          (bound.kind !== 'updated' && bound.kind !== 'unchanged')
          || !targetMatches(bound.action, {
            groupKey: selected.groupKey,
            groupUrl: selected.groupUrl,
            contentKey: target.contentKey,
            contentUrl: target.contentUrl,
            selection: target.selection,
          })
        ) {
          coordinationFailure = {
            reason: `comment_target_bind_${bound.kind}`,
            result: bound,
          };
          return false;
        }
        action = bound.action;
        exactTarget = target;
        return true;
      },
      onBeforeSubmit: async (target) => {
        // Ordering is security-sensitive: effective mode/revision first, then
        // durable exact-target dispatched CAS, and only its `updated` result
        // authorizes the scheduler's platform submit.
        const policy = await this.operationPolicyCheck(action);
        if (policy.kind !== 'active') {
          coordinationFailure = {
            reason: `operation_policy_${policy.kind}:${policy.blocker}`,
          };
          return false;
        }
        if (
          !exactTarget
          || target.contentKey !== exactTarget.contentKey
          || target.contentUrl !== exactTarget.contentUrl
          || target.groupUrl !== exactTarget.groupUrl
        ) {
          coordinationFailure = { reason: 'comment_target_changed_before_submit' };
          return false;
        }
        const membershipBlocker = await this.commentMembershipFreshnessBlocker(
          action,
        );
        if (membershipBlocker) {
          coordinationFailure = { reason: membershipBlocker };
          return false;
        }
        const dispatched = await this.deps.runtimeStore.bindTargetAndMarkDispatched({
          actionId: action.actionId,
          accountId: action.accountId,
          policyRevision: action.policyRevision,
          ownerId: this.ownerId,
          expectedVersion: action.version,
          target: {
            groupKey: selected.groupKey,
            groupUrl: selected.groupUrl,
            contentKey: target.contentKey,
            contentUrl: target.contentUrl,
            selection: target.selection,
            evidence: selected.evidence,
          },
        });
        if (dispatched.kind !== 'updated') {
          coordinationFailure = {
            reason: `comment_dispatch_${dispatched.kind}`,
            result: dispatched,
          };
          return false;
        }
        action = dispatched.action;
        dispatchAuthorized = true;
        return true;
      },
    });

    // The callbacks run synchronously within the awaited executor, but TS does
    // not model closure assignments in its post-await control flow.
    const failureAfterComment = coordinationFailure as {
      reason: string;
      result?: MutateFacebookConsumptionActionResult;
    } | null;
    if (failureAfterComment) {
      const policyStop = this.operationPolicyFailure(failureAfterComment.reason);
      if (policyStop) {
        return this.stopForOperationPolicy(action, policyStop, true);
      }
      if (
        failureAfterComment.reason
          .startsWith('comment_membership_freshness_')
      ) {
        return this.waitAndRelease(
          action,
          'gate',
          failureAfterComment.reason,
        );
      }
      if (
        failureAfterComment.result?.kind === 'target_conflict'
        && action.dispatchPhase === 'not_started'
      ) {
        return this.settleAndContinue(action, {
          sourceDedupeKey: `${action.idempotencyKey}:comment-target-conflict`,
          outcome: 'structural',
          expectedGroupKey: action.target.groupKey,
          expectedGroupUrl: action.target.groupUrl,
          expectedContentKey: action.target.contentKey,
          expectedContentUrl: action.target.contentUrl,
          evidence: { blocker: failureAfterComment.reason },
        });
      }
      return this.coordinationFailureResult(failureAfterComment);
    }
    if (!result.triggered) {
      if (transientPreDispatchReason(result.reason)) {
        return this.waitAndRelease(
          action,
          'gate',
          `comment_${result.reason}`,
        );
      }
      return this.settleAndContinue(action, {
        sourceDedupeKey: `${action.idempotencyKey}:comment-not-started`,
        outcome: result.reason?.includes('approval') ? 'gated' : 'failed',
        expectedGroupKey: action.target.groupKey,
        expectedGroupUrl: action.target.groupUrl,
        expectedContentKey: action.target.contentKey,
        expectedContentUrl: action.target.contentUrl,
        evidence: { blocker: result.reason },
      });
    }

    if (
      !dispatchAuthorized
      && result.result.outcome === 'submit_failed'
      && transientPreDispatchReason(result.result.reason)
    ) {
      return this.waitAndRelease(
        action,
        'gate',
        `comment_${result.result.reason ?? 'temporarily_unavailable'}`,
      );
    }
    const outcome = commentResultOutcome(result.result);
    if (
      (outcome === 'confirmed_comment'
        || outcome === 'pending'
        || outcome === 'ambiguous'
        || outcome === 'submitted_unknown')
      && !dispatchAuthorized
    ) {
      return {
        kind: 'coordination_conflict',
        action,
        reason: 'comment_receipt_without_dispatch_authorization',
      };
    }
    let membershipEvidence: Record<string, unknown> = {};
    if (outcome === 'confirmed_comment') {
      const recorded = await this.recordConfirmedCommentMembership(action);
      if (recorded.kind === 'blocked') {
        return this.awaitingReconciliation(action, recorded.blocker);
      }
      membershipEvidence = {
        membershipLastCommentedAt: recorded.membership.lastCommentedAt,
        membershipCooldownUntil: recorded.membership.cooldownUntil,
        groupCommentPolicyRevision: recorded.policy.revision,
        recommentCooldownHours:
          recorded.policy.sameGroupRecommentCooldownHours,
      };
    }
    return this.settleAndContinue(action, {
      sourceDedupeKey: `${action.idempotencyKey}:comment-platform`,
      outcome,
      expectedGroupKey: action.target.groupKey,
      expectedGroupUrl: action.target.groupUrl,
      expectedContentKey: action.target.contentKey,
      expectedContentUrl: action.target.contentUrl,
      evidence: {
        rawOutcome: result.result.outcome,
        rawReason: result.result.reason ?? null,
        dispatchAuthorized,
        ...membershipEvidence,
      },
    });
  }

  /**
   * The historical-group selector proves eligibility only at selection time.
   * Comment composition and approval may take long enough for membership to
   * change, so re-read the exact group immediately before the durable
   * dispatched CAS. Unknown storage is retryable; an explicit non-joined
   * projection remains a named gate on this same pinned target.
   */
  private async commentMembershipFreshnessBlocker(
    action: FacebookConsumptionActionView,
  ): Promise<string | null> {
    const expectedGroupUrl = action.target.groupUrl
      ? canonicalFacebookGroupUrl(action.target.groupUrl)
      : null;
    if (!expectedGroupUrl || expectedGroupUrl !== action.target.groupUrl) {
      return 'comment_membership_freshness_exact_group_missing';
    }

    let membership: FacebookGroupMembershipRow | null;
    try {
      membership = await this.deps.readGroupMembership(
        action.accountId,
        expectedGroupUrl,
      );
    } catch (error) {
      return `comment_membership_freshness_unavailable:${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    if (!membership) {
      return 'comment_membership_freshness_missing';
    }
    if (membership.accountId !== action.accountId) {
      return 'comment_membership_freshness_account_mismatch';
    }
    const observedGroupUrl = canonicalFacebookGroupUrl(membership.groupUrl);
    if (!observedGroupUrl || observedGroupUrl !== expectedGroupUrl) {
      return 'comment_membership_freshness_group_mismatch';
    }
    if (membership.status !== 'joined') {
      return `comment_membership_freshness_status_${membership.status}`;
    }
    return null;
  }

  private membershipProvesConfirmedComment(
    action: FacebookConsumptionActionView,
    membership: FacebookGroupMembershipRow | null,
  ): boolean {
    if (
      !membership
      || membership.status !== 'joined'
      || !membership.lastCommentedAt
      || !action.dispatchedAt
      || !action.target.groupUrl
    ) {
      return false;
    }
    if (
      canonicalFacebookGroupUrl(membership.groupUrl)
      !== canonicalFacebookGroupUrl(action.target.groupUrl)
    ) {
      return false;
    }
    const commentedAt = Date.parse(membership.lastCommentedAt);
    const dispatchedAt = Date.parse(action.dispatchedAt);
    return Number.isFinite(commentedAt)
      && Number.isFinite(dispatchedAt)
      && commentedAt >= dispatchedAt
      && membership.lastReason
        === `consumption_confirmed_comment:${action.actionId}`;
  }

  private async readConfirmedCommentMembershipProof(
    action: FacebookConsumptionActionView,
  ): Promise<
    | { kind: 'proved'; membership: FacebookGroupMembershipRow }
    | { kind: 'blocked'; blocker: string }
  > {
    const groupUrl = action.target.groupUrl
      ? canonicalFacebookGroupUrl(action.target.groupUrl)
      : null;
    if (
      !groupUrl
      || groupUrl !== action.target.groupUrl
      || !action.dispatchedAt
    ) {
      return {
        kind: 'blocked',
        blocker: 'comment_reconciliation_exact_target_or_dispatch_time_missing',
      };
    }
    let membership: FacebookGroupMembershipRow | null;
    try {
      membership = await this.deps.readGroupMembership(
        action.accountId,
        groupUrl,
      );
    } catch (error) {
      return {
        kind: 'blocked',
        blocker: `comment_reconciliation_membership_read_failed:${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (
      membership
      && this.membershipProvesConfirmedComment(action, membership)
    ) {
      return { kind: 'proved', membership };
    }
    if (!membership) {
      return {
        kind: 'blocked',
        blocker: 'comment_reconciliation_membership_missing',
      };
    }
    if (membership.status !== 'joined') {
      return {
        kind: 'blocked',
        blocker: `comment_reconciliation_membership_not_joined:${membership.status}`,
      };
    }
    if (
      membership.lastCommentedAt
      && membership.lastReason
        !== `consumption_confirmed_comment:${action.actionId}`
    ) {
      return {
        kind: 'blocked',
        blocker: 'comment_reconciliation_action_receipt_missing',
      };
    }
    return {
      kind: 'blocked',
      blocker: membership.lastCommentedAt
        ? 'comment_reconciliation_last_commented_before_dispatch'
        : 'comment_reconciliation_last_commented_proof_missing',
    };
  }

  private async recordConfirmedCommentMembership(
    action: FacebookConsumptionActionView,
  ): Promise<
    | {
        kind: 'recorded';
        membership: FacebookGroupMembershipRow;
        policy: FacebookConsumptionGroupCommentPolicyView;
      }
    | { kind: 'blocked'; blocker: string }
  > {
    const existing = await this.readConfirmedCommentMembershipProof(action);
    if (existing.kind === 'proved') {
      let policy: FacebookConsumptionGroupCommentPolicyView | null;
      try {
        policy = this.deps.resolveGroupCommentPolicy();
      } catch (error) {
        return {
          kind: 'blocked',
          blocker: `group_comment_policy_unavailable:${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if (
        !policy
        || !Number.isFinite(policy.sameGroupRecommentCooldownHours)
        || (policy.sameGroupRecommentCooldownHours ?? -1) < 0
      ) {
        return {
          kind: 'blocked',
          blocker: 'group_comment_policy_unavailable',
        };
      }
      return {
        kind: 'recorded',
        membership: existing.membership,
        policy,
      };
    }

    const groupUrl = action.target.groupUrl
      ? canonicalFacebookGroupUrl(action.target.groupUrl)
      : null;
    if (!groupUrl || groupUrl !== action.target.groupUrl) {
      return {
        kind: 'blocked',
        blocker: 'comment_membership_exact_group_missing',
      };
    }
    let policy: FacebookConsumptionGroupCommentPolicyView | null;
    try {
      policy = this.deps.resolveGroupCommentPolicy();
    } catch (error) {
      return {
        kind: 'blocked',
        blocker: `group_comment_policy_unavailable:${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (
      !policy
      || !Number.isFinite(policy.sameGroupRecommentCooldownHours)
      || (policy.sameGroupRecommentCooldownHours ?? -1) < 0
    ) {
      return {
        kind: 'blocked',
        blocker: 'group_comment_policy_unavailable',
      };
    }

    let membership: FacebookGroupMembershipRow | null;
    try {
      membership = await this.deps.recordConfirmedComment(
        action.accountId,
        groupUrl,
        {
          cooldownMs:
            policy.sameGroupRecommentCooldownHours! * 60 * 60 * 1000,
          reason: `consumption_confirmed_comment:${action.actionId}`,
        },
      );
    } catch (error) {
      return {
        kind: 'blocked',
        blocker: `comment_membership_record_failed:${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (
      !membership
      || !this.membershipProvesConfirmedComment(action, membership)
    ) {
      return {
        kind: 'blocked',
        blocker: membership
          ? 'comment_membership_record_not_confirmed'
          : 'comment_membership_joined_row_missing',
      };
    }
    return { kind: 'recorded', membership, policy };
  }

  private coordinationFailureResult(input: {
    reason: string;
    result?: MutateFacebookConsumptionActionResult;
  }): FacebookConsumptionCoordinatorResult {
    const action = input.result && input.result.kind !== 'not_found'
      ? input.result.action
      : undefined;
    return {
      kind: 'coordination_conflict',
      ...(action ? { action } : {}),
      reason: input.reason,
    };
  }

  private async operationPolicyCheck(
    action: FacebookConsumptionActionView,
  ): Promise<OperationPolicyCheck> {
    let authority: Awaited<
      ReturnType<FacebookConsumptionCoordinatorDeps['resolveOperationPolicy']>
    >;
    try {
      authority = await this.deps.resolveOperationPolicy(action.accountId);
    } catch (error) {
      return {
        kind: 'waiting_gate',
        blocker: `operation_policy_unavailable:${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (
      authority.effectiveMode === 'consumption'
      && authority.policyRevision === action.policyRevision
    ) {
      return { kind: 'active' };
    }
    if (
      authority.policyRevision !== null
      && authority.policyRevision !== action.policyRevision
    ) {
      return {
        kind: 'superseded',
        blocker: authority.blocker
          ?? `effective_${authority.effectiveMode}_revision_${authority.policyRevision ?? 'unknown'}`,
        keepPolicyRevision:
          authority.effectiveMode === 'consumption'
            ? authority.policyRevision
            : null,
      };
    }
    // A temporary effective-mode overlay (notably an active slow-start
    // lifecycle) can hide consumption without changing its base policy
    // revision. That is a gate, not evidence that the durable revision was
    // replaced. Only a different authoritative revision may destroy work.
    return {
      kind: 'waiting_gate',
      blocker: authority.blocker ?? `effective_mode_${authority.effectiveMode}`,
    };
  }

  private operationPolicyFailure(
    reason: string,
  ): Exclude<OperationPolicyCheck, { kind: 'active' }> | null {
    const prefix = 'operation_policy_';
    if (!reason.startsWith(prefix)) return null;
    const separator = reason.indexOf(':');
    if (separator < 0) return null;
    const kind = reason.slice(prefix.length, separator);
    const blocker = reason.slice(separator + 1);
    if (kind === 'superseded') {
      return { kind, blocker, keepPolicyRevision: null };
    }
    if (kind === 'waiting_gate') return { kind, blocker };
    return null;
  }

  private async stopForOperationPolicy(
    action: FacebookConsumptionActionView,
    policy: Exclude<OperationPolicyCheck, { kind: 'active' }>,
    owned: boolean,
  ): Promise<FacebookConsumptionCoordinatorResult> {
    if (action.dispatchPhase === 'dispatched') {
      return this.awaitingReconciliation(
        action,
        `operation_policy_${policy.kind}:${policy.blocker}`,
      );
    }
    if (policy.kind === 'waiting_gate') {
      return owned
        ? this.waitAndRelease(action, 'gate', policy.blocker)
        : { kind: 'waiting_gate', action };
    }
    return this.settleAndContinue(action, {
      sourceDedupeKey: `${action.idempotencyKey}:policy-superseded`,
      outcome: 'policy_superseded',
      expectedGroupKey: action.target.groupKey,
      expectedGroupUrl: action.target.groupUrl,
      expectedContentKey: action.target.contentKey,
      expectedContentUrl: action.target.contentUrl,
      evidence: { blocker: policy.blocker },
    });
  }

  private async waitAndRelease(
    action: FacebookConsumptionActionView,
    state: 'target' | 'gate',
    blocker: string,
  ): Promise<FacebookConsumptionCoordinatorResult> {
    if (action.dispatchPhase === 'dispatched') {
      return this.awaitingReconciliation(action, blocker);
    }
    const marked = state === 'target'
      ? await this.deps.runtimeStore.markActionWaitingTarget({
          actionId: action.actionId,
          accountId: action.accountId,
          policyRevision: action.policyRevision,
          ownerId: this.ownerId,
          expectedVersion: action.version,
          blocker,
        })
      : await this.deps.runtimeStore.markActionWaitingGate({
          actionId: action.actionId,
          accountId: action.accountId,
          policyRevision: action.policyRevision,
          ownerId: this.ownerId,
          expectedVersion: action.version,
          blocker,
        });
    if (marked.kind !== 'updated' && marked.kind !== 'unchanged') {
      return this.coordinationFailureResult({
        reason: `mark_waiting_${state}_${marked.kind}`,
        result: marked,
      });
    }
    action = marked.action;
    const released = await this.deps.runtimeStore.releaseActionClaim({
      actionId: action.actionId,
      accountId: action.accountId,
      policyRevision: action.policyRevision,
      ownerId: this.ownerId,
      expectedVersion: action.version,
    });
    if (released.kind === 'updated' || released.kind === 'unchanged') {
      action = released.action;
    } else {
      this.deps.logger?.warn?.(
        `[facebook-consumption] failed to release waiting action=${action.actionId} kind=${released.kind}`,
      );
    }
    return {
      kind: state === 'target' ? 'waiting_target' : 'waiting_gate',
      action,
    };
  }

  private async settleAndContinue(
    action: FacebookConsumptionActionView,
    receipt: Omit<
      FacebookConsumptionActionReceiptInput,
      'actionId' | 'accountId' | 'policyRevision' | 'occurredAt'
    >,
  ): Promise<FacebookConsumptionCoordinatorResult> {
    const settled = await this.deps.runtimeStore.settleAction({
      actionId: action.actionId,
      accountId: action.accountId,
      policyRevision: action.policyRevision,
      occurredAt: this.clock(),
      ...receipt,
    });
    if (settled.kind === 'not_found') {
      return { kind: 'not_found', reason: 'action_settlement_not_found' };
    }
    if (
      settled.kind === 'target_mismatch'
      || settled.kind === 'incompatible_outcome'
    ) {
      return {
        kind: 'coordination_conflict',
        action: settled.action,
        reason: `settlement_${settled.kind}`,
      };
    }
    if (settled.kind === 'pending') {
      return { kind: 'pending', action: settled.action };
    }
    if (settled.kind === 'settled' && settled.nextAction) {
      return this.drive(settled.nextAction);
    }
    return { kind: 'settled', action: settled.action };
  }
}
