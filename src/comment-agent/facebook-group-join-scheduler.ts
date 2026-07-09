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
} from './facebook-group-store.js';
import { buildFacebookGroupJoinEdgeSteps } from './facebook-group-join-edge-steps.js';

export interface FacebookGroupJoinSchedulerDeps {
  resolveConnection: (accountId: string) => { bus: EventBus; edgeId?: string } | null;
  pusher: EdgePusher;
  targets: FacebookGroupTargetStore;
  memberships: FacebookGroupMembershipStore;
  audit: FacebookGroupJoinAuditStore;
  llmFor?: (accountId: string) => RoleLlmLike;
  canJoin?: (accountId: string) => boolean | Promise<boolean>;
  isFacebookAccount?: (accountId: string) => boolean | Promise<boolean>;
  pauseAccount?: (accountId: string, reason: string) => Promise<void> | void;
  autoEnabled?: () => boolean;
  shadow?: () => boolean;
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

function isRetryableEdgeFailure(reason: string): boolean {
  return isAccountTransient(reason) || reason === 'timeout' || reason === 'no_observation' || reason === 'no_post_observation' || reason.startsWith('nav_error');
}

export class FacebookGroupJoinScheduler {
  private readonly running = new Set<string>();

  constructor(private readonly deps: FacebookGroupJoinSchedulerDeps) {}

  isRunning(accountId: string): boolean {
    return this.running.has(accountId);
  }

  async triggerScheduled(accountId: string): Promise<FacebookGroupJoinTriggerResult> {
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

      if (this.deps.canJoin && !(await this.deps.canJoin(accountId))) {
        await this.audit({ accountId, outcome: 'quota_denied', phase: 'scheduler', reason: 'canDo', shadow: false });
        return { triggered: false, reason: 'quota_denied' };
      }
      return this.runReal(accountId, conn.bus, conn.edgeId);
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
    const steps = this.steps(bus, edgeId);
    const observed = await steps.observeGroup(target.groupUrl);
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
    await this.audit({ accountId, groupUrl: assigned.groupUrl, outcome: 'claimed', phase: 'scheduler', shadow: false });
    await this.deps.memberships.markJoining(accountId, assigned.groupUrl);

    const steps = this.steps(bus, edgeId);
    const observed = await steps.observeGroup(assigned.groupUrl);
    if (!observed.observation) {
      await this.markEdgeFailure(accountId, assigned, observed.reason ?? 'no_observation');
      return { triggered: true, groupUrl: assigned.groupUrl, outcome: observed.reason ?? 'no_observation' };
    }
    const pre = await this.judge(accountId).evaluatePreClick(observed.observation);
    const preHandled = await this.handlePreVerdict(accountId, assigned, pre, observed.observation);
    if (preHandled) return preHandled;

    const clicked = await steps.clickJoin(assigned.groupUrl);
    const postObservation = clicked.postObservation ?? clicked.observation;
    if (!postObservation) {
      await this.markEdgeFailure(accountId, assigned, clicked.reason ?? 'no_post_observation');
      return { triggered: true, groupUrl: assigned.groupUrl, outcome: clicked.reason ?? 'no_post_observation' };
    }
    const post = await this.judge(accountId).evaluatePostClick(postObservation);
    return this.handlePostVerdict(accountId, assigned, post, postObservation, clicked.ok);
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
  ): Promise<FacebookGroupJoinTriggerResult> {
    if (verdict.phase !== 'post_click') {
      await this.deps.memberships.markOutcome(accountId, assigned.groupUrl, 'failed', 'invalid_post_verdict');
      return { triggered: true, groupUrl: assigned.groupUrl, outcome: 'invalid_post_verdict' };
    }
    if (verdict.verdict === 'joined' && edgeOk) {
      await this.deps.memberships.markJoined(accountId, assigned.groupUrl, verdict.reason);
      await this.deps.targets.markJoinGating(assigned.groupUrl, 'instant');
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
    if (isRetryableEdgeFailure(reason)) {
      if (isAccountTransient(reason)) {
        await this.deps.pauseAccount?.(accountId, `facebook_group_join:${reason}`);
      }
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

  private steps(bus: EventBus, edgeId: string) {
    return buildFacebookGroupJoinEdgeSteps({
      bus,
      edgeId,
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
