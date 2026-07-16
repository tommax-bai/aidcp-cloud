-- Distinguish persisted Cloud controls from the latest version Edge reports as applied.
ALTER TABLE interaction_auth_state
  ADD COLUMN IF NOT EXISTS runtime_controls_version INTEGER
  CHECK (runtime_controls_version IS NULL OR runtime_controls_version >= 0);
