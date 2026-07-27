-- aidcp:kind=expand
-- aidcp:objects=column:automation_account_projection_state.sync_read_cursor,column:automation_account_projection_state.sync_read_payload_digest
-- aidcp:objects=column:automation_account_projection_state.sync_read_source_as_of_ms,constraint:automation_account_projection_state_sync_read_check
--
-- B4 delivery checkpoints are target-scoped, but the projection payload is
-- shared by dev/ol. Its applied cursor/digest therefore live on the existing
-- shared projection-state singleton and serialize both targets.

ALTER TABLE automation_account_projection_state
  ADD COLUMN IF NOT EXISTS sync_read_cursor NUMERIC;

ALTER TABLE automation_account_projection_state
  ADD COLUMN IF NOT EXISTS sync_read_payload_digest TEXT;

ALTER TABLE automation_account_projection_state
  ADD COLUMN IF NOT EXISTS sync_read_source_as_of_ms BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'automation_account_projection_state_sync_read_check'
  ) THEN
    ALTER TABLE automation_account_projection_state
      ADD CONSTRAINT automation_account_projection_state_sync_read_check
      CHECK (
        (
          sync_read_cursor IS NULL
          AND sync_read_payload_digest IS NULL
          AND sync_read_source_as_of_ms IS NULL
        )
        OR
        (
          sync_read_cursor IS NOT NULL
          AND sync_read_payload_digest IS NOT NULL
          AND sync_read_source_as_of_ms IS NOT NULL
          AND
          sync_read_cursor >= 0
          AND sync_read_cursor = trunc(sync_read_cursor)
          AND sync_read_payload_digest ~ '^sha256:[0-9a-f]{64}$'
          AND sync_read_source_as_of_ms >= 0
        )
      );
  END IF;
END $$;
