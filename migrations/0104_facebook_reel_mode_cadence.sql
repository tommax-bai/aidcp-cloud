-- 0104_facebook_reel_mode_cadence.sql
-- aidcp:kind=expand
-- aidcp:objects=column:facebook_operation_global_policy.persona_reel_views_per_like,column:facebook_operation_global_policy.persona_reel_views_per_follow
-- aidcp:objects=column:facebook_operation_global_policy.slow_start_reel_views_per_follow,column:facebook_operation_global_policy.rule_reel_views_per_follow,column:facebook_operation_global_policy.consumption_reel_views_per_follow

ALTER TABLE facebook_operation_global_policy
  ADD COLUMN IF NOT EXISTS persona_reel_views_per_like INTEGER NOT NULL DEFAULT 4
    CHECK (persona_reel_views_per_like BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS persona_reel_views_per_follow INTEGER NOT NULL DEFAULT 10
    CHECK (persona_reel_views_per_follow BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS slow_start_reel_views_per_follow INTEGER NOT NULL DEFAULT 15
    CHECK (slow_start_reel_views_per_follow BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS rule_reel_views_per_follow INTEGER NOT NULL DEFAULT 15
    CHECK (rule_reel_views_per_follow BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS consumption_reel_views_per_follow INTEGER NOT NULL DEFAULT 15
    CHECK (consumption_reel_views_per_follow BETWEEN 1 AND 100);
