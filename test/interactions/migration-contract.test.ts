import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const migrationUrl = new URL('../../migrations/0039_interaction_inbox.sql', import.meta.url);
const authorityMigrationUrl = new URL('../../migrations/0040_customer_env_authority.sql', import.meta.url);
const recoveryMigrationUrl = new URL('../../migrations/0041_interaction_recovery_offboarding.sql', import.meta.url);

test('0039 creates the dedicated inbound domain and never writes outbound interaction_feed', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const withoutComments = sql.replace(/--.*$/gm, '');
  for (const table of [
    'interaction_threads', 'interaction_messages', 'interaction_reply_jobs', 'interaction_send_attempts',
    'interaction_sync_cursors', 'interaction_reply_configs', 'interaction_reply_config_versions',
    'reply_templates', 'reply_rules', 'account_reply_profiles',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), table);
  }
  assert.doesNotMatch(withoutComments, /\binteraction_feed\b/, '入站数据不得落 outbound interaction_feed');
});

test('0039 freezes job/attempt idempotency, active uniqueness and write-off defaults', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /inbound_message_id\s+TEXT NOT NULL UNIQUE/);
  assert.match(sql, /idempotency_key\s+TEXT NOT NULL UNIQUE CHECK \(idempotency_key ~ '\^\[a-f0-9\]\{64\}\$'\)/);
  assert.match(sql, /UNIQUE \(reply_job_id, attempt_no\)/);
  assert.match(sql, /WHERE status IN \('created','dispatched','ambiguous'\)/);
  assert.match(sql, /uq_interaction_send_attempts_active_account[\s\S]*ON interaction_send_attempts \(account_id\)/);
  assert.match(sql, /comments_reply_enabled\s+BOOLEAN NOT NULL DEFAULT false/);
  assert.match(sql, /dm_send_text_enabled\s+BOOLEAN NOT NULL DEFAULT false/);
  assert.match(sql, /dm_send_image_enabled\s+BOOLEAN NOT NULL DEFAULT false CHECK \(dm_send_image_enabled = false\)/);
  assert.match(sql, /write_paused\s+BOOLEAN NOT NULL DEFAULT true/);
  assert.match(sql, /'dm_reply'/);
});

test('0039 scope indexes and CAS columns keep accountId/envKey on reads and writes', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /UNIQUE \(id, account_id, env_key\)/);
  assert.match(sql, /idx_interaction_threads_scope_time[\s\S]*\(account_id, env_key, last_message_at DESC, id DESC\)/);
  assert.match(sql, /idx_interaction_messages_scope_thread_time[\s\S]*\(account_id, env_key, thread_id, platform_created_at DESC, id DESC\)/);
  assert.match(sql, /version\s+INTEGER NOT NULL DEFAULT 0 CHECK \(version >= 0\)/);
  assert.match(sql, /uq_interaction_sync_cursors_scope[\s\S]*COALESCE\(scope_external_id, ''\)/);
  assert.match(sql, /FOREIGN KEY \(thread_id, account_id, env_key\)[\s\S]*interaction_threads\(id, account_id, env_key\)/);
  assert.match(sql, /FOREIGN KEY \(inbound_message_id, account_id, env_key\)[\s\S]*interaction_messages\(id, account_id, env_key\)/);
  assert.match(sql, /FOREIGN KEY \(reply_job_id, account_id, env_key\)[\s\S]*interaction_reply_jobs\(id, account_id, env_key\)/);
});

test('0040 archives/removes customer self-claims and freezes globally unique active env ownership', async () => {
  const sql = await readFile(authorityMigrationUrl, 'utf8');
  assert.match(sql, /INSERT INTO client_environments[\s\S]*FROM client_env_scope/,
    'legacy environment metadata must be preserved in the authoritative registry');
  assert.match(sql, /INSERT INTO client_env_scope_audit[\s\S]*legacy_self_claim/);
  assert.match(sql, /DELETE FROM client_env_scope WHERE source = 'client'/);
  assert.match(sql, /client_env_scope_authoritative_source[\s\S]*CHECK \(source = 'admin'\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_client_env_scope_active_env[\s\S]*ON client_env_scope \(env_key\)/);
});

test('0041 adds durable recovery/offboarding and releases only account-level ambiguous serialization', async () => {
  const sql = await readFile(recoveryMigrationUrl, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS interaction_offboards/);
  assert.match(sql, /purge_due_at[\s\S]*30 days/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS interaction_offboard_audit/);
  assert.match(sql, /uq_interaction_send_attempts_dispatching_account[\s\S]*WHERE status IN \('created','dispatched'\)/);
  assert.match(sql, /DROP INDEX IF EXISTS uq_interaction_send_attempts_active_account/);
  assert.ok(
    sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS uq_interaction_send_attempts_dispatching_account')
      < sql.indexOf('DROP INDEX IF EXISTS uq_interaction_send_attempts_active_account'),
    'replacement account serialization index must exist before the legacy index is removed',
  );
  assert.match(sql, /reconciliation_state[\s\S]*result_replayed[\s\S]*not_found[\s\S]*binding_conflict/);
  assert.doesNotMatch(sql, /content_text|final_text|cookie|credential/i,
    'offboard audit/migration must not copy message bodies, reply text or credentials');
});
