-- aidcp:kind=expand
-- aidcp:objects=table:automation_sync_read_owner_generation,column:automation_sync_read_owner_generation.execution_target
-- aidcp:objects=column:automation_sync_read_owner_generation.stream,column:automation_sync_read_owner_generation.generation
-- aidcp:objects=column:automation_sync_read_owner_generation.payload_digest,column:automation_sync_read_owner_generation.last_emitted_generation
-- aidcp:objects=column:automation_sync_read_owner_generation.updated_at
--
-- Durable target-local cursor metadata for automation-owned runtime snapshots.
-- Business payload remains process-local; restart continuity uses only digest + generation.

CREATE TABLE IF NOT EXISTS automation_sync_read_owner_generation (
  execution_target        TEXT NOT NULL CHECK (execution_target IN ('dev', 'ol')),
  stream                  TEXT NOT NULL CHECK (
    stream IN (
      'edge_presence',
      'publish_in_flight',
      'captcha_availability',
      'automation_config_mirror_health'
    )
  ),
  generation              NUMERIC NOT NULL CHECK (
    generation >= 1 AND generation = trunc(generation)
  ),
  payload_digest          TEXT NOT NULL CHECK (
    payload_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  last_emitted_generation NUMERIC NOT NULL DEFAULT 0 CHECK (
    last_emitted_generation >= 0
    AND last_emitted_generation = trunc(last_emitted_generation)
    AND last_emitted_generation <= generation
  ),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (execution_target, stream)
);
