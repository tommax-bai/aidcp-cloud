import type { DeploymentTarget } from '../deployment-target.js';
import {
  isSyncReadFactPayload,
  makeSyncReadFactEnvelope,
  type AutomationConfigMirrorHealthSnapshot,
  type CaptchaAvailabilitySnapshot,
  type EdgePresenceSnapshot,
  type PublishInFlightSnapshot,
  type SyncReadOwnerSnapshotSource,
  type SyncReadPayloadByStream,
} from '../kernel/sync-read-facts.js';
import type {
  SyncReadJson,
  SyncReadSnapshotEnvelope,
  SyncReadStream,
} from '../kernel/sync-read-snapshot.js';
import { syncReadPayloadDigest } from '../kernel/sync-read-snapshot.js';

const DEFAULT_FRESH_MS = 30_000;
const PRESENCE_FRESH_MS = 45_000;

export type AutomationRuntimeSyncReadStream =
  | 'edge_presence'
  | 'publish_in_flight'
  | 'captcha_availability'
  | 'automation_config_mirror_health';

export interface AutomationSyncReadGenerationSource {
  observe(
    stream: AutomationRuntimeSyncReadStream,
    value: SyncReadJson,
  ): Promise<string>;
  current(
    stream: AutomationRuntimeSyncReadStream,
  ): Promise<{ generation: string; payloadDigest: string } | null>;
}

export interface AutomationSyncReadChangedEmitter {
  emit(
    stream: AutomationRuntimeSyncReadStream,
    generation: string,
  ): Promise<{ emitted: boolean; generation: string }>;
}

export interface AutomationSyncReadRuntimeSources {
  sessionConfigGlobal(): Promise<{
    cursor: string;
    weekActiveMask: string | null;
  }>;
  edgePresence(): EdgePresenceSnapshot;
  publishInFlight(): PublishInFlightSnapshot;
  captchaAvailability(): CaptchaAvailabilitySnapshot;
  configMirrorHealth(): AutomationConfigMirrorHealthSnapshot;
}

export class AutomationSyncReadSnapshotSource
  implements SyncReadOwnerSnapshotSource
{
  private readonly observedRuntimeSnapshots = new Map<
    AutomationRuntimeSyncReadStream,
    SyncReadSnapshotEnvelope<any>
  >();
  private readonly publishTails = new Map<
    AutomationRuntimeSyncReadStream,
    Promise<SyncReadSnapshotEnvelope<any>>
  >();

  constructor(
    private readonly executionTarget: DeploymentTarget,
    private readonly sources: AutomationSyncReadRuntimeSources,
    private readonly generationSource: AutomationSyncReadGenerationSource,
    private readonly changedEmitter: AutomationSyncReadChangedEmitter,
  ) {}

  async publishChanged(
    stream: AutomationRuntimeSyncReadStream,
    observedAt = Date.now(),
  ): Promise<SyncReadSnapshotEnvelope<any>> {
    const prior = this.publishTails.get(stream);
    const next = (prior ? prior.catch(() => undefined) : Promise.resolve())
      .then(() => this.observeAndPublish(stream, observedAt));
    this.publishTails.set(stream, next);
    try {
      return await next;
    } finally {
      if (this.publishTails.get(stream) === next) {
        this.publishTails.delete(stream);
      }
    }
  }

  private async observeAndPublish(
    stream: AutomationRuntimeSyncReadStream,
    observedAt: number,
  ): Promise<SyncReadSnapshotEnvelope<any>> {
    // Read mutable runtime state inside the per-stream critical section.
    // Concurrent signals therefore cannot let an older pre-await value obtain
    // a later generation and overwrite the stable cache.
    const value = cloneSyncReadJson(this.runtimeValue(stream));
    if (!isSyncReadFactPayload(stream, value)) {
      throw new Error(`automation_sync_read_runtime_payload_invalid:${stream}`);
    }
    const generation = await this.generationSource.observe(stream, value);
    const envelope = makeSyncReadFactEnvelope({
      executionTarget: this.executionTarget,
      stream,
      cursor: generation,
      asOf: observedAt,
      freshUntil:
        observedAt +
        (stream === 'edge_presence' ? PRESENCE_FRESH_MS : DEFAULT_FRESH_MS),
      value,
    }) as SyncReadSnapshotEnvelope<any>;
    // Publish the immutable observation before emitting its wake-up hint. The
    // HTTP snapshot route only returns this stable generation/value pair and
    // never observes mutable runtime state itself.
    this.observedRuntimeSnapshots.set(stream, envelope);
    await this.changedEmitter.emit(stream, generation);
    return envelope;
  }

  async snapshot<S extends SyncReadStream>(
    stream: S,
    observedAt = Date.now(),
  ): Promise<SyncReadSnapshotEnvelope<any>> {
    if (stream === 'session_config_global') {
      const observation = await this.sources.sessionConfigGlobal();
      if (!/^(?:0|[1-9][0-9]*)$/.test(observation.cursor)) {
        throw new Error('session_config_global_version_unavailable');
      }
      return makeSyncReadFactEnvelope({
        executionTarget: this.executionTarget,
        stream: 'session_config_global',
        cursor: observation.cursor,
        asOf: observedAt,
        freshUntil: observedAt + DEFAULT_FRESH_MS,
        value: { weekActiveMask: observation.weekActiveMask },
      }) as SyncReadSnapshotEnvelope<any>;
    }
    if (stream === 'edge_presence') {
      return this.currentRuntimeSnapshot(stream);
    }
    if (stream === 'publish_in_flight') {
      return this.currentRuntimeSnapshot(stream);
    }
    if (stream === 'captcha_availability') {
      return this.currentRuntimeSnapshot(stream);
    }
    if (stream === 'automation_config_mirror_health') {
      return this.currentRuntimeSnapshot(stream);
    }
    throw new Error(`sync_read_stream_not_owned_by_automation:${stream}`);
  }

  private runtimeValue<S extends AutomationRuntimeSyncReadStream>(
    stream: S,
  ): SyncReadPayloadByStream[S] {
    switch (stream) {
      case 'edge_presence':
        return this.sources.edgePresence() as SyncReadPayloadByStream[S];
      case 'publish_in_flight':
        return this.sources.publishInFlight() as SyncReadPayloadByStream[S];
      case 'captcha_availability':
        return this.sources.captchaAvailability() as SyncReadPayloadByStream[S];
      case 'automation_config_mirror_health':
        return this.sources.configMirrorHealth() as SyncReadPayloadByStream[S];
    }
  }

  private async currentRuntimeSnapshot<
    S extends AutomationRuntimeSyncReadStream,
  >(
    stream: S,
  ): Promise<SyncReadSnapshotEnvelope<any>> {
    const durable = await this.generationSource.current(stream);
    const observed = this.observedRuntimeSnapshots.get(stream);
    if (!durable || !observed) {
      throw new Error(`automation_sync_read_runtime_unobserved:${stream}`);
    }
    if (
      observed.cursor !== durable.generation ||
      syncReadPayloadDigest(observed.value) !== durable.payloadDigest
    ) {
      throw new Error(`automation_sync_read_runtime_observation_stale:${stream}`);
    }
    // A fetch is delivery, not a new observation. Return the exact cached
    // owner observation so a stopped/failed observer cannot keep old runtime
    // facts fresh merely because the API continues polling this route.
    return observed;
  }
}

function cloneSyncReadJson<T extends SyncReadJson>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
