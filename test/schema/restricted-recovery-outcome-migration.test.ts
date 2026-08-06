import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readMigration } from '../helpers/migration-union.js';

test('0080 只做 nullable additive recovery/env/resume 阶段列与 state check 扩展', async () => {
  const sql = await readMigration('0080_restricted_recovery_outcome.sql');
  assert.match(sql, /-- aidcp:kind=expand/);
  assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|COLUMN)\b/i);
  assert.doesNotMatch(sql, /\bCREATE\s+TABLE\b/i);

  for (const column of [
    'signal_count',
    'env_key',
    'last_signal_at',
    'status_since',
    'state_updated_at',
    'recovery_changed',
    'recovery_refusal',
    'resumed_edges',
    'resume_failure',
    'resume_state',
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column} `));
  }
  assert.match(sql, /state IN \('submitted', 'applying', 'applied', 'refused', 'failed'\)/);
  assert.match(sql, /recovery_refusal = 'state_not_restricted'/);
  assert.match(sql, /resumed_edges >= 0/);
  assert.match(sql, /resume_state IN \('pending', 'claimed', 'completed'\)/);
  assert.match(sql, /resume_failure IN \('edge_resume_failed', 'edge_resume_result_unknown'\)/);
  assert.match(sql, /command_kind <> 'recoverRestricted' OR env_key IS NOT NULL\) NOT VALID/);
  assert.match(
    sql,
    /state <> 'applied'\s+OR resume_state IN \('pending', 'claimed', 'completed'\)\s+\) NOT VALID/,
  );
});
