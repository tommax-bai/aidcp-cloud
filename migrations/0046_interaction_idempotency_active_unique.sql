-- aidcp:kind=contract
-- aidcp:objects=index:uq_interaction_send_attempts_active_idem
-- A completed send attempt must not prevent a later attempt from reusing the
-- deterministic reply idempotency key. Only attempts that can still reach the
-- platform retain the uniqueness slot.
ALTER TABLE interaction_send_attempts
  DROP CONSTRAINT IF EXISTS interaction_send_attempts_idempotency_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_interaction_send_attempts_active_idem
  ON interaction_send_attempts (idempotency_key)
  WHERE status IN ('created','dispatched','ambiguous');

-- This column was written but never consumed. Keeping it would falsely imply
-- that a recovery path exists, so migration 0046 removes the dead marker.
ALTER TABLE interaction_send_attempts
  DROP COLUMN IF EXISTS retryable;
