import type { DeploymentTarget } from '../deployment-target.js';
import {
  isSyncReadFactPayload,
  type AutomationConfigMirrorHealthSnapshot,
  type CaptchaAvailabilitySnapshot,
  type EdgePresenceSnapshot,
  type PublishInFlightSnapshot,
  type SessionConfigGlobalSnapshot,
} from '../kernel/sync-read-facts.js';
import {
  AtomicSyncReadMirror,
  syncReadProcessReadiness,
  type SyncReadApplyResult,
  type SyncReadDeliveryState,
  type SyncReadObservationSource,
  type SyncReadSnapshotEnvelope,
} from '../kernel/sync-read-snapshot.js';

export type EvidenceState = SyncReadDeliveryState;

export class ApiSyncReadMirrors {
  readonly sessionConfig: AtomicSyncReadMirror<SessionConfigGlobalSnapshot>;
  readonly edgePresence: AtomicSyncReadMirror<EdgePresenceSnapshot>;
  readonly publishInFlight: AtomicSyncReadMirror<PublishInFlightSnapshot>;
  readonly captchaAvailability: AtomicSyncReadMirror<CaptchaAvailabilitySnapshot>;
  readonly automationHealth: AtomicSyncReadMirror<AutomationConfigMirrorHealthSnapshot>;

  constructor(executionTarget: DeploymentTarget, clock: () => number = Date.now) {
    this.sessionConfig = mirror(
      executionTarget,
      'session_config_global',
      clock,
    );
    this.edgePresence = mirror(executionTarget, 'edge_presence', clock);
    this.publishInFlight = mirror(
      executionTarget,
      'publish_in_flight',
      clock,
    );
    this.captchaAvailability = mirror(
      executionTarget,
      'captcha_availability',
      clock,
    );
    this.automationHealth = mirror(
      executionTarget,
      'automation_config_mirror_health',
      clock,
    );
  }

  apply(
    envelope: SyncReadSnapshotEnvelope,
    source: SyncReadObservationSource,
  ): SyncReadApplyResult {
    switch (envelope.stream) {
      case 'session_config_global':
        return this.sessionConfig.apply(envelope, source);
      case 'edge_presence':
        return this.edgePresence.apply(envelope, source);
      case 'publish_in_flight':
        return this.publishInFlight.apply(envelope, source);
      case 'captcha_availability':
        return this.captchaAvailability.apply(envelope, source);
      case 'automation_config_mirror_health':
        return this.automationHealth.apply(envelope, source);
      default:
        return {
          outcome: 'rejected',
          reason: 'invalid_envelope',
          currentCursor: null,
          message: `sync_read_stream_not_consumed_by_api:${envelope.stream}`,
        };
    }
  }

  weekActiveMask(now = Date.now()): {
    state: EvidenceState;
    value: string | null;
    asOf: number | null;
  } {
    const view = this.sessionConfig.view(now);
    return {
      state: deliveryState(view.state),
      value: view.value?.weekActiveMask ?? null,
      asOf: view.metadata?.sourceAsOf ?? null,
    };
  }

  presence(now = Date.now()): {
    state: EvidenceState;
    asOf: number | null;
    edgeCount: number | null;
    onlineEdgeCount: number | null;
    resolveEdgeIdForAccount(accountId: string): string | null;
  } {
    const view = this.edgePresence.view(now);
    const state = deliveryState(view.state);
    const fresh = state === 'fresh' ? view.value : null;
    const byAccount = new Map(
      fresh?.accountEdges.map((row) => [row.accountId, row.edgeId]) ?? [],
    );
    return {
      state,
      asOf: view.metadata?.sourceAsOf ?? null,
      edgeCount: fresh?.edgeCount ?? null,
      onlineEdgeCount: fresh?.onlineEdgeCount ?? null,
      resolveEdgeIdForAccount: (accountId) => byAccount.get(accountId) ?? null,
    };
  }

  inFlightEvidence(now = Date.now()): {
    state: EvidenceState;
    asOf: number | null;
    recordIds: ReadonlySet<number> | null;
  } {
    const view = this.publishInFlight.view(now);
    const state = deliveryState(view.state);
    return {
      state,
      asOf: view.metadata?.sourceAsOf ?? null,
      recordIds:
        state === 'fresh' && view.value
          ? new Set(view.value.recordIds)
          : null,
    };
  }

  captcha(now = Date.now()): {
    state: EvidenceState;
    asOf: number | null;
    capability:
      | 'disabled'
      | 'available'
      | 'unavailable'
      | 'unknown';
  } {
    const view = this.captchaAvailability.view(now);
    const state = deliveryState(view.state);
    return {
      state,
      asOf: view.metadata?.sourceAsOf ?? null,
      capability: state === 'fresh' ? view.value!.state : 'unknown',
    };
  }

  automationConfigMirrorHealth(now = Date.now()): {
    sourceService: 'automation';
    asOf: number | null;
    deliveryState: EvidenceState;
    entries: AutomationConfigMirrorHealthSnapshot['entries'];
  } {
    const view = this.automationHealth.view(now);
    const state = deliveryState(view.state);
    return {
      sourceService: 'automation',
      asOf: view.metadata?.sourceAsOf ?? null,
      deliveryState: state,
      entries: state === 'fresh' ? view.value!.entries : [],
    };
  }

  readiness(now = Date.now()) {
    return syncReadProcessReadiness(
      [
        this.sessionConfig.health(now),
        this.edgePresence.health(now),
        this.publishInFlight.health(now),
        this.captchaAvailability.health(now),
        this.automationHealth.health(now),
      ],
      now,
    );
  }
}

function mirror<S extends
  | 'session_config_global'
  | 'edge_presence'
  | 'publish_in_flight'
  | 'captcha_availability'
  | 'automation_config_mirror_health'>(
  executionTarget: DeploymentTarget,
  stream: S,
  clock: () => number,
): AtomicSyncReadMirror<
  S extends 'session_config_global'
    ? SessionConfigGlobalSnapshot
    : S extends 'edge_presence'
      ? EdgePresenceSnapshot
      : S extends 'publish_in_flight'
        ? PublishInFlightSnapshot
        : S extends 'captcha_availability'
          ? CaptchaAvailabilitySnapshot
          : AutomationConfigMirrorHealthSnapshot
> {
  return new AtomicSyncReadMirror({
    executionTarget,
    stream,
    required: true,
    clock,
    validateValue: (value): value is any =>
      isSyncReadFactPayload(stream, value),
  });
}

function deliveryState(
  state: 'uninitialized' | 'ready' | 'stale' | 'invalid' | 'recovering',
): EvidenceState {
  if (state === 'ready') return 'fresh';
  if (state === 'stale') return 'stale';
  if (state === 'invalid') return 'invalid';
  return 'unknown';
}
