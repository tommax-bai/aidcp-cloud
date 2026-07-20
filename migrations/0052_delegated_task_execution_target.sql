-- scope-delegated-tasks-by-cloud-target
-- dev/ol currently share PostgreSQL. Persist a trusted Cloud execution target so
-- one deployment cannot claim, recover, dedupe, or control the other's tasks.
-- The user explicitly confirmed that every pre-existing delegated task belongs to dev.

BEGIN;

ALTER TABLE delegated_tasks ADD COLUMN IF NOT EXISTS execution_target TEXT;

UPDATE delegated_tasks
   SET execution_target = 'dev'
 WHERE execution_target IS NULL;

ALTER TABLE delegated_tasks ALTER COLUMN execution_target SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'delegated_tasks'::regclass
       AND conname = 'delegated_tasks_execution_target_check'
  ) THEN
    ALTER TABLE delegated_tasks
      ADD CONSTRAINT delegated_tasks_execution_target_check
      CHECK (execution_target IN ('dev','ol'));
  END IF;
END $$;

DROP INDEX IF EXISTS idx_delegated_tasks_active_dedupe;
CREATE UNIQUE INDEX IF NOT EXISTS idx_delegated_tasks_target_active_dedupe
  ON delegated_tasks(execution_target, dedupe_key)
  WHERE status IN ('draft','awaiting_confirmation','queued','planning','waiting_approval','executing','deferred');

DROP INDEX IF EXISTS idx_delegated_tasks_claim;
CREATE INDEX IF NOT EXISTS idx_delegated_tasks_target_claim
  ON delegated_tasks(execution_target, status, next_eligible_at, not_before, deadline_at, priority, created_at);

DROP INDEX IF EXISTS idx_delegated_tasks_ownership;
CREATE INDEX IF NOT EXISTS idx_delegated_tasks_target_ownership
  ON delegated_tasks(execution_target, account_id, action_family, status);

COMMIT;
