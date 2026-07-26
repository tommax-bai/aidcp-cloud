import type { DeploymentTarget } from '../deployment-target.js';
import type { ConfigMirrorKey } from '../kernel/config-mirror-bump-types.js';
import {
  makeSyncReadFactEnvelope,
  type AutomationConfigMirrorHealthSnapshot,
  type CaptchaAvailabilitySnapshot,
  type EdgePresenceSnapshot,
  type PublishInFlightSnapshot,
  type SyncReadOwnerSnapshotSource,
} from '../kernel/sync-read-facts.js';
import type {
  SyncReadSnapshotEnvelope,
  SyncReadStream,
} from '../kernel/sync-read-snapshot.js';

const DEFAULT_FRESH_MS = 30_000;
const PRESENCE_FRESH_MS = 45_000;

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
  private readonly generation = new Map<SyncReadStream, bigint>([
    ['edge_presence', 1n],
    ['publish_in_flight', 1n],
    ['captcha_availability', 1n],
    ['automation_config_mirror_health', 1n],
  ]);

  constructor(
    private readonly executionTarget: DeploymentTarget,
    private readonly sources: AutomationSyncReadRuntimeSources,
  ) {}

  markChanged(
    stream:
      | 'edge_presence'
      | 'publish_in_flight'
      | 'captcha_availability'
      | 'automation_config_mirror_health',
  ): string {
    const next = (this.generation.get(stream) ?? 0n) + 1n;
    this.generation.set(stream, next);
    return next.toString();
  }

  currentGeneration(
    stream:
      | 'edge_presence'
      | 'publish_in_flight'
      | 'captcha_availability'
      | 'automation_config_mirror_health',
  ): string {
    return (this.generation.get(stream) ?? 1n).toString();
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
      return makeSyncReadFactEnvelope({
        executionTarget: this.executionTarget,
        stream: 'edge_presence',
        cursor: this.currentGeneration(stream),
        asOf: observedAt,
        freshUntil: observedAt + PRESENCE_FRESH_MS,
        value: this.sources.edgePresence(),
      }) as SyncReadSnapshotEnvelope<any>;
    }
    if (stream === 'publish_in_flight') {
      return makeSyncReadFactEnvelope({
        executionTarget: this.executionTarget,
        stream: 'publish_in_flight',
        cursor: this.currentGeneration(stream),
        asOf: observedAt,
        freshUntil: observedAt + DEFAULT_FRESH_MS,
        value: this.sources.publishInFlight(),
      }) as SyncReadSnapshotEnvelope<any>;
    }
    if (stream === 'captcha_availability') {
      return makeSyncReadFactEnvelope({
        executionTarget: this.executionTarget,
        stream: 'captcha_availability',
        cursor: this.currentGeneration(stream),
        asOf: observedAt,
        freshUntil: observedAt + DEFAULT_FRESH_MS,
        value: this.sources.captchaAvailability(),
      }) as SyncReadSnapshotEnvelope<any>;
    }
    if (stream === 'automation_config_mirror_health') {
      return makeSyncReadFactEnvelope({
        executionTarget: this.executionTarget,
        stream: 'automation_config_mirror_health',
        cursor: this.currentGeneration(stream),
        asOf: observedAt,
        freshUntil: observedAt + DEFAULT_FRESH_MS,
        value: this.sources.configMirrorHealth(),
      }) as SyncReadSnapshotEnvelope<any>;
    }
    throw new Error(`sync_read_stream_not_owned_by_automation:${stream}`);
  }
}
