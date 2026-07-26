import type { DeploymentTarget } from '../deployment-target.js';
import type { ConfigMirrorKey } from '../kernel/config-mirror-bump-types.js';
import {
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
}

export interface AutomationSyncReadChangedEmitter {
  emit(
    stream: AutomationRuntimeSyncReadStream,
    generation: string,
  ): Promise<{ emitted: boolean; generation: string }>;
}

export interface AutomationSyncReadRuntimeSources {
  versionOf(mirrorKey: ConfigMirrorKey): Promise<number | null>;
  weekActiveMask(): string | null;
  edgePresence(): EdgePresenceSnapshot;
  publishInFlight(): PublishInFlightSnapshot;
  captchaAvailability(): CaptchaAvailabilitySnapshot;
  configMirrorHealth(): AutomationConfigMirrorHealthSnapshot;
}

export class AutomationSyncReadSnapshotSource
  implements SyncReadOwnerSnapshotSource
{
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
    return this.snapshot(stream, observedAt);
  }

  async snapshot<S extends SyncReadStream>(
    stream: S,
    observedAt = Date.now(),
  ): Promise<SyncReadSnapshotEnvelope<any>> {
    if (stream === 'session_config_global') {
      const version = await this.sources.versionOf('session_config_global');
      if (version === null || !Number.isSafeInteger(version) || version < 0) {
        throw new Error('session_config_global_version_unavailable');
      }
      return makeSyncReadFactEnvelope({
        executionTarget: this.executionTarget,
        stream: 'session_config_global',
        cursor: String(version),
        asOf: observedAt,
        freshUntil: observedAt + DEFAULT_FRESH_MS,
        value: { weekActiveMask: this.sources.weekActiveMask() },
      }) as SyncReadSnapshotEnvelope<any>;
    }
    if (stream === 'edge_presence') {
      return this.runtimeSnapshot(
        stream,
        this.sources.edgePresence(),
        observedAt,
        PRESENCE_FRESH_MS,
      );
    }
    if (stream === 'publish_in_flight') {
      return this.runtimeSnapshot(
        stream,
        this.sources.publishInFlight(),
        observedAt,
        DEFAULT_FRESH_MS,
      );
    }
    if (stream === 'captcha_availability') {
      return this.runtimeSnapshot(
        stream,
        this.sources.captchaAvailability(),
        observedAt,
        DEFAULT_FRESH_MS,
      );
    }
    if (stream === 'automation_config_mirror_health') {
      return this.runtimeSnapshot(
        stream,
        this.sources.configMirrorHealth(),
        observedAt,
        DEFAULT_FRESH_MS,
      );
    }
    throw new Error(`sync_read_stream_not_owned_by_automation:${stream}`);
  }

  private async runtimeSnapshot<S extends AutomationRuntimeSyncReadStream>(
    stream: S,
    value: SyncReadPayloadByStream[S],
    observedAt: number,
    freshMs: number,
  ): Promise<SyncReadSnapshotEnvelope<any>> {
    const generation = await this.generationSource.observe(stream, value);
    await this.changedEmitter.emit(stream, generation);
    return makeSyncReadFactEnvelope({
      executionTarget: this.executionTarget,
      stream,
      cursor: generation,
      asOf: observedAt,
      freshUntil: observedAt + freshMs,
      value,
    }) as SyncReadSnapshotEnvelope<any>;
  }
}
