-- bind-auto-publish-to-connected-environment
-- ContentScheduleStore.init() applies the same idempotent DDL at runtime.
-- This table is a latest-cell idempotency ledger, not a pending-work queue.

CREATE TABLE IF NOT EXISTS content_schedule_hour_claims (
  account_id       TEXT NOT NULL,
  action           TEXT NOT NULL CHECK (action = 'post'),
  hour_cell        TEXT NOT NULL,
  execution_target TEXT NOT NULL CHECK (execution_target IN ('dev', 'ol')),
  env_key          TEXT NOT NULL,
  claimed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, action)
);
