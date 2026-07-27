import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('0089 migrates only snapshotted targets to global and preserves OL-compatible scope facts', async () => {
  const sql = await readFile(
    new URL(
      '../../migrations/0089_facebook_global_scope_regional_templates.sql',
      import.meta.url,
    ),
    'utf8',
  );

  assert.match(sql, /ADD COLUMN IF NOT EXISTS account_scope_mode TEXT NOT NULL DEFAULT 'restricted'/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS facebook_region_comment_template_config/);
  assert.match(sql, /CREATE TEMP TABLE aidcp_0089_facebook_target_snapshot ON COMMIT DROP/);
  assert.match(
    sql,
    /UPDATE facebook_group_target[\s\S]*SET account_scope_mode = 'global'[\s\S]*WHERE group_url IN \(SELECT group_url FROM aidcp_0089_facebook_target_snapshot\)/,
  );
  assert.match(
    sql,
    /CREATE TEMP TABLE aidcp_0089_scope_snapshot ON COMMIT DROP/,
  );
  assert.doesNotMatch(sql, /DELETE FROM facebook_group_target_scope/);
  for (const field of [
    'group_name',
    'region',
    'park',
    'direction',
    'join_gating',
    'priority',
    'enabled',
    'import_batch',
    'created_at',
    'updated_at',
  ]) {
    assert.match(sql, new RegExp(`after\\.${field} IS DISTINCT FROM before\\.${field}`));
  }
  assert.match(sql, /facebook target global migration changed compatibility scopes/);
  assert.match(sql, /facebook target global migration changed membership facts/);
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\s+TABLE\b/i);
});

test('0090 preserves existing persisted modes as explicit and defaults future rows to unconfigured', async () => {
  const sql = await readFile(
    new URL(
      '../../migrations/0090_facebook_comment_mode_configured.sql',
      import.meta.url,
    ),
    'utf8',
  );

  assert.match(sql, /ADD COLUMN IF NOT EXISTS comment_mode_configured BOOLEAN/);
  assert.match(
    sql,
    /UPDATE account_facebook_comment_config[\s\S]*SET comment_mode_configured = true[\s\S]*WHERE comment_mode_configured IS NULL/,
  );
  assert.match(sql, /ALTER COLUMN comment_mode_configured SET DEFAULT false/);
  assert.doesNotMatch(sql, /ALTER COLUMN comment_mode_configured SET NOT NULL/);
});
