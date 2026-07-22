-- aidcp:kind=expand
-- aidcp:objects=column:publish_draft_refinement_jobs.account_id,column:publish_draft_refinement_jobs.claim_expires_at,column:publish_draft_refinement_jobs.claim_token,column:publish_draft_refinement_jobs.completed_at
-- aidcp:objects=column:publish_draft_refinement_jobs.created_at,column:publish_draft_refinement_jobs.error_code,column:publish_draft_refinement_jobs.error_message,column:publish_draft_refinement_jobs.execution_target
-- aidcp:objects=column:publish_draft_refinement_jobs.expected_version,column:publish_draft_refinement_jobs.id,column:publish_draft_refinement_jobs.instruction,column:publish_draft_refinement_jobs.progress
-- aidcp:objects=column:publish_draft_refinement_jobs.record_id,column:publish_draft_refinement_jobs.result_version,column:publish_draft_refinement_jobs.scope,column:publish_draft_refinement_jobs.selection
-- aidcp:objects=column:publish_draft_refinement_jobs.status,column:publish_draft_refinement_jobs.updated_at,index:idx_publish_draft_refinement_account_record,index:idx_publish_draft_refinement_one_active
-- aidcp:objects=index:idx_publish_draft_refinement_target_claim,table:publish_draft_refinement_jobs
CREATE TABLE IF NOT EXISTS publish_draft_refinement_jobs (
  id                 UUID PRIMARY KEY,
  execution_target   TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  account_id         TEXT NOT NULL,
  record_id          INT NOT NULL REFERENCES publish_log(id) ON DELETE CASCADE,
  expected_version   INT NOT NULL CHECK (expected_version >= 0),
  scope              TEXT NOT NULL CHECK (scope IN ('whole','body','images','selected_image','selected_text')),
  instruction        TEXT NOT NULL,
  selection          JSONB,
  status             TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  progress           JSONB NOT NULL DEFAULT '[]'::jsonb,
  claim_token        UUID,
  claim_expires_at   TIMESTAMPTZ,
  result_version     INT,
  error_code         TEXT,
  error_message      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_publish_draft_refinement_target_claim
  ON publish_draft_refinement_jobs(execution_target, status, created_at);
CREATE INDEX IF NOT EXISTS idx_publish_draft_refinement_account_record
  ON publish_draft_refinement_jobs(execution_target, account_id, record_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_draft_refinement_one_active
  ON publish_draft_refinement_jobs(execution_target, record_id)
  WHERE status IN ('queued','running');
