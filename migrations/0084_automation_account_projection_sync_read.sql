-- aidcp:kind=expand
-- aidcp:objects=column:automation_account_projection.created_at,column:automation_account_projection.status
--
-- 4b post-4a minimal B4 projection. Display/card fields stay API-local.
ALTER TABLE automation_account_projection
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

ALTER TABLE automation_account_projection
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'automation_account_projection_status_check'
  ) THEN
    ALTER TABLE automation_account_projection
      ADD CONSTRAINT automation_account_projection_status_check
      CHECK (status IN ('active', 'paused'));
  END IF;
END $$;
