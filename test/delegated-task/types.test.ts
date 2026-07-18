import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionFamilyFor,
  canTransitionTask,
  clampClientApprovalMode,
  honestTerminalStatus,
  validateDelegatedTaskIntent,
  verificationCountsAsSuccess,
} from '../../src/delegated-task/types.js';

// change delegated-approvalmode-clamp：客户端体不可信——绝不放行 auto_approve；缺省保 undefined 交 store 默认；
// draft_only 放行；其余（含 auto_approve / 未来新模式）夹成 review。
test('clampClientApprovalMode never lets a client body self-declare auto_approve', () => {
  assert.equal(clampClientApprovalMode('auto_approve'), 'review');
  assert.equal(clampClientApprovalMode('review'), 'review');
  assert.equal(clampClientApprovalMode('draft_only'), 'draft_only');
  assert.equal(clampClientApprovalMode(undefined), undefined);
  assert.equal(clampClientApprovalMode(null), undefined);
  assert.equal(clampClientApprovalMode('something_new'), 'review');
});

test('delegated task state machine keeps terminal states terminal and supports honest partial completion', () => {
  assert.equal(canTransitionTask('awaiting_confirmation', 'queued'), true);
  assert.equal(canTransitionTask('completed', 'queued'), false);
  assert.equal(honestTerminalStatus({ successCount: 3, attemptCount: 8, skippedCount: 3, failureCount: 2 }, 'max_attempts'), 'partially_completed');
  assert.equal(honestTerminalStatus({ successCount: 0, attemptCount: 8, skippedCount: 5, failureCount: 3 }, 'max_attempts'), 'failed');
});

test('verification evidence is action-specific', () => {
  assert.equal(verificationCountsAsSuccess('publish_post', 'candidate_persisted'), false);
  assert.equal(verificationCountsAsSuccess('generate_candidates', 'candidate_persisted'), true);
  assert.equal(verificationCountsAsSuccess('comment_batch', 'platform_comment_confirmed'), true);
  assert.equal(verificationCountsAsSuccess('approve_candidate', 'platform_publish_confirmed'), true);
  assert.equal(verificationCountsAsSuccess('approve_candidate', 'platform_schedule_confirmed'), true);
  assert.equal(verificationCountsAsSuccess('comment_batch', 'submitted_unknown'), false);
  assert.equal(actionFamilyFor('facebook_group_comment'), 'comment');
});

test('intent validation requires bounded attempts, future deadline and Feishu nickname', () => {
  const now = 1_700_000_000_000;
  const errors = validateDelegatedTaskIntent({
    action: 'comment_batch', targetSuccessCount: 5, maxAttempts: 4, deadlineAt: now - 1,
    source: 'feishu',
  }, now);
  assert.deepEqual(errors, ['invalid_max_attempts', 'invalid_deadline', 'feishu_account_name_required']);
});
