import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DELEGATED_TASK_SCHEMA_SQL, PgDelegatedTaskStore } from '@automation/delegated-task/store.js';

import { readMigration } from '../helpers/migration-union.js';

test('delegated task schema indexes account-scoped curated rewrite trigger lookups', () => {
  assert.match(DELEGATED_TASK_SCHEMA_SQL, /idx_delegated_tasks_curated_publish_id[\s\S]*account_id[\s\S]*source_constraints->>'curatedId'[\s\S]*WHERE action = 'publish_post'/);
  assert.match(DELEGATED_TASK_SCHEMA_SQL, /idx_delegated_tasks_curated_publish_source[\s\S]*account_id[\s\S]*source_constraints->>'sourceId'[\s\S]*WHERE action = 'publish_post'/);
});

test('delegated task schema backfills legacy rows to dev and partitions queue indexes by target', () => {
  assert.match(DELEGATED_TASK_SCHEMA_SQL, /ALTER TABLE delegated_tasks ADD COLUMN IF NOT EXISTS execution_target TEXT/);
  assert.match(DELEGATED_TASK_SCHEMA_SQL, /UPDATE delegated_tasks SET execution_target='dev' WHERE execution_target IS NULL/);
  assert.match(DELEGATED_TASK_SCHEMA_SQL, /ALTER COLUMN execution_target SET NOT NULL/);
  assert.match(DELEGATED_TASK_SCHEMA_SQL, /CHECK \(execution_target IN \('dev','ol'\)\)/);
  assert.doesNotMatch(DELEGATED_TASK_SCHEMA_SQL, /execution_target[^\n]*DEFAULT/);
  assert.match(DELEGATED_TASK_SCHEMA_SQL, /idx_delegated_tasks_target_active_dedupe[\s\S]*execution_target, dedupe_key/);
  assert.match(DELEGATED_TASK_SCHEMA_SQL, /idx_delegated_tasks_target_claim[\s\S]*execution_target, status/);
  assert.match(DELEGATED_TASK_SCHEMA_SQL, /idx_delegated_tasks_target_ownership[\s\S]*execution_target, account_id, action_family/);
});

test('explicit delegated task migration preserves the same target boundary as startup schema', async () => {
  const migration = await readMigration('0052_delegated_task_execution_target.sql');
  assert.match(migration, /UPDATE delegated_tasks\s+SET execution_target\s*=\s*'dev'\s+WHERE execution_target IS NULL/);
  assert.match(migration, /ALTER COLUMN execution_target SET NOT NULL/);
  assert.match(migration, /CHECK \(execution_target IN \('dev','ol'\)\)/);
  assert.doesNotMatch(migration, /execution_target[^\n]*DEFAULT/);
  assert.match(migration, /idx_delegated_tasks_target_active_dedupe[\s\S]*execution_target, dedupe_key/);
  assert.match(migration, /idx_delegated_tasks_target_claim[\s\S]*execution_target, status/);
  assert.match(migration, /idx_delegated_tasks_target_ownership[\s\S]*execution_target, account_id, action_family/);
});

test('interrupted claim recovery binds the shared restart timestamp as timestamptz', async () => {
  const calls: string[] = [];
  const pool = {
    async query(sql: string) {
      calls.push(sql);
      return { rows: [] };
    },
  };
  const store = new PgDelegatedTaskStore({ pool: pool as never, executionTarget: 'ol' });

  await store.recoverInterruptedClaims(Date.parse('2026-07-20T04:00:00.000Z'));

  assert.equal(calls.length, 1);
  assert.match(calls[0], /next_eligible_at=CASE[\s\S]*ELSE \$1::timestamptz/);
  assert.match(calls[0], /completed_at=CASE WHEN t\.cancel_requested THEN \$1::timestamptz/);
  assert.match(calls[0], /updated_at=\$1::timestamptz/);
  assert.match(calls[0], /WHERE execution_target=\$2 AND status IN \('planning','executing'\)/);
});
