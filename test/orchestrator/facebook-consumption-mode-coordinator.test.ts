import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FacebookConsumptionModeCoordinator,
  createStrictFacebookConsumptionGroupSelector,
  type FacebookConsumptionCoordinatorRuntimePort,
} from '@automation/orchestrator/facebook-consumption-mode-coordinator.js';
import {
  FACEBOOK_GROUP_COMMENT_POLICY_BOUNDS,
  type FacebookGroupCommentPolicyView,
} from '@api/config/facebook-group-comment-policy-store.js';
import type {
  FacebookConsumptionActionReceiptInput,
  FacebookConsumptionActionTarget,
  FacebookConsumptionActionType,
  FacebookConsumptionActionView,
  FacebookConsumptionOutcome,
} from '@automation/orchestrator/facebook-consumption-mode-types.js';
import type { FacebookGroupMembershipRow } from '@automation/comment-agent/facebook-group-store.js';

const NOW = Date.parse('2026-07-30T08:00:00.000Z');
const GROUP_NEW = 'https://www.facebook.com/groups/new-join';
const GROUP_OLD = 'https://www.facebook.com/groups/historical';
const POST = 'https://www.facebook.com/groups/historical/posts/42';

function makeAction(
  actionId: string,
  actionType: FacebookConsumptionActionType,
  overrides: Partial<FacebookConsumptionActionView> = {},
): FacebookConsumptionActionView {
  return {
    actionId,
    accountId: `account-${actionId}`,
    executionTarget: 'dev',
    policyRevision: 7,
    policySnapshot: {
      viewsPerLike: 5,
      confirmedLikesPerJoin: 2,
      confirmedJoinsPerComment: 2,
    },
    sequence: 1,
    actionType,
    idempotencyKey: `idem-${actionId}`,
    triggerSourceDedupeKey: `source-${actionId}`,
    state: 'waiting_target',
    dispatchPhase: 'not_started',
    outcome: null,
    blocker: null,
    downstreamEnabled: true,
    target: {
      groupKey: null,
      groupUrl: null,
      contentKey: null,
      contentUrl: null,
      selection: null,
      evidence: null,
    },
    ownerId: null,
    ownerExpiresAt: null,
    version: 1,
    dispatchedAt: null,
    settledAt: null,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function dispatchable(
  actionType: 'join' | 'comment' | 'like',
  target: FacebookConsumptionActionTarget,
): boolean {
  if (actionType === 'join') return Boolean(target.groupUrl);
  if (actionType === 'comment') {
    return Boolean(
      target.groupUrl
      && target.contentKey
      && target.contentUrl
      && target.selection === 'first_commentable_group_post',
    );
  }
  return Boolean(target.contentKey && target.contentUrl);
}

function makeRuntime(
  initial: FacebookConsumptionActionView[],
  nextByActionId: Map<string, FacebookConsumptionActionView> = new Map(),
): {
  port: FacebookConsumptionCoordinatorRuntimePort;
  actions: Map<string, FacebookConsumptionActionView>;
  receipts: FacebookConsumptionActionReceiptInput[];
  events: string[];
} {
  const actions = new Map(initial.map((action) => [action.actionId, action]));
  const receipts: FacebookConsumptionActionReceiptInput[] = [];
  const events: string[] = [];
  const read = (actionId: string) => actions.get(actionId)!;
  const write = (
    actionId: string,
    patch: Partial<FacebookConsumptionActionView>,
  ): FacebookConsumptionActionView => {
    const current = read(actionId);
    const next = {
      ...current,
      ...patch,
      version: current.version + 1,
      updatedAt: new Date(NOW).toISOString(),
    };
    actions.set(actionId, next);
    return next;
  };
  const versionConflict = (
    action: FacebookConsumptionActionView,
    expectedVersion: number,
  ) => action.version === expectedVersion
    ? null
    : { kind: 'version_conflict' as const, action };

  const port: FacebookConsumptionCoordinatorRuntimePort = {
    listActiveActions: async (limit = 100) => [...actions.values()]
      .filter((action) => action.state !== 'terminal')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit),
    claimAction: async (input) => {
      const action = actions.get(input.actionId);
      if (!action || action.state === 'terminal') return { kind: 'not_found' };
      if (action.ownerId && action.ownerId !== input.ownerId) {
        return { kind: 'owned_elsewhere', action };
      }
      events.push(`claim:${action.actionType}`);
      const claimed = write(action.actionId, {
        ownerId: input.ownerId,
        ownerExpiresAt: new Date(NOW + input.leaseMs).toISOString(),
      });
      return { kind: action.ownerId ? 'already_owned' : 'claimed', action: claimed };
    },
    bindActionTarget: async (input) => {
      const action = read(input.actionId);
      const conflict = versionConflict(action, input.expectedVersion);
      if (conflict) return conflict;
      const target = { ...action.target, ...input.target };
      events.push(
        `bind:${action.actionType}:${target.contentUrl ? 'content' : 'group'}`,
      );
      const bound = write(action.actionId, {
        target,
        state: dispatchable(action.actionType, target) ? 'ready' : 'waiting_target',
        blocker: dispatchable(action.actionType, target)
          ? null
          : 'waiting_content_target',
      });
      return { kind: 'updated', action: bound };
    },
    bindTargetAndMarkDispatched: async (input) => {
      const action = read(input.actionId);
      const conflict = versionConflict(action, input.expectedVersion);
      if (conflict) return conflict;
      if (action.dispatchPhase === 'dispatched') {
        return { kind: 'unchanged', action };
      }
      const target = { ...action.target, ...input.target };
      assert.equal(dispatchable(action.actionType, target), true);
      events.push(`dispatch:${action.actionType}`);
      const dispatched = write(action.actionId, {
        target,
        state: 'dispatched',
        dispatchPhase: 'dispatched',
        dispatchedAt: new Date(NOW).toISOString(),
        blocker: null,
      });
      return { kind: 'updated', action: dispatched };
    },
    markActionWaitingTarget: async (input) => {
      const action = read(input.actionId);
      const conflict = versionConflict(action, input.expectedVersion);
      if (conflict) return conflict;
      events.push(`waiting_target:${action.actionType}`);
      return {
        kind: 'updated',
        action: write(action.actionId, {
          state: 'waiting_target',
          blocker: input.blocker ?? 'waiting_target',
        }),
      };
    },
    markActionWaitingGate: async (input) => {
      const action = read(input.actionId);
      const conflict = versionConflict(action, input.expectedVersion);
      if (conflict) return conflict;
      events.push(`waiting_gate:${action.actionType}`);
      return {
        kind: 'updated',
        action: write(action.actionId, {
          state: 'waiting_gate',
          blocker: input.blocker ?? 'waiting_gate',
        }),
      };
    },
    releaseActionClaim: async (input) => {
      const action = read(input.actionId);
      const conflict = versionConflict(action, input.expectedVersion);
      if (conflict) return conflict;
      events.push(`release:${action.actionType}`);
      return {
        kind: 'updated',
        action: write(action.actionId, {
          ownerId: null,
          ownerExpiresAt: null,
        }),
      };
    },
    settleAction: async (receipt) => {
      receipts.push(receipt);
      const action = actions.get(receipt.actionId);
      if (!action) return { kind: 'not_found' };
      events.push(`settle:${action.actionType}:${receipt.outcome}`);
      if (receipt.outcome === 'pending') {
        const pending = write(action.actionId, { outcome: 'pending' });
        return { kind: 'pending', action: pending };
      }
      const terminal = write(action.actionId, {
        state: 'terminal',
        dispatchPhase: 'settled',
        outcome: receipt.outcome,
        blocker: receipt.outcome === 'confirmed_new_join'
          || receipt.outcome === 'confirmed_comment'
          ? null
          : receipt.outcome,
        ownerId: null,
        ownerExpiresAt: null,
        settledAt: new Date(NOW).toISOString(),
      });
      const nextAction = receipt.outcome === 'confirmed_new_join'
        && action.downstreamEnabled
        ? nextByActionId.get(action.actionId) ?? null
        : null;
      return { kind: 'settled', action: terminal, nextAction };
    },
    supersedeAccount: async (input) => {
      const updated: FacebookConsumptionActionView[] = [];
      for (const action of actions.values()) {
        if (
          action.accountId !== input.accountId
          || action.state === 'terminal'
          || (
            input.keepPolicyRevision != null
            && action.policyRevision === input.keepPolicyRevision
          )
        ) {
          continue;
        }
        events.push(`supersede:${action.actionType}`);
        updated.push(write(action.actionId, {
          downstreamEnabled: false,
          blocker: input.reason ?? 'policy_superseded',
          ...(action.dispatchPhase === 'not_started'
            ? {
                state: 'terminal' as const,
                dispatchPhase: 'settled' as const,
                outcome: 'policy_superseded' as const,
                settledAt: new Date(NOW).toISOString(),
              }
            : {}),
        }));
      }
      return updated;
    },
  };
  return { port, actions, receipts, events };
}

function activePolicy(accountId: string) {
  void accountId;
  return {
    effectiveMode: 'consumption' as const,
    policyRevision: 7,
  };
}

function joinedMembership(
  accountId: string,
  groupUrl: string,
  overrides: Partial<FacebookGroupMembershipRow> = {},
): FacebookGroupMembershipRow {
  return {
    accountId,
    groupUrl,
    status: 'joined',
    assignedAt: '2026-07-01T00:00:00.000Z',
    joinedAt: '2026-07-02T00:00:00.000Z',
    lastAttemptAt: null,
    attempts: 1,
    lastReason: null,
    lastCommentedAt: null,
    cooldownUntil: null,
    commentsTotal: 0,
    leftConfirmations: 0,
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function makeCommentMembershipRuntime(options: {
  initialLastCommentedAt?: string | null;
  initialLastReason?: string | null;
  failRecord?: boolean;
} = {}) {
  const rows = new Map<string, FacebookGroupMembershipRow>();
  const records: Array<{
    accountId: string;
    groupUrl: string;
    cooldownMs: number;
    reason: string;
  }> = [];
  const key = (accountId: string, groupUrl: string) => `${accountId}:${groupUrl}`;
  return {
    records,
    resolveGroupCommentPolicy: () => ({
      joinToFirstCommentHours: 24,
      revision: 9,
      source: 'db' as const,
      bounds: FACEBOOK_GROUP_COMMENT_POLICY_BOUNDS,
      sameGroupRecommentCooldownHours: 72,
      sameGroupRecommentCooldownSource: 'default' as const,
      updatedAt: null,
      updatedBy: null,
    }),
    readGroupMembership: async (accountId: string, groupUrl: string) => {
      const stored = rows.get(key(accountId, groupUrl));
      if (stored) return stored;
      const initial = joinedMembership(accountId, groupUrl, {
        lastCommentedAt: options.initialLastCommentedAt ?? null,
        lastReason: options.initialLastReason ?? null,
      });
      rows.set(key(accountId, groupUrl), initial);
      return initial;
    },
    recordConfirmedComment: async (
      accountId: string,
      groupUrl: string,
      input: { cooldownMs: number; reason: string },
    ) => {
      records.push({ accountId, groupUrl, ...input });
      if (options.failRecord) return null;
      const current = rows.get(key(accountId, groupUrl))
        ?? joinedMembership(accountId, groupUrl);
      const recorded = {
        ...current,
        lastCommentedAt: new Date(NOW).toISOString(),
        cooldownUntil: new Date(NOW + input.cooldownMs).toISOString(),
        commentsTotal: current.commentsTotal + 1,
        lastReason: input.reason,
      };
      rows.set(key(accountId, groupUrl), recorded);
      return recorded;
    },
  };
}

const noJoinReconciliation = async () => ({
  reconciled: false as const,
  outcome: 'unknown' as const,
  reason: 'not_expected',
});

describe('strict Facebook consumption historical-group selector', () => {
  it('reports a stale account projection as waiting_gate instead of no eligible group', async () => {
    const selector = createStrictFacebookConsumptionGroupSelector({
      commentPolicy: {
        get: () => ({
          joinToFirstCommentHours: 24,
          revision: 3,
          source: 'db',
          bounds: FACEBOOK_GROUP_COMMENT_POLICY_BOUNDS,
          sameGroupRecommentCooldownHours: 72,
          sameGroupRecommentCooldownSource: 'default',
          updatedAt: null,
          updatedBy: null,
        }),
      },
      memberships: {
        coverageProjectionState: async () => 'projection_stale',
        coverageCandidates: async () => {
          throw new Error('stale projection must stop before candidate query');
        },
      },
    });

    assert.deepEqual(await selector('account-selector'), {
      kind: 'waiting_gate',
      blocker: 'automation_account_projection_stale',
    });
  });

  it('re-reads timing policy, passes only strict warmup/cooldown predicates, and pins their revision', async () => {
    let policy: FacebookGroupCommentPolicyView = {
      joinToFirstCommentHours: 24,
      revision: 3,
      source: 'db',
      bounds: FACEBOOK_GROUP_COMMENT_POLICY_BOUNDS,
      sameGroupRecommentCooldownHours: 72,
      sameGroupRecommentCooldownSource: 'default',
      updatedAt: null,
      updatedBy: null,
    };
    const calls: Array<Record<string, unknown>> = [];
    let eligible = false;
    const selector = createStrictFacebookConsumptionGroupSelector({
      commentPolicy: { get: () => policy },
      memberships: {
        coverageCandidates: async (_accountId, options = {}) => {
          calls.push(options as Record<string, unknown>);
          if (!eligible) return [];
          return [{
            accountId: 'account-selector',
            groupUrl: GROUP_OLD,
            status: 'joined',
            assignedAt: null,
            joinedAt: '2026-07-28T00:00:00.000Z',
            lastAttemptAt: null,
            attempts: 1,
            lastReason: null,
            lastCommentedAt: '2026-07-20T00:00:00.000Z',
            cooldownUntil: null,
            commentsTotal: 1,
            leftConfirmations: 0,
            updatedAt: '2026-07-28T00:00:00.000Z',
          }];
        },
      },
      clock: () => NOW,
    });

    assert.deepEqual(await selector('account-selector'), {
      kind: 'no_target',
      blocker: 'no_strict_eligible_historical_group',
    });
    policy = { ...policy, joinToFirstCommentHours: 6, revision: 4 };
    eligible = true;
    const selected = await selector('account-selector');
    assert.equal(selected.kind, 'selected');
    if (selected.kind !== 'selected') return;
    assert.equal(selected.target.groupUrl, GROUP_OLD);
    assert.equal(selected.target.evidence.groupCommentPolicyRevision, 4);
    assert.equal(selected.target.evidence.joinToFirstCommentHours, 6);
    assert.equal(selected.target.evidence.recommentCooldownHours, 72);
    assert.deepEqual(calls, [
      { limit: 1, warmupMs: 24 * 60 * 60 * 1000, cooldownMs: 72 * 60 * 60 * 1000 },
      { limit: 1, warmupMs: 6 * 60 * 60 * 1000, cooldownMs: 72 * 60 * 60 * 1000 },
    ]);
    assert.equal(calls.some((options) => 'relaxed' in options), false);
  });
});

describe('FacebookConsumptionModeCoordinator', () => {
  it('runs standalone join then recursively comments an exact historical first post with CAS before each write', async () => {
    const join = makeAction('join-chain', 'join', { accountId: 'account-chain' });
    const comment = makeAction('comment-chain', 'comment', {
      accountId: 'account-chain',
      sequence: 2,
    });
    const runtime = makeRuntime([join, comment], new Map([[join.actionId, comment]]));
    const membershipRuntime = makeCommentMembershipRuntime();
    let commentCalls = 0;
    const redrives: Array<[string, string]> = [];
    const coordinator = new FacebookConsumptionModeCoordinator({
      runtimeStore: runtime.port,
      ...membershipRuntime,
      resolveOperationPolicy: activePolicy,
      commentActionGate: () => ({ allowed: true }),
      selectHistoricalGroup: async () => ({
        kind: 'selected',
        target: {
          groupKey: GROUP_OLD,
          groupUrl: GROUP_OLD,
          evidence: {
            selectedAt: new Date(NOW).toISOString(),
            joinedAt: '2026-07-20T00:00:00.000Z',
            lastConfirmedCommentAt: null,
            groupCommentPolicyRevision: 5,
            joinToFirstCommentHours: 24,
            recommentCooldownHours: 72,
          },
        },
      }),
      joinExecutor: {
        reconcileForMode: noJoinReconciliation,
        triggerForMode: async (accountId, options) => {
          assert.equal(accountId, 'account-chain');
          assert.equal('joinFirst' in options, false);
          assert.equal(await options.onAssigned({
            accountId,
            groupUrl: GROUP_NEW,
            source: 'consumption',
          }), true);
          assert.equal(await options.onBeforeDispatch({
            accountId,
            groupUrl: GROUP_NEW,
            source: 'consumption',
          }), true);
          options.onPageLeaseSettled?.(true, 'edge-test');
          return {
            triggered: true,
            groupUrl: GROUP_NEW,
            outcome: 'joined',
          };
        },
      },
      commentExecutor: {
        triggerForMode: async (accountId, options) => {
          commentCalls += 1;
          assert.equal(accountId, 'account-chain');
          assert.equal(options.source, 'consumption');
          assert.equal(options.groupUrl, GROUP_OLD);
          assert.equal(options.selection, 'first_commentable_group_post');
          assert.equal('joinFirst' in options, false);
          assert.deepEqual(options.actionGate('comment'), { allowed: true });
          const exact = {
            accountId,
            groupUrl: GROUP_OLD,
            contentKey: '42',
            contentUrl: POST,
            selection: 'first_commentable_group_post' as const,
          };
          assert.equal(await options.onTargetSelected(exact), true);
          assert.equal(await options.onBeforeSubmit(exact), true);
          options.onPageLeaseSettled?.(true, 'edge-test');
          return {
            triggered: true,
            result: { outcome: 'commented', container: GROUP_OLD },
          };
        },
      },
      ownerId: 'coordinator-test',
      clock: () => NOW,
      redriveBrowse: (accountId, edgeId) => { redrives.push([accountId, edgeId]); },
    });

    const result = await coordinator.trigger(join);
    assert.equal(result.kind, 'settled');
    assert.equal(result.kind === 'settled' ? result.action.actionId : '', comment.actionId);
    assert.equal(commentCalls, 1);
    assert.deepEqual(
      redrives,
      [['account-chain', 'edge-test']],
      '两段 release ACK 只在根 action chain 收敛后精确定向重驱一次',
    );
    assert.deepEqual(
      runtime.receipts.map((receipt) => receipt.outcome),
      ['confirmed_new_join', 'confirmed_comment'],
    );
    assert.deepEqual(runtime.events, [
      'claim:join',
      'bind:join:group',
      'dispatch:join',
      'settle:join:confirmed_new_join',
      'claim:comment',
      'bind:comment:group',
      'bind:comment:content',
      'dispatch:comment',
      'settle:comment:confirmed_comment',
    ]);
    const commentReceipt = runtime.receipts[1]!;
    assert.equal(commentReceipt.expectedGroupUrl, GROUP_OLD);
    assert.equal(commentReceipt.expectedContentKey, '42');
    assert.equal(commentReceipt.expectedContentUrl, POST);
    assert.deepEqual(membershipRuntime.records, [{
      accountId: 'account-chain',
      groupUrl: GROUP_OLD,
      cooldownMs: 72 * 60 * 60 * 1000,
      reason: `consumption_confirmed_comment:${comment.actionId}`,
    }]);
  });

  it('keeps missing join/comment groups as durable waiting_target without settlement or relaxed fallback', async () => {
    const join = makeAction('join-no-target', 'join');
    const joinRuntime = makeRuntime([join]);
    const joinCoordinator = new FacebookConsumptionModeCoordinator({
      runtimeStore: joinRuntime.port,
      ...makeCommentMembershipRuntime(),
      resolveOperationPolicy: activePolicy,
      commentActionGate: () => ({ allowed: true }),
      selectHistoricalGroup: async () => {
        throw new Error('comment selector must not run');
      },
      joinExecutor: {
        reconcileForMode: noJoinReconciliation,
        triggerForMode: async () => ({ triggered: false, reason: 'no_targets' }),
      },
      commentExecutor: {
        triggerForMode: async () => {
          throw new Error('comment must not run');
        },
      },
      ownerId: 'coordinator-test',
      clock: () => NOW,
    });
    const joinResult = await joinCoordinator.trigger(join);
    assert.equal(joinResult.kind, 'waiting_target');
    assert.deepEqual(joinRuntime.receipts, []);
    assert.deepEqual(joinRuntime.events, [
      'claim:join',
      'waiting_target:join',
      'release:join',
    ]);

    const comment = makeAction('comment-no-target', 'comment');
    const commentRuntime = makeRuntime([comment]);
    let commentCalls = 0;
    const commentCoordinator = new FacebookConsumptionModeCoordinator({
      runtimeStore: commentRuntime.port,
      ...makeCommentMembershipRuntime(),
      resolveOperationPolicy: activePolicy,
      commentActionGate: () => ({ allowed: true }),
      selectHistoricalGroup: async () => ({
        kind: 'no_target',
        blocker: 'no_strict_eligible_historical_group',
      }),
      joinExecutor: {
        reconcileForMode: noJoinReconciliation,
        triggerForMode: async () => {
          throw new Error('join must not run');
        },
      },
      commentExecutor: {
        triggerForMode: async () => {
          commentCalls += 1;
          throw new Error('comment must not run');
        },
      },
      ownerId: 'coordinator-test',
      clock: () => NOW,
    });
    const commentResult = await commentCoordinator.trigger(comment);
    assert.equal(commentResult.kind, 'waiting_target');
    assert.equal(commentCalls, 0);
    assert.deepEqual(commentRuntime.receipts, []);
  });

  it('recovers a durable waiting_target after restart when strict timing becomes eligible, while never replaying dispatched work', async () => {
    const waiting = makeAction('comment-recovery', 'comment', {
      accountId: 'account-recovery',
    });
    const runtime = makeRuntime([waiting]);
    let eligible = false;
    let commentCalls = 0;
    const deps = {
      runtimeStore: runtime.port,
      ...makeCommentMembershipRuntime(),
      resolveOperationPolicy: activePolicy,
      commentActionGate: () => ({ allowed: true }),
      selectHistoricalGroup: async () => eligible
        ? {
            kind: 'selected' as const,
            target: {
              groupKey: GROUP_OLD,
              groupUrl: GROUP_OLD,
              evidence: {
                selectedAt: new Date(NOW).toISOString(),
                joinedAt: '2026-07-20T00:00:00.000Z',
                joinToFirstCommentHours: 24,
                recommentCooldownHours: 72,
              },
            },
          }
        : {
            kind: 'no_target' as const,
            blocker: 'no_strict_eligible_historical_group',
          },
      joinExecutor: {
        reconcileForMode: noJoinReconciliation,
        triggerForMode: async () => {
          throw new Error('join must not run');
        },
      },
      commentExecutor: {
        triggerForMode: async (
          accountId: string,
          options: Parameters<
            import('@automation/orchestrator/facebook-consumption-mode-coordinator.js').FacebookConsumptionCommentExecutorPort['triggerForMode']
          >[1],
        ) => {
          commentCalls += 1;
          const exact = {
            accountId,
            groupUrl: GROUP_OLD,
            contentKey: '42',
            contentUrl: POST,
            selection: 'first_commentable_group_post' as const,
          };
          assert.equal(await options.onTargetSelected(exact), true);
          assert.equal(await options.onBeforeSubmit(exact), true);
          return {
            triggered: true as const,
            result: { outcome: 'commented' as const },
          };
        },
      },
      ownerId: 'coordinator-recovery',
      clock: () => NOW,
    };
    const beforeRestart = new FacebookConsumptionModeCoordinator(deps);
    assert.equal((await beforeRestart.trigger(waiting)).kind, 'waiting_target');
    assert.equal(commentCalls, 0);

    eligible = true;
    const afterRestart = new FacebookConsumptionModeCoordinator(deps);
    const recovered = await afterRestart.recoverActiveActions(10);
    assert.equal(recovered.scanned, 1);
    assert.equal(recovered.driven, 1);
    assert.equal(recovered.results[0]?.kind, 'settled');
    assert.equal(commentCalls, 1);
    assert.equal(runtime.receipts.at(-1)?.outcome, 'confirmed_comment');

    const dispatched = makeAction('join-recovery-dispatched', 'join', {
      accountId: 'account-dispatched',
      state: 'dispatched',
      dispatchPhase: 'dispatched',
      target: {
        groupKey: GROUP_NEW,
        groupUrl: GROUP_NEW,
        contentKey: null,
        contentUrl: null,
        selection: null,
        evidence: { selectedAt: new Date(NOW).toISOString() },
      },
    });
    const dispatchedRuntime = makeRuntime([dispatched]);
    let joinCalls = 0;
    const dispatchedRecovery = new FacebookConsumptionModeCoordinator({
      ...deps,
      runtimeStore: dispatchedRuntime.port,
      joinExecutor: {
        reconcileForMode: async () => ({
          reconciled: false as const,
          groupUrl: GROUP_NEW,
          outcome: 'still_pending' as const,
          reason: 'clear_join_cta',
        }),
        triggerForMode: async () => {
          joinCalls += 1;
          throw new Error('dispatched join must not replay');
        },
      },
    });
    const snapshot = await dispatchedRecovery.recoverActiveActions();
    assert.equal(snapshot.results[0]?.kind, 'awaiting_reconciliation');
    assert.equal(
      snapshot.results[0]?.kind === 'awaiting_reconciliation'
        ? snapshot.results[0].blocker
        : '',
      'join_reconciliation_still_pending:clear_join_cta',
    );
    assert.equal(joinCalls, 0);
  });

  it('settles restarted pending membership proof as non-counting already_member and never replays the write', async () => {
    const dispatched = makeAction('join-reconcile-confirmed', 'join', {
      accountId: 'account-reconcile-confirmed',
      state: 'dispatched',
      dispatchPhase: 'dispatched',
      outcome: 'pending',
      dispatchedAt: new Date(NOW - 1_000).toISOString(),
      target: {
        groupKey: GROUP_NEW,
        groupUrl: GROUP_NEW,
        contentKey: null,
        contentUrl: null,
        selection: null,
        evidence: { selectedAt: new Date(NOW - 2_000).toISOString() },
      },
    });
    const runtime = makeRuntime([dispatched]);
    let writeCalls = 0;
    let observationCalls = 0;
    const coordinator = new FacebookConsumptionModeCoordinator({
      runtimeStore: runtime.port,
      ...makeCommentMembershipRuntime(),
      resolveOperationPolicy: activePolicy,
      commentActionGate: () => ({ allowed: true }),
      selectHistoricalGroup: async () => ({
        kind: 'no_target',
        blocker: 'must_not_run',
      }),
      joinExecutor: {
        triggerForMode: async () => {
          writeCalls += 1;
          throw new Error('pending join must not replay');
        },
        reconcileForMode: async (accountId, groupUrl, options) => {
          observationCalls += 1;
          assert.equal(accountId, dispatched.accountId);
          assert.equal(groupUrl, GROUP_NEW);
          assert.equal(options.source, 'consumption');
          options.onPageLeaseSettled?.(true, 'edge-test');
          return {
            reconciled: true,
            groupUrl: GROUP_NEW,
            outcome: 'confirmed_member',
            reason: 'member_signal',
            observation: {
              groupUrl: GROUP_NEW,
              mainCtaText: 'Joined',
            },
          };
        },
      },
      commentExecutor: {
        triggerForMode: async () => {
          throw new Error('no downstream comment is due in this fixture');
        },
      },
      ownerId: 'coordinator-reconcile',
      clock: () => NOW,
    });

    const recovered = await coordinator.recoverActiveActions();
    assert.equal(recovered.results[0]?.kind, 'settled');
    assert.equal(writeCalls, 0);
    assert.equal(observationCalls, 1);
    assert.deepEqual(runtime.receipts.map((receipt) => ({
      key: receipt.sourceDedupeKey,
      outcome: receipt.outcome,
    })), [{
      key: `${dispatched.idempotencyKey}:join-platform`,
      outcome: 'already_member',
    }]);
  });

  it('supersedes a mode-switched pending join before read-only reconciliation and creates no downstream work', async () => {
    const dispatched = makeAction('join-reconcile-switched', 'join', {
      accountId: 'account-reconcile-switched',
      state: 'dispatched',
      dispatchPhase: 'dispatched',
      outcome: 'pending',
      dispatchedAt: new Date(NOW - 1_000).toISOString(),
      target: {
        groupKey: GROUP_NEW,
        groupUrl: GROUP_NEW,
        contentKey: null,
        contentUrl: null,
        selection: null,
        evidence: { selectedAt: new Date(NOW - 2_000).toISOString() },
      },
    });
    const wouldBeComment = makeAction('comment-must-not-appear', 'comment', {
      accountId: dispatched.accountId,
      sequence: 2,
    });
    const runtime = makeRuntime(
      [dispatched],
      new Map([[dispatched.actionId, wouldBeComment]]),
    );
    let joinWrites = 0;
    let readOnlyObservations = 0;
    const coordinator = new FacebookConsumptionModeCoordinator({
      runtimeStore: runtime.port,
      ...makeCommentMembershipRuntime(),
      resolveOperationPolicy: () => ({
        effectiveMode: 'persona' as const,
        policyRevision: 8,
      }),
      commentActionGate: () => ({ allowed: true }),
      selectHistoricalGroup: async () => ({
        kind: 'no_target',
        blocker: 'must_not_run',
      }),
      joinExecutor: {
        triggerForMode: async () => {
          joinWrites += 1;
          throw new Error('mode-switched join must not replay');
        },
        reconcileForMode: async () => {
          readOnlyObservations += 1;
          return {
            reconciled: true,
            groupUrl: GROUP_NEW,
            outcome: 'confirmed_member',
            reason: 'member_signal',
            observation: {
              groupUrl: GROUP_NEW,
              membershipSignals: ['member of this group'],
            },
          };
        },
      },
      commentExecutor: {
        triggerForMode: async () => {
          throw new Error('superseded action must not create a comment');
        },
      },
      ownerId: 'coordinator-reconcile',
      clock: () => NOW,
    });

    const recovered = await coordinator.recoverActiveActions();
    assert.equal(recovered.results[0]?.kind, 'settled');
    assert.equal(joinWrites, 0);
    assert.equal(readOnlyObservations, 1);
    assert.equal(runtime.actions.get(dispatched.actionId)?.downstreamEnabled, false);
    assert.equal(runtime.actions.has(wouldBeComment.actionId), false);
    assert.deepEqual(runtime.events, [
      'supersede:join',
      'settle:join:already_member',
    ]);
  });

  it('keeps same-revision work gated during a temporary slow-start overlay', async () => {
    const waiting = makeAction('join-slow-start-overlay', 'join');
    const runtime = makeRuntime([waiting]);
    let joinCalls = 0;
    const coordinator = new FacebookConsumptionModeCoordinator({
      runtimeStore: runtime.port,
      ...makeCommentMembershipRuntime(),
      resolveOperationPolicy: () => ({
        effectiveMode: 'slow_start',
        policyRevision: waiting.policyRevision,
        blocker: 'slow_start_active',
      }),
      commentActionGate: () => ({ allowed: true }),
      selectHistoricalGroup: async () => ({
        kind: 'no_target',
        blocker: 'must_not_run',
      }),
      joinExecutor: {
        reconcileForMode: noJoinReconciliation,
        triggerForMode: async () => {
          joinCalls += 1;
          throw new Error('same-revision slow-start overlay must not dispatch');
        },
      },
      commentExecutor: {
        triggerForMode: async () => {
          throw new Error('comment must not run');
        },
      },
      ownerId: 'coordinator-slow-start-overlay',
      clock: () => NOW,
    });

    const result = await coordinator.trigger(waiting);
    assert.equal(result.kind, 'waiting_gate');
    assert.equal(joinCalls, 0);
    assert.equal(runtime.receipts.length, 0);
    assert.equal(runtime.actions.get(waiting.actionId)?.state, 'waiting_target');
  });

  it('settles an expired-owner dispatched like as ambiguous without replay or success credit', async () => {
    const like = makeAction('like-orphaned-dispatch', 'like', {
      state: 'dispatched',
      dispatchPhase: 'dispatched',
      outcome: 'pending',
      ownerId: 'dead-dispatcher',
      ownerExpiresAt: new Date(NOW - 1).toISOString(),
      dispatchedAt: new Date(NOW - 60_001).toISOString(),
      target: {
        groupKey: null,
        groupUrl: null,
        contentKey: '42',
        contentUrl: POST,
        selection: null,
        evidence: null,
      },
    });
    const runtime = makeRuntime([like]);
    const coordinator = new FacebookConsumptionModeCoordinator({
      runtimeStore: runtime.port,
      ...makeCommentMembershipRuntime(),
      resolveOperationPolicy: activePolicy,
      commentActionGate: () => ({ allowed: true }),
      selectHistoricalGroup: async () => ({
        kind: 'no_target',
        blocker: 'must_not_run',
      }),
      joinExecutor: {
        reconcileForMode: noJoinReconciliation,
        triggerForMode: async () => {
          throw new Error('like recovery must not call join');
        },
      },
      commentExecutor: {
        triggerForMode: async () => {
          throw new Error('like recovery must not call comment');
        },
      },
      ownerId: 'coordinator-like-recovery',
      clock: () => NOW,
    });

    const recovered = await coordinator.recoverActiveActions();
    assert.equal(recovered.results[0]?.kind, 'settled');
    assert.equal(runtime.receipts[0]?.outcome, 'ambiguous');
    assert.equal(runtime.receipts[0]?.sourceDedupeKey, `${like.actionId}:edge-like`);
    assert.equal(runtime.actions.get(like.actionId)?.state, 'terminal');
  });

  it('does not preempt a dispatched like while its receipt owner lease is active', async () => {
    const like = makeAction('like-live-dispatch', 'like', {
      state: 'dispatched',
      dispatchPhase: 'dispatched',
      ownerId: 'live-dispatcher',
      ownerExpiresAt: new Date(NOW + 1_000).toISOString(),
      dispatchedAt: new Date(NOW - 1_000).toISOString(),
      target: {
        groupKey: null,
        groupUrl: null,
        contentKey: '42',
        contentUrl: POST,
        selection: null,
        evidence: null,
      },
    });
    const runtime = makeRuntime([like]);
    const coordinator = new FacebookConsumptionModeCoordinator({
      runtimeStore: runtime.port,
      ...makeCommentMembershipRuntime(),
      resolveOperationPolicy: activePolicy,
      commentActionGate: () => ({ allowed: true }),
      selectHistoricalGroup: async () => ({
        kind: 'no_target',
        blocker: 'must_not_run',
      }),
      joinExecutor: {
        reconcileForMode: noJoinReconciliation,
        triggerForMode: async () => {
          throw new Error('like recovery must not call join');
        },
      },
      commentExecutor: {
        triggerForMode: async () => {
          throw new Error('like recovery must not call comment');
        },
      },
      ownerId: 'coordinator-like-recovery',
      clock: () => NOW,
    });

    const recovered = await coordinator.recoverActiveActions();
    assert.equal(recovered.results[0]?.kind, 'awaiting_reconciliation');
    assert.equal(
      recovered.results[0]?.kind === 'awaiting_reconciliation'
        ? recovered.results[0].blocker
        : '',
      'like_receipt_owner_lease_active',
    );
    assert.equal(runtime.receipts.length, 0);
  });

  it('does not advance or redispatch pending, ambiguous, or failed join outcomes', async () => {
    const cases: Array<{
      raw: FacebookGroupJoinTriggerResultLike;
      expected: FacebookConsumptionOutcome;
      resultKind: string;
    }> = [
      {
        raw: { triggered: true, groupUrl: GROUP_NEW, outcome: 'pending' },
        expected: 'pending',
        resultKind: 'pending',
      },
      {
        raw: { triggered: true, groupUrl: GROUP_NEW, outcome: 'ambiguous_skip' },
        expected: 'ambiguous',
        resultKind: 'settled',
      },
      {
        raw: { triggered: true, groupUrl: GROUP_NEW, outcome: 'join_failed' },
        expected: 'failed',
        resultKind: 'settled',
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      const action = makeAction(`join-nonconfirmed-${index}`, 'join');
      const runtime = makeRuntime([action]);
      let joinCalls = 0;
      let commentCalls = 0;
      const coordinator = new FacebookConsumptionModeCoordinator({
        runtimeStore: runtime.port,
        ...makeCommentMembershipRuntime(),
        resolveOperationPolicy: activePolicy,
        commentActionGate: () => ({ allowed: true }),
        selectHistoricalGroup: async () => ({
          kind: 'no_target',
          blocker: 'must_not_run',
        }),
        joinExecutor: {
          reconcileForMode: async () => ({
            reconciled: false as const,
            groupUrl: GROUP_NEW,
            outcome: 'still_pending' as const,
            reason: 'pending_request',
          }),
          triggerForMode: async (accountId, options) => {
            joinCalls += 1;
            await options.onAssigned({
              accountId,
              groupUrl: GROUP_NEW,
              source: 'consumption',
            });
            await options.onBeforeDispatch({
              accountId,
              groupUrl: GROUP_NEW,
              source: 'consumption',
            });
            return testCase.raw;
          },
        },
        commentExecutor: {
          triggerForMode: async () => {
            commentCalls += 1;
            throw new Error('non-confirmed join must not create comment');
          },
        },
        ownerId: 'coordinator-test',
        clock: () => NOW,
      });
      const result = await coordinator.trigger(action);
      assert.equal(result.kind, testCase.resultKind);
      assert.deepEqual(runtime.receipts.map((receipt) => receipt.outcome), [
        testCase.expected,
      ]);
      assert.equal(commentCalls, 0);
      if (testCase.expected === 'pending') {
        const replay = await coordinator.trigger(runtime.actions.get(action.actionId)!);
        assert.equal(replay.kind, 'awaiting_reconciliation');
        assert.equal(joinCalls, 1, 'pending action must never be dispatched twice');
      }
    }
  });

  it('revalidates the exact joined membership before comment dispatch and keeps failures as named gates', async () => {
    const cases: Array<{
      name: string;
      blocker: string;
      readMembership: (
        accountId: string,
        groupUrl: string,
      ) => Promise<FacebookGroupMembershipRow | null>;
    }> = [
      {
        name: 'unavailable',
        blocker: 'comment_membership_freshness_unavailable:membership_db_down',
        readMembership: async () => {
          throw new Error('membership_db_down');
        },
      },
      {
        name: 'missing',
        blocker: 'comment_membership_freshness_missing',
        readMembership: async () => null,
      },
      {
        name: 'wrong-account',
        blocker: 'comment_membership_freshness_account_mismatch',
        readMembership: async (_accountId, groupUrl) =>
          joinedMembership('another-account', groupUrl),
      },
      {
        name: 'wrong-group',
        blocker: 'comment_membership_freshness_group_mismatch',
        readMembership: async (accountId) =>
          joinedMembership(accountId, GROUP_NEW),
      },
      {
        name: 'left',
        blocker: 'comment_membership_freshness_status_left',
        readMembership: async (accountId, groupUrl) =>
          joinedMembership(accountId, groupUrl, { status: 'left' }),
      },
    ];

    for (const testCase of cases) {
      const comment = makeAction(`comment-membership-${testCase.name}`, 'comment');
      const runtime = makeRuntime([comment]);
      const membershipRuntime = makeCommentMembershipRuntime();
      let submitCalls = 0;
      const coordinator = new FacebookConsumptionModeCoordinator({
        runtimeStore: runtime.port,
        ...membershipRuntime,
        readGroupMembership: testCase.readMembership,
        resolveOperationPolicy: activePolicy,
        commentActionGate: () => ({ allowed: true }),
        selectHistoricalGroup: async () => ({
          kind: 'selected',
          target: {
            groupKey: GROUP_OLD,
            groupUrl: GROUP_OLD,
            evidence: {
              selectedAt: new Date(NOW).toISOString(),
              joinedAt: '2026-07-20T00:00:00.000Z',
              joinToFirstCommentHours: 24,
              recommentCooldownHours: 72,
            },
          },
        }),
        joinExecutor: {
          reconcileForMode: noJoinReconciliation,
          triggerForMode: async () => {
            throw new Error('join must not run');
          },
        },
        commentExecutor: {
          triggerForMode: async (accountId, options) => {
            const exact = {
              accountId,
              groupUrl: GROUP_OLD,
              contentKey: '42',
              contentUrl: POST,
              selection: 'first_commentable_group_post' as const,
            };
            assert.equal(await options.onTargetSelected(exact), true);
            if (await options.onBeforeSubmit(exact)) submitCalls += 1;
            return {
              triggered: true,
              result: {
                outcome: 'submit_failed',
                reason: 'dispatch_suppressed:consumption_before_submit_rejected',
              },
            };
          },
        },
        ownerId: `coordinator-membership-${testCase.name}`,
        clock: () => NOW,
      });

      const result = await coordinator.trigger(comment);
      assert.equal(result.kind, 'waiting_gate', testCase.name);
      assert.equal(submitCalls, 0, testCase.name);
      assert.equal(
        runtime.events.includes('dispatch:comment'),
        false,
        testCase.name,
      );
      assert.deepEqual(runtime.receipts, [], testCase.name);
      assert.equal(
        runtime.actions.get(comment.actionId)?.blocker,
        testCase.blocker,
        testCase.name,
      );
      assert.equal(
        runtime.actions.get(comment.actionId)?.ownerId,
        null,
        testCase.name,
      );
    }
  });

  it('awaits the joined-membership cooldown write before settling a confirmed consumption comment', async () => {
    const comment = makeAction('comment-ledger-failure', 'comment');
    const runtime = makeRuntime([comment]);
    const membershipRuntime = makeCommentMembershipRuntime({ failRecord: true });
    const coordinator = new FacebookConsumptionModeCoordinator({
      runtimeStore: runtime.port,
      ...membershipRuntime,
      resolveOperationPolicy: activePolicy,
      commentActionGate: () => ({ allowed: true }),
      selectHistoricalGroup: async () => ({
        kind: 'selected',
        target: {
          groupKey: GROUP_OLD,
          groupUrl: GROUP_OLD,
          evidence: {
            selectedAt: new Date(NOW).toISOString(),
            joinedAt: '2026-07-20T00:00:00.000Z',
            joinToFirstCommentHours: 24,
            recommentCooldownHours: 72,
          },
        },
      }),
      joinExecutor: {
        reconcileForMode: noJoinReconciliation,
        triggerForMode: async () => {
          throw new Error('join must not run');
        },
      },
      commentExecutor: {
        triggerForMode: async (accountId, options) => {
          const exact = {
            accountId,
            groupUrl: GROUP_OLD,
            contentKey: '42',
            contentUrl: POST,
            selection: 'first_commentable_group_post' as const,
          };
          assert.equal(await options.onTargetSelected(exact), true);
          assert.equal(await options.onBeforeSubmit(exact), true);
          return {
            triggered: true,
            result: { outcome: 'commented' as const },
          };
        },
      },
      ownerId: 'coordinator-ledger',
      clock: () => NOW,
    });

    const result = await coordinator.trigger(comment);
    assert.equal(result.kind, 'awaiting_reconciliation');
    assert.equal(
      result.kind === 'awaiting_reconciliation' ? result.blocker : '',
      'comment_membership_joined_row_missing',
    );
    assert.equal(runtime.receipts.length, 0, 'ledger failure must block settlement');
    assert.equal(
      runtime.actions.get(comment.actionId)?.dispatchPhase,
      'dispatched',
    );
    assert.equal(membershipRuntime.records.length, 1);
  });

  it('requires an action-correlated membership receipt as durable comment recovery proof', async () => {
    const exactTarget: FacebookConsumptionActionTarget = {
      groupKey: GROUP_OLD,
      groupUrl: GROUP_OLD,
      contentKey: '42',
      contentUrl: POST,
      selection: 'first_commentable_group_post',
      evidence: { selectedAt: new Date(NOW - 2_000).toISOString() },
    };
    const proved = makeAction('comment-reconcile-proved', 'comment', {
      state: 'dispatched',
      dispatchPhase: 'dispatched',
      outcome: 'pending',
      dispatchedAt: new Date(NOW - 1_000).toISOString(),
      target: exactTarget,
    });
    const provedRuntime = makeRuntime([proved]);
    let commentWrites = 0;
    const provedCoordinator = new FacebookConsumptionModeCoordinator({
      runtimeStore: provedRuntime.port,
      ...makeCommentMembershipRuntime({
        initialLastCommentedAt: new Date(NOW).toISOString(),
        initialLastReason: `consumption_confirmed_comment:${proved.actionId}`,
      }),
      resolveOperationPolicy: activePolicy,
      commentActionGate: () => ({ allowed: true }),
      selectHistoricalGroup: async () => ({
        kind: 'no_target',
        blocker: 'must_not_run',
      }),
      joinExecutor: {
        reconcileForMode: noJoinReconciliation,
        triggerForMode: async () => {
          throw new Error('join must not run');
        },
      },
      commentExecutor: {
        triggerForMode: async () => {
          commentWrites += 1;
          throw new Error('dispatched comment must never replay');
        },
      },
      ownerId: 'coordinator-comment-recovery',
      clock: () => NOW,
    });

    const provedResult = await provedCoordinator.recoverActiveActions();
    assert.equal(provedResult.results[0]?.kind, 'settled');
    assert.equal(commentWrites, 0);
    assert.deepEqual(provedRuntime.receipts.map((receipt) => ({
      key: receipt.sourceDedupeKey,
      outcome: receipt.outcome,
    })), [{
      key: `${proved.idempotencyKey}:comment-platform`,
      outcome: 'confirmed_comment',
    }]);

    const unproved = makeAction('comment-reconcile-unproved', 'comment', {
      state: 'dispatched',
      dispatchPhase: 'dispatched',
      outcome: 'pending',
      dispatchedAt: new Date(NOW - 1_000).toISOString(),
      target: exactTarget,
    });
    const unprovedRuntime = makeRuntime([unproved]);
    const unprovedCoordinator = new FacebookConsumptionModeCoordinator({
      runtimeStore: unprovedRuntime.port,
      ...makeCommentMembershipRuntime({
        initialLastCommentedAt: new Date(NOW).toISOString(),
        initialLastReason: 'scheduled_comment:another-action',
      }),
      resolveOperationPolicy: activePolicy,
      commentActionGate: () => ({ allowed: true }),
      selectHistoricalGroup: async () => ({
        kind: 'no_target',
        blocker: 'must_not_run',
      }),
      joinExecutor: {
        reconcileForMode: noJoinReconciliation,
        triggerForMode: async () => {
          throw new Error('join must not run');
        },
      },
      commentExecutor: {
        triggerForMode: async () => {
          throw new Error('unproved comment must never replay');
        },
      },
      ownerId: 'coordinator-comment-recovery',
      clock: () => NOW,
    });

    const unprovedResult = await unprovedCoordinator.recoverActiveActions();
    assert.equal(unprovedResult.results[0]?.kind, 'settled');
    assert.deepEqual(unprovedRuntime.receipts.map((receipt) => ({
      key: receipt.sourceDedupeKey,
      outcome: receipt.outcome,
      evidence: receipt.evidence,
    })), [{
      key: `${unproved.idempotencyKey}:comment-platform`,
      outcome: 'ambiguous',
      evidence: {
        reconciliation:
          'expired_dispatch_owner_without_action_correlated_receipt',
        blocker: 'comment_reconciliation_action_receipt_missing',
        operationPolicyState: 'active',
      },
    }]);
  });

  it('settles policy_superseded and submits nothing when effective mode changes before comment dispatch CAS', async () => {
    const comment = makeAction('comment-policy-switch', 'comment');
    const runtime = makeRuntime([comment]);
    let policyReads = 0;
    let submitCalls = 0;
    const coordinator = new FacebookConsumptionModeCoordinator({
      runtimeStore: runtime.port,
      ...makeCommentMembershipRuntime(),
      resolveOperationPolicy: () => {
        policyReads += 1;
        return policyReads < 4
          ? { effectiveMode: 'consumption' as const, policyRevision: 7 }
          : { effectiveMode: 'persona' as const, policyRevision: 8 };
      },
      commentActionGate: () => ({ allowed: true }),
      selectHistoricalGroup: async () => ({
        kind: 'selected',
        target: {
          groupKey: GROUP_OLD,
          groupUrl: GROUP_OLD,
          evidence: {
            selectedAt: new Date(NOW).toISOString(),
            joinedAt: '2026-07-20T00:00:00.000Z',
            recommentCooldownHours: 72,
            joinToFirstCommentHours: 24,
          },
        },
      }),
      joinExecutor: {
        reconcileForMode: noJoinReconciliation,
        triggerForMode: async () => {
          throw new Error('join must not run');
        },
      },
      commentExecutor: {
        triggerForMode: async (accountId, options) => {
          const exact = {
            accountId,
            groupUrl: GROUP_OLD,
            contentKey: '42',
            contentUrl: POST,
            selection: 'first_commentable_group_post' as const,
          };
          assert.equal(await options.onTargetSelected(exact), true);
          if (await options.onBeforeSubmit(exact)) submitCalls += 1;
          return {
            triggered: true,
            result: {
              outcome: 'submit_failed',
              reason: 'dispatch_suppressed:consumption_before_submit_rejected',
            },
          };
        },
      },
      ownerId: 'coordinator-test',
      clock: () => NOW,
    });

    const result = await coordinator.trigger(comment);
    assert.equal(result.kind, 'settled');
    assert.equal(submitCalls, 0);
    assert.equal(runtime.events.includes('dispatch:comment'), false);
    assert.deepEqual(runtime.receipts.map((receipt) => receipt.outcome), [
      'policy_superseded',
    ]);
  });

  it('preserves terminal accounting and redrives failures or submitted-unknown only after an acknowledged final release', async () => {
    const cases = [
      {
        name: 'submitted-unknown',
        result: { outcome: 'verification_ambiguous' as const },
        expectedOutcome: 'ambiguous',
      },
      {
        name: 'submit-failed',
        result: { outcome: 'submit_failed' as const, reason: 'platform_submit_failed' },
        expectedOutcome: 'failed',
      },
    ];
    for (const terminalCase of cases) {
      for (const acknowledged of [true, false]) {
        const accountId = `account-${terminalCase.name}-${acknowledged}`;
        const comment = makeAction(`comment-${terminalCase.name}-${acknowledged}`, 'comment', { accountId });
        const runtime = makeRuntime([comment]);
        const redrives: Array<[string, string]> = [];
        const coordinator = new FacebookConsumptionModeCoordinator({
          runtimeStore: runtime.port,
          ...makeCommentMembershipRuntime(),
          resolveOperationPolicy: activePolicy,
          commentActionGate: () => ({ allowed: true }),
          selectHistoricalGroup: async () => ({
            kind: 'selected',
            target: {
              groupKey: GROUP_OLD,
              groupUrl: GROUP_OLD,
              evidence: {
                selectedAt: new Date(NOW).toISOString(),
                joinedAt: '2026-07-20T00:00:00.000Z',
                joinToFirstCommentHours: 24,
                recommentCooldownHours: 72,
              },
            },
          }),
          joinExecutor: {
            reconcileForMode: noJoinReconciliation,
            triggerForMode: async () => {
              throw new Error('join must not run');
            },
          },
          commentExecutor: {
            triggerForMode: async (executorAccountId, options) => {
              const exact = {
                accountId: executorAccountId,
                groupUrl: GROUP_OLD,
                contentKey: '42',
                contentUrl: POST,
                selection: 'first_commentable_group_post' as const,
              };
              assert.equal(await options.onTargetSelected(exact), true);
              assert.equal(await options.onBeforeSubmit(exact), true);
              options.onPageLeaseSettled?.(acknowledged, 'edge-test');
              return {
                triggered: true,
                // verification_ambiguous is the scheduler name for product submitted_unknown.
                result: terminalCase.result,
              };
            },
          },
          redriveBrowse: (redriveAccountId, edgeId) => {
            redrives.push([redriveAccountId, edgeId]);
          },
          ownerId: `coordinator-${terminalCase.name}-${acknowledged}`,
          clock: () => NOW,
        });

        const result = await coordinator.trigger(comment);
        assert.equal(result.kind, 'settled');
        assert.deepEqual(
          runtime.receipts.map((receipt) => receipt.outcome),
          [terminalCase.expectedOutcome],
        );
        assert.deepEqual(redrives, acknowledged ? [[accountId, 'edge-test']] : []);
      }
    }
  });
});

type FacebookGroupJoinTriggerResultLike = {
  triggered: boolean;
  reason?: string;
  groupUrl?: string;
  outcome?: string;
};
