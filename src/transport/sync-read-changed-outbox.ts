import type { DeploymentTarget } from '../deployment-target.js';
import {
  SYNC_READ_CHANGED_TOPIC,
  compareUnsignedSyncReadCursor,
  parseSyncReadChangedSignal,
  syncReadChangedSignal,
  type SyncReadApplyResult,
  type SyncReadChangedSignal,
  type SyncReadChangedStream,
  type SyncReadSnapshotEnvelope,
} from '../kernel/sync-read-snapshot.js';
import {
  EVENT_OUTBOX_NOTIFY_CHANNEL,
  type OutboxEvent,
  type OutboxHandler,
  type OutboxQueryable,
} from './event-outbox.js';
import { InternalHttpError } from './internal-http.js';
import type { SyncReadChangedDeliveryPort } from './sync-read-changed-http.js';

export class SyncReadChangedOutbox {
  constructor(
    private readonly executionTarget: DeploymentTarget,
    private readonly pool: OutboxQueryable,
    private readonly logger: Pick<Console, 'warn'> = console,
  ) {}

  async emit(
    stream: SyncReadChangedStream,
    generation: string,
    client: OutboxQueryable = this.pool,
  ): Promise<{ emitted: boolean; generation: string }> {
    const signal = syncReadChangedSignal({
      executionTarget: this.executionTarget,
      stream,
      generation,
    });
    const { rows } = await client.query<{ id: string | number }>(
      `WITH claimed AS (
         UPDATE automation_sync_read_owner_generation
            SET last_emitted_generation = generation
          WHERE execution_target = $1
            AND stream = $2
            AND generation = $3::numeric
            AND last_emitted_generation < generation
        RETURNING generation
       )
       INSERT INTO event_outbox (topic, payload, execution_target)
       SELECT $4, $5::jsonb, $1
         FROM claimed
       RETURNING id`,
      [
        this.executionTarget,
        stream,
        generation,
        SYNC_READ_CHANGED_TOPIC,
        JSON.stringify(signal),
      ],
    );
    if (rows.length === 0) return { emitted: false, generation };
    try {
      await client.query('SELECT pg_notify($1, $2)', [
        EVENT_OUTBOX_NOTIFY_CHANNEL,
        SYNC_READ_CHANGED_TOPIC,
      ]);
    } catch (error) {
      this.logger.warn(
        `[sync-read-changed] pg_notify failed; polling remains authoritative: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return { emitted: true, generation };
  }
}

export function createSyncReadChangedHandler(options: {
  executionTarget: DeploymentTarget;
  fetchSnapshot(stream: SyncReadChangedStream): Promise<SyncReadSnapshotEnvelope>;
  apply(
    envelope: SyncReadSnapshotEnvelope,
    source: 'owner_fetch' | 'replay',
  ): SyncReadApplyResult | Promise<SyncReadApplyResult>;
}): (event: OutboxEvent) => Promise<void> {
  return async (event) => {
    const signal = parseSignal(event, options.executionTarget);
    const envelope = await options.fetchSnapshot(signal.stream);
    if (
      compareUnsignedSyncReadCursor(envelope.cursor, signal.generation) < 0
    ) {
      throw new Error(
        `sync_read_snapshot_generation_behind stream=${signal.stream} expected>=${signal.generation} actual=${envelope.cursor}`,
      );
    }
    const applied = await options.apply(envelope, 'owner_fetch');
    if (applied.outcome === 'rejected') {
      throw new Error(
        `sync_read_snapshot_apply_failed stream=${signal.stream} reason=${applied.reason}`,
      );
    }
  };
}

export function createSyncReadChangedHttpRelay(options: {
  executionTarget: DeploymentTarget;
  delivery: SyncReadChangedDeliveryPort;
}): OutboxHandler {
  return async (event: OutboxEvent): Promise<void> => {
    if (event.topic !== SYNC_READ_CHANGED_TOPIC) {
      throw new InternalHttpError(
        'sync_read_changed_topic_mismatch',
        `expected ${SYNC_READ_CHANGED_TOPIC}, got ${event.topic}`,
      );
    }
    if (event.executionTarget !== options.executionTarget) {
      throw new InternalHttpError(
        'sync_read_changed_event_target_mismatch',
        `outbox event target ${event.executionTarget} does not match relay target ${options.executionTarget}`,
      );
    }
    const signal = parseSignal(event, options.executionTarget);
    await options.delivery.deliver({
      stream: signal.stream,
      generation: signal.generation,
    });
  };
}

function parseSignal(
  event: OutboxEvent,
  executionTarget: DeploymentTarget,
): SyncReadChangedSignal {
  if (event.topic !== SYNC_READ_CHANGED_TOPIC) {
    throw new Error(`sync_read_topic_mismatch:${event.topic}`);
  }
  try {
    return parseSyncReadChangedSignal(event.payload, { executionTarget });
  } catch (error) {
    throw new Error(
      `sync_read_changed_payload_invalid:${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
