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

// 红线：让开（deferred → settle 成 skipped）同样烧尝试预算，且从未接触平台。
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
