import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgDelegatedTaskStore } from '../../src/delegated-task/store.js';

test('delegated task list pushes action-family and status filters before limit', async () => {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const pool = {
    query: async (sql: string, args: unknown[]) => {
      calls.push({ sql, args });
      return { rows: [] };
    },
  };
  const store = new PgDelegatedTaskStore({ pool: pool as never, executionTarget: 'ol' });

  const result = await store.list({ actionFamily: 'publish', statuses: ['queued', 'planning', 'deferred'], limit: 7 });

  assert.deepEqual(result, []);
  assert.match(calls[0].sql, /WHERE execution_target=\$1 AND action_family=\$2 AND status = ANY\(\$3::text\[\]\)/);
  assert.match(calls[0].sql, /ORDER BY created_at DESC LIMIT \$4$/);
  assert.deepEqual(calls[0].args, ['ol', 'publish', ['queued', 'planning', 'deferred'], 7]);
});

test('delegated task list always scopes even an otherwise unfiltered query', async () => {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const pool = {
    query: async (sql: string, args: unknown[]) => {
      calls.push({ sql, args });
      return { rows: [] };
    },
  };
  const store = new PgDelegatedTaskStore({ pool: pool as never, executionTarget: 'dev' });

  await store.list({ limit: 11 });

  assert.equal(calls[0].sql, 'SELECT * FROM delegated_tasks WHERE execution_target=$1 ORDER BY created_at DESC LIMIT $2');
  assert.deepEqual(calls[0].args, ['dev', 11]);
});
