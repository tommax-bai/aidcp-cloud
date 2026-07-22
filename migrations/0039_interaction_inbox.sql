-- aidcp:kind=expand
-- aidcp:objects=column:account_reply_profiles.account_id,column:account_reply_profiles.channel,column:account_reply_profiles.config_version,column:account_reply_profiles.platform
-- aidcp:objects=column:account_reply_profiles.profile,column:account_reply_profiles.updated_at,column:account_reply_profiles.updated_by,column:interaction_api_requests.account_id
-- aidcp:objects=column:interaction_api_requests.action,column:interaction_api_requests.actor,column:interaction_api_requests.created_at,column:interaction_api_requests.env_key
-- aidcp:objects=column:interaction_api_requests.idempotency_key,column:interaction_api_requests.platform,column:interaction_api_requests.request_id,column:interaction_api_requests.resource_id
-- aidcp:objects=column:interaction_api_requests.response,column:interaction_api_requests.status,column:interaction_api_requests.updated_at,column:interaction_audit_events.account_id
-- aidcp:objects=column:interaction_audit_events.action,column:interaction_audit_events.actor,column:interaction_audit_events.config_version,column:interaction_audit_events.created_at
-- aidcp:objects=column:interaction_audit_events.entity_id,column:interaction_audit_events.entity_type,column:interaction_audit_events.env_key,column:interaction_audit_events.event_id
-- aidcp:objects=column:interaction_audit_events.labels,column:interaction_audit_events.platform,column:interaction_audit_events.summary,column:interaction_auth_state.account_id
-- aidcp:objects=column:interaction_auth_state.active_since,column:interaction_auth_state.browser_state,column:interaction_auth_state.capabilities,column:interaction_auth_state.checked_at
-- aidcp:objects=column:interaction_auth_state.env_key,column:interaction_auth_state.identity,column:interaction_auth_state.platform,column:interaction_auth_state.reason_code
-- aidcp:objects=column:interaction_auth_state.status,column:interaction_auth_state.updated_at,column:interaction_messages.account_id,column:interaction_messages.attachment_meta
-- aidcp:objects=column:interaction_messages.channel,column:interaction_messages.content_text,column:interaction_messages.created_at,column:interaction_messages.direction
-- aidcp:objects=column:interaction_messages.env_key,column:interaction_messages.external_message_id,column:interaction_messages.external_parent_id,column:interaction_messages.external_root_id
-- aidcp:objects=column:interaction_messages.id,column:interaction_messages.lifecycle,column:interaction_messages.message_type,column:interaction_messages.platform
-- aidcp:objects=column:interaction_messages.platform_created_at,column:interaction_messages.raw_meta_sanitized,column:interaction_messages.thread_id,column:interaction_messages.updated_at
-- aidcp:objects=column:interaction_reply_config_versions.account_id,column:interaction_reply_config_versions.config_version,column:interaction_reply_config_versions.created_at,column:interaction_reply_config_versions.created_by
-- aidcp:objects=column:interaction_reply_config_versions.platform,column:interaction_reply_config_versions.policy,column:interaction_reply_config_versions.published_at,column:interaction_reply_config_versions.published_by
-- aidcp:objects=column:interaction_reply_config_versions.state,column:interaction_reply_configs.account_id,column:interaction_reply_configs.current_version,column:interaction_reply_configs.draft_version
-- aidcp:objects=column:interaction_reply_configs.platform,column:interaction_reply_configs.published_version,column:interaction_reply_configs.updated_at,column:interaction_reply_configs.updated_by
-- aidcp:objects=column:interaction_reply_jobs.account_id,column:interaction_reply_jobs.approval_actor,column:interaction_reply_jobs.approved_at,column:interaction_reply_jobs.channel
-- aidcp:objects=column:interaction_reply_jobs.config_version,column:interaction_reply_jobs.created_at,column:interaction_reply_jobs.env_key,column:interaction_reply_jobs.expires_at
-- aidcp:objects=column:interaction_reply_jobs.final_text,column:interaction_reply_jobs.id,column:interaction_reply_jobs.idempotency_key,column:interaction_reply_jobs.inbound_message_id
-- aidcp:objects=column:interaction_reply_jobs.introduced_claims,column:interaction_reply_jobs.last_error_code,column:interaction_reply_jobs.matched_rule_id,column:interaction_reply_jobs.meaning_changed
-- aidcp:objects=column:interaction_reply_jobs.platform,column:interaction_reply_jobs.polished_text,column:interaction_reply_jobs.rendered_text,column:interaction_reply_jobs.risk_level
-- aidcp:objects=column:interaction_reply_jobs.risk_reasons,column:interaction_reply_jobs.state,column:interaction_reply_jobs.template_id,column:interaction_reply_jobs.template_version
-- aidcp:objects=column:interaction_reply_jobs.updated_at,column:interaction_reply_jobs.version,column:interaction_runtime_controls.account_id,column:interaction_runtime_controls.circuit_opened_at
-- aidcp:objects=column:interaction_runtime_controls.comments_read_enabled,column:interaction_runtime_controls.comments_reply_enabled,column:interaction_runtime_controls.consecutive_failures,column:interaction_runtime_controls.dm_read_enabled
-- aidcp:objects=column:interaction_runtime_controls.dm_send_image_enabled,column:interaction_runtime_controls.dm_send_text_enabled,column:interaction_runtime_controls.env_key,column:interaction_runtime_controls.last_confirmed_at
-- aidcp:objects=column:interaction_runtime_controls.platform,column:interaction_runtime_controls.updated_at,column:interaction_runtime_controls.updated_by,column:interaction_runtime_controls.version
-- aidcp:objects=column:interaction_runtime_controls.write_paused,column:interaction_send_attempts.account_id,column:interaction_send_attempts.attempt_no,column:interaction_send_attempts.channel
-- aidcp:objects=column:interaction_send_attempts.dispatched_at,column:interaction_send_attempts.env_key,column:interaction_send_attempts.error_category,column:interaction_send_attempts.error_code
-- aidcp:objects=column:interaction_send_attempts.error_summary,column:interaction_send_attempts.external_message_id,column:interaction_send_attempts.finished_at,column:interaction_send_attempts.id
-- aidcp:objects=column:interaction_send_attempts.idempotency_key,column:interaction_send_attempts.platform,column:interaction_send_attempts.reply_job_id,column:interaction_send_attempts.risk_recorded_at
-- aidcp:objects=column:interaction_send_attempts.started_at,column:interaction_send_attempts.status,column:interaction_send_attempts.verification_status,column:interaction_sync_batches.account_id
-- aidcp:objects=column:interaction_sync_batches.ack_status,column:interaction_sync_batches.batch_id,column:interaction_sync_batches.channel,column:interaction_sync_batches.cursor_after
-- aidcp:objects=column:interaction_sync_batches.cursor_before,column:interaction_sync_batches.env_key,column:interaction_sync_batches.has_more,column:interaction_sync_batches.id
-- aidcp:objects=column:interaction_sync_batches.observed_at,column:interaction_sync_batches.persisted_messages,column:interaction_sync_batches.persisted_threads,column:interaction_sync_batches.platform
-- aidcp:objects=column:interaction_sync_batches.received_at,column:interaction_sync_batches.request_id,column:interaction_sync_batches.scope_external_id,column:interaction_sync_cursors.account_id
-- aidcp:objects=column:interaction_sync_cursors.channel,column:interaction_sync_cursors.cursor,column:interaction_sync_cursors.env_key,column:interaction_sync_cursors.id
-- aidcp:objects=column:interaction_sync_cursors.last_batch_id,column:interaction_sync_cursors.last_success_at,column:interaction_sync_cursors.platform,column:interaction_sync_cursors.schema_version
-- aidcp:objects=column:interaction_sync_cursors.scope_external_id,column:interaction_sync_cursors.updated_at,column:interaction_threads.account_id,column:interaction_threads.channel
-- aidcp:objects=column:interaction_threads.created_at,column:interaction_threads.env_key,column:interaction_threads.external_thread_id,column:interaction_threads.id
-- aidcp:objects=column:interaction_threads.last_message_at,column:interaction_threads.last_synced_at,column:interaction_threads.participant_avatar_url,column:interaction_threads.participant_external_id
-- aidcp:objects=column:interaction_threads.participant_name,column:interaction_threads.platform,column:interaction_threads.source_cover_url,column:interaction_threads.source_external_id
-- aidcp:objects=column:interaction_threads.source_title,column:interaction_threads.status,column:interaction_threads.updated_at,column:reply_rules.account_id
-- aidcp:objects=column:reply_rules.actions,column:reply_rules.channel,column:reply_rules.conditions,column:reply_rules.config_version
-- aidcp:objects=column:reply_rules.enabled,column:reply_rules.name,column:reply_rules.platform,column:reply_rules.priority
-- aidcp:objects=column:reply_rules.rule_id,column:reply_rules.updated_at,column:reply_rules.updated_by,column:reply_templates.account_id
-- aidcp:objects=column:reply_templates.archived,column:reply_templates.channel,column:reply_templates.config_version,column:reply_templates.content
-- aidcp:objects=column:reply_templates.enabled,column:reply_templates.name,column:reply_templates.platform,column:reply_templates.template_id
-- aidcp:objects=column:reply_templates.template_version,column:reply_templates.updated_at,column:reply_templates.updated_by,column:reply_templates.variables
-- aidcp:objects=index:idx_interaction_api_requests_scope,index:idx_interaction_audit_account_time,index:idx_interaction_messages_retention,index:idx_interaction_messages_scope_thread_time
-- aidcp:objects=index:idx_interaction_reply_jobs_recovery,index:idx_interaction_reply_jobs_scope_state,index:idx_interaction_send_attempts_recovery,index:idx_interaction_send_attempts_scope_time
-- aidcp:objects=index:idx_interaction_sync_batches_scope,index:idx_interaction_sync_cursors_env,index:idx_interaction_threads_scope_channel_state,index:idx_interaction_threads_scope_time
-- aidcp:objects=index:idx_reply_rules_match,index:uq_interaction_send_attempts_active_job,index:uq_interaction_sync_cursors_scope,table:account_reply_profiles
-- aidcp:objects=table:interaction_api_requests,table:interaction_audit_events,table:interaction_auth_state,table:interaction_messages
-- aidcp:objects=table:interaction_reply_config_versions,table:interaction_reply_configs,table:interaction_reply_jobs,table:interaction_runtime_controls
-- aidcp:objects=table:interaction_send_attempts,table:interaction_sync_batches,table:interaction_sync_cursors,table:interaction_threads
-- aidcp:objects=table:reply_rules,table:reply_templates
-- 0039_interaction_inbox.sql
-- Session 02 / frozen contract v1 (control commit a678003).
-- Additive inbound interaction domain. It is deliberately separate from the
-- outbound interaction_feed display ledger.

CREATE TABLE IF NOT EXISTS interaction_threads (
  id                       TEXT PRIMARY KEY,
  platform                 TEXT NOT NULL CHECK (platform = 'wechat_channels'),
  account_id               TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  env_key                  TEXT NOT NULL,
  channel                  TEXT NOT NULL CHECK (channel IN ('comment', 'dm')),
  external_thread_id       TEXT NOT NULL,
  source_external_id       TEXT,
  source_title             TEXT,
  source_cover_url         TEXT,
  participant_external_id  TEXT,
  participant_name         TEXT,
  participant_avatar_url   TEXT,
  status                   TEXT NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open','waiting_review','replied','escalated','closed')),
  last_message_at          TIMESTAMPTZ NOT NULL,
  last_synced_at           TIMESTAMPTZ NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, account_id, channel, external_thread_id),
  UNIQUE (id, account_id, env_key)
);
CREATE INDEX IF NOT EXISTS idx_interaction_threads_scope_time
  ON interaction_threads (account_id, env_key, last_message_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_interaction_threads_scope_channel_state
  ON interaction_threads (account_id, env_key, channel, status, last_message_at DESC);

CREATE TABLE IF NOT EXISTS interaction_messages (
  id                       TEXT PRIMARY KEY,
  thread_id                TEXT NOT NULL,
  platform                 TEXT NOT NULL CHECK (platform = 'wechat_channels'),
  account_id               TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  env_key                  TEXT NOT NULL,
  channel                  TEXT NOT NULL CHECK (channel IN ('comment', 'dm')),
  direction                TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  external_message_id      TEXT NOT NULL,
  external_parent_id       TEXT,
  external_root_id         TEXT,
  message_type             TEXT NOT NULL CHECK (message_type IN ('text','image','unknown')),
  content_text             TEXT,
  attachment_meta          JSONB,
  lifecycle                TEXT NOT NULL DEFAULT 'active'
                           CHECK (lifecycle IN ('active','deleted','hidden')),
  platform_created_at      TIMESTAMPTZ NOT NULL,
  raw_meta_sanitized       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, account_id, channel, direction, external_message_id),
  UNIQUE (id, account_id, env_key),
  FOREIGN KEY (thread_id, account_id, env_key)
    REFERENCES interaction_threads(id, account_id, env_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_interaction_messages_scope_thread_time
  ON interaction_messages (account_id, env_key, thread_id, platform_created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_interaction_messages_retention
  ON interaction_messages (channel, platform_created_at);

CREATE TABLE IF NOT EXISTS interaction_sync_batches (
  id                       TEXT PRIMARY KEY,
  platform                 TEXT NOT NULL CHECK (platform = 'wechat_channels'),
  account_id               TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  env_key                  TEXT NOT NULL,
  batch_id                 TEXT NOT NULL,
  request_id               TEXT,
  channel                  TEXT NOT NULL CHECK (channel IN ('comment', 'dm')),
  scope_external_id        TEXT,
  cursor_before            TEXT,
  cursor_after             TEXT,
  has_more                 BOOLEAN NOT NULL,
  ack_status               TEXT NOT NULL CHECK (ack_status IN ('accepted')),
  persisted_threads        INTEGER NOT NULL CHECK (persisted_threads >= 0),
  persisted_messages       INTEGER NOT NULL CHECK (persisted_messages >= 0),
  observed_at              TIMESTAMPTZ NOT NULL,
  received_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, account_id, batch_id)
);
CREATE INDEX IF NOT EXISTS idx_interaction_sync_batches_scope
  ON interaction_sync_batches (account_id, env_key, received_at DESC);

CREATE TABLE IF NOT EXISTS interaction_sync_cursors (
  id                       TEXT PRIMARY KEY,
  platform                 TEXT NOT NULL CHECK (platform = 'wechat_channels'),
  account_id               TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  env_key                  TEXT NOT NULL,
  channel                  TEXT NOT NULL CHECK (channel IN ('comment', 'dm')),
  scope_external_id        TEXT,
  cursor                   TEXT,
  last_success_at          TIMESTAMPTZ NOT NULL,
  last_batch_id            TEXT NOT NULL,
  schema_version           INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_interaction_sync_cursors_scope
  ON interaction_sync_cursors (platform, account_id, channel, COALESCE(scope_external_id, ''));
CREATE INDEX IF NOT EXISTS idx_interaction_sync_cursors_env
  ON interaction_sync_cursors (account_id, env_key, channel);

CREATE TABLE IF NOT EXISTS interaction_reply_jobs (
  id                       TEXT PRIMARY KEY,
  platform                 TEXT NOT NULL CHECK (platform = 'wechat_channels'),
  account_id               TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  env_key                  TEXT NOT NULL,
  channel                  TEXT NOT NULL CHECK (channel IN ('comment', 'dm')),
  inbound_message_id       TEXT NOT NULL UNIQUE,
  state                    TEXT NOT NULL DEFAULT 'new'
                           CHECK (state IN ('new','classifying','draft_ready','approval_required','approved','queued','sending','sent','failed','ambiguous','ignored','escalated')),
  version                  INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  matched_rule_id          TEXT,
  config_version           INTEGER,
  template_id              TEXT,
  template_version         INTEGER,
  rendered_text            TEXT,
  polished_text            TEXT,
  final_text               TEXT,
  meaning_changed          BOOLEAN NOT NULL DEFAULT false,
  introduced_claims        JSONB NOT NULL DEFAULT '[]'::jsonb,
  risk_level               TEXT NOT NULL DEFAULT 'unknown'
                           CHECK (risk_level IN ('low','medium','high','unknown')),
  risk_reasons             JSONB NOT NULL DEFAULT '[]'::jsonb,
  approval_actor           TEXT,
  approved_at              TIMESTAMPTZ,
  idempotency_key          TEXT,
  last_error_code          TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at               TIMESTAMPTZ,
  UNIQUE (id, account_id, env_key),
  FOREIGN KEY (inbound_message_id, account_id, env_key)
    REFERENCES interaction_messages(id, account_id, env_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_interaction_reply_jobs_scope_state
  ON interaction_reply_jobs (account_id, env_key, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_interaction_reply_jobs_recovery
  ON interaction_reply_jobs (state, updated_at)
  WHERE state IN ('new','classifying','queued','sending','ambiguous');

CREATE TABLE IF NOT EXISTS interaction_send_attempts (
  id                       TEXT PRIMARY KEY,
  platform                 TEXT NOT NULL CHECK (platform = 'wechat_channels'),
  account_id               TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  env_key                  TEXT NOT NULL,
  channel                  TEXT NOT NULL CHECK (channel IN ('comment', 'dm')),
  reply_job_id             TEXT NOT NULL,
  attempt_no               INTEGER NOT NULL CHECK (attempt_no >= 1),
  idempotency_key          TEXT NOT NULL UNIQUE CHECK (idempotency_key ~ '^[a-f0-9]{64}$'),
  status                   TEXT NOT NULL DEFAULT 'created'
                           CHECK (status IN ('created','dispatched','confirmed','failed','ambiguous')),
  verification_status      TEXT NOT NULL DEFAULT 'not_needed'
                           CHECK (verification_status IN ('not_needed','pending','confirmed','not_found')),
  external_message_id      TEXT,
  error_category           TEXT,
  error_code               TEXT,
  retryable                BOOLEAN NOT NULL DEFAULT false,
  error_summary            TEXT,
  started_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at            TIMESTAMPTZ,
  finished_at              TIMESTAMPTZ,
  risk_recorded_at         TIMESTAMPTZ,
  UNIQUE (reply_job_id, attempt_no),
  UNIQUE (id, account_id, env_key),
  FOREIGN KEY (reply_job_id, account_id, env_key)
    REFERENCES interaction_reply_jobs(id, account_id, env_key) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_interaction_send_attempts_active_job
  ON interaction_send_attempts (reply_job_id)
  WHERE status IN ('created','dispatched','ambiguous');
CREATE UNIQUE INDEX IF NOT EXISTS uq_interaction_send_attempts_active_account
  ON interaction_send_attempts (account_id)
  WHERE status IN ('created','dispatched','ambiguous');
CREATE INDEX IF NOT EXISTS idx_interaction_send_attempts_scope_time
  ON interaction_send_attempts (account_id, env_key, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_interaction_send_attempts_recovery
  ON interaction_send_attempts (status, started_at)
  WHERE status IN ('created','dispatched','ambiguous');

CREATE TABLE IF NOT EXISTS interaction_auth_state (
  platform                 TEXT NOT NULL CHECK (platform = 'wechat_channels'),
  account_id               TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  env_key                  TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('login_required','authenticating','active','reauth_required','challenge_required','degraded','disabled')),
  browser_state            TEXT NOT NULL CHECK (browser_state IN ('closed','opening','open','closing','unavailable')),
  capabilities             JSONB NOT NULL,
  identity                 JSONB,
  reason_code              TEXT,
  checked_at               TIMESTAMPTZ NOT NULL,
  active_since             TIMESTAMPTZ,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, account_id),
  UNIQUE (platform, env_key)
);

CREATE TABLE IF NOT EXISTS interaction_runtime_controls (
  platform                 TEXT NOT NULL CHECK (platform = 'wechat_channels'),
  account_id               TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  env_key                  TEXT,
  version                  INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  comments_read_enabled    BOOLEAN NOT NULL DEFAULT false,
  comments_reply_enabled   BOOLEAN NOT NULL DEFAULT false,
  dm_read_enabled          BOOLEAN NOT NULL DEFAULT false,
  dm_send_text_enabled     BOOLEAN NOT NULL DEFAULT false,
  dm_send_image_enabled    BOOLEAN NOT NULL DEFAULT false CHECK (dm_send_image_enabled = false),
  write_paused             BOOLEAN NOT NULL DEFAULT true,
  consecutive_failures     INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  circuit_opened_at        TIMESTAMPTZ,
  last_confirmed_at        TIMESTAMPTZ,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by               TEXT NOT NULL DEFAULT 'system',
  PRIMARY KEY (platform, account_id)
);

CREATE TABLE IF NOT EXISTS interaction_reply_configs (
  platform                 TEXT NOT NULL CHECK (platform = 'wechat_channels'),
  account_id               TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  current_version          INTEGER NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  draft_version            INTEGER,
  published_version        INTEGER,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by               TEXT NOT NULL,
  PRIMARY KEY (platform, account_id)
);

CREATE TABLE IF NOT EXISTS interaction_reply_config_versions (
  platform                 TEXT NOT NULL CHECK (platform = 'wechat_channels'),
  account_id               TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  config_version           INTEGER NOT NULL CHECK (config_version >= 1),
  state                    TEXT NOT NULL CHECK (state IN ('draft','published')),
  policy                   JSONB NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by               TEXT NOT NULL,
  published_at             TIMESTAMPTZ,
  published_by             TEXT,
  PRIMARY KEY (platform, account_id, config_version)
);

CREATE TABLE IF NOT EXISTS reply_templates (
  platform                 TEXT NOT NULL CHECK (platform = 'wechat_channels'),
  account_id               TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  config_version           INTEGER NOT NULL CHECK (config_version >= 1),
  template_id              TEXT NOT NULL,
  channel                  TEXT NOT NULL CHECK (channel IN ('comment','dm')),
  name                     TEXT NOT NULL,
  content                  TEXT NOT NULL,
  enabled                  BOOLEAN NOT NULL,
  archived                 BOOLEAN NOT NULL DEFAULT false,
  template_version         INTEGER NOT NULL CHECK (template_version >= 1),
  variables                JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by               TEXT NOT NULL,
  PRIMARY KEY (platform, account_id, config_version, template_id),
  UNIQUE (platform, account_id, config_version, channel, template_id, template_version)
);

CREATE TABLE IF NOT EXISTS reply_rules (
  platform                 TEXT NOT NULL CHECK (platform = 'wechat_channels'),
  account_id               TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  config_version           INTEGER NOT NULL CHECK (config_version >= 1),
  rule_id                  TEXT NOT NULL,
  channel                  TEXT NOT NULL CHECK (channel IN ('comment','dm')),
  name                     TEXT NOT NULL,
  priority                 INTEGER NOT NULL CHECK (priority >= 0),
  enabled                  BOOLEAN NOT NULL,
  conditions               JSONB NOT NULL,
  actions                  JSONB NOT NULL,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by               TEXT NOT NULL,
  PRIMARY KEY (platform, account_id, config_version, rule_id)
);
CREATE INDEX IF NOT EXISTS idx_reply_rules_match
  ON reply_rules (platform, account_id, config_version, channel, priority, rule_id);

CREATE TABLE IF NOT EXISTS account_reply_profiles (
  platform                 TEXT NOT NULL CHECK (platform = 'wechat_channels'),
  account_id               TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  config_version           INTEGER NOT NULL CHECK (config_version >= 1),
  channel                  TEXT NOT NULL CHECK (channel IN ('comment','dm')),
  profile                  JSONB NOT NULL,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by               TEXT NOT NULL,
  PRIMARY KEY (platform, account_id, config_version, channel)
);

CREATE TABLE IF NOT EXISTS interaction_audit_events (
  event_id                 TEXT PRIMARY KEY,
  platform                 TEXT NOT NULL CHECK (platform = 'wechat_channels'),
  account_id               TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  env_key                  TEXT,
  actor                    TEXT NOT NULL,
  action                   TEXT NOT NULL,
  config_version           INTEGER,
  entity_type              TEXT NOT NULL,
  entity_id                TEXT,
  summary                  TEXT NOT NULL,
  labels                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_interaction_audit_account_time
  ON interaction_audit_events (account_id, created_at DESC, event_id DESC);

CREATE TABLE IF NOT EXISTS interaction_api_requests (
  request_id               TEXT PRIMARY KEY,
  actor                    TEXT NOT NULL,
  action                   TEXT NOT NULL,
  idempotency_key          TEXT NOT NULL,
  platform                 TEXT NOT NULL CHECK (platform = 'wechat_channels'),
  account_id               TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  env_key                  TEXT NOT NULL,
  resource_id              TEXT,
  status                   TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed')),
  response                 JSONB,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (actor, action, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_interaction_api_requests_scope
  ON interaction_api_requests (account_id, env_key, created_at DESC);

-- dm_reply is intentionally quota-only (no per-note risk_interactions row).
-- Its hardcoded fallback quota is zero in all windows; operators must create an
-- explicit quota_config override before any DM write can pass RiskController.
DO $$
DECLARE constraint_name TEXT;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'risk_counters'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%action%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE risk_counters DROP CONSTRAINT %I', constraint_name);
  END IF;
  ALTER TABLE risk_counters ADD CONSTRAINT risk_counters_action_check
    CHECK (action IN ('like','collect','comment','follow','publish','view','comment_like','join_group','dm_reply'));
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;
