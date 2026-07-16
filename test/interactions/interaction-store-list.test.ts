import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { InteractionStore } from '../../src/interactions/interaction-store.js';

test('pending list filter expands to all actionable reply job states', async () => {
  let capturedSql = '';
  let capturedParams: unknown[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    },
  } as unknown as Pool;
  const store = new InteractionStore({ pool });

  const result = await store.listInteractions({
    accountId: 'acct-a', envKey: 'env-a', asOf: 1_784_044_800_000, limit: 30, state: 'pending',
  });

  assert.deepEqual(result, { items: [], next: null });
  assert.match(capturedSql, /j\.state=ANY\(\$5::text\[\]\)/);
  assert.deepEqual(capturedParams[4], [
    'new', 'classifying', 'draft_ready', 'approval_required', 'approved',
    'queued', 'sending', 'failed', 'ambiguous',
  ]);
});
