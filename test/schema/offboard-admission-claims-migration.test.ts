import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const migrationUrl = new URL('../../migrations/0081_offboard_admission_claims.sql', import.meta.url);

test('0081 只做 additive claim/CAS、command receipt 与 snapshot cursor state', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /-- aidcp:kind=expand/);
  assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|COLUMN)\b/i);
  for (const column of [
    'admission_revision',
    'claim_token',
    'claimed_by',
    'claim_expires_at',
    'execution_target',
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column} `));
  }
  assert.match(sql, /CREATE TABLE IF NOT EXISTS client_env_admission_command_receipts/);
  assert.match(sql, /execution_target\s+TEXT\s+NOT NULL/);
  assert.match(sql, /command_id\s+TEXT\s+NOT NULL/);
  assert.match(sql, /PRIMARY KEY \(execution_target, command_id\)/);
  assert.match(sql, /payload_hash\s+TEXT\s+NOT NULL/);
  assert.match(sql, /receipt\s+JSONB\s+NOT NULL/);
  assert.match(sql, /client_env_revocation_holds_claimable_idx/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS client_env_admission_snapshot_state/);
  assert.match(sql, /observed_at_ms\s+BIGINT\s+NOT NULL/);
  assert.match(sql, /snapshot_digest\s+TEXT\s+NOT NULL/);
  assert.match(sql, /PRIMARY KEY \(execution_target, capability\)/);
  assert.match(sql, /offboard_admission_execution_target_backfill_required/);
  assert.match(sql, /WHERE execution_target IS NULL[\s\S]*ORDER BY requested_at, env_key[\s\S]*LIMIT 1/);
  assert.match(sql, /CONSTRAINT = 'client_env_revocation_holds_execution_target_assignment'/);
  assert.doesNotMatch(sql, /ALTER COLUMN execution_target SET NOT NULL/);
  assert.doesNotMatch(sql, /execution_target TEXT(?:\s+NOT NULL)?\s+DEFAULT/i);
});
