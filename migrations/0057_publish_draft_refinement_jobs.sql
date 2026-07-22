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
