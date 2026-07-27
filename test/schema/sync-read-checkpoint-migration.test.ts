// aidcp:test-owner=cloud
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { loadMigrationFiles } from '../../src/schema/migration-files.js';
import {
  attributeMigrations,
  loadTableOwnership,
  versionsForOwner,
} from '../../src/schema/migration-owners.js';
import { KNOWN_MAX_SCHEMA_VERSION } from '../../src/schema/schema-contract.js';

const migrations = [
  {
    name: '0082_api_sync_read_consumer_checkpoint',
    table: 'api_sync_read_consumer_checkpoint',
    consumer: 'api',
    streams: [
      'session_config_global',
      'edge_presence',
      'publish_in_flight',
      'captcha_availability',
      'automation_config_mirror_health',
    ],
  },
  {
    name: '0083_automation_sync_read_consumer_checkpoint',
    table: 'automation_sync_read_consumer_checkpoint',
    consumer: 'automation',
    streams: [
      'account_persona',
      'client_environment_automation',
      'automation_account_projection',
      'content_schedule',
      'hot_lead_config',
      'facebook_comment_config',
      'facebook_group_join_automation_config',
    ],
  },
] as const;

test('0082/0083 are expand-only owner-local checkpoint tables with no business payload', async () => {
  for (const migration of migrations) {
    const sql = await readFile(
      new URL(`../../migrations/${migration.name}.sql`, import.meta.url),
      'utf8',
    );
    assert.match(sql, /-- aidcp:kind=expand/);
    assert.match(
      sql,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${migration.table}`),
    );
    assert.match(sql, /PRIMARY KEY \(execution_target, consumer, stream\)/);
    assert.match(
      sql,
      new RegExp(`consumer\\s+TEXT NOT NULL CHECK \\(consumer = '${migration.consumer}'\\)`),
    );
    for (const stream of migration.streams) {
      assert.match(sql, new RegExp(`'${stream}'`));
    }
    for (const column of [
      'applied_cursor',
      'payload_digest',
      'source_as_of_ms',
      'last_observed_at_ms',
      'fresh_until_ms',
      'last_applied_at_ms',
      'state',
      'last_error',
    ]) {
      assert.match(sql, new RegExp(`\\b${column}\\b`));
    }
    const executable = sql.replace(/^--.*$/gm, '');
    assert.doesNotMatch(
      executable,
      /\b(?:payload|value|fact_scope|owner_version|config_mirror_version)\b/i,
      'checkpoint tables MUST NOT copy shared facts, projection payloads, or owner versions',
    );
    assert.doesNotMatch(executable, /\b(?:DROP|ALTER)\s+(?:TABLE|COLUMN)\b/i);
  }
});

test('checkpoint migrations remain owner-local when owner databases split', async () => {
  const files = await loadMigrationFiles();
  const index = attributeMigrations(files, await loadTableOwnership());
  const api = versionsForOwner(index, 'api');
  const automation = versionsForOwner(index, 'automation');
  assert.ok(api.includes('0082_api_sync_read_consumer_checkpoint'));
  assert.ok(!api.includes('0083_automation_sync_read_consumer_checkpoint'));
  assert.ok(automation.includes('0083_automation_sync_read_consumer_checkpoint'));
  assert.ok(!automation.includes('0082_api_sync_read_consumer_checkpoint'));
  assert.equal(
    KNOWN_MAX_SCHEMA_VERSION,
    '0090_facebook_comment_mode_configured',
  );
});

test('0085 keeps runtime owner generations durable, target-scoped and payload-free', async () => {
  const sql = await readFile(
    new URL(
      '../../migrations/0085_automation_sync_read_owner_generation.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(sql, /-- aidcp:kind=expand/);
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS automation_sync_read_owner_generation/,
  );
  assert.match(sql, /PRIMARY KEY \(execution_target, stream\)/);
  assert.match(sql, /\bgeneration\b/);
  assert.match(sql, /\bpayload_digest\b/);
  assert.match(sql, /\blast_emitted_generation\b/);
  assert.doesNotMatch(
    sql.replace(/^--.*$/gm, ''),
    /\b(?:payload|value|account_id|record_ids|edge_id)\b/i,
  );
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\b(?:DROP|ALTER)\b/i);
});

test('0086 keeps A1 owner revision on session_config_global rather than a parallel authority', async () => {
  const sql = await readFile(
    new URL(
      '../../migrations/0086_session_config_global_sync_read_revision.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(sql, /-- aidcp:kind=expand/);
  assert.match(sql, /ALTER TABLE session_config_global/);
  assert.match(sql, /sync_read_revision NUMERIC NOT NULL DEFAULT 0/);
  assert.doesNotMatch(sql, /\bCREATE TABLE\b/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\bevent_outbox\b/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\bDROP\b/i);
});

test('0087 stores the B4 shared cursor on the shared projection state row', async () => {
  const sql = await readFile(
    new URL(
      '../../migrations/0087_automation_account_projection_shared_cursor.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(sql, /-- aidcp:kind=expand/);
  assert.match(sql, /ALTER TABLE automation_account_projection_state/);
  assert.match(sql, /sync_read_cursor NUMERIC/);
  assert.match(sql, /sync_read_payload_digest TEXT/);
  assert.match(sql, /sync_read_source_as_of_ms BIGINT/);
  assert.match(sql, /automation_account_projection_state_sync_read_check/);
  assert.match(sql, /sync_read_cursor IS NOT NULL/);
  assert.match(sql, /sync_read_payload_digest IS NOT NULL/);
  assert.match(sql, /sync_read_source_as_of_ms IS NOT NULL/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\bCREATE TABLE\b/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\bDROP\b/i);
});
