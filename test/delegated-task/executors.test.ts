import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDelegatedExecutorRouter, type CandidateSnapshot } from '../../src/delegated-task/executors.js';
import type { DelegatedTask, DelegatedTaskAttempt } from '../../src/delegated-task/types.js';

function task(overrides: Partial<DelegatedTask> = {}): DelegatedTask {
  return {
    id: 'task-1', accountId: 'xhs-1', accountName: '小萝北', platform: 'xiaohongshu',
    action: 'comment_batch', actionFamily: 'comment', targetSuccessCount: 3, maxAttempts: 6,
    deadlineAt: Date.now() + 60_000, notBefore: Date.now(), executionWindow: { mode: 'immediate' },
    sourceConstraints: {}, targetConstraints: {}, approvalMode: 'review', priority: 'normal', source: 'api', sourceRef: null, originChatId: null,
    status: 'executing', progress: { successCount: 0, attemptCount: 1, skippedCount: 0, failureCount: 0 },
    currentStep: null, terminalOutcome: null, pauseRequested: false, cancelRequested: false, nextEligibleAt: null,
    claimToken: 'claim', claimExpiresAt: Date.now() + 60_000, dedupeKey: 'dedupe', version: 1,
    createdAt: Date.now(), updatedAt: Date.now(), confirmedAt: Date.now(), completedAt: null,
    ...overrides,
  };
}

const attempt: DelegatedTaskAttempt = {
  id: 'attempt-1', taskId: 'task-1', ordinal: 1, targetKey: 'target-1', status: 'dispatched',
  verificationKind: null, evidenceRef: null, reason: null, preparedAt: Date.now(), dispatchedAt: Date.now(), finishedAt: null,
};

function candidate(overrides: Partial<CandidateSnapshot> = {}): CandidateSnapshot {
  return {
    recordId: 42, accountId: 'xhs-1', platform: 'xiaohongshu', status: 'pending_approval',
    contentVersion: 3, title: '原题', content: '原文', images: ['one.jpg', 'two.jpg'], ...overrides,
  };
}

test('batch comments always use automatic quota semantics while legacy single comment retains manual compatibility', async () => {
  const calls: Array<{ priority: string; manualOverride: boolean; force: boolean }> = [];
  const router = createDelegatedExecutorRouter({
    comments: {
      triggerManual: async (_accountId, options) => {
        calls.push({ priority: options.priority, manualOverride: options.manualOverride, force: options.force });
        await options.onResult({ outcome: 'commented', noteId: 'note-1' });
        return { ok: true, message: 'started' };
      },
      triggerTargeted: async () => ({ ok: false, message: 'unused' }),
      isRunning: () => false,
    },
    publishes: { triggerDelegated: async () => ({ result: 'blocked', reason: 'unused' }), isBusy: () => false },
    loadCandidate: async () => null,
    approveCandidate: async () => null,
    rejectCandidate: async () => null,
    modifyCandidate: async () => null,
  });
  const batch = await router.executorFor(task()).execute(task(), attempt);
  assert.equal(batch.kind, 'success');
  assert.deepEqual(calls[0], { priority: 'automatic', manualOverride: false, force: false });

  const legacy = task({ source: 'legacy_command', targetSuccessCount: 1, targetConstraints: { manualSingle: true, force: true } });
  await router.executorFor(legacy).execute(legacy, attempt);
  assert.deepEqual(calls[1], { priority: 'human', manualOverride: true, force: true });
});

test('Facebook shadow observation is skipped and never counted as a verified comment', async () => {
  const router = createDelegatedExecutorRouter({
    comments: {
      triggerManual: async (_accountId, options) => {
        await options.onResult({ outcome: 'shadow_ok', reason: 'shadow_no_submit' });
        return { ok: true, message: 'shadow' };
      },
      triggerTargeted: async () => ({ ok: false, message: 'unused' }),
      isRunning: () => false,
    },
    publishes: { triggerDelegated: async () => ({ result: 'blocked', reason: 'unused' }), isBusy: () => false },
    loadCandidate: async () => null,
    approveCandidate: async () => null,
    rejectCandidate: async () => null,
    modifyCandidate: async () => null,
  });
  const fb = task({ platform: 'facebook', action: 'facebook_group_comment', actionFamily: 'comment', targetSuccessCount: 1 });
  assert.deepEqual(await router.executorFor(fb).execute(fb, attempt), { kind: 'skipped', reason: 'shadow_no_submit' });
});

// 复核 HIGH-2（change lease-strict-preemption 7.6）：委托执行器必须认下评论新增的两态，绝不落 failed/retryable 重入。
function routerWithCommentOutcome(outcome: string, reason?: string) {
  return createDelegatedExecutorRouter({
    comments: {
      triggerManual: async (_accountId, options) => {
        await options.onResult({ outcome, reason, noteId: 'note-1' } as never);
        return { ok: true, message: 'started' };
      },
      triggerTargeted: async () => ({ ok: false, message: 'unused' }),
      isRunning: () => false,
    },
    publishes: { triggerDelegated: async () => ({ result: 'blocked', reason: 'unused' }), isBusy: () => false },
    loadCandidate: async () => null,
    approveCandidate: async () => null,
    rejectCandidate: async () => null,
    modifyCandidate: async () => null,
  });
}

test('submitted_unconfirmed 评论 → submitted_unknown（绝不重试；防 worker 重入 → 重复评论，--force 更甚）', async () => {
  const router = routerWithCommentOutcome('submitted_unconfirmed', 'comment submitted but unconfirmed');
  const r = await router.executorFor(task()).execute(task(), attempt);
  assert.equal(r.kind, 'submitted_unknown', '提交已派发未确认 = 已提交未知，MUST NOT retryable(那会重复评论)');
});

test('preempted 评论 → deferred（未发出、退避重试，绝不立刻对着仍被占用的浏览器空转）', async () => {
  const router = routerWithCommentOutcome('preempted', 'preempted:preempted_by_task');
  const r = await router.executorFor(task()).execute(task(), attempt);
  assert.equal(r.kind, 'deferred', '被抢占＝未发出、可安全稍后重试');
});

test('candidate modification is CAS-bound and carries the requested retained-image subset', async () => {
  let writtenPatch: { title?: string; content?: string; images?: string[] } | null = null;
  const before = candidate();
  const router = createDelegatedExecutorRouter({
    comments: {
      triggerManual: async () => ({ ok: false, message: 'unused' }),
      triggerTargeted: async () => ({ ok: false, message: 'unused' }),
      isRunning: () => false,
    },
    publishes: { triggerDelegated: async () => ({ result: 'blocked', reason: 'unused' }), isBusy: () => false },
    loadCandidate: async () => before,
    approveCandidate: async () => null,
    rejectCandidate: async () => null,
    modifyCandidate: async (_draft, patch) => {
      writtenPatch = patch;
      return candidate({ contentVersion: 4, images: patch.images ?? before.images });
    },
  });
  const modify = task({
    action: 'modify_candidate', actionFamily: 'candidate_control', targetSuccessCount: 1, maxAttempts: 1,
    targetConstraints: { candidateId: '42', candidateVersion: 3, images: ['one.jpg'] },
  });
  const result = await router.executorFor(modify).execute(modify, attempt);
  assert.equal(result.kind, 'success');
  assert.deepEqual(writtenPatch, { images: ['one.jpg'] });

  const stale = task({ ...modify, targetConstraints: { ...modify.targetConstraints, candidateVersion: 2 } });
  assert.deepEqual(await router.executorFor(stale).execute(stale, attempt), {
    kind: 'failed', reason: 'candidate_version_conflict(current=3)', retryable: false,
  });
});

// change restore-delegated-command-card-origin-chat：命令来源会话 → 审批卡目标（manual_source）。
test('delegated publish threads originChatId to the publish port as manualApprovalChatId, and omits it when absent', async () => {
  const calls: Array<{ manualApprovalChatId?: string }> = [];
  const router = createDelegatedExecutorRouter({
    comments: {
      triggerManual: async () => ({ ok: true, message: 'unused' }),
      triggerTargeted: async () => ({ ok: false, message: 'unused' }),
      isRunning: () => false,
    },
    publishes: {
      triggerDelegated: async (_accountId, opts) => {
        calls.push({ manualApprovalChatId: opts.manualApprovalChatId });
        return { result: 'triggered', reason: 'delegated_publish_post', status: 'pending_approval', recordId: 7 };
      },
      isBusy: () => false,
    },
    loadCandidate: async () => null,
    approveCandidate: async () => null,
    rejectCandidate: async () => null,
    modifyCandidate: async () => null,
  });

  const withOrigin = task({ action: 'publish_post', actionFamily: 'publish', originChatId: 'oc_private_P' });
  const r1 = await router.executorFor(withOrigin).execute(withOrigin, attempt);
  assert.equal(r1.kind, 'waiting_approval');
  assert.equal(calls[0].manualApprovalChatId, 'oc_private_P');

  const noOrigin = task({ action: 'publish_post', actionFamily: 'publish', originChatId: null });
  await router.executorFor(noOrigin).execute(noOrigin, attempt);
  assert.equal(calls[1].manualApprovalChatId, undefined);
});

// change delegated-executor-operator-authority-parity：精确 /publish（legacy_command + manualSingle）＝操作员全权，
// 透传 operatorOverride:true 越风控（人审仍在下游）；自然语言 / 结构化发帖一律 governed（不置该标志）。
test('delegated publish sets operatorOverride only for the precise legacy_command class, not NL/structured', async () => {
  const calls: Array<{ operatorOverride?: boolean }> = [];
  const router = createDelegatedExecutorRouter({
    comments: {
      triggerManual: async () => ({ ok: true, message: 'unused' }),
      triggerTargeted: async () => ({ ok: false, message: 'unused' }),
      isRunning: () => false,
    },
    publishes: {
      triggerDelegated: async (_accountId, opts) => {
        calls.push({ operatorOverride: opts.operatorOverride });
        return { result: 'triggered', reason: 'delegated_publish_post', status: 'pending_approval', recordId: 9 };
      },
      isBusy: () => false,
    },
    loadCandidate: async () => null,
    approveCandidate: async () => null,
    rejectCandidate: async () => null,
    modifyCandidate: async () => null,
  });

  const precise = task({ action: 'publish_post', actionFamily: 'publish', source: 'legacy_command', targetSuccessCount: 1, targetConstraints: { manualSingle: true } });
  await router.executorFor(precise).execute(precise, attempt);
  assert.equal(calls[0].operatorOverride, true);

  const nl = task({ action: 'publish_post', actionFamily: 'publish', source: 'feishu' });
  await router.executorFor(nl).execute(nl, attempt);
  assert.equal(calls[1].operatorOverride, undefined);

  const structured = task({ action: 'publish_post', actionFamily: 'publish', source: 'edge' });
  await router.executorFor(structured).execute(structured, attempt);
  assert.equal(calls[2].operatorOverride, undefined);
});
