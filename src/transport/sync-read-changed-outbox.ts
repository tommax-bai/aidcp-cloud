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
  emitOutboxEvent,
  type OutboxEvent,
  type OutboxQueryable,
} from './event-outbox.js';

type RuntimeStream =
  | 'edge_presence'
  | 'publish_in_flight'
  | 'captcha_availability'
  | 'automation_config_mirror_health';

export class SyncReadChangedOutbox {
  private readonly emitted = new Map<RuntimeStream, string>();

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
    const prior = this.emitted.get(stream);
    if (
      prior !== undefined &&
      compareUnsignedSyncReadCursor(generation, prior) <= 0
    ) {
      return { emitted: false, generation: prior };
    }
    const signal = syncReadChangedSignal({
      executionTarget: this.executionTarget,
      stream,
      generation,
    });
    await emitOutboxEvent(
      client,
      {
        topic: SYNC_READ_CHANGED_TOPIC,
        executionTarget: this.executionTarget,
        payload: signal,
      },
      this.logger,
    );
    this.emitted.set(stream, generation);
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
  if (signal.executionTarget !== executionTarget) {
    throw new Error('sync_read_changed_target_mismatch');
  }
  if (!isRuntimeStream(signal.stream)) {
    throw new Error('sync_read_changed_stream_invalid');
  }
  return syncReadChangedSignal({
    executionTarget,
    stream: signal.stream,
    generation: String(signal.generation),
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
