import type pg from 'pg';

import type { DeploymentTarget } from '../deployment-target.js';
import {
  syncReadPayloadDigest,
  type SyncReadJson,
} from '../kernel/sync-read-snapshot.js';
import type {
  AutomationRuntimeSyncReadStream,
  AutomationSyncReadGenerationSource,
} from './automation-sync-read-source.js';

/**
 * Durable target-local owner cursor for runtime facts.
 *
 * The payload itself remains in the automation process. Only its digest and a
 * monotonic generation are persisted, so a process restart cannot reset a
 * cursor below an API consumer checkpoint.
 */
export class PgAutomationSyncReadGenerationStore
  implements AutomationSyncReadGenerationSource
{
  constructor(
    private readonly executionTarget: DeploymentTarget,
    private readonly pool: Pick<pg.Pool, 'query'>,
  ) {}

  async observe(
    stream: AutomationRuntimeSyncReadStream,
    value: SyncReadJson,
  ): Promise<string> {
    const digest = syncReadPayloadDigest(value);
    const { rows } = await this.pool.query<{ generation: string | number }>(
      `INSERT INTO automation_sync_read_owner_generation (
         execution_target, stream, generation, payload_digest, last_emitted_generation, updated_at
       )
       VALUES ($1, $2, 1, $3, 0, now())
       ON CONFLICT (execution_target, stream)
       DO UPDATE SET
         generation = CASE
           WHEN automation_sync_read_owner_generation.payload_digest
                  IS DISTINCT FROM EXCLUDED.payload_digest
             THEN automation_sync_read_owner_generation.generation + 1
           ELSE automation_sync_read_owner_generation.generation
         END,
         payload_digest = EXCLUDED.payload_digest,
         updated_at = CASE
           WHEN automation_sync_read_owner_generation.payload_digest
                  IS DISTINCT FROM EXCLUDED.payload_digest
             THEN now()
           ELSE automation_sync_read_owner_generation.updated_at
         END
       RETURNING generation`,
      [this.executionTarget, stream, digest],
    );
    const generation = String(rows[0]?.generation ?? '');
    if (!/^(?:0|[1-9][0-9]*)$/.test(generation)) {
      throw new Error(
        `automation_sync_read_generation_invalid stream=${stream} generation=${generation}`,
      );
    }
    return generation;
  }

  async current(
    stream: AutomationRuntimeSyncReadStream,
  ): Promise<{ generation: string; payloadDigest: string } | null> {
    const { rows } = await this.pool.query<{
      generation: string | number;
      payload_digest: string;
    }>(
      `SELECT generation, payload_digest
         FROM automation_sync_read_owner_generation
        WHERE execution_target = $1
          AND stream = $2`,
      [this.executionTarget, stream],
    );
    const row = rows[0];
    if (!row) return null;
    const generation = String(row.generation);
    if (
      !/^(?:0|[1-9][0-9]*)$/.test(generation) ||
      !/^sha256:[0-9a-f]{64}$/.test(row.payload_digest)
    ) {
      throw new Error(
        `automation_sync_read_generation_invalid stream=${stream} generation=${generation}`,
      );
    }
    return { generation, payloadDigest: row.payload_digest };
  }
}
