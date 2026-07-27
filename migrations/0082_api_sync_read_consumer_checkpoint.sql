-- aidcp:kind=expand
-- aidcp:objects=table:api_sync_read_consumer_checkpoint,column:api_sync_read_consumer_checkpoint.execution_target
-- aidcp:objects=column:api_sync_read_consumer_checkpoint.consumer,column:api_sync_read_consumer_checkpoint.stream
-- aidcp:objects=column:api_sync_read_consumer_checkpoint.applied_cursor,column:api_sync_read_consumer_checkpoint.payload_digest
-- aidcp:objects=column:api_sync_read_consumer_checkpoint.source_as_of_ms,column:api_sync_read_consumer_checkpoint.last_observed_at_ms
-- aidcp:objects=column:api_sync_read_consumer_checkpoint.fresh_until_ms,column:api_sync_read_consumer_checkpoint.last_applied_at_ms
-- aidcp:objects=column:api_sync_read_consumer_checkpoint.state,column:api_sync_read_consumer_checkpoint.last_error
-- aidcp:objects=column:api_sync_read_consumer_checkpoint.updated_at
--
-- change split-cloud-api-composition-root-4b：api 消费 automation 快照的本地恢复状态。
-- 这里只持久化 consumer delivery cursor/readiness/health；owner payload 与共享业务版本不进本表。
-- 0081 由并行的 4a offboard admission migration 占用，本 change 从 0082 继续，避免集成时同号。

CREATE TABLE IF NOT EXISTS api_sync_read_consumer_checkpoint (
  execution_target   TEXT NOT NULL CHECK (execution_target IN ('dev', 'ol')),
  consumer           TEXT NOT NULL CHECK (consumer = 'api'),
  stream             TEXT NOT NULL CHECK (
    stream IN (
      'session_config_global',
      'edge_presence',
      'publish_in_flight',
      'captcha_availability',
      'automation_config_mirror_health'
    )
  ),
  applied_cursor      NUMERIC,
  payload_digest      TEXT,
  source_as_of_ms     BIGINT,
  last_observed_at_ms BIGINT,
  fresh_until_ms      BIGINT,
  last_applied_at_ms  BIGINT,
  state               TEXT NOT NULL CHECK (
    state IN ('uninitialized', 'ready', 'stale', 'invalid', 'recovering')
  ),
  last_error          TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (execution_target, consumer, stream),
  CHECK (
    applied_cursor IS NULL
    OR (applied_cursor >= 0 AND applied_cursor = trunc(applied_cursor))
  ),
  CHECK (payload_digest IS NULL OR payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (
    (
      applied_cursor IS NULL
      AND payload_digest IS NULL
      AND source_as_of_ms IS NULL
      AND last_observed_at_ms IS NULL
      AND fresh_until_ms IS NULL
      AND last_applied_at_ms IS NULL
      AND state IN ('uninitialized', 'invalid', 'recovering')
    )
    OR
    (
      applied_cursor IS NOT NULL
      AND payload_digest IS NOT NULL
      AND source_as_of_ms IS NOT NULL
      AND last_observed_at_ms IS NOT NULL
      AND fresh_until_ms IS NOT NULL
      AND last_applied_at_ms IS NOT NULL
    )
  ),
  CHECK (source_as_of_ms IS NULL OR source_as_of_ms >= 0),
  CHECK (last_observed_at_ms IS NULL OR last_observed_at_ms >= 0),
  CHECK (fresh_until_ms IS NULL OR fresh_until_ms >= source_as_of_ms),
  CHECK (last_applied_at_ms IS NULL OR last_applied_at_ms >= 0)
);
