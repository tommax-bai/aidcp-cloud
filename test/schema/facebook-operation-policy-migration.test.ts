import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const migrationUrl = new URL(
  '../../migrations/0100_facebook_operation_and_group_comment_policy.sql',
  import.meta.url,
);
const globalMigrationUrl = new URL(
  '../../migrations/0103_facebook_operation_global_policy.sql',
  import.meta.url,
);
const reelCadenceMigrationUrl = new URL(
  '../../migrations/0104_facebook_reel_mode_cadence.sql',
  import.meta.url,
);

describe('facebook operation policy migration', () => {
  it('allocates a global revision after the fixed schema version in every seed row', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    assert.match(
      sql,
      /CREATE SEQUENCE IF NOT EXISTS facebook_operation_policy_revision_seq[\s\S]*NO CYCLE;/,
    );
    assert.match(
      sql,
      /policy_schema_version,\s*policy_revision,[\s\S]*?\n\s*1,\s*\n\s*nextval\('facebook_operation_policy_revision_seq'\),/,
    );
    assert.match(
      sql,
      /policy_revision\s+BIGINT NOT NULL\s+DEFAULT nextval\('facebook_operation_policy_revision_seq'\)/,
    );
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_facebook_operation_policy_audit_revision\s+ON facebook_operation_policy_audit \(new_revision\)/,
    );
    assert.match(
      sql,
      /lower\(btrim\(COALESCE\(e\.platform, ''\)\)\) IN \('facebook', 'fb'\)/,
      'migration seed must accept every Facebook alias accepted by runtime normalization',
    );
  });

  it('adds target-global values, inherited cadence source and target-scoped sticky graduation', async () => {
    const sql = await readFile(globalMigrationUrl, 'utf8');
    assert.match(
      sql,
      /ADD COLUMN IF NOT EXISTS cadence_source TEXT NOT NULL DEFAULT 'environment'/,
      'existing environment values must migrate as independent overrides',
    );
    assert.match(
      sql,
      /ALTER COLUMN cadence_source SET DEFAULT 'global'/,
      'new environments must inherit target-global cadence by default',
    );
    assert.match(
      sql,
      /CREATE TABLE IF NOT EXISTS facebook_operation_global_policy[\s\S]*execution_target\s+TEXT PRIMARY KEY[\s\S]*CHECK \(execution_target IN \('dev', 'ol'\)\)/,
    );
    assert.match(
      sql,
      /CREATE TABLE IF NOT EXISTS facebook_environment_slow_start_completion[\s\S]*PRIMARY KEY \(env_key, execution_target\)/,
      'graduation must be sticky independently for DEV and OL',
    );
    assert.match(
      sql,
      /FROM \(VALUES \('dev'\), \('ol'\)\) AS targets\(target\)/,
      'both deployment targets must receive an explicit global row',
    );
    assert.match(
      sql,
      /slow_start_total_days[\s\S]*CHECK \(slow_start_total_days BETWEEN 1 AND 30\)/,
    );
  });

  it('adds only global Reel cadence fields with safe defaults for every Facebook mode', async () => {
    const sql = await readFile(reelCadenceMigrationUrl, 'utf8');
    assert.match(
      sql,
      /ALTER TABLE facebook_operation_global_policy[\s\S]*ADD COLUMN IF NOT EXISTS persona_reel_views_per_like[\s\S]*DEFAULT 4/,
    );
    assert.match(sql, /persona_reel_views_per_follow[\s\S]*DEFAULT 10/);
    assert.match(sql, /slow_start_reel_views_per_follow[\s\S]*DEFAULT 15/);
    assert.match(sql, /rule_reel_views_per_follow[\s\S]*DEFAULT 15/);
    assert.match(sql, /consumption_reel_views_per_follow[\s\S]*DEFAULT 15/);
    assert.match(
      sql,
      /CHECK \(persona_reel_views_per_like BETWEEN 1 AND 100\)/,
      'all cadence values must remain bounded before runtime reads them',
    );
    assert.doesNotMatch(
      sql,
      /ALTER TABLE facebook_operation_policy\b/,
      'Reel cadence is global-only and must not add environment override columns',
    );
  });
});
