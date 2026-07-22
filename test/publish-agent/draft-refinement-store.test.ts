import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DRAFT_REFINEMENT_SCHEMA_SQL,
  DraftRefinementStore,
} from '../../src/publish-agent/draft-refinement.js';

function row(target: 'dev' | 'ol' = 'dev') {
  return {
    id: '00000000-0000-4000-8000-000000000057',
    execution_target: target,
    account_id: 'account-1',
    record_id: 17,
    expected_version: 2,
    scope: 'body',
    instruction: '更口语一些',
    selection: null,
    status: 'queued',
    progress: [],
    claim_token: null,
    result_version: null,
    error_code: null,
    error_message: null,
    created_at: new Date('2026-07-22T00:00:00.000Z'),
    updated_at: new Date('2026-07-22T00:00:00.000Z'),
    completed_at: null,
  };
}

test('refinement schema requires explicit dev/ol target and target-scoped indexes', () => {
  assert.match(DRAFT_REFINEMENT_SCHEMA_SQL, /execution_target\s+TEXT NOT NULL CHECK \(execution_target IN \('dev','ol'\)\)/);
  assert.doesNotMatch(DRAFT_REFINEMENT_SCHEMA_SQL, /execution_target[^\n]*DEFAULT/);
  assert.match(DRAFT_REFINEMENT_SCHEMA_SQL, /idx_publish_draft_refinement_target_claim[\s\S]*execution_target, status/);
  assert.match(DRAFT_REFINEMENT_SCHEMA_SQL, /idx_publish_draft_refinement_one_active[\s\S]*execution_target, record_id/);

  const migration = readFileSync(
    new URL('../../migrations/0057_publish_draft_refinement_jobs.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /execution_target\s+TEXT NOT NULL CHECK \(execution_target IN \('dev','ol'\)\)/);
  assert.doesNotMatch(migration, /execution_target[^\n]*DEFAULT/);
});

test('store injects trusted target into create/read/claim/recovery', async () => {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const pool = {
    async query(sql: string, args: unknown[] = []) {
      calls.push({ sql, args });
      if (sql.includes('INSERT INTO publish_draft_refinement_jobs')) return { rows: [row('ol')], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };
  const store = new DraftRefinementStore({ pool: pool as never, executionTarget: 'ol' });

  const created = await store.create({
    accountId: 'account-1', recordId: 17, expectedVersion: 2, scope: 'body', instruction: '更口语一些', selection: null,
  });
  assert.equal(created.executionTarget, 'ol');
  assert.equal(calls[0].args[1], 'ol');

  calls.length = 0;
  await store.getForAccount('account-1', 17, created.id);
  assert.match(calls[0].sql, /id=\$1 AND execution_target=\$2 AND account_id=\$3 AND record_id=\$4/);
  assert.deepEqual(calls[0].args, [created.id, 'ol', 'account-1', 17]);

  calls.length = 0;
  await store.latestForAccountRecords('account-1', [17, 18]);
  assert.match(calls[0].sql, /execution_target=\$1 AND account_id=\$2 AND record_id = ANY\(\$3::int\[\]\)/);
  assert.deepEqual(calls[0].args, ['ol', 'account-1', [17, 18]]);

  calls.length = 0;
  await store.claimNext('worker-1', 60_000, Date.parse('2026-07-22T00:00:00.000Z'));
  assert.match(calls[0].sql, /execution_target=\$1 AND status='queued'[\s\S]*FOR UPDATE SKIP LOCKED/);
  assert.equal(calls[0].args[0], 'ol');
  assert.equal(calls[0].args.length, 3);

  calls.length = 0;
  await store.recoverInterruptedClaims(Date.parse('2026-07-22T00:00:00.000Z'));
  assert.match(calls[0].sql, /WHERE execution_target=\$2 AND status='running'/);
  assert.equal(calls[0].args[1], 'ol');
});

test('progress and terminal writes require target, running state, and claim token', async () => {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const pool = {
    async query(sql: string, args: unknown[] = []) {
      calls.push({ sql, args });
      return { rows: [], rowCount: 1 };
    },
    async end() {},
  };
  const store = new DraftRefinementStore({ pool: pool as never, executionTarget: 'dev' });
  const progress = [{ seq: 1, stage: '计划' as const, status: 'running' as const, summary: '核对调整范围', at: 1 }];
  assert.equal(await store.replaceProgress('job', 'token', progress), true);
  assert.match(calls[0].sql, /status='running' AND claim_token=\$2/);
  assert.equal(calls[0].args[3], 'dev');

  assert.equal(await store.complete('job', 'token', 3, progress), true);
  assert.match(calls[1].sql, /status='completed'/);
  assert.equal(calls[1].args[4], 'dev');

  assert.equal(await store.fail('job', 'token', 'version_conflict', '稿件已更新', progress), true);
  assert.match(calls[2].sql, /status='failed'/);
  assert.equal(calls[2].args[5], 'dev');
});
