-- aidcp:kind=expand
-- aidcp:objects=
-- One-time, customer-bound intents for the official Electron main process to
-- finish a freshly-created AdsPower environment. The proof is never stored in
-- plaintext; active ownership remains in client_env_scope and keeps the global
-- unique owner boundary installed by 0040.

CREATE TABLE IF NOT EXISTS client_env_provisioning_intents (
  intent_id         UUID        PRIMARY KEY,
  user_id           TEXT        NOT NULL REFERENCES client_users(user_id) ON DELETE CASCADE,
  proof_hash        CHAR(64)    NOT NULL,
  state             TEXT        NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed','expired')),
  expires_at        TIMESTAMPTZ NOT NULL,
  completed_env_key TEXT,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((state = 'completed') = (completed_env_key IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS client_env_provisioning_intents_user_idx
  ON client_env_provisioning_intents (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS client_env_provisioning_intents_expiry_idx
  ON client_env_provisioning_intents (expires_at) WHERE state = 'pending';

-- Assert the customer attach path cannot be reintroduced by this migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'client_env_scope'::regclass
       AND conname = 'client_env_scope_authoritative_source'
  ) THEN
    RAISE EXCEPTION 'client_env_scope_authoritative_source is required before provisioning intents';
  END IF;
  IF to_regclass('uq_client_env_scope_active_env') IS NULL THEN
    RAISE EXCEPTION 'uq_client_env_scope_active_env is required before provisioning intents';
  END IF;
END $$;
