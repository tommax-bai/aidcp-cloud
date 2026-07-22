-- aidcp:kind=expand
-- aidcp:objects=column:interaction_reply_config_scopes.current_version,column:interaction_reply_config_scopes.draft_version,column:interaction_reply_config_scopes.group_label,column:interaction_reply_config_scopes.platform
-- aidcp:objects=column:interaction_reply_config_scopes.published_version,column:interaction_reply_config_scopes.scope_id,column:interaction_reply_config_scopes.scope_type,column:interaction_reply_config_scopes.updated_at
-- aidcp:objects=column:interaction_reply_config_scopes.updated_by,column:interaction_reply_jobs.config_scope_id,column:interaction_reply_scope_audit.action,column:interaction_reply_scope_audit.actor
-- aidcp:objects=column:interaction_reply_scope_audit.config_version,column:interaction_reply_scope_audit.created_at,column:interaction_reply_scope_audit.entity_id,column:interaction_reply_scope_audit.entity_type
-- aidcp:objects=column:interaction_reply_scope_audit.event_id,column:interaction_reply_scope_audit.labels,column:interaction_reply_scope_audit.scope_id,column:interaction_reply_scope_audit.summary
-- aidcp:objects=column:interaction_reply_scope_versions.config_version,column:interaction_reply_scope_versions.created_at,column:interaction_reply_scope_versions.created_by,column:interaction_reply_scope_versions.policy
-- aidcp:objects=column:interaction_reply_scope_versions.profiles,column:interaction_reply_scope_versions.published_at,column:interaction_reply_scope_versions.published_by,column:interaction_reply_scope_versions.rules
-- aidcp:objects=column:interaction_reply_scope_versions.scope_id,column:interaction_reply_scope_versions.state,column:interaction_reply_scope_versions.templates,index:idx_interaction_reply_jobs_config_scope
-- aidcp:objects=index:idx_reply_scope_audit_time,index:uq_reply_config_scope_default,index:uq_reply_config_scope_group,table:interaction_reply_config_scopes
-- aidcp:objects=table:interaction_reply_scope_audit,table:interaction_reply_scope_versions
-- 0048_wechat_group_reply_config.sql
-- Additive, rollback-safe storage for shared WeChat Channels reply configuration.
-- Legacy account-scoped tables from 0039 remain untouched and readable during migration.

CREATE TABLE IF NOT EXISTS interaction_reply_config_scopes (
  scope_id                  TEXT PRIMARY KEY,
  platform                  TEXT NOT NULL CHECK (platform = 'wechat_channels'),
  scope_type                TEXT NOT NULL CHECK (scope_type IN ('group','default')),
  group_label               TEXT,
  current_version           INTEGER NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  draft_version             INTEGER,
  published_version         INTEGER,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                TEXT NOT NULL,
  CHECK (
    (scope_type = 'group' AND group_label IS NOT NULL AND btrim(group_label) <> '') OR
    (scope_type = 'default' AND group_label IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reply_config_scope_group
  ON interaction_reply_config_scopes (platform, group_label)
  WHERE scope_type = 'group';
CREATE UNIQUE INDEX IF NOT EXISTS uq_reply_config_scope_default
  ON interaction_reply_config_scopes (platform)
  WHERE scope_type = 'default';

CREATE TABLE IF NOT EXISTS interaction_reply_scope_versions (
  scope_id                  TEXT NOT NULL REFERENCES interaction_reply_config_scopes(scope_id) ON DELETE CASCADE,
  config_version            INTEGER NOT NULL CHECK (config_version >= 1),
  state                     TEXT NOT NULL CHECK (state IN ('draft','published')),
  policy                    JSONB NOT NULL,
  templates                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  rules                     JSONB NOT NULL DEFAULT '[]'::jsonb,
  profiles                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by                TEXT NOT NULL,
  published_at              TIMESTAMPTZ,
  published_by              TEXT,
  PRIMARY KEY (scope_id, config_version)
);

CREATE TABLE IF NOT EXISTS interaction_reply_scope_audit (
  event_id                  TEXT PRIMARY KEY,
  scope_id                  TEXT NOT NULL REFERENCES interaction_reply_config_scopes(scope_id) ON DELETE CASCADE,
  actor                     TEXT NOT NULL,
  action                    TEXT NOT NULL,
  config_version            INTEGER,
  entity_type               TEXT NOT NULL,
  entity_id                 TEXT,
  summary                   TEXT NOT NULL,
  labels                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reply_scope_audit_time
  ON interaction_reply_scope_audit (scope_id, created_at DESC, event_id DESC);

ALTER TABLE interaction_reply_jobs
  ADD COLUMN IF NOT EXISTS config_scope_id TEXT REFERENCES interaction_reply_config_scopes(scope_id);
CREATE INDEX IF NOT EXISTS idx_interaction_reply_jobs_config_scope
  ON interaction_reply_jobs (config_scope_id, config_version)
  WHERE config_scope_id IS NOT NULL;
