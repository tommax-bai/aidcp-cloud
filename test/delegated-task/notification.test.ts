import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DelegatedTaskNotificationGate } from '../../src/delegated-task/notification.js';
import { MemoryDelegatedTaskStore } from '../../src/delegated-task/store.js';

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
