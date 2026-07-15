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
