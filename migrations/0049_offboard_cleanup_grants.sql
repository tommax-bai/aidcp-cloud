-- aidcp:kind=expand
-- aidcp:objects=column:interaction_offboards.cleanup_grant_edge_id,column:interaction_offboards.cleanup_grant_expires_at,column:interaction_offboards.cleanup_grant_jti_hash,column:interaction_offboards.cleanup_grant_used_at
-- aidcp:objects=index:idx_interaction_offboards_cleanup_grant
-- 0049_offboard_cleanup_grants.sql
-- Short-lived, use-once cleanup bootstrap for browserless offboard recovery.

ALTER TABLE interaction_offboards
  ADD COLUMN IF NOT EXISTS cleanup_grant_jti_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS cleanup_grant_edge_id TEXT,
  ADD COLUMN IF NOT EXISTS cleanup_grant_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cleanup_grant_used_at TIMESTAMPTZ;

ALTER TABLE interaction_offboards DROP CONSTRAINT IF EXISTS interaction_offboards_cleanup_grant_shape;
ALTER TABLE interaction_offboards ADD CONSTRAINT interaction_offboards_cleanup_grant_shape CHECK (
  (cleanup_grant_jti_hash IS NULL AND cleanup_grant_edge_id IS NULL AND cleanup_grant_expires_at IS NULL)
  OR
  (cleanup_grant_jti_hash IS NOT NULL AND cleanup_grant_edge_id IS NOT NULL AND cleanup_grant_expires_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_interaction_offboards_cleanup_grant
  ON interaction_offboards (offboard_id, cleanup_grant_edge_id, cleanup_grant_expires_at)
  WHERE cleanup_grant_used_at IS NULL AND state IN ('pending_edge','dispatched');
