-- aidcp:kind=expand
-- aidcp:objects=column:account_facebook_comment_config.account_id,column:account_facebook_comment_config.containers,column:account_facebook_comment_config.keywords,column:account_facebook_comment_config.updated_at
-- aidcp:objects=column:account_facebook_comment_config.updated_by,table:account_facebook_comment_config
-- 0034_facebook_comment_config.sql
-- change facebook-scheduled-comment (2.1): per-account Facebook scheduled-comment target config.
-- Keyword list + allowed-container list (operator's own / joined Pages and Groups).
-- Execution picks a keyword at random and searches ONLY within a configured container.
-- fail-closed: keywords or containers empty => config not effective (honest no-op).
-- Idempotent; verbatim-same as FACEBOOK_COMMENT_CONFIG_SCHEMA_SQL in
-- src/config/facebook-comment-config-store.ts (the store self-heals via CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS account_facebook_comment_config (
  account_id  TEXT PRIMARY KEY,
  keywords    JSONB NOT NULL DEFAULT '[]'::jsonb,
  containers  JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);
