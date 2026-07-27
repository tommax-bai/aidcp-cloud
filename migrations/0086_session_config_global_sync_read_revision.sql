-- aidcp:kind=expand
-- aidcp:objects=column:session_config_global.sync_read_revision
--
-- A1 is a projection of the session_config_global singleton, so its durable
-- revision lives on that owner row rather than in a parallel authority table.
-- The owner UPSERT changes the revision in the same statement as the mask.

ALTER TABLE session_config_global
  ADD COLUMN IF NOT EXISTS sync_read_revision NUMERIC NOT NULL DEFAULT 0
  CHECK (
    sync_read_revision >= 0
    AND sync_read_revision = trunc(sync_read_revision)
  );
