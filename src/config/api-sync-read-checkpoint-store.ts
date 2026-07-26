import type pg from 'pg';

import {
  SyncReadConsumerCheckpointStore,
  syncReadCheckpointFromStorageRow,
  type SyncReadCheckpointBackend,
  type SyncReadCheckpointStorageRow,
  type SyncReadConsumerCheckpoint,
  type SyncReadStream,
} from '../kernel/sync-read-snapshot.js';
import type { DeploymentTarget } from '../deployment-target.js';

const RETURNING_COLUMNS = `
  execution_target, consumer, stream, applied_cursor, payload_digest,
  source_as_of_ms, last_observed_at_ms, fresh_until_ms, last_applied_at_ms,
  state, last_error
`;

class ApiSyncReadCheckpointBackend implements SyncReadCheckpointBackend {
  readonly consumer = 'api' as const;

  constructor(private readonly pool: pg.Pool) {}

  async load(
    executionTarget: DeploymentTarget,
    stream: SyncReadStream,
  ): Promise<unknown | null> {
    const { rows } = await this.pool.query<SyncReadCheckpointStorageRow & pg.QueryResultRow>(
      `SELECT ${RETURNING_COLUMNS}
         FROM api_sync_read_consumer_checkpoint
        WHERE execution_target = $1
          AND consumer = 'api'
          AND stream = $2`,
      [executionTarget, stream],
    );
    return rows[0] ? syncReadCheckpointFromStorageRow(rows[0]) : null;
  }

  async store(
    checkpoint: SyncReadConsumerCheckpoint,
  ): Promise<
    | { stored: true; row: unknown }
    | { stored: false; current: unknown | null }
  > {
    const { rows } = await this.pool.query<SyncReadCheckpointStorageRow & pg.QueryResultRow>(
      `INSERT INTO api_sync_read_consumer_checkpoint (
         execution_target, consumer, stream, applied_cursor, payload_digest,
         source_as_of_ms, last_observed_at_ms, fresh_until_ms, last_applied_at_ms,
         state, last_error, updated_at
       )
       VALUES ($1, 'api', $2, $3::numeric, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (execution_target, consumer, stream)
       DO UPDATE SET
         applied_cursor = EXCLUDED.applied_cursor,
         payload_digest = EXCLUDED.payload_digest,
         source_as_of_ms = EXCLUDED.source_as_of_ms,
         last_observed_at_ms = EXCLUDED.last_observed_at_ms,
         fresh_until_ms = EXCLUDED.fresh_until_ms,
         last_applied_at_ms = EXCLUDED.last_applied_at_ms,
         state = EXCLUDED.state,
         last_error = EXCLUDED.last_error,
         updated_at = now()
       WHERE api_sync_read_consumer_checkpoint.applied_cursor IS NULL
          OR (
            EXCLUDED.applied_cursor IS NOT NULL
            AND (
              EXCLUDED.applied_cursor > api_sync_read_consumer_checkpoint.applied_cursor
              OR (
                EXCLUDED.applied_cursor = api_sync_read_consumer_checkpoint.applied_cursor
                AND EXCLUDED.payload_digest = api_sync_read_consumer_checkpoint.payload_digest
                AND (
                  (
                    EXCLUDED.source_as_of_ms > api_sync_read_consumer_checkpoint.source_as_of_ms
                    AND EXCLUDED.last_observed_at_ms >= api_sync_read_consumer_checkpoint.last_observed_at_ms
                    AND EXCLUDED.last_applied_at_ms = api_sync_read_consumer_checkpoint.last_applied_at_ms
                  )
                  OR (
                    EXCLUDED.source_as_of_ms = api_sync_read_consumer_checkpoint.source_as_of_ms
                    AND EXCLUDED.last_observed_at_ms = api_sync_read_consumer_checkpoint.last_observed_at_ms
                    AND EXCLUDED.fresh_until_ms = api_sync_read_consumer_checkpoint.fresh_until_ms
                    AND EXCLUDED.last_applied_at_ms = api_sync_read_consumer_checkpoint.last_applied_at_ms
                  )
                )
              )
            )
          )
       RETURNING ${RETURNING_COLUMNS}`,
      [
        checkpoint.executionTarget,
        checkpoint.stream,
        checkpoint.appliedCursor,
        checkpoint.payloadDigest,
        checkpoint.sourceAsOf,
        checkpoint.lastObservedAt,
        checkpoint.freshUntil,
        checkpoint.lastAppliedAt,
        checkpoint.state,
        checkpoint.lastError,
      ],
    );
    if (rows[0]) {
      return { stored: true, row: syncReadCheckpointFromStorageRow(rows[0]) };
    }
    return {
      stored: false,
      current: await this.load(checkpoint.executionTarget, checkpoint.stream),
    };
  }
}

export function createApiSyncReadConsumerCheckpointStore(
  pool: pg.Pool,
  executionTarget: DeploymentTarget,
): SyncReadConsumerCheckpointStore {
  return new SyncReadConsumerCheckpointStore({
    executionTarget,
    consumer: 'api',
    backend: new ApiSyncReadCheckpointBackend(pool),
  });
}
