import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DELEGATED_TASK_SCHEMA_SQL } from '../../src/delegated-task/store.js';

test('delegated task schema indexes account-scoped curated rewrite trigger lookups', () => {
  assert.match(DELEGATED_TASK_SCHEMA_SQL, /idx_delegated_tasks_curated_publish_id[\s\S]*account_id[\s\S]*source_constraints->>'curatedId'[\s\S]*WHERE action = 'publish_post'/);
  assert.match(DELEGATED_TASK_SCHEMA_SQL, /idx_delegated_tasks_curated_publish_source[\s\S]*account_id[\s\S]*source_constraints->>'sourceId'[\s\S]*WHERE action = 'publish_post'/);
});
