export const FACEBOOK_CONSUMPTION_ACTION_TYPES = ['like', 'join', 'comment'] as const;
export type FacebookConsumptionActionType =
  (typeof FACEBOOK_CONSUMPTION_ACTION_TYPES)[number];

export const FACEBOOK_CONSUMPTION_ACTION_STATES = [
  'waiting_target',
  'waiting_gate',
  'ready',
  'dispatched',
  'terminal',
] as const;
export type FacebookConsumptionActionState =
  (typeof FACEBOOK_CONSUMPTION_ACTION_STATES)[number];

export const FACEBOOK_CONSUMPTION_DISPATCH_PHASES = [
  'not_started',
  'dispatched',
  'settled',
] as const;
export type FacebookConsumptionDispatchPhase =
  (typeof FACEBOOK_CONSUMPTION_DISPATCH_PHASES)[number];

/**
 * These values describe platform truth, not transport completion. In particular,
 * `pending`, `ambiguous`, and `submitted_unknown` are never success aliases.
 */
export const FACEBOOK_CONSUMPTION_OUTCOMES = [
  'confirmed_new_like',
  'confirmed_new_join',
  'confirmed_comment',
  'already_liked',
  'already_reacted',
  'already_member',
  'pending',
  'ambiguous',
  'submitted_unknown',
  'gated',
  'not_started',
  'structural',
  'rejected',
  'failed',
  'no_target',
  'policy_superseded',
] as const;
export type FacebookConsumptionOutcome =
  (typeof FACEBOOK_CONSUMPTION_OUTCOMES)[number];

export type FacebookConsumptionEffectiveMode =
  | 'persona'
  | 'slow_start'
  | 'rule'
  | 'consumption'
  | 'blocked'
  | 'unsupported';

export interface FacebookConsumptionPolicySnapshot {
  viewsPerLike: number;
  confirmedLikesPerJoin: number;
  confirmedJoinsPerComment: number;
}

export interface FacebookConsumptionRuntimePolicy {
  policyRevision: number;
  snapshot: FacebookConsumptionPolicySnapshot;
}

export interface FacebookConsumptionTargetEvidence {
  selectedAt?: string;
  joinedAt?: string;
  lastConfirmedCommentAt?: string | null;
  groupCommentPolicyRevision?: number;
  joinToFirstCommentHours?: number;
  recommentCooldownHours?: number;
  [key: string]: unknown;
}

export interface FacebookConsumptionActionTarget {
  groupKey: string | null;
  groupUrl: string | null;
  contentKey: string | null;
  /** Exact Edge dispatch target retained independently from the canonical dedupe key. */
  contentUrl: string | null;
  selection: 'first_commentable_group_post' | null;
  evidence: FacebookConsumptionTargetEvidence | null;
}

export interface FacebookConsumptionActionView {
  actionId: string;
  accountId: string;
  executionTarget: 'dev' | 'ol';
  policyRevision: number;
  policySnapshot: FacebookConsumptionPolicySnapshot;
  sequence: number;
  actionType: FacebookConsumptionActionType;
  idempotencyKey: string;
  triggerSourceDedupeKey: string;
  state: FacebookConsumptionActionState;
  dispatchPhase: FacebookConsumptionDispatchPhase;
  outcome: FacebookConsumptionOutcome | null;
  blocker: string | null;
  downstreamEnabled: boolean;
  target: FacebookConsumptionActionTarget;
  ownerId: string | null;
  ownerExpiresAt: string | null;
  version: number;
  dispatchedAt: string | null;
  settledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FacebookConsumptionRuntimeView {
  accountId: string;
  executionTarget: 'dev' | 'ol';
  policyRevision: number;
  policySnapshot: FacebookConsumptionPolicySnapshot;
  revisionState: 'active' | 'superseded';
  collectingSequence: number;
  viewsSinceLike: number;
  confirmedNewLikesSinceJoin: number;
  confirmedNewJoinsSinceComment: number;
  nextActionSequence: number;
  activeAction: FacebookConsumptionActionView | null;
  updatedAt: string;
}

export type ApplyFacebookConsumptionViewResult =
  | { kind: 'counted'; viewCount: number }
  | { kind: 'duplicate'; viewCount: number }
  | { kind: 'action_active'; action: FacebookConsumptionActionView }
  | { kind: 'action_created'; action: FacebookConsumptionActionView }
  | { kind: 'policy_superseded' }
  | { kind: 'policy_snapshot_mismatch' };

export type ClaimFacebookConsumptionActionResult =
  | { kind: 'claimed'; action: FacebookConsumptionActionView }
  | { kind: 'already_owned'; action: FacebookConsumptionActionView }
  | { kind: 'owned_elsewhere'; action: FacebookConsumptionActionView }
  | { kind: 'not_found' };

export type MutateFacebookConsumptionActionResult =
  | { kind: 'updated'; action: FacebookConsumptionActionView }
  | { kind: 'unchanged'; action: FacebookConsumptionActionView }
  | { kind: 'version_conflict'; action: FacebookConsumptionActionView }
  | { kind: 'owner_conflict'; action: FacebookConsumptionActionView }
  | { kind: 'target_conflict'; action: FacebookConsumptionActionView }
  | { kind: 'invalid_state'; action: FacebookConsumptionActionView }
  | { kind: 'not_found' };

export type SettleFacebookConsumptionActionResult =
  | {
      kind: 'settled';
      action: FacebookConsumptionActionView;
      nextAction: FacebookConsumptionActionView | null;
    }
  | { kind: 'pending'; action: FacebookConsumptionActionView }
  | { kind: 'duplicate'; action: FacebookConsumptionActionView }
  | { kind: 'already_terminal'; action: FacebookConsumptionActionView }
  | { kind: 'target_mismatch'; action: FacebookConsumptionActionView }
  | { kind: 'incompatible_outcome'; action: FacebookConsumptionActionView }
  | { kind: 'not_found' };

export interface FacebookConsumptionConfirmedViewInput {
  accountId: string;
  effectiveMode: FacebookConsumptionEffectiveMode;
  modeBlocker?: string | null;
  policy: FacebookConsumptionRuntimePolicy;
  contentKey: string;
  contentUrl: string;
  sourceDedupeKey: string;
  occurredAt: number;
}

export type RecordFacebookConsumptionViewResult =
  | ApplyFacebookConsumptionViewResult
  | { kind: 'not_admitted'; blocker: string }
  | { kind: 'invalid_policy'; blocker: string }
  | { kind: 'invalid_fact'; blocker: string };

export interface FacebookConsumptionActionReceiptInput {
  actionId: string;
  accountId: string;
  policyRevision: number;
  sourceDedupeKey: string;
  outcome: FacebookConsumptionOutcome;
  occurredAt: number;
  expectedContentKey?: string | null;
  expectedContentUrl?: string | null;
  expectedGroupKey?: string | null;
  expectedGroupUrl?: string | null;
  evidence?: Record<string, unknown> | null;
}

export interface FacebookConsumptionRuntimeStorePort {
  applyConfirmedView(input: Omit<
    FacebookConsumptionConfirmedViewInput,
    'effectiveMode' | 'modeBlocker'
  >): Promise<ApplyFacebookConsumptionViewResult>;
  settleAction(
    input: FacebookConsumptionActionReceiptInput,
  ): Promise<SettleFacebookConsumptionActionResult>;
}
