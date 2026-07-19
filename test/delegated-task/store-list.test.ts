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
  const store = new PgDelegatedTaskStore({ pool: pool as never });

  const result = await store.list({ actionFamily: 'publish', statuses: ['queued', 'planning', 'deferred'], limit: 7 });

  assert.deepEqual(result, []);
  assert.match(calls[0].sql, /WHERE action_family=\$1 AND status = ANY\(\$2::text\[\]\)/);
  assert.match(calls[0].sql, /ORDER BY created_at DESC LIMIT \$3$/);
  assert.deepEqual(calls[0].args, ['publish', ['queued', 'planning', 'deferred'], 7]);
});

test('delegated task list keeps the legacy unfiltered query shape', async () => {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const pool = {
    query: async (sql: string, args: unknown[]) => {
      calls.push({ sql, args });
      return { rows: [] };
    },
  };
  const store = new PgDelegatedTaskStore({ pool: pool as never });

  await store.list({ limit: 11 });

  assert.equal(calls[0].sql, 'SELECT * FROM delegated_tasks ORDER BY created_at DESC LIMIT $1');
  assert.deepEqual(calls[0].args, [11]);
});
