import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const migrationUrl = new URL('../../migrations/0039_interaction_inbox.sql', import.meta.url);

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
