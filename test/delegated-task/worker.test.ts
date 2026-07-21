import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDelegatedTaskStore } from '../../src/delegated-task/store.js';
import { DelegatedTaskWorker, type DelegatedExecutionResult, type DelegatedTaskExecutor } from '../../src/delegated-task/worker.js';
import type { DelegatedTask, DelegatedTaskAttempt } from '../../src/delegated-task/types.js';

function deferredExecution(): {
  promise: Promise<DelegatedExecutionResult>;
  resolve: (result: DelegatedExecutionResult) => void;
} {
  let resolve!: (result: DelegatedExecutionResult) => void;
  const promise = new Promise<DelegatedExecutionResult>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('condition_not_reached');
}

async function confirmedTask(store: MemoryDelegatedTaskStore, now: number, overrides: Partial<Parameters<MemoryDelegatedTaskStore['createDraft']>[0]> = {}) {
  const created = await store.createDraft({
    accountId: 'xhs-1', accountName: '小萝北', platform: 'xiaohongshu', action: 'comment_batch',
    targetSuccessCount: 5, maxAttempts: 5, deadlineAt: now + 60_000, notBefore: now, source: 'api', dedupeKey: `key-${Math.random()}`,
    ...overrides,
  });
  return (await store.confirm(created.task.id, created.task.version))!;
}

test('worker runs three different rewrite sources concurrently and keeps the fourth queued at the configured cap', async () => {
  const store = new MemoryDelegatedTaskStore();
  const now = 15_000_000;
  const tasks = await Promise.all(['source-1', 'source-2', 'source-3', 'source-4'].map((sourceId) =>
    confirmedTask(store, now, {
      action: 'publish_post', targetSuccessCount: 1, maxAttempts: 1,
      sourceConstraints: { sourceId }, dedupeKey: `rewrite-${sourceId}`,
    })));
  const gates = new Map(tasks.map((task) => [task.id, deferredExecution()]));
  const started: string[] = [];
  const executor: DelegatedTaskExecutor = {
    targetKey: (task) => `draft:${task.id}`,
    execute: async (task) => {
      started.push(task.id);
      return gates.get(task.id)!.promise;
    },
  };
  const worker = new DelegatedTaskWorker({
    store, executorFor: () => executor, now: () => now, claimLeaseMs: 10_000, maxConcurrent: 3,
  });

  const running = [worker.tick(), worker.tick(), worker.tick()];
  await waitFor(() => started.length === 3);
  assert.equal(await worker.tick(), null);
  assert.equal((await store.get(tasks[3]!.id))?.status, 'queued');

  for (const taskId of started) {
    gates.get(taskId)!.resolve({ kind: 'waiting_approval', evidenceRef: `draft:${taskId}` });
  }
  await Promise.all(running);
  assert.deepEqual((await Promise.all(tasks.slice(0, 3).map((task) => store.get(task.id)))).map((task) => task?.status), [
    'waiting_approval', 'waiting_approval', 'waiting_approval',
  ]);
});

test('worker defers a second rewrite for the same account and source while the first is executing', async () => {
  const store = new MemoryDelegatedTaskStore();
  const now = 16_000_000;
  const first = await confirmedTask(store, now, {
    action: 'publish_post', targetSuccessCount: 1, maxAttempts: 1,
    sourceConstraints: { sourceId: 'same-source' }, dedupeKey: 'same-source-1',
  });
  const second = await confirmedTask(store, now, {
    action: 'publish_post', targetSuccessCount: 1, maxAttempts: 1,
    sourceConstraints: { sourceId: 'same-source' }, dedupeKey: 'same-source-2',
  });
  const gate = deferredExecution();
  const started: string[] = [];
  const executor: DelegatedTaskExecutor = {
    targetKey: (task) => `draft:${task.id}`,
    execute: async (task) => {
      started.push(task.id);
      return gate.promise;
    },
  };
  const worker = new DelegatedTaskWorker({
    store, executorFor: () => executor, now: () => now, retryDelayMs: 1_000,
    claimLeaseMs: 10_000, maxConcurrent: 3,
  });

  const firstRun = worker.tick();
  await waitFor(() => started.length === 1);
  const deferred = await worker.tick();
  assert.equal(deferred?.id, second.id);
  assert.equal(deferred?.status, 'deferred');
  assert.deepEqual(started, [first.id]);

  gate.resolve({ kind: 'waiting_approval', evidenceRef: `draft:${first.id}` });
  await firstRun;
});

test('startup recovery clears interrupted claims and preserves pause/cancel intent', async () => {
  const store = new MemoryDelegatedTaskStore();
  const now = 16_500_000;

  const ordinary = await confirmedTask(store, now, { dedupeKey: 'recover-ordinary' });
  const ordinaryClaim = (await store.claimNext({ workerId: 'old-worker', leaseMs: 10_000, now }))!;
  assert.equal(ordinaryClaim.id, ordinary.id);

  const paused = await confirmedTask(store, now, { dedupeKey: 'recover-paused' });
  const pausedClaim = (await store.claimNext({ workerId: 'old-worker', leaseMs: 10_000, now }))!;
  await store.markExecuting(paused.id, pausedClaim.claimToken!, 'executing:comment_batch');
  await store.requestPause(paused.id);

  const cancelled = await confirmedTask(store, now, { dedupeKey: 'recover-cancelled' });
  const cancelledClaim = (await store.claimNext({ workerId: 'old-worker', leaseMs: 10_000, now }))!;
  await store.markExecuting(cancelled.id, cancelledClaim.claimToken!, 'executing:comment_batch');
  await store.requestCancel(cancelled.id);

  const untouched = await confirmedTask(store, now, { dedupeKey: 'recover-untouched' });
  const untouchedBefore = await store.get(untouched.id);
  const recovered = await store.recoverInterruptedClaims(now + 1_000);

  assert.deepEqual(recovered.map((item) => item.task.id), [ordinary.id, paused.id, cancelled.id]);
  assert.equal((await store.get(ordinary.id))?.status, 'queued');
  assert.equal((await store.get(ordinary.id))?.claimToken, null);
  assert.equal((await store.get(paused.id))?.status, 'deferred');
  assert.equal((await store.get(paused.id))?.currentStep, 'paused_by_user');
  assert.equal((await store.get(cancelled.id))?.status, 'cancelled');
  assert.equal((await store.get(cancelled.id))?.terminalOutcome?.code, 'remaining_cancelled_by_user');
  assert.equal((await store.get(untouched.id))?.version, untouchedBefore?.version, 'queued task must not be rewritten');
  assert.equal(store.interruptedClaimEvents.length, 3);
  assert.deepEqual(store.interruptedClaimEvents.map((event) => event.fromStatus), ['planning', 'executing', 'executing']);
});

test('startup recovery discards a prepared attempt as proven not dispatched and returns its budget', async () => {
  const store = new MemoryDelegatedTaskStore();
  const now = 16_600_000;
  const task = await confirmedTask(store, now, {
    action: 'publish_post', targetSuccessCount: 1, maxAttempts: 1,
    sourceConstraints: { sourceId: 'prepared-source' }, dedupeKey: 'recover-prepared',
  });
  const claimed = (await store.claimNext({ workerId: 'old-worker', leaseMs: 10_000, now }))!;
  await store.startAttempt(task.id, claimed.claimToken!, 'draft:prepared');

  let executions = 0;
  const worker = new DelegatedTaskWorker({
    store,
    executorFor: () => ({
      targetKey: () => 'draft:fresh',
      execute: async () => {
        executions += 1;
        return { kind: 'waiting_approval', evidenceRef: 'publish:101' };
      },
      reconcileAttempt: async () => ({ kind: 'failed', reason: 'must_not_reconcile_prepared' }),
    }),
    now: () => now + 1_000,
    claimLeaseMs: 10_000,
  });

  await worker.recoverInterruptedClaims();
  const requeued = await worker.tick();
  assert.equal(requeued?.status, 'queued');
  assert.equal(requeued?.currentStep, 'recovered_before_dispatch');
  assert.equal(requeued?.progress.attemptCount, 0);
  assert.equal((await store.listAttempts(task.id)).length, 0);
  assert.equal(executions, 0);

  const completed = await worker.tick();
  assert.equal(completed?.status, 'waiting_approval');
  assert.equal(executions, 1);
});

test('startup recovery reconciles dispatched work as unknown, then releases a same-source rewrite', async () => {
  const store = new MemoryDelegatedTaskStore();
  const now = 16_700_000;
  const oldTask = await confirmedTask(store, now, {
    action: 'publish_post', targetSuccessCount: 1, maxAttempts: 1,
    sourceConstraints: { sourceId: 'restart-source' }, dedupeKey: 'recover-dispatched-old',
  });
  const oldClaim = (await store.claimNext({ workerId: 'old-worker', leaseMs: 10_000, now }))!;
  const oldAttempt = await store.startAttempt(oldTask.id, oldClaim.claimToken!, 'draft:old');
  await store.markAttemptDispatched(oldAttempt.id);
  await store.markExecuting(oldTask.id, oldClaim.claimToken!, 'executing:publish_post');

  const newTask = await confirmedTask(store, now + 1, {
    action: 'publish_post', targetSuccessCount: 1, maxAttempts: 1,
    sourceConstraints: { sourceId: 'restart-source' }, dedupeKey: 'recover-dispatched-new',
  });
  const executed: string[] = [];
  const worker = new DelegatedTaskWorker({
    store,
    executorFor: () => ({
      targetKey: (task) => `draft:${task.id}`,
      execute: async (task) => {
        executed.push(task.id);
        return { kind: 'waiting_approval', evidenceRef: `draft:${task.id}` };
      },
      reconcileAttempt: async (_task, attempt) => ({
        kind: 'submitted_unknown',
        reason: `派发账本 ${attempt.id} 在进程重启前未收敛；停止盲重试。`,
      }),
    }),
    now: () => now + 1_000,
    claimLeaseMs: 10_000,
  });

  await worker.recoverInterruptedClaims();
  const oldDone = await worker.tick();
  assert.equal(oldDone?.status, 'failed');
  assert.equal(oldDone?.terminalOutcome?.code, 'submitted_result_unknown');
  assert.equal((await store.listAttempts(oldTask.id))[0]?.status, 'submitted_unknown');
  assert.deepEqual(executed, []);

  const newDone = await worker.tick();
  assert.equal(newDone?.id, newTask.id);
  assert.equal(newDone?.status, 'waiting_approval');
  assert.deepEqual(executed, [newTask.id]);
});

test('startup recovery releases an interrupted task that expired while the process was down', async () => {
  const store = new MemoryDelegatedTaskStore();
  const now = 16_800_000;
  const task = await confirmedTask(store, now, {
    targetSuccessCount: 1,
    maxAttempts: 1,
    deadlineAt: now + 500,
    dedupeKey: 'recover-expired',
  });
  await store.claimNext({ workerId: 'old-worker', leaseMs: 10_000, now });
  let executions = 0;
  const worker = new DelegatedTaskWorker({
    store,
    executorFor: () => ({
      targetKey: () => 'must-not-run',
      execute: async () => {
        executions += 1;
        return { kind: 'failed', reason: 'must_not_run' };
      },
    }),
    now: () => now + 1_000,
    claimLeaseMs: 10_000,
  });

  await worker.recoverInterruptedClaims();
  await worker.tick();
  const done = await store.get(task.id);
  assert.equal(done?.status, 'failed');
  assert.equal(done?.terminalOutcome?.code, 'deadline');
  assert.equal(done?.claimToken, null);
  assert.equal(executions, 0);
});

test('interrupted-claim recovery is one-shot and cannot be invoked after the worker starts', async () => {
  const store = new MemoryDelegatedTaskStore();
  const worker = new DelegatedTaskWorker({
    store,
    executorFor: () => null,
    now: () => 16_900_000,
  });
  assert.deepEqual(await worker.recoverInterruptedClaims(), []);
  await worker.start(60_000);
  await assert.rejects(worker.recoverInterruptedClaims(), /interrupted_claim_recovery_after_worker_start/);
  worker.stop();
});

test('waiting approval rewrite does not block another task for the same source', async () => {
  const store = new MemoryDelegatedTaskStore();
  let now = 17_000_000;
  const first = await confirmedTask(store, now, {
    action: 'publish_post', targetSuccessCount: 1, maxAttempts: 1,
    sourceConstraints: { sourceId: 'reusable-source' }, dedupeKey: 'waiting-source-1',
  });
  const second = await confirmedTask(store, now, {
    action: 'publish_post', targetSuccessCount: 1, maxAttempts: 1,
    sourceConstraints: { sourceId: 'reusable-source' }, dedupeKey: 'waiting-source-2',
  });
  const executed: string[] = [];
  const executor: DelegatedTaskExecutor = {
    targetKey: (task) => `draft:${task.id}`,
    execute: async (task) => {
      executed.push(task.id);
      return { kind: 'waiting_approval', evidenceRef: `draft:${task.id}` };
    },
    reconcileWaitingApproval: async (task) => ({ kind: 'waiting_approval', evidenceRef: `draft:${task.id}` }),
  };
  const worker = new DelegatedTaskWorker({
    store, executorFor: () => executor, now: () => now, retryDelayMs: 1_000,
    claimLeaseMs: 10_000, maxConcurrent: 3,
  });

  await worker.tick();
  assert.equal((await store.get(first.id))?.status, 'waiting_approval');
  now += 2_000;
  await worker.tick();
  await worker.tick();
  assert.deepEqual(executed, [first.id, second.id]);
  assert.equal((await store.get(second.id))?.status, 'waiting_approval');
});

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
  let now = 3_000_000;
  const task = await confirmedTask(store, now, { action: 'publish_post', targetSuccessCount: 1, maxAttempts: 1 });
  const updates: DelegatedTask[] = [];
  const executor: DelegatedTaskExecutor = {
    targetKey: () => 'draft-1',
    execute: async () => ({ kind: 'waiting_approval', evidenceRef: 'draft-1' }),
  };
  const worker = new DelegatedTaskWorker({
    store,
    executorFor: () => executor,
    now: () => now,
    retryDelayMs: 1_000,
    claimLeaseMs: 10_000,
    onTaskUpdated: (updated) => { updates.push(updated); },
  });
  await worker.tick();
  const waiting = await store.get(task.id);
  assert.equal(waiting?.status, 'waiting_approval');
  assert.equal(waiting?.progress.successCount, 0);
  assert.equal(waiting?.progress.attemptCount, 1);
  assert.equal(updates.length, 1);

  const waitingVersion = waiting!.version;
  now += 2_000;
  await worker.tick();
  const stillWaiting = await store.get(task.id);
  assert.equal(stillWaiting?.status, 'waiting_approval');
  assert.equal(stillWaiting?.version, waitingVersion);
  assert.equal(stillWaiting?.progress.attemptCount, 1);
  assert.equal(updates.length, 1);
});

test('waiting approval claim keeps version stable and recovers after lease expiry', async () => {
  const store = new MemoryDelegatedTaskStore();
  let now = 3_100_000;
  const task = await confirmedTask(store, now, { action: 'publish_post', targetSuccessCount: 1, maxAttempts: 1 });
  const executor: DelegatedTaskExecutor = {
    targetKey: () => 'draft-lease',
    execute: async () => ({ kind: 'waiting_approval', evidenceRef: 'draft-lease' }),
  };
  const worker = new DelegatedTaskWorker({ store, executorFor: () => executor, now: () => now, retryDelayMs: 1_000, claimLeaseMs: 10_000 });
  await worker.tick();
  const waiting = (await store.get(task.id))!;
  now += 2_000;

  const firstClaim = (await store.claimNext({ workerId: 'worker-a', leaseMs: 10_000, now }))!;
  assert.equal(firstClaim.status, 'waiting_approval');
  assert.equal(firstClaim.version, waiting.version);
  assert.equal(await store.claimNext({ workerId: 'worker-b', leaseMs: 10_000, now: now + 1 }), null);

  now += 10_001;
  const recovered = (await store.claimNext({ workerId: 'worker-b', leaseMs: 10_000, now }))!;
  assert.equal(recovered.status, 'waiting_approval');
  assert.equal(recovered.version, waiting.version);
  const released = await store.releaseWaitingApprovalClaim(recovered.id, recovered.claimToken!, now + 1_000);
  assert.equal(released?.version, waiting.version);
  assert.equal(released?.claimToken, null);
});

test('approval result change leaves silent wait and emits completed update', async () => {
  const store = new MemoryDelegatedTaskStore();
  let now = 3_200_000;
  const task = await confirmedTask(store, now, { action: 'publish_post', targetSuccessCount: 1, maxAttempts: 1 });
  const updates: DelegatedTask[] = [];
  const executor: DelegatedTaskExecutor = {
    targetKey: () => 'draft-approved',
    execute: async () => ({ kind: 'waiting_approval', evidenceRef: 'draft-approved' }),
    reconcileWaitingApproval: async () => ({ kind: 'success', verificationKind: 'platform_publish_confirmed', evidenceRef: 'post-1' }),
  };
  const worker = new DelegatedTaskWorker({
    store,
    executorFor: () => executor,
    now: () => now,
    retryDelayMs: 1_000,
    claimLeaseMs: 10_000,
    onTaskUpdated: (updated) => { updates.push(updated); },
  });
  await worker.tick();
  now += 2_000;
  await worker.tick();
  const completed = await store.get(task.id);
  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.progress.successCount, 1);
  assert.deepEqual(updates.map((updated) => updated.status), ['waiting_approval', 'completed']);
});

test('silent waiting release cannot overwrite a concurrent cancellation', async () => {
  const store = new MemoryDelegatedTaskStore();
  let now = 3_300_000;
  const task = await confirmedTask(store, now, { action: 'publish_post', targetSuccessCount: 1, maxAttempts: 1 });
  const executor: DelegatedTaskExecutor = {
    targetKey: () => 'draft-cancelled',
    execute: async () => ({ kind: 'waiting_approval', evidenceRef: 'draft-cancelled' }),
    reconcileWaitingApproval: async (waiting) => {
      await store.requestCancel(waiting.id);
      return { kind: 'waiting_approval', evidenceRef: 'draft-cancelled' };
    },
  };
  const worker = new DelegatedTaskWorker({ store, executorFor: () => executor, now: () => now, retryDelayMs: 1_000, claimLeaseMs: 10_000 });
  await worker.tick();
  now += 2_000;
  await worker.tick();
  const cancelled = await store.get(task.id);
  assert.equal(cancelled?.status, 'cancelled');
  assert.equal(cancelled?.progress.attemptCount, 1);
});

test('explicit candidate rejection settles a zero-success publish task as cancelled without failure count', async () => {
  const store = new MemoryDelegatedTaskStore();
  let now = 3_400_000;
  const task = await confirmedTask(store, now, {
    action: 'publish_post', targetSuccessCount: 1, maxAttempts: 1, dedupeKey: 'candidate-user-rejected',
  });
  const executor: DelegatedTaskExecutor = {
    targetKey: () => 'publish:42',
    execute: async () => ({ kind: 'waiting_approval', evidenceRef: 'publish:42' }),
    reconcileWaitingApproval: async () => ({
      kind: 'cancelled', reason: '用户已取消发布，候选稿已留档，未向平台下发。', evidenceRef: 'publish:42',
    }),
  };
  const worker = new DelegatedTaskWorker({ store, executorFor: () => executor, now: () => now, retryDelayMs: 1_000, claimLeaseMs: 10_000 });

  await worker.tick();
  now += 2_000;
  await worker.tick();

  const cancelled = await store.get(task.id);
  assert.equal(cancelled?.status, 'cancelled');
  assert.deepEqual(cancelled?.progress, { successCount: 0, attemptCount: 1, skippedCount: 1, failureCount: 0 });
  assert.equal(cancelled?.terminalOutcome?.code, 'candidate_cancelled_by_user');
  assert.equal(cancelled?.terminalOutcome?.evidenceRef, 'publish:42');
  const [attempt] = await store.listAttempts(task.id);
  assert.equal(attempt.status, 'skipped');
  assert.equal(attempt.verificationKind, 'not_dispatched');
});

test('explicit candidate rejection preserves earlier success and settles the remaining target without an artificial failure', async () => {
  const store = new MemoryDelegatedTaskStore();
  let now = 3_500_000;
  const task = await confirmedTask(store, now, {
    action: 'publish_post', targetSuccessCount: 2, maxAttempts: 2, dedupeKey: 'candidate-user-rejected-after-success',
  });
  let executions = 0;
  const executor: DelegatedTaskExecutor = {
    targetKey: () => `publish:${executions + 1}`,
    execute: async () => {
      executions += 1;
      return executions === 1
        ? { kind: 'success', verificationKind: 'platform_publish_confirmed', evidenceRef: 'publish:41' }
        : { kind: 'waiting_approval', evidenceRef: 'publish:42' };
    },
    reconcileWaitingApproval: async () => ({
      kind: 'cancelled', reason: '用户已取消发布，候选稿已留档，未向平台下发。', evidenceRef: 'publish:42',
    }),
  };
  const worker = new DelegatedTaskWorker({ store, executorFor: () => executor, now: () => now, retryDelayMs: 1_000, claimLeaseMs: 10_000 });

  await worker.tick();
  now += 2_000;
  await worker.tick();
  now += 2_000;
  await worker.tick();

  const partial = await store.get(task.id);
  assert.equal(partial?.status, 'partially_completed');
  assert.deepEqual(partial?.progress, { successCount: 1, attemptCount: 2, skippedCount: 1, failureCount: 0 });
  assert.equal(partial?.terminalOutcome?.code, 'candidate_cancelled_by_user');
  assert.equal(partial?.terminalOutcome?.remainingCount, 1);
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

// ---- change delegated-terminal-failure-reason：预算终态必须说清「为什么没成」，不只是「为什么停」 ----

test('预算耗尽终态带上最后一次失败原因（而非只有记账）', async () => {
  const store = new MemoryDelegatedTaskStore();
  let now = 5_000_000;
  const task = await confirmedTask(store, now, { action: 'publish_post', targetSuccessCount: 1, maxAttempts: 2 });
  let n = 0;
  const executor: DelegatedTaskExecutor = {
    targetKey: () => `t-${n}`,
    execute: async () => ({ kind: 'failed', reason: 'Pipeline aborted by content_writer: llm_error', retryable: true }),
  };
  const worker = new DelegatedTaskWorker({ store, executorFor: () => executor, now: () => now, claimLeaseMs: 10_000 });
  for (let i = 0; i < 3; i++) { n++; await worker.tick(); now += 2_000; }
  const done = await store.get(task.id);
  assert.equal(done?.status, 'failed');
  assert.equal(done?.terminalOutcome?.code, 'max_attempts');
  // 既有前缀原样保留（追加而非替换）
  assert.match(done!.terminalOutcome!.message, /已达到最大尝试次数；真实完成 0\/1。/);
  assert.match(done!.terminalOutcome!.message, /最后一次未成原因：/);
  assert.match(done!.terminalOutcome!.message, /Pipeline aborted by content_writer: llm_error/);
});

test('明确未起跑的资源等待可反复排队且零尝试，资源释放后仍能执行', async () => {
  const store = new MemoryDelegatedTaskStore();
  let now = 5_500_000;
  const task = await confirmedTask(store, now, {
    action: 'comment_batch', targetSuccessCount: 1, maxAttempts: 1, deadlineAt: now + 300_000,
  });
  let waits = 3;
  const executor: DelegatedTaskExecutor = {
    // provisional attempt 被原子移除，所以同一目标可以在资源释放后安全重试。
    targetKey: () => 'browser-lease:xhs-1',
    execute: async () => waits-- > 0
      ? { kind: 'deferred', reason: 'edge_task_lease_timeout', retryAt: now + 1_000, attemptStarted: false }
      : { kind: 'success', verificationKind: 'platform_comment_confirmed', evidenceRef: 'comment:note-1' },
  };
  const worker = new DelegatedTaskWorker({ store, executorFor: () => executor, now: () => now, claimLeaseMs: 10_000 });

  for (let i = 0; i < 3; i++) {
    await worker.tick();
    const queued = await store.get(task.id);
    assert.equal(queued?.status, 'deferred');
    assert.deepEqual(queued?.progress, { successCount: 0, attemptCount: 0, skippedCount: 0, failureCount: 0 });
    assert.deepEqual(await store.listAttempts(task.id), []);
    now += 2_000;
  }

  await worker.tick();
  const done = await store.get(task.id);
  assert.equal(done?.status, 'completed');
  assert.deepEqual(done?.progress, { successCount: 1, attemptCount: 1, skippedCount: 0, failureCount: 0 });
  assert.equal((await store.listAttempts(task.id)).length, 1);
});

// 红线：未携带 attemptStarted:false 的一般让开（deferred → settle 成 skipped）仍烧尝试预算；
// worker 不能自行猜测执行器是否真的完全没碰浏览器/平台。
// 与真实失败同文表述会让运营误以为系统已在平台上动过手。
test('全程被让开而耗尽预算 → 明说「均未真正开始」，绝不暗示已动过手', async () => {
  const store = new MemoryDelegatedTaskStore();
  let now = 6_000_000;
  const task = await confirmedTask(store, now, { action: 'publish_post', targetSuccessCount: 1, maxAttempts: 2 });
  const executor: DelegatedTaskExecutor = {
    targetKey: () => `t-${Math.random()}`,
    execute: async () => ({ kind: 'deferred', reason: 'risk_status(warned)', retryAt: now + 1 }),
  };
  const worker = new DelegatedTaskWorker({ store, executorFor: () => executor, now: () => now, claimLeaseMs: 10_000 });
  for (let i = 0; i < 3; i++) { await worker.tick(); now += 2_000; }
  const done = await store.get(task.id);
  assert.equal(done?.progress.failureCount, 0);
  assert.equal(done?.progress.skippedCount, done?.progress.attemptCount);
  const msg = done!.terminalOutcome!.message;
  assert.match(msg, /2 次均未真正开始：/);
  assert.match(msg, /风控状态为 warned/);
  assert.doesNotMatch(msg, /最后一次未成原因/);
});

test('无原因可取时保持现状，绝不补推测', async () => {
  const store = new MemoryDelegatedTaskStore();
  let now = 7_000_000;
  const task = await confirmedTask(store, now, { action: 'publish_post', targetSuccessCount: 1, maxAttempts: 1 });
  const executor: DelegatedTaskExecutor = {
    targetKey: () => 't-1',
    execute: async () => ({ kind: 'failed', reason: '   ', retryable: true }),
  };
  const worker = new DelegatedTaskWorker({ store, executorFor: () => executor, now: () => now, claimLeaseMs: 10_000 });
  for (let i = 0; i < 2; i++) { await worker.tick(); now += 2_000; }
  const done = await store.get(task.id);
  assert.equal(done!.terminalOutcome!.message, '已达到最大尝试次数；真实完成 0/1。');
  assert.doesNotMatch(done!.terminalOutcome!.message, /未知|可能|原因/);
});

test('混合局面（既有失败又有让开）报最后一次未成并标注总次数', async () => {
  const store = new MemoryDelegatedTaskStore();
  let now = 8_000_000;
  const task = await confirmedTask(store, now, { action: 'publish_post', targetSuccessCount: 1, maxAttempts: 2 });
  const outcomes: DelegatedExecutionResult[] = [
    { kind: 'deferred', reason: 'risk_status(warned)', retryAt: now + 1 },
    { kind: 'failed', reason: 'needs_persona_setup', retryable: true },
  ];
  let n = 0;
  const executor: DelegatedTaskExecutor = {
    targetKey: () => `t-${n}`,
    execute: async () => outcomes[n++]!,
  };
  const worker = new DelegatedTaskWorker({ store, executorFor: () => executor, now: () => now, claimLeaseMs: 10_000 });
  for (let i = 0; i < 3; i++) { await worker.tick(); now += 2_000; }
  const done = await store.get(task.id);
  const msg = done!.terminalOutcome!.message;
  assert.match(msg, /最后一次未成原因：/);
  assert.match(msg, /未配置人设/);
  assert.match(msg, /共 2 次尝试/);
});

// D2 的支点：listUnsettledAttempts 按构造对已 settle 的 failed / skipped 恒返回 []，
// 恰好排除掉终态要读的那些——故另开 listAttempts。这条断言防的就是有人把两者合并。
test('listAttempts 看得见已 settle 的 attempt，listUnsettledAttempts 看不见', async () => {
  const store = new MemoryDelegatedTaskStore();
  const now = 9_000_000;
  const task = await confirmedTask(store, now, { targetSuccessCount: 1, maxAttempts: 2 });
  const claimed = (await store.claimNext({ workerId: 'w', leaseMs: 10_000, now }))!;
  const a1 = await store.startAttempt(task.id, claimed.claimToken!, 'k-1');
  await store.markAttemptDispatched(a1.id);
  await store.finishAttempt(a1.id, { status: 'failed', verificationKind: 'not_dispatched', reason: 'boom' });

  assert.deepEqual(await store.listUnsettledAttempts(task.id), []);
  const all = await store.listAttempts(task.id);
  assert.equal(all.length, 1);
  assert.equal(all[0]!.status, 'failed');
  assert.equal(all[0]!.reason, 'boom');
});

// 红线（code review 抓到的真 bug）：`skipped` 同时覆盖「让开、执行器没跑」与「执行器跑了、
// 搜了词开了页、最终判定不写」。靠 skippedCount 断言「均未真正开始」＝说了拿不出证据的话。
// 判据必须是 not_started 证据，不是计数器。
test('执行器跑过但判定不写 → 绝不说「均未真正开始」（浏览器真的动过）', async () => {
  const store = new MemoryDelegatedTaskStore();
  let now = 10_000_000;
  const task = await confirmedTask(store, now, { action: 'comment_batch', targetSuccessCount: 1, maxAttempts: 2 });
  let ran = 0;
  const executor: DelegatedTaskExecutor = {
    targetKey: () => `t-${ran}`,
    // 执行器真跑了（搜词 / 开页），只是最终判定无强候选而不评 —— executors.ts 把这类映射成 skipped。
    execute: async () => { ran++; return { kind: 'skipped', reason: 'no_strong_candidate' }; },
  };
  const worker = new DelegatedTaskWorker({ store, executorFor: () => executor, now: () => now, claimLeaseMs: 10_000 });
  for (let i = 0; i < 3; i++) { await worker.tick(); now += 2_000; }
  const done = await store.get(task.id);
  assert.equal(ran, 2, '前提：执行器确实跑过两轮');
  assert.equal(done!.progress.failureCount, 0);
  assert.equal(done!.progress.skippedCount, done!.progress.attemptCount, '前提：计数器与「全让开」局面完全一样');
  const msg = done!.terminalOutcome!.message;
  assert.doesNotMatch(msg, /均未真正开始/, '执行器跑过就绝不能说没开始');
  assert.match(msg, /最后一次未成原因：/);
  assert.match(msg, /no_strong_candidate/);
});

test('让开与跑过混在一起 → 同样不得说「均未真正开始」', async () => {
  const store = new MemoryDelegatedTaskStore();
  let now = 11_000_000;
  const task = await confirmedTask(store, now, { action: 'comment_batch', targetSuccessCount: 1, maxAttempts: 2 });
  const outcomes: DelegatedExecutionResult[] = [
    { kind: 'deferred', reason: 'risk_status(warned)', retryAt: now + 1 },
    { kind: 'skipped', reason: 'no_strong_candidate' },
  ];
  let n = 0;
  const executor: DelegatedTaskExecutor = {
    targetKey: () => `t-${n}`,
    execute: async () => outcomes[n++]!,
  };
  const worker = new DelegatedTaskWorker({ store, executorFor: () => executor, now: () => now, claimLeaseMs: 10_000 });
  for (let i = 0; i < 3; i++) { await worker.tick(); now += 2_000; }
  const done = await store.get(task.id);
  assert.doesNotMatch(done!.terminalOutcome!.message, /均未真正开始/);
  assert.match(done!.terminalOutcome!.message, /共 2 次尝试/);
});

// ---- code review findings：到期终态从前一张卡都不发（纯静默），且在途派发会被谎报成干净失败 ----

test('到期失败必须触发通知（从前裸调 complete → 一张卡都不发、纯静默）', async () => {
  const store = new MemoryDelegatedTaskStore();
  let now = 12_000_000;
  const seen: string[] = [];
  const task = await confirmedTask(store, now, { action: 'publish_post', targetSuccessCount: 1, maxAttempts: 5 });
  const executor: DelegatedTaskExecutor = {
    targetKey: () => `t-${Math.random()}`,
    execute: async () => ({ kind: 'failed', reason: 'needs_persona_setup', retryable: true }),
  };
  const worker = new DelegatedTaskWorker({
    store, executorFor: () => executor, now: () => now, claimLeaseMs: 10_000,
    onTaskUpdated: async (t) => { if (t.terminalOutcome) seen.push(t.terminalOutcome.code); },
  });
  await worker.tick();
  now += 120_000; // 越过 deadline
  await worker.tick();
  const done = await store.get(task.id);
  assert.equal(done?.terminalOutcome?.code, 'deadline');
  assert.ok(seen.includes('deadline'), '到期终态必须经 onTaskUpdated 通知，否则运营零反馈');
  assert.match(done!.terminalOutcome!.message, /已到截止时间/);
  assert.match(done!.terminalOutcome!.message, /未配置人设/);
});

// 反向假确定性：命令可能已在平台落了写入，绝不能报成「干净失败 + 一个更早的确定原因」。
test('到期时派发仍在途 → 诚实标记结果未知，绝不谎报干净失败', async () => {
  const store = new MemoryDelegatedTaskStore();
  const now = 13_000_000;
  const task = await confirmedTask(store, now, { action: 'publish_post', targetSuccessCount: 1, maxAttempts: 5 });
  const claimed = (await store.claimNext({ workerId: 'crashed', leaseMs: 1_000, now }))!;
  // attempt 1：早前 settle 的良性原因（会被当成「最后一次未成原因」误报）
  const a1 = await store.startAttempt(task.id, claimed.claimToken!, 'k-1');
  await store.markAttemptDispatched(a1.id);
  await store.finishAttempt(a1.id, { status: 'skipped', verificationKind: 'not_dispatched', reason: 'no_targets' });
  // attempt 2：已派发、进程重启后永远停在 dispatched；租约随后失效
  const a2 = await store.startAttempt(task.id, claimed.claimToken!, 'k-2');
  await store.markAttemptDispatched(a2.id);
  await store.releaseClaim(task.id, claimed.claimToken!, 'queued');

  const worker = new DelegatedTaskWorker({
    store, executorFor: () => ({ targetKey: () => 'x', execute: async () => ({ kind: 'failed', reason: 'must_not_run' }) }),
    now: () => now + 120_000, claimLeaseMs: 10_000,
  });
  await worker.tick();
  const done = await store.get(task.id);
  assert.equal(done?.terminalOutcome?.code, 'submitted_result_unknown');
  assert.equal(done?.terminalOutcome?.submittedUnknown, true);
  assert.match(done!.terminalOutcome!.message, /是否已写入未知/);
  assert.doesNotMatch(done!.terminalOutcome!.message, /no_targets/, '绝不把更早那次的良性原因当成本次结局');
});

test('非重试终态也说人话（needs_persona_setup 只走这条路，从不经预算终态）', async () => {
  const store = new MemoryDelegatedTaskStore();
  const now = 14_000_000;
  const task = await confirmedTask(store, now, { action: 'publish_post', targetSuccessCount: 1, maxAttempts: 3 });
  const executor: DelegatedTaskExecutor = {
    targetKey: () => 't-1',
    execute: async () => ({ kind: 'failed', reason: 'needs_persona_setup', retryable: false }),
  };
  const worker = new DelegatedTaskWorker({ store, executorFor: () => executor, now: () => now, claimLeaseMs: 10_000 });
  await worker.tick();
  const done = await store.get(task.id);
  assert.equal(done?.terminalOutcome?.code, 'non_retryable_failure');
  assert.match(done!.terminalOutcome!.message, /未配置人设/);
  assert.doesNotMatch(done!.terminalOutcome!.message, /needs_persona_setup/, '不该把生码甩给运营');
});
