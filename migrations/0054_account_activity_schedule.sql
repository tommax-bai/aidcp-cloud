-- aidcp:kind=expand
-- aidcp:objects=column:account_content_schedule.active_week_mask
-- account-activity-content-schedule
-- Optional per-account browse activity mask. NULL means inherit
-- session_config_global.active_week_mask; no backfill keeps existing behavior.
ALTER TABLE account_content_schedule
  ADD COLUMN IF NOT EXISTS active_week_mask TEXT;
