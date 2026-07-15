import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDelegatedTaskStore } from '../../src/delegated-task/store.js';
import { DelegatedTaskWorker, type DelegatedExecutionResult, type DelegatedTaskExecutor } from '../../src/delegated-task/worker.js';
import type { DelegatedTask, DelegatedTaskAttempt } from '../../src/delegated-task/types.js';

async function confirmedTask(store: MemoryDelegatedTaskStore, now: number, overrides: Partial<Parameters<MemoryDelegatedTaskStore['createDraft']>[0]> = {}) {
  const created = await store.createDraft({
    accountId: 'xhs-1', accountName: '小萝北', platform: 'xiaohongshu', action: 'comment_batch',
    targetSuccessCount: 5, maxAttempts: 5, deadlineAt: now + 60_000, notBefore: now, source: 'api', dedupeKey: `key-${Math.random()}`,
    ...overrides,
  });
  return (await store.confirm(created.task.id, created.task.version))!;
}

test('worker reports honest 3/5 partial completion after five attempts', async () => {
  const store = new MemoryDelegatedTaskStore();
  let now = 1_000_000;
  const task = await confirmedTask(store, now);
  const outcomes: DelegatedExecutionResult[] = [
    { kind: 'success', verificationKind: 'platform_comment_confirmed', evidenceRef: 'c1' },
    { kind: 'success', verificationKind: 'platform_comment_confirmed', evidenceRef: 'c2' },
    { kind: 'success', verificationKind: 'platform_comment_confirmed', evidenceRef: 'c3' },
    { kind: 'skipped', reason: 'no_candidate' },
    { kind: 'failed', reason: 'platform_not_confirmed' },
  ];
  let n = 0;
  const executor: DelegatedTaskExecutor = {
    targetKey: () => `target-${n}`,
    execute: async () => outcomes[n++]!,
  };
  const worker = new DelegatedTaskWorker({ store, executorFor: () => executor, now: () => now, retryDelayMs: 1_000, claimLeaseMs: 10_000 });
  for (let i = 0; i < 5; i++) { await worker.tick(); now += 2_000; }
  const done = await store.get(task.id);
  assert.equal(done?.status, 'partially_completed');
  assert.deepEqual(done?.progress, { successCount: 3, attemptCount: 5, skippedCount: 1, failureCount: 1 });
});

test('pause request made during an action takes effect only after that action settles', async () => {
  const store = new MemoryDelegatedTaskStore();
  let now = 2_000_000;
  const task = await confirmedTask(store, now, { targetSuccessCount: 2, maxAttempts: 3 });
  const executor: DelegatedTaskExecutor = {
    targetKey: () => 'target-1',
    execute: async (running) => {
      const requested = await store.requestPause(running.id);
      assert.equal(requested?.status, 'executing');
      return { kind: 'success', verificationKind: 'platform_comment_confirmed', evidenceRef: 'c1' };
    },
  };
  const worker = new DelegatedTaskWorker({ store, executorFor: () => executor, now: () => now, claimLeaseMs: 10_000 });
  await worker.tick();
  now += 1;
  const paused = await store.get(task.id);
  assert.equal(paused?.status, 'deferred');
  assert.equal(paused?.pauseRequested, true);
  assert.equal(paused?.progress.successCount, 1);
});

test('candidate persisted does not count as publish success while waiting approval', async () => {
  const store = new MemoryDelegatedTaskStore();
  const now = 3_000_000;
  const task = await confirmedTask(store, now, { action: 'publish_post', targetSuccessCount: 1, maxAttempts: 1 });
  const executor: DelegatedTaskExecutor = {
    targetKey: () => 'draft-1',
    execute: async () => ({ kind: 'waiting_approval', evidenceRef: 'draft-1' }),
  };
  const worker = new DelegatedTaskWorker({ store, executorFor: () => executor, now: () => now, claimLeaseMs: 10_000 });
  await worker.tick();
  const waiting = await store.get(task.id);
  assert.equal(waiting?.status, 'waiting_approval');
  assert.equal(waiting?.progress.successCount, 0);
  assert.equal(waiting?.progress.attemptCount, 1);
});

test('reconciles dispatched attempt before any retry', async () => {
  const store = new MemoryDelegatedTaskStore();
  let now = 4_000_000;
  const task = await confirmedTask(store, now, { targetSuccessCount: 1, maxAttempts: 2 });
  const claimed = (await store.claimNext({ workerId: 'crashed', leaseMs: 10_000, now }))!;
  const attempt = await store.startAttempt(task.id, claimed.claimToken!, 'note-1');
  await store.markAttemptDispatched(attempt.id);
  await store.releaseClaim(task.id, claimed.claimToken!, 'queued');
  let executed = 0;
  const executor: DelegatedTaskExecutor = {
    targetKey: () => 'note-2',
    execute: async () => { executed++; return { kind: 'failed', reason: 'must_not_run' }; },
    reconcileAttempt: async (_task: DelegatedTask, _attempt: DelegatedTaskAttempt) => ({
      kind: 'success', verificationKind: 'platform_comment_confirmed', evidenceRef: 'dedup:note-1',
    }),
  };
  const worker = new DelegatedTaskWorker({ store, executorFor: () => executor, now: () => now, claimLeaseMs: 10_000 });
  await worker.tick();
  now += 1;
  const done = await store.get(task.id);
  assert.equal(done?.status, 'completed');
  assert.equal(done?.progress.successCount, 1);
  assert.equal(executed, 0);
});
