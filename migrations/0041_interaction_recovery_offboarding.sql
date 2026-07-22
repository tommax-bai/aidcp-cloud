-- aidcp:kind=contract
-- aidcp:objects=column:interaction_auth_state.offboarded_at,column:interaction_offboard_audit.account_id,column:interaction_offboard_audit.created_at,column:interaction_offboard_audit.env_key
-- aidcp:objects=column:interaction_offboard_audit.event,column:interaction_offboard_audit.event_id,column:interaction_offboard_audit.offboard_id,column:interaction_offboard_audit.platform
-- aidcp:objects=column:interaction_offboard_audit.status,column:interaction_offboard_audit.user_id,column:interaction_offboards.account_id,column:interaction_offboards.dispatch_attempts
-- aidcp:objects=column:interaction_offboards.edge_cleared_at,column:interaction_offboards.edge_result_status,column:interaction_offboards.env_key,column:interaction_offboards.last_dispatched_at
-- aidcp:objects=column:interaction_offboards.last_error_code,column:interaction_offboards.offboard_id,column:interaction_offboards.platform,column:interaction_offboards.purge_due_at
-- aidcp:objects=column:interaction_offboards.purged_at,column:interaction_offboards.reason,column:interaction_offboards.requested_at,column:interaction_offboards.state
-- aidcp:objects=column:interaction_offboards.tombstoned_at,column:interaction_offboards.updated_at,column:interaction_offboards.user_id,column:interaction_send_attempts.last_reconciled_at
-- aidcp:objects=column:interaction_send_attempts.reconciliation_state,index:idx_interaction_offboard_audit_scope_time,index:idx_interaction_offboards_dispatch,index:uq_interaction_offboards_active_env
-- aidcp:objects=index:uq_interaction_send_attempts_dispatching_account,table:interaction_offboard_audit,table:interaction_offboards
-- 0041_interaction_recovery_offboarding.sql
-- Durable Edge result acknowledgement/reconciliation and explicit offboarding.

ALTER TABLE interaction_send_attempts
  ADD COLUMN IF NOT EXISTS reconciliation_state TEXT
    CHECK (reconciliation_state IS NULL OR reconciliation_state IN ('result_replayed','not_found','binding_conflict')),
  ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ;

-- An ambiguous attempt remains active for its own job (no blind resend), but it
-- must not serialize every later job for the account forever.
-- Install the replacement before removing the legacy, stricter predicate. If
-- deployment stops between the two statements the account remains fail-closed;
-- there is never a window without created/dispatched serialization.
CREATE UNIQUE INDEX IF NOT EXISTS uq_interaction_send_attempts_dispatching_account
  ON interaction_send_attempts (account_id)
  WHERE status IN ('created','dispatched');
DROP INDEX IF EXISTS uq_interaction_send_attempts_active_account;

CREATE TABLE IF NOT EXISTS interaction_offboards (
  offboard_id              TEXT PRIMARY KEY,
  platform                 TEXT NOT NULL CHECK (platform = 'wechat_channels'),
  account_id               TEXT NOT NULL,
  env_key                  TEXT NOT NULL,
  user_id                  TEXT,
  reason                   TEXT NOT NULL CHECK (reason IN ('environment_unbind','customer_terminated','admin_revoked')),
  state                    TEXT NOT NULL DEFAULT 'pending_edge'
                           CHECK (state IN ('pending_edge','dispatched','tombstoned','purged')),
  edge_result_status       TEXT CHECK (edge_result_status IS NULL OR edge_result_status IN ('cleared','already_cleared','failed')),
  last_error_code          TEXT,
  dispatch_attempts        INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  requested_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_dispatched_at       TIMESTAMPTZ,
  edge_cleared_at          TIMESTAMPTZ,
  tombstoned_at            TIMESTAMPTZ,
  purge_due_at             TIMESTAMPTZ NOT NULL CHECK (purge_due_at <= requested_at + interval '30 days'),
  purged_at                TIMESTAMPTZ,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_interaction_offboards_active_env
  ON interaction_offboards (platform, env_key) WHERE state <> 'purged';
CREATE INDEX IF NOT EXISTS idx_interaction_offboards_dispatch
  ON interaction_offboards (state, updated_at) WHERE state IN ('pending_edge','dispatched');
CREATE INDEX IF NOT EXISTS idx_interaction_offboards_purge
  ON interaction_offboards (purge_due_at) WHERE state = 'tombstoned';

CREATE TABLE IF NOT EXISTS interaction_offboard_audit (
  event_id                 TEXT PRIMARY KEY,
  offboard_id              TEXT NOT NULL,
  platform                 TEXT NOT NULL CHECK (platform = 'wechat_channels'),
  account_id               TEXT NOT NULL,
  env_key                  TEXT NOT NULL,
  user_id                  TEXT,
  event                    TEXT NOT NULL,
  status                   TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_interaction_offboard_audit_scope_time
  ON interaction_offboard_audit (env_key, created_at DESC, event_id DESC);

ALTER TABLE interaction_auth_state
  ADD COLUMN IF NOT EXISTS offboarded_at TIMESTAMPTZ;

ALTER TABLE client_env_scope_audit DROP CONSTRAINT IF EXISTS client_env_scope_audit_reason_check;
ALTER TABLE client_env_scope_audit
  ADD CONSTRAINT client_env_scope_audit_reason_check
  CHECK (reason IN ('legacy_self_claim','scope_replaced','environment_unbind','customer_terminated','admin_revoked'));
