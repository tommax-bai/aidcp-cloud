-- aidcp:kind=expand
-- aidcp:objects=column:publish_log.schedule_last_error,column:publish_log.schedule_next_reconcile_at,column:publish_log.schedule_reconcile_attempts,column:publish_log.scheduled_at
-- aidcp:objects=column:publish_log.scheduled_platform_id,index:idx_publish_log_scheduled_due
-- change xhs-native-scheduled-publish: distinguish platform-accepted schedules from public notes.
ALTER TABLE publish_log DROP CONSTRAINT IF EXISTS publish_log_status_check;
ALTER TABLE publish_log ADD CONSTRAINT publish_log_status_check
  CHECK (status IN ('draft','pending_approval','scheduled','submitted','published','failed','needs_review'));

ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS scheduled_platform_id TEXT;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS schedule_reconcile_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS schedule_next_reconcile_at TIMESTAMPTZ;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS schedule_last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_publish_log_scheduled_due
  ON publish_log (schedule_next_reconcile_at, id)
  WHERE status = 'scheduled';

