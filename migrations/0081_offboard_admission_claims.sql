-- aidcp:kind=expand
-- aidcp:objects=column:client_env_revocation_holds.admission_revision
-- aidcp:objects=column:client_env_revocation_holds.claim_token,column:client_env_revocation_holds.claimed_by
-- aidcp:objects=column:client_env_revocation_holds.claim_expires_at
-- aidcp:objects=column:client_env_revocation_holds.execution_target
-- aidcp:objects=table:client_env_admission_command_receipts
-- aidcp:objects=table:client_env_admission_snapshot_state
-- aidcp:objects=index:client_env_revocation_holds_claimable_idx
--
-- change split-cloud-api-composition-root-4a：offboard reconcile 改由 automation 编排。
--
-- API 只保留 owner-local admission ledger primitives。claim 必须跨网络存活，因而不能靠
-- `FOR UPDATE SKIP LOCKED` 的事务锁跨 HTTP；revision + claim token + expiry 是最小持久形状。
-- command receipt 与 ledger 写同事务提交，用来在 ACK 丢失后按稳定 commandId 返回原始 receipt，
-- 不把重复 materialization、假 0 counts 或重新认领冒充成首次结果。
ALTER TABLE client_env_revocation_holds
  ADD COLUMN IF NOT EXISTS admission_revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS claim_token TEXT,
  ADD COLUMN IF NOT EXISTS claimed_by TEXT,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS execution_target TEXT;

ALTER TABLE client_env_revocation_holds
  DROP CONSTRAINT IF EXISTS client_env_revocation_holds_admission_revision_check;
ALTER TABLE client_env_revocation_holds
  ADD CONSTRAINT client_env_revocation_holds_admission_revision_check
  CHECK (admission_revision >= 1);

ALTER TABLE client_env_revocation_holds
  DROP CONSTRAINT IF EXISTS client_env_revocation_holds_claim_shape_check;
ALTER TABLE client_env_revocation_holds
  ADD CONSTRAINT client_env_revocation_holds_claim_shape_check
  CHECK (
    (claim_token IS NULL AND claimed_by IS NULL AND claim_expires_at IS NULL)
    OR
    (claim_token IS NOT NULL AND claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL)
  );

ALTER TABLE client_env_revocation_holds
  DROP CONSTRAINT IF EXISTS client_env_revocation_holds_execution_target_check;
ALTER TABLE client_env_revocation_holds
  ADD CONSTRAINT client_env_revocation_holds_execution_target_check
  CHECK (execution_target IS NULL OR execution_target IN ('dev','ol'));

-- Existing admissions predate target-local durable claiming. Guessing dev/ol here would let the
-- wrong worker materialize or release a shared business fact, while leaving NULL would strand it
-- behind every target-filtered scan. Stop with the first exact row so the operator can inspect the
-- owning account/runtime evidence and assign that row deliberately before rerunning 0081.
--
-- After the explicit legacy-row gate, make the durable-work dimension a database invariant. An old
-- writer that omits the new column during the rollout fails closed instead of silently creating work
-- that neither target can claim. The 4a writers also require a valid server-injected target, and
-- reconcile/claim retain a loud defensive gate for pre-migration or constraint-drift states.
DO $$
DECLARE
  unassigned_env_key TEXT;
BEGIN
  SELECT env_key
    INTO unassigned_env_key
    FROM client_env_revocation_holds
   WHERE execution_target IS NULL
   ORDER BY requested_at, env_key
   LIMIT 1;

  IF unassigned_env_key IS NOT NULL THEN
    RAISE EXCEPTION
      'offboard_admission_execution_target_backfill_required env_key=%: inspect owner evidence and assign execution_target=dev|ol before rerunning 0081',
      unassigned_env_key
      USING ERRCODE = '23514',
            CONSTRAINT = 'client_env_revocation_holds_execution_target_assignment';
  END IF;
END $$;

-- This remains an expand migration: the physical column cannot become NOT NULL until a later D6
-- contract change proves every deployed writer sends the new column. The 4a writer rejects a
-- missing/invalid server target before INSERT, and the owner ledger checks again before every
-- reconcile/claim operation, so a late rolling-deploy NULL stops loudly instead of being stranded.

CREATE INDEX IF NOT EXISTS client_env_revocation_holds_claimable_idx
  ON client_env_revocation_holds (execution_target, claim_expires_at, requested_at, env_key)
  WHERE materialized_at IS NULL;

CREATE TABLE IF NOT EXISTS client_env_admission_command_receipts (
  execution_target TEXT     NOT NULL CHECK (execution_target IN ('dev','ol')),
  command_id    TEXT        NOT NULL,
  capability    TEXT        NOT NULL
                CHECK (capability IN ('reconcile_snapshot','claim_materializations','record_receipt')),
  payload_hash  TEXT        NOT NULL,
  receipt       JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (execution_target, command_id)
);

-- A complete snapshot is destructive because rows absent from it release materialized holds.
-- Persisting a target/capability cursor prevents an older empty snapshot from deleting state
-- adopted by a newer observation after process restart or cross-process reordering.
CREATE TABLE IF NOT EXISTS client_env_admission_snapshot_state (
  execution_target TEXT     NOT NULL CHECK (execution_target IN ('dev','ol')),
  capability       TEXT     NOT NULL CHECK (capability = 'reconcile_snapshot'),
  observed_at_ms   BIGINT   NOT NULL CHECK (observed_at_ms >= 0),
  snapshot_digest  TEXT     NOT NULL,
  receipt          JSONB    NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (execution_target, capability)
);
