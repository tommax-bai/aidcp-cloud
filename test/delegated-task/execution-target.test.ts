import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDelegatedTaskStore, PgDelegatedTaskStore } from '../../src/delegated-task/store.js';
import {
  parseDelegatedExecutionTarget,
  type DelegatedTask,
  type DelegatedTaskIntent,
} from '../../src/delegated-task/types.js';

const deadlineAt = Date.parse('2030-01-01T00:00:00.000Z');

function intent(): DelegatedTaskIntent & { accountId: string; accountName: string; platform: 'xiaohongshu'; dedupeKey: string } {
  return {
    accountId: 'account-1',
    accountName: '小猫',
    platform: 'xiaohongshu',
    action: 'publish_post',
    targetSuccessCount: 1,
    maxAttempts: 2,
    deadlineAt,
    source: 'operator_action',
    sourceRef: 'edge:curated:env-1:42:create-post',
    approvalMode: 'review',
    dedupeKey: 'same-business-request',
  };
}

function taskRow(executionTarget: 'dev' | 'ol'): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    execution_target: executionTarget,
    account_id: 'account-1',
    account_name: '小猫',
    platform: 'xiaohongshu',
    action: 'publish_post',
    action_family: 'publish',
    target_success_count: 1,
    max_attempts: 2,
    deadline_at: new Date(deadlineAt),
    not_before: new Date('2029-12-31T00:00:00.000Z'),
    execution_window: { mode: 'immediate' },
    source_constraints: {},
    target_constraints: {},
    approval_mode: 'review',
    priority: 'normal',
    source: 'operator_action',
    source_ref: 'edge:curated:env-1:42:create-post',
    origin_chat_id: null,
    status: 'awaiting_confirmation',
    success_count: 0,
    attempt_count: 0,
    skipped_count: 0,
    failure_count: 0,
    current_step: null,
    terminal_outcome: null,
    pause_requested: false,
    cancel_requested: false,
    next_eligible_at: null,
    claim_token: null,
    claim_expires_at: null,
    dedupe_key: 'same-business-request',
    version: 1,
    created_at: new Date('2029-12-31T00:00:00.000Z'),
    updated_at: new Date('2029-12-31T00:00:00.000Z'),
    confirmed_at: null,
    completed_at: null,
  };
}

test('deployment target parser accepts only dev or ol and never defaults', () => {
  assert.equal(parseDelegatedExecutionTarget('dev'), 'dev');
  assert.equal(parseDelegatedExecutionTarget(' ol '), 'ol');
  assert.equal(parseDelegatedExecutionTarget(undefined), null);
  assert.equal(parseDelegatedExecutionTarget(''), null);
  assert.equal(parseDelegatedExecutionTarget('prod'), null);
  assert.equal(parseDelegatedExecutionTarget('DEV'), null);
});

test('memory store injects its trusted target and keeps dev/ol dedupe independent', async () => {
  const dev = new MemoryDelegatedTaskStore('dev');
  const ol = new MemoryDelegatedTaskStore('ol');
  const forged = { ...intent(), executionTarget: 'ol' } as unknown as Parameters<typeof dev.createDraft>[0];

  const devFirst = await dev.createDraft(forged);
  const devDuplicate = await dev.createDraft(forged);
  const olFirst = await ol.createDraft(intent());

  assert.equal(devFirst.task.executionTarget, 'dev');
  assert.equal(devDuplicate.created, false);
  assert.equal(devDuplicate.task.id, devFirst.task.id);
  assert.equal(olFirst.created, true);
  assert.equal(olFirst.task.executionTarget, 'ol');
  assert.notEqual(olFirst.task.id, devFirst.task.id);
});

test('postgres store inserts trusted target and scopes reads, controls, claims, recovery, and ownership', async () => {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const pool = {
    query: async (sql: string, args: unknown[] = []) => {
      calls.push({ sql, args });
      if (/INSERT INTO delegated_tasks \(/.test(sql)) return { rows: [taskRow('ol')] };
      return { rows: [] };
    },
  };
  const store = new PgDelegatedTaskStore({ pool: pool as never, executionTarget: 'ol' });

  const created = await store.createDraft(intent());
  assert.equal(created.task.executionTarget, 'ol');
  assert.match(calls[0].sql, /origin_chat_id, execution_target/);
  assert.equal(calls[0].args.at(-1), 'ol');

  calls.length = 0;
  assert.equal(await store.get('00000000-0000-4000-8000-000000000001'), null);
  assert.equal(calls[0].sql, 'SELECT * FROM delegated_tasks WHERE id=$1 AND execution_target=$2');
  assert.deepEqual(calls[0].args, ['00000000-0000-4000-8000-000000000001', 'ol']);

  calls.length = 0;
  await store.claimNext({ workerId: 'worker', leaseMs: 60_000, now: Date.parse('2029-12-31T00:00:00.000Z') });
  assert.match(calls[0].sql, /WHERE execution_target=\$4 AND status IN \('queued','deferred','waiting_approval'\)/);
  assert.equal(calls[0].args[3], 'ol');

  calls.length = 0;
  await store.recoverInterruptedClaims(Date.parse('2029-12-31T00:00:00.000Z'));
  assert.match(calls[0].sql, /WHERE execution_target=\$2 AND status IN \('planning','executing'\)/);
  assert.equal(calls[0].args[1], 'ol');

  calls.length = 0;
  assert.equal(await store.confirm('00000000-0000-4000-8000-000000000001', 1), null);
  assert.match(calls[0].sql, /version=\$2 AND execution_target=\$3/);
  assert.equal(calls[0].args[2], 'ol');
  assert.match(calls[1].sql, /id=\$1 AND execution_target=\$2/);

  calls.length = 0;
  assert.equal(await store.hasActiveOwnership('account-1', 'publish'), false);
  assert.match(calls[0].sql, /execution_target=\$1 AND account_id=\$2/);
  assert.equal(calls[0].args[0], 'ol');
});

test('task projection exposes the persisted execution target for audit', async () => {
  const pool = {
    query: async () => ({ rows: [taskRow('dev')] }),
  };
  const store = new PgDelegatedTaskStore({ pool: pool as never, executionTarget: 'dev' });
  const task = await store.get('00000000-0000-4000-8000-000000000001') as DelegatedTask;
  assert.equal(task.executionTarget, 'dev');
});
