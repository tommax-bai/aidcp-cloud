-- user-delegated-tasks-phase-1
-- Runtime init uses the same idempotent schema from src/delegated-task/store.ts.

CREATE TABLE IF NOT EXISTS delegated_tasks (
  id UUID PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  account_name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('xiaohongshu','facebook')),
  action TEXT NOT NULL,
  action_family TEXT NOT NULL CHECK (action_family IN ('comment','publish','candidate_control')),
  target_success_count INTEGER NOT NULL CHECK (target_success_count > 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= target_success_count),
  deadline_at TIMESTAMPTZ NOT NULL,
  not_before TIMESTAMPTZ NOT NULL,
  execution_window JSONB NOT NULL DEFAULT '{}',
  source_constraints JSONB NOT NULL DEFAULT '{}',
  target_constraints JSONB NOT NULL DEFAULT '{}',
  approval_mode TEXT NOT NULL CHECK (approval_mode IN ('review','auto_approve','draft_only')),
  priority TEXT NOT NULL CHECK (priority IN ('normal','high')),
  source TEXT NOT NULL,
  source_ref TEXT,
  status TEXT NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  current_step TEXT,
  terminal_outcome JSONB,
  pause_requested BOOLEAN NOT NULL DEFAULT false,
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  next_eligible_at TIMESTAMPTZ,
  claim_token TEXT,
  claim_expires_at TIMESTAMPTZ,
  dedupe_key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  confirmed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_delegated_tasks_active_dedupe ON delegated_tasks(dedupe_key)
WHERE status IN ('draft','awaiting_confirmation','queued','planning','waiting_approval','executing','deferred');
CREATE INDEX IF NOT EXISTS idx_delegated_tasks_claim ON delegated_tasks(status,next_eligible_at,not_before,deadline_at,priority,created_at);
CREATE INDEX IF NOT EXISTS idx_delegated_tasks_ownership ON delegated_tasks(account_id,action_family,status);

CREATE TABLE IF NOT EXISTS delegated_task_events (
  id BIGSERIAL PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES delegated_tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_delegated_task_events_task ON delegated_task_events(task_id,id);

CREATE TABLE IF NOT EXISTS delegated_task_attempts (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES delegated_tasks(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  target_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared','dispatched','succeeded','skipped','failed','submitted_unknown')),
  verification_kind TEXT,
  evidence_ref TEXT,
  reason TEXT,
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE(task_id,ordinal),
  UNIQUE(task_id,target_key)
);
CREATE INDEX IF NOT EXISTS idx_delegated_task_attempts_reconcile ON delegated_task_attempts(task_id,status,prepared_at);
