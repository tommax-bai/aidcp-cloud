import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DelegatedTaskNotificationGate, delegatedTaskFailureReceipt } from '../../src/delegated-task/notification.js';
import { MemoryDelegatedTaskStore } from '../../src/delegated-task/store.js';
import type { DelegatedTask } from '../../src/delegated-task/types.js';

async function makeTask(action: DelegatedTask['action'], overrides: Partial<DelegatedTask>): Promise<DelegatedTask> {
  const store = new MemoryDelegatedTaskStore();
  const { task } = await store.createDraft({
    accountId: 'xhs-1', accountName: '工程师大白', platform: 'xiaohongshu',
    action, targetSuccessCount: overrides.targetSuccessCount ?? 1, maxAttempts: 2,
    deadlineAt: Date.now() + 60_000, notBefore: Date.now(), source: 'feishu', dedupeKey: 'receipt-test',
  });
  return { ...task, ...overrides };
}

test('notification gate ignores internal version and timestamp churn but keeps semantic changes', async () => {
  const store = new MemoryDelegatedTaskStore();
  const created = await store.createDraft({
    accountId: 'xhs-1',
    accountName: '工程师大白',
    platform: 'xiaohongshu',
    action: 'publish_post',
    targetSuccessCount: 1,
    maxAttempts: 2,
    deadlineAt: Date.now() + 60_000,
    notBefore: Date.now(),
    source: 'feishu',
    dedupeKey: 'notification-gate',
  });
  const task = created.task;
  const gate = new DelegatedTaskNotificationGate();

  assert.equal(gate.shouldSend(task), true);
  gate.markSent(task);
  assert.equal(gate.shouldSend(task), false);
  assert.equal(gate.shouldSend({ ...task, version: task.version + 100, updatedAt: task.updatedAt + 30_000 }), false);

  const progressed = { ...task, status: 'waiting_approval' as const, currentStep: 'waiting_approval' };
  assert.equal(gate.shouldSend(progressed), true);
  gate.markSent(progressed);
  assert.equal(gate.shouldSend({ ...progressed, currentStep: 'reconcile_waiting_approval', version: progressed.version + 1 }), false);
  assert.equal(gate.shouldSend({ ...progressed, pauseRequested: true }), true);
  assert.equal(gate.shouldSend({
    ...progressed,
    status: 'completed' as const,
    progress: { ...progressed.progress, successCount: 1 },
    terminalOutcome: { code: 'target_reached', message: '已验证完成 1/1。' },
  }), true);
});

test('delegatedTaskFailureReceipt: 发帖失败(0 成功) → 红色结果卡(绝不静默失败)', async () => {
  const task = await makeTask('publish_post', {
    status: 'failed',
    progress: { successCount: 0, attemptCount: 2, skippedCount: 0, failureCount: 1 },
    terminalOutcome: { code: 'max_attempts', message: '已达到最大尝试次数；真实完成 0/1。' },
  });
  const r = delegatedTaskFailureReceipt(task);
  assert.ok(r);
  assert.equal(r?.level, 'error');
  assert.match(r!.message, /已达到最大尝试次数/);
});

test('delegatedTaskFailureReceipt: 发帖有缺口的部分完成 → 黄色部分完成卡', async () => {
  const task = await makeTask('publish_post', {
    targetSuccessCount: 3,
    status: 'partially_completed',
    progress: { successCount: 2, attemptCount: 3, skippedCount: 0, failureCount: 1 },
  });
  const r = delegatedTaskFailureReceipt(task);
  assert.equal(r?.level, 'warning');
  assert.match(r!.title, /部分完成/);
});

test('delegatedTaskFailureReceipt: 发帖成功 → null(成功不重复报绿，由人审卡自证)', async () => {
  const task = await makeTask('publish_post', {
    status: 'completed',
    progress: { successCount: 1, attemptCount: 1, skippedCount: 0, failureCount: 0 },
  });
  assert.equal(delegatedTaskFailureReceipt(task), null);
});

test('delegatedTaskFailureReceipt: 发帖等待人审 → null(人审卡本身承担通知)', async () => {
  const task = await makeTask('publish_post', { status: 'waiting_approval' });
  assert.equal(delegatedTaskFailureReceipt(task), null);
});

test('delegatedTaskFailureReceipt: 用户取消发帖 → null(预期操作不报警)', async () => {
  const task = await makeTask('publish_post', {
    status: 'cancelled',
    progress: { successCount: 0, attemptCount: 1, skippedCount: 1, failureCount: 0 },
    terminalOutcome: { code: 'candidate_cancelled_by_user', message: '用户已取消发布，候选稿已留档，未向平台下发。' },
  });
  assert.equal(delegatedTaskFailureReceipt(task), null);
});

test('delegatedTaskFailureReceipt: 已有成功后用户取消剩余发帖 → null(不误报部分完成)', async () => {
  const task = await makeTask('publish_post', {
    targetSuccessCount: 2,
    status: 'partially_completed',
    progress: { successCount: 1, attemptCount: 2, skippedCount: 1, failureCount: 0 },
    terminalOutcome: { code: 'candidate_cancelled_by_user', message: '用户已取消发布，保留真实完成 1/2。' },
  });
  assert.equal(delegatedTaskFailureReceipt(task), null);
});

test('delegatedTaskFailureReceipt: 评论起跑后失败(max_attempts) → null(评论链自己已发 postResultCard，不双发)', async () => {
  const task = await makeTask('comment_batch', {
    status: 'failed',
    progress: { successCount: 0, attemptCount: 2, skippedCount: 1, failureCount: 1 },
    terminalOutcome: { code: 'max_attempts', message: '已达到最大尝试次数；真实完成 0/1。' },
  });
  assert.equal(delegatedTaskFailureReceipt(task), null);
});

test('delegatedTaskFailureReceipt: 评论起跑前触发闸失败(non_retryable_failure) → 红卡(评论链从未发卡，绝不静默失败)', async () => {
  const task = await makeTask('comment_batch', {
    status: 'failed',
    progress: { successCount: 0, attemptCount: 1, skippedCount: 0, failureCount: 1 },
    terminalOutcome: { code: 'non_retryable_failure', message: '该账号未绑定人设，未执行评论。' },
  });
  const r = delegatedTaskFailureReceipt(task);
  assert.ok(r);
  assert.equal(r?.level, 'error');
  assert.match(r!.title, /评论任务未触发/);
  assert.match(r!.message, /未绑定人设/);
});
