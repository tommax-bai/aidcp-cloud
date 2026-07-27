-- aidcp:kind=expand
-- aidcp:objects=column:account_facebook_comment_config.comment_mode_configured
--
-- Preserve the meaning of every pre-existing persisted mode as an explicit
-- operator choice. New rows default to "not explicitly configured" unless the
-- application write carries commentMode and sets the flag in the same upsert.

ALTER TABLE account_facebook_comment_config
  ADD COLUMN IF NOT EXISTS comment_mode_configured BOOLEAN;

UPDATE account_facebook_comment_config
   SET comment_mode_configured = true
 WHERE comment_mode_configured IS NULL;

ALTER TABLE account_facebook_comment_config
  ALTER COLUMN comment_mode_configured SET DEFAULT false;
