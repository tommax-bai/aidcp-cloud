import type { DeploymentTarget } from '../deployment-target.js';
import {
  SYNC_READ_CHANGED_TOPIC,
  compareUnsignedSyncReadCursor,
  syncReadChangedSignal,
  type SyncReadApplyResult,
  type SyncReadChangedSignal,
  type SyncReadSnapshotEnvelope,
  type SyncReadStream,
} from '../kernel/sync-read-snapshot.js';
import {
  EVENT_OUTBOX_NOTIFY_CHANNEL,
  type OutboxEvent,
  type OutboxQueryable,
} from './event-outbox.js';

type RuntimeStream =
  | 'edge_presence'
  | 'publish_in_flight'
  | 'captcha_availability'
  | 'automation_config_mirror_health';

export class SyncReadChangedOutbox {
  constructor(
    private readonly executionTarget: DeploymentTarget,
    private readonly pool: OutboxQueryable,
    private readonly logger: Pick<Console, 'warn'> = console,
  ) {}

  async emit(
    stream: RuntimeStream,
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
  fetchSnapshot(stream: RuntimeStream): Promise<SyncReadSnapshotEnvelope>;
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

function parseSignal(
  event: OutboxEvent,
  executionTarget: DeploymentTarget,
): SyncReadChangedSignal & { stream: RuntimeStream } {
  if (event.topic !== SYNC_READ_CHANGED_TOPIC) {
    throw new Error(`sync_read_topic_mismatch:${event.topic}`);
  }
  if (
    typeof event.payload !== 'object' ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    throw new Error('sync_read_changed_payload_invalid');
  }
  const signal = event.payload as Partial<SyncReadChangedSignal>;
  const keys = Object.keys(signal).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== 'contractVersion' ||
    keys[1] !== 'executionTarget' ||
    keys[2] !== 'generation' ||
    keys[3] !== 'stream' ||
    signal.contractVersion !== 1 ||
    typeof signal.generation !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/.test(signal.generation)
  ) {
    throw new Error('sync_read_changed_payload_invalid');
  }
  if (signal.executionTarget !== executionTarget) {
    throw new Error('sync_read_changed_target_mismatch');
  }
  if (!isRuntimeStream(signal.stream)) {
    throw new Error('sync_read_changed_stream_invalid');
  }
  return syncReadChangedSignal({
    executionTarget,
    stream: signal.stream,
    generation: signal.generation,
  }) as SyncReadChangedSignal & { stream: RuntimeStream };
}

function isRuntimeStream(stream: SyncReadStream | undefined): stream is RuntimeStream {
  return (
    stream === 'edge_presence' ||
    stream === 'publish_in_flight' ||
    stream === 'captcha_availability' ||
    stream === 'automation_config_mirror_health'
  );
}
