-- 0037_session_join_group_budget.sql
--
-- Add the Facebook group-join per-session budget to the global session-limit
-- singleton. Existing rows default to the conservative one-join-per-session cap.

ALTER TABLE session_config_global
  ADD COLUMN IF NOT EXISTS budget_join_groups INTEGER NOT NULL DEFAULT 1;
