import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const migrationUrl = new URL(
  '../../migrations/0100_facebook_operation_and_group_comment_policy.sql',
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
});
