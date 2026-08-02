-- 0107_facebook_slow_start_reel_like_cadence.sql
-- aidcp:kind=expand
-- aidcp:objects=column:facebook_operation_global_policy.slow_start_reel_views_per_like

ALTER TABLE facebook_operation_global_policy
  ADD COLUMN IF NOT EXISTS slow_start_reel_views_per_like INTEGER NOT NULL DEFAULT 15
    CHECK (slow_start_reel_views_per_like BETWEEN 1 AND 100);
