import type {
  FacebookConsumptionActionReceiptInput,
  FacebookConsumptionActionState,
  FacebookConsumptionActionTarget,
  FacebookConsumptionActionType,
  FacebookConsumptionDispatchPhase,
  FacebookConsumptionConfirmedViewInput,
  FacebookConsumptionOutcome,
  FacebookConsumptionPolicySnapshot,
  FacebookConsumptionRuntimeStorePort,
  RecordFacebookConsumptionViewResult,
  SettleFacebookConsumptionActionResult,
} from './facebook-consumption-mode-types.js';

export interface FacebookConsumptionCounters {
  confirmedNewLikesSinceJoin: number;
  confirmedNewJoinsSinceComment: number;
}

export interface FacebookConsumptionCounterTransition {
  counters: FacebookConsumptionCounters;
  nextActionType: 'join' | 'comment' | null;
}

export type FacebookConsumptionPolicyValidation =
  | { ok: true }
  | { ok: false; blocker: string };

function boundedInteger(
  value: number,
  min: number,
  max: number,
  field: string,
): FacebookConsumptionPolicyValidation {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return { ok: false, blocker: `invalid_${field}` };
  }
  return { ok: true };
}

export function validateFacebookConsumptionPolicy(
  policyRevision: number,
  snapshot: FacebookConsumptionPolicySnapshot,
): FacebookConsumptionPolicyValidation {
  const revision = boundedInteger(policyRevision, 1, Number.MAX_SAFE_INTEGER, 'policy_revision');
  if (!revision.ok) return revision;
  for (const [value, min, max, field] of [
    [snapshot.viewsPerLike, 1, 100, 'views_per_like'],
    [snapshot.confirmedLikesPerJoin, 1, 20, 'confirmed_likes_per_join'],
    [snapshot.confirmedJoinsPerComment, 1, 20, 'confirmed_joins_per_comment'],
  ] as const) {
    const result = boundedInteger(value, min, max, field);
    if (!result.ok) return result;
  }
  return { ok: true };
}

export function sameFacebookConsumptionPolicySnapshot(
  left: FacebookConsumptionPolicySnapshot,
  right: FacebookConsumptionPolicySnapshot,
): boolean {
  return left.viewsPerLike === right.viewsPerLike
    && left.confirmedLikesPerJoin === right.confirmedLikesPerJoin
    && left.confirmedJoinsPerComment === right.confirmedJoinsPerComment;
}

/**
 * Pure counter reducer used inside the store transaction. Non-confirmed and
 * already-state receipts intentionally fall through with no credit.
 */
export function advanceFacebookConsumptionCounters(input: {
  actionType: FacebookConsumptionActionType;
  outcome: FacebookConsumptionOutcome;
  snapshot: FacebookConsumptionPolicySnapshot;
  counters: FacebookConsumptionCounters;
  downstreamEnabled: boolean;
}): FacebookConsumptionCounterTransition {
  const counters = { ...input.counters };
  if (!input.downstreamEnabled) return { counters, nextActionType: null };

  if (input.actionType === 'like' && input.outcome === 'confirmed_new_like') {
    const next = counters.confirmedNewLikesSinceJoin + 1;
    if (next >= input.snapshot.confirmedLikesPerJoin) {
      counters.confirmedNewLikesSinceJoin = next - input.snapshot.confirmedLikesPerJoin;
      return { counters, nextActionType: 'join' };
    }
    counters.confirmedNewLikesSinceJoin = next;
  }

  if (input.actionType === 'join' && input.outcome === 'confirmed_new_join') {
    const next = counters.confirmedNewJoinsSinceComment + 1;
    if (next >= input.snapshot.confirmedJoinsPerComment) {
      counters.confirmedNewJoinsSinceComment =
        next - input.snapshot.confirmedJoinsPerComment;
      return { counters, nextActionType: 'comment' };
    }
    counters.confirmedNewJoinsSinceComment = next;
  }

  return { counters, nextActionType: null };
}

/**
 * 「让位型义务」判据 —— 推进槽位的唯一定义处（SQL 侧那份谓词是它的机械转写）。
 *
 * 消费链本来是单槽的：`facebook_consumption_progress.active_action_id` 一旦非空，
 * 新的浏览连事实都不记。评论义务停在等待态时，它后面的点赞与加群随之永久停摆
 * （2026-08-05 生产实测 12 个账号，最早一个卡了一天多、零点赞）。
 *
 * 所以槽位重新定义为「当前唯一**可下发 / 在途**的动作」。三条同时成立才让位：
 *  1. 非 like —— 点赞段正是被保护的那一段，不参与让位；
 *  2. 处在等待态（等目标 / 等闸）；
 *  3. **一次都没派发过** —— 这条是红线「提交点是最外层前置」的落点：
 *     已 `dispatched` 的写一律照旧占槽，绝不允许在有在途写时再起新动作。
 *
 * 让位 ≠ 作废：义务行保持非终态，仍会被在途扫描（判据是 `state <> 'terminal'`、
 * 不是槽位指针）扫到并继续推进。
 */
export function isDeferrableFacebookConsumptionObligation(action: {
  actionType: FacebookConsumptionActionType;
  state: FacebookConsumptionActionState;
  dispatchPhase: FacebookConsumptionDispatchPhase;
}): boolean {
  return (
    action.actionType !== 'like'
    && (action.state === 'waiting_target' || action.state === 'waiting_gate')
    && action.dispatchPhase === 'not_started'
  );
}

export function facebookConsumptionTargetIsDispatchable(
  actionType: FacebookConsumptionActionType,
  target: FacebookConsumptionActionTarget,
): boolean {
  if (actionType === 'like') return Boolean(target.contentKey && target.contentUrl);
  if (actionType === 'join') return Boolean(target.groupUrl);
  return Boolean(
    target.groupUrl
      && target.contentKey
      && target.contentUrl
      && target.selection === 'first_commentable_group_post',
  );
}

function normalizedReason(reason: string | undefined): string {
  return reason?.trim().toLowerCase() ?? '';
}

function classifyNonSuccessReason(reason: string): FacebookConsumptionOutcome {
  if (reason === 'pending' || reason === 'receipt_pending') return 'pending';
  if (reason === 'verification_ambiguous' || reason === 'ambiguous_skip') return 'ambiguous';
  if (reason === 'submitted_unconfirmed' || reason === 'submitted_unknown') {
    return 'submitted_unknown';
  }
  if (
    reason.includes('risk')
    || reason.includes('quota')
    || reason.includes('cooldown')
    || reason.includes('gated')
    || reason.includes('blocked')
    || reason.includes('captcha')
    || reason.includes('login')
    || reason.includes('approval_rejected')
  ) {
    return 'gated';
  }
  if (
    reason === 'preempted_by_task'
    || reason === 'not_started'
    || reason.includes('dispatch_suppressed')
  ) {
    return 'not_started';
  }
  if (
    reason === 'no_button'
    || reason === 'observation_only'
    || reason.startsWith('no_target')
    || reason.startsWith('btn_no-')
  ) {
    return 'structural';
  }
  if (reason.includes('rejected')) return 'rejected';
  return 'failed';
}

function explicitNonSuccessReason(
  reason: string,
): FacebookConsumptionOutcome | null {
  if (!reason) return null;
  const explicit = reason === 'pending'
    || reason === 'receipt_pending'
    || reason === 'verification_ambiguous'
    || reason === 'ambiguous_skip'
    || reason === 'verify_indeterminate'
    || reason === 'state_unchanged'
    || reason === 'submitted_unconfirmed'
    || reason === 'submitted_unknown'
    || reason === 'preempted_by_task'
    || reason === 'not_started'
    || reason === 'no_button'
    || reason === 'observation_only'
    || reason.startsWith('no_target')
    || reason.startsWith('btn_no-')
    || reason.includes('risk')
    || reason.includes('quota')
    || reason.includes('cooldown')
    || reason.includes('gated')
    || reason.includes('blocked')
    || reason.includes('captcha')
    || reason.includes('login')
    || reason.includes('approval_rejected')
    || reason.includes('rejected')
    || reason === 'failed'
    || reason.endsWith('_failed')
    || reason.includes('failure')
    || reason.includes('exception')
    || reason.includes('timeout')
    || reason.includes('error');
  return explicit ? classifyNonSuccessReason(reason) : null;
}

export function classifyFacebookConsumptionLikeReceipt(input: {
  ok: boolean;
  reason?: string;
}): FacebookConsumptionOutcome {
  const reason = normalizedReason(input.reason);
  if (reason === 'already_liked') return 'already_liked';
  if (reason === 'already_reacted') return 'already_reacted';
  if (reason === 'verify_indeterminate' || reason === 'state_unchanged') {
    // state_unchanged is not proof that no click happened: Edge can observe it
    // both after an unverified click and from a pre-click anomaly. Conservatively
    // retain unknown-write semantics so Cloud never authorizes a blind retry.
    return 'ambiguous';
  }
  const explicitNonSuccess = explicitNonSuccessReason(reason);
  if (explicitNonSuccess) return explicitNonSuccess;
  if (
    input.ok
    && (
      !reason
      || ['confirmed', 'liked', 'like_confirmed', 'reaction_confirmed', 'success']
        .includes(reason)
    )
  ) {
    return 'confirmed_new_like';
  }
  return classifyNonSuccessReason(reason);
}

export function classifyFacebookConsumptionJoinReceipt(input: {
  triggered: boolean;
  outcome?: string;
  reason?: string;
}): FacebookConsumptionOutcome {
  const outcome = normalizedReason(input.outcome);
  const reason = normalizedReason(input.reason);
  const explicitReason = explicitNonSuccessReason(reason);
  if (explicitReason) return explicitReason;
  if (outcome === 'joined' && input.triggered) return 'confirmed_new_join';
  if (outcome === 'already_member') return 'already_member';
  if (outcome === 'pending' || reason === 'pending') return 'pending';
  if (outcome === 'ambiguous_skip' || outcome === 'ambiguous') return 'ambiguous';
  if (
    !input.triggered
    && (
      reason === 'no_targets'
      || reason === 'no_target'
      || outcome === 'no_targets'
      || outcome === 'no_target'
    )
  ) {
    return 'no_target';
  }
  return classifyNonSuccessReason(outcome || reason);
}

export function classifyFacebookConsumptionCommentReceipt(input: {
  ok: boolean;
  reason?: string;
}): FacebookConsumptionOutcome {
  const reason = normalizedReason(input.reason);
  const explicitNonSuccess = explicitNonSuccessReason(reason);
  if (explicitNonSuccess) return explicitNonSuccess;
  if (
    input.ok
    && (
      !reason
      || ['confirmed', 'commented', 'comment_confirmed', 'success'].includes(reason)
    )
  ) {
    return 'confirmed_comment';
  }
  return classifyNonSuccessReason(reason);
}

/**
 * Thin admission facade. Mode resolution stays in the operation-policy service;
 * this class refuses to infer or repair an unavailable mode.
 */
export class FacebookConsumptionMode {
  constructor(private readonly runtimeStore: FacebookConsumptionRuntimeStorePort) {}

  async recordConfirmedView(
    input: FacebookConsumptionConfirmedViewInput,
  ): Promise<RecordFacebookConsumptionViewResult> {
    if (input.effectiveMode !== 'consumption') {
      return {
        kind: 'not_admitted',
        blocker: input.modeBlocker?.trim()
          || `effective_mode_${input.effectiveMode}`,
      };
    }
    const policy = validateFacebookConsumptionPolicy(
      input.policy.policyRevision,
      input.policy.snapshot,
    );
    if (!policy.ok) return { kind: 'invalid_policy', blocker: policy.blocker };
    if (
      !input.accountId.trim()
      || !input.contentKey.trim()
      || !input.contentUrl.trim()
      || !input.sourceDedupeKey.trim()
      || !Number.isFinite(input.occurredAt)
    ) {
      return { kind: 'invalid_fact', blocker: 'invalid_confirmed_view_fact' };
    }
    return this.runtimeStore.applyConfirmedView({
      accountId: input.accountId,
      policy: input.policy,
      contentKey: input.contentKey,
      contentUrl: input.contentUrl,
      sourceDedupeKey: input.sourceDedupeKey,
      occurredAt: input.occurredAt,
    });
  }

  async recordActionReceipt(
    input: FacebookConsumptionActionReceiptInput,
  ): Promise<SettleFacebookConsumptionActionResult> {
    return this.runtimeStore.settleAction(input);
  }
}
