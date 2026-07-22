-- aidcp:kind=contract
-- aidcp:objects=index:idx_interaction_offboards_purge
-- Cloud purge is time-bounded independently of whether the Edge cleanup receipt arrives.
DROP INDEX IF EXISTS idx_interaction_offboards_purge;
CREATE INDEX idx_interaction_offboards_purge
  ON interaction_offboards (purge_due_at)
  WHERE state IN ('pending_edge','dispatched','tombstoned');
