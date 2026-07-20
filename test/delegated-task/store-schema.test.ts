import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DELEGATED_TASK_SCHEMA_SQL, PgDelegatedTaskStore } from '../../src/delegated-task/store.js';

test('delegated task schema indexes account-scoped curated rewrite trigger lookups', () => {
  assert.match(DELEGATED_TASK_SCHEMA_SQL, /idx_delegated_tasks_curated_publish_id[\s\S]*account_id[\s\S]*source_constraints->>'curatedId'[\s\S]*WHERE action = 'publish_post'/);
  assert.match(DELEGATED_TASK_SCHEMA_SQL, /idx_delegated_tasks_curated_publish_source[\s\S]*account_id[\s\S]*source_constraints->>'sourceId'[\s\S]*WHERE action = 'publish_post'/);
});

test('interrupted claim recovery binds the shared restart timestamp as timestamptz', async () => {
  const calls: string[] = [];
  const pool = {
    async query(sql: string) {
      calls.push(sql);
      return { rows: [] };
    },
  };
  const store = new PgDelegatedTaskStore({ pool: pool as never });

  await store.recoverInterruptedClaims(Date.parse('2026-07-20T04:00:00.000Z'));

  assert.equal(calls.length, 1);
  assert.match(calls[0], /next_eligible_at=CASE[\s\S]*ELSE \$1::timestamptz/);
  assert.match(calls[0], /completed_at=CASE WHEN t\.cancel_requested THEN \$1::timestamptz/);
  assert.match(calls[0], /updated_at=\$1::timestamptz/);
});
