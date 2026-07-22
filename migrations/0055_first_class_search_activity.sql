-- aidcp:kind=expand
-- aidcp:objects=
-- Add platform search as an account-level risk fact without adding it to note-scoped interactions.

ALTER TABLE risk_counters DROP CONSTRAINT IF EXISTS risk_counters_action_check;
ALTER TABLE risk_counters ADD CONSTRAINT risk_counters_action_check
  CHECK (action IN ('like','collect','comment','follow','publish','view','search','comment_like','join_group','dm_reply'));

INSERT INTO quota_config (tier, action, daily, per_minute, per_hour, updated_by)
VALUES
  ('conservative', 'search', 5, 1, 4, 'migration:0055'),
  ('normal',       'search', 10, 1, 4, 'migration:0055'),
  ('aggressive',   'search', 20, 1, 4, 'migration:0055')
ON CONFLICT (tier, action) DO NOTHING;
