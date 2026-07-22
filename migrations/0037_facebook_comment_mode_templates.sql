-- aidcp:kind=expand
-- aidcp:objects=column:account_facebook_comment_config.comment_mode,column:account_facebook_comment_config.comment_templates
-- 0037_facebook_comment_mode_templates.sql
-- facebook-joined-group-template-comments: add per-account Facebook comment body mode and templates.
-- Idempotent; same columns are also self-healed by FACEBOOK_COMMENT_CONFIG_SCHEMA_SQL.

ALTER TABLE account_facebook_comment_config ADD COLUMN IF NOT EXISTS comment_mode TEXT NOT NULL DEFAULT 'generated';
ALTER TABLE account_facebook_comment_config ADD COLUMN IF NOT EXISTS comment_templates JSONB NOT NULL DEFAULT '[]'::jsonb;
