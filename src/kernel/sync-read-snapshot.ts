import { createHash } from 'node:crypto';

import type {
  ConfigMirrorFreshnessSource,
  ConfigMirrorKey,
  MirrorReadState,
} from './config-mirror-bump-types.js';
import type { DeploymentTarget } from '../deployment-target.js';

export const SYNC_READ_CONTRACT_VERSION = 1 as const;
export const SYNC_READ_CHANGED_TOPIC = 'sync_read.changed' as const;

export type SyncReadFactScope = 'shared' | 'target';

export const SYNC_READ_STREAM_DEFINITIONS = {
  session_config_global: {
    owner: 'automation',
    consumer: 'api',
    factScope: 'shared',
    allowsEmptyValue: false,
  },
  edge_presence: {
    owner: 'automation',
    consumer: 'api',
    factScope: 'target',
    allowsEmptyValue: true,
  },
  publish_in_flight: {
    owner: 'automation',
    consumer: 'api',
    factScope: 'target',
    allowsEmptyValue: true,
  },
  captcha_availability: {
    owner: 'automation',
    consumer: 'api',
    factScope: 'target',
    allowsEmptyValue: false,
  },
  automation_config_mirror_health: {
    owner: 'automation',
    consumer: 'api',
    factScope: 'target',
    allowsEmptyValue: false,
  },
  account_persona: {
    owner: 'api',
    consumer: 'automation',
    factScope: 'shared',
    allowsEmptyValue: true,
  },
  client_environment_automation: {
    owner: 'api',
    consumer: 'automation',
    factScope: 'shared',
    allowsEmptyValue: true,
  },
  automation_account_projection: {
    owner: 'api',
    consumer: 'automation',
    factScope: 'shared',
    allowsEmptyValue: true,
  },
  content_schedule: {
    owner: 'api',
    consumer: 'automation',
    factScope: 'shared',
    allowsEmptyValue: true,
  },
  hot_lead_config: {
    owner: 'api',
    consumer: 'automation',
    factScope: 'shared',
    allowsEmptyValue: true,
  },
  facebook_comment_config: {
    owner: 'api',
    consumer: 'automation',
    factScope: 'shared',
    allowsEmptyValue: true,
  },
  facebook_group_join_automation_config: {
    owner: 'api',
    consumer: 'automation',
    factScope: 'shared',
    allowsEmptyValue: true,
  },
} as const satisfies Record<
  string,
  {
    owner: 'api' | 'automation';
    consumer: 'api' | 'automation';
    factScope: SyncReadFactScope;
    allowsEmptyValue: boolean;
  }
>;

export type SyncReadStream = keyof typeof SYNC_READ_STREAM_DEFINITIONS;

export type SyncReadJson =
  | null
  | boolean
  | number
  | string
  | readonly SyncReadJson[]
  | { readonly [key: string]: SyncReadJson };

export interface SyncReadSnapshotEnvelope<T extends SyncReadJson = SyncReadJson> {
  contractVersion: typeof SYNC_READ_CONTRACT_VERSION;
  executionTarget: DeploymentTarget;
  factScope: SyncReadFactScope;
  stream: SyncReadStream;
  cursor: string;
  asOf: number;
  freshUntil: number;
  complete: true;
  value: T;
}

export interface SyncReadChangedSignal {
  contractVersion: typeof SYNC_READ_CONTRACT_VERSION;
  executionTarget: DeploymentTarget;
  stream: SyncReadStream;
  generation: string;
}

export type SyncReadMirrorState =
  | 'uninitialized'
  | 'ready'
  | 'stale'
  | 'invalid'
  | 'recovering';

export type SyncReadDeliveryState = 'fresh' | 'stale' | 'unknown' | 'invalid';

export interface SyncReadAppliedMetadata {
  appliedCursor: string;
  payloadDigest: string;
  sourceAsOf: number;
  lastObservedAt: number;
  freshUntil: number;
  lastAppliedAt: number;
}

export type SyncReadMirrorView<T extends SyncReadJson> =
  | { state: 'uninitialized'; value: null; metadata: null }
  | { state: 'ready'; value: Readonly<T>; metadata: Readonly<SyncReadAppliedMetadata> }
  | { state: 'stale'; value: Readonly<T>; metadata: Readonly<SyncReadAppliedMetadata> }
  | {
      state: 'invalid' | 'recovering';
      value: Readonly<T> | null;
      metadata: Readonly<SyncReadAppliedMetadata> | null;
    };

export interface SyncReadMirrorHealth {
  stream: SyncReadStream;
  executionTarget: DeploymentTarget;
  factScope: SyncReadFactScope;
  required: boolean;
  state: SyncReadMirrorState;
  deliveryState: SyncReadDeliveryState;
  appliedCursor: string | null;
  sourceAsOf: number | null;
  lastObservedAt: number | null;
  freshUntil: number | null;
  lastAppliedAt: number | null;
  lastError: string | null;
}

/**
 * 持久化实现的最小公共形状。这里只定义 target-scoped consumer delivery state；
 * 不把 shared owner fact/version/projection payload 复制成 target-scoped 业务数据。
 */
export interface SyncReadConsumerCheckpoint {
  executionTarget: DeploymentTarget;
  stream: SyncReadStream;
  appliedCursor: string | null;
  payloadDigest: string | null;
  sourceAsOf: number | null;
  lastObservedAt: number | null;
  freshUntil: number | null;
  lastAppliedAt: number | null;
  state: SyncReadMirrorState;
  lastError: string | null;
}

export type SyncReadProcessReadiness =
  | {
      state: 'ready';
      checkedAt: number;
      blockers: readonly [];
    }
  | {
      state: 'not_ready';
      checkedAt: number;
      blockers: ReadonlyArray<{
        stream: SyncReadStream;
        state: Exclude<SyncReadMirrorState, 'ready'>;
        lastError: string | null;
      }>;
    };

export type SyncReadApplyResult =
  | { outcome: 'applied'; cursor: string; payloadDigest: string }
  | { outcome: 'freshness_renewed'; cursor: string; payloadDigest: string }
  | { outcome: 'already_applied'; cursor: string; payloadDigest: string }
  | {
      outcome: 'rejected';
      reason:
        | 'invalid_envelope'
        | 'old_cursor'
        | 'same_cursor_payload_drift';
      currentCursor: string | null;
      message: string;
    };

export type SyncReadObservationSource = 'owner_fetch' | 'replay';

export class SyncReadSnapshotValidationError extends Error {
  readonly code = 'sync_read_snapshot_invalid';

  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'SyncReadSnapshotValidationError';
  }
}

export interface SyncReadEnvelopeExpectation<T extends SyncReadJson> {
  executionTarget: DeploymentTarget;
  stream: SyncReadStream;
  factScope?: SyncReadFactScope;
  validateValue?: (value: unknown) => value is T;
}

export function isSyncReadStream(value: unknown): value is SyncReadStream {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(SYNC_READ_STREAM_DEFINITIONS, value)
  );
}

export function compareUnsignedSyncReadCursor(left: string, right: string): -1 | 0 | 1 {
  assertUnsignedCursor(left);
  assertUnsignedCursor(right);
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function syncReadChangedSignal(input: {
  executionTarget: DeploymentTarget;
  stream: SyncReadStream;
  generation: string;
}): SyncReadChangedSignal {
  if (SYNC_READ_STREAM_DEFINITIONS[input.stream].factScope !== 'target') {
    throw new SyncReadSnapshotValidationError(
      'changed_signal_shared_fact',
      `sync_read.changed is reserved for target-scoped runtime facts: ${input.stream}`,
    );
  }
  assertUnsignedCursor(input.generation);
  return {
    contractVersion: SYNC_READ_CONTRACT_VERSION,
    executionTarget: input.executionTarget,
    stream: input.stream,
    generation: input.generation,
  };
}

export function syncReadPayloadDigest(value: SyncReadJson): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function parseSyncReadSnapshotEnvelope<T extends SyncReadJson>(
  input: unknown,
  expectation: SyncReadEnvelopeExpectation<T>,
): SyncReadSnapshotEnvelope<T> {
  if (!isRecord(input)) invalid('envelope_type', 'snapshot envelope must be an object');
  if (input.contractVersion !== SYNC_READ_CONTRACT_VERSION) {
    invalid('contract_version', 'snapshot contractVersion is unsupported');
  }
  if (input.executionTarget !== expectation.executionTarget) {
    invalid(
      'target_mismatch',
      `snapshot target ${String(input.executionTarget)} does not match ${expectation.executionTarget}`,
    );
  }
  if (input.stream !== expectation.stream) {
    invalid('stream_mismatch', `snapshot stream ${String(input.stream)} does not match ${expectation.stream}`);
  }
  const expectedScope =
    expectation.factScope ?? SYNC_READ_STREAM_DEFINITIONS[expectation.stream].factScope;
  if (input.factScope !== expectedScope) {
    invalid(
      'fact_scope_mismatch',
      `snapshot factScope ${String(input.factScope)} does not match ${expectedScope}`,
    );
  }
  if (input.complete !== true) invalid('incomplete', 'snapshot complete must be true');
  if (typeof input.cursor !== 'string') invalid('cursor_type', 'snapshot cursor must be a string');
  assertUnsignedCursor(input.cursor as string);
  const asOf = assertTimestamp(input.asOf, 'asOf');
  const freshUntil = assertTimestamp(input.freshUntil, 'freshUntil');
  if (freshUntil < asOf) {
    invalid('freshness_window', 'snapshot freshUntil must be greater than or equal to asOf');
  }
  if (!isSyncReadJson(input.value)) invalid('payload_json', 'snapshot value must be JSON-safe');
  if (expectation.validateValue && !expectation.validateValue(input.value)) {
    invalid('payload_shape', `snapshot payload failed validation for ${expectation.stream}`);
  }
  const definition = SYNC_READ_STREAM_DEFINITIONS[expectation.stream];
  if (!definition.allowsEmptyValue && isSemanticallyEmpty(input.value)) {
    invalid('empty_payload', `snapshot stream ${expectation.stream} does not allow an empty payload`);
  }
  const value = freezeJson(JSON.parse(canonicalJson(input.value)) as T);
  return {
    contractVersion: SYNC_READ_CONTRACT_VERSION,
    executionTarget: expectation.executionTarget,
    factScope: expectedScope,
    stream: expectation.stream,
    cursor: input.cursor as string,
    asOf,
    freshUntil,
    complete: true,
    value,
  };
}

export interface AtomicSyncReadMirrorOptions<T extends SyncReadJson> {
  executionTarget: DeploymentTarget;
  stream: SyncReadStream;
  required?: boolean;
  validateValue?: (value: unknown) => value is T;
  clock?: () => number;
}

export class AtomicSyncReadMirror<T extends SyncReadJson = SyncReadJson> {
  private readonly executionTarget: DeploymentTarget;
  private readonly stream: SyncReadStream;
  private readonly factScope: SyncReadFactScope;
  private readonly required: boolean;
  private readonly validateValue: ((value: unknown) => value is T) | undefined;
  private readonly clock: () => number;
  private current: { value: Readonly<T>; metadata: SyncReadAppliedMetadata } | null = null;
  private forcedState: 'invalid' | 'recovering' | null = null;
  private lastError: string | null = null;

  constructor(options: AtomicSyncReadMirrorOptions<T>) {
    this.executionTarget = options.executionTarget;
    this.stream = options.stream;
    this.factScope = SYNC_READ_STREAM_DEFINITIONS[options.stream].factScope;
    this.required = options.required ?? true;
    this.validateValue = options.validateValue;
    this.clock = options.clock ?? Date.now;
  }

  apply(input: unknown, source: SyncReadObservationSource): SyncReadApplyResult {
    let envelope: SyncReadSnapshotEnvelope<T>;
    try {
      envelope = parseSyncReadSnapshotEnvelope(input, {
        executionTarget: this.executionTarget,
        stream: this.stream,
        factScope: this.factScope,
        validateValue: this.validateValue,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.forcedState = 'invalid';
      this.lastError = message;
      return {
        outcome: 'rejected',
        reason: 'invalid_envelope',
        currentCursor: this.current?.metadata.appliedCursor ?? null,
        message,
      };
    }

    const now = this.clock();
    const digest = syncReadPayloadDigest(envelope.value);
    if (!this.current) {
      this.replace(envelope, digest, now);
      return { outcome: 'applied', cursor: envelope.cursor, payloadDigest: digest };
    }

    const comparison = compareUnsignedSyncReadCursor(
      envelope.cursor,
      this.current.metadata.appliedCursor,
    );
    if (comparison < 0) {
      this.lastError = `out_of_order cursor=${envelope.cursor} current=${this.current.metadata.appliedCursor}`;
      return {
        outcome: 'rejected',
        reason: 'old_cursor',
        currentCursor: this.current.metadata.appliedCursor,
        message: this.lastError,
      };
    }
    if (comparison > 0) {
      this.replace(envelope, digest, now);
      return { outcome: 'applied', cursor: envelope.cursor, payloadDigest: digest };
    }
    if (digest !== this.current.metadata.payloadDigest) {
      this.forcedState = 'invalid';
      this.lastError = `same cursor ${envelope.cursor} carried a different payload digest`;
      return {
        outcome: 'rejected',
        reason: 'same_cursor_payload_drift',
        currentCursor: this.current.metadata.appliedCursor,
        message: this.lastError,
      };
    }
    if (
      source === 'owner_fetch' &&
      envelope.asOf > this.current.metadata.sourceAsOf
    ) {
      this.current.metadata.sourceAsOf = envelope.asOf;
      this.current.metadata.lastObservedAt = now;
      this.current.metadata.freshUntil = envelope.freshUntil;
      this.forcedState = null;
      this.lastError = null;
      return {
        outcome: 'freshness_renewed',
        cursor: envelope.cursor,
        payloadDigest: digest,
      };
    }
    return {
      outcome: 'already_applied',
      cursor: envelope.cursor,
      payloadDigest: digest,
    };
  }

  beginRecovery(message = 'owner snapshot recovery in progress'): void {
    this.forcedState = 'recovering';
    this.lastError = message;
  }

  view(now = this.clock()): SyncReadMirrorView<T> {
    if (!this.current) {
      if (this.forcedState === 'invalid' || this.forcedState === 'recovering') {
        return { state: this.forcedState, value: null, metadata: null };
      }
      return { state: 'uninitialized', value: null, metadata: null };
    }
    if (this.forcedState === 'invalid' || this.forcedState === 'recovering') {
      return {
        state: this.forcedState,
        value: this.current.value,
        metadata: { ...this.current.metadata },
      };
    }
    return {
      state: now <= this.current.metadata.freshUntil ? 'ready' : 'stale',
      value: this.current.value,
      metadata: { ...this.current.metadata },
    };
  }

  health(now = this.clock()): SyncReadMirrorHealth {
    const view = this.view(now);
    const metadata = view.metadata;
    return {
      stream: this.stream,
      executionTarget: this.executionTarget,
      factScope: this.factScope,
      required: this.required,
      state: view.state,
      deliveryState: deliveryStateOf(view.state),
      appliedCursor: metadata?.appliedCursor ?? null,
      sourceAsOf: metadata?.sourceAsOf ?? null,
      lastObservedAt: metadata?.lastObservedAt ?? null,
      freshUntil: metadata?.freshUntil ?? null,
      lastAppliedAt: metadata?.lastAppliedAt ?? null,
      lastError: this.lastError,
    };
  }

  checkpoint(now = this.clock()): SyncReadConsumerCheckpoint {
    const health = this.health(now);
    return {
      executionTarget: health.executionTarget,
      stream: health.stream,
      appliedCursor: health.appliedCursor,
      payloadDigest: this.current?.metadata.payloadDigest ?? null,
      sourceAsOf: health.sourceAsOf,
      lastObservedAt: health.lastObservedAt,
      freshUntil: health.freshUntil,
      lastAppliedAt: health.lastAppliedAt,
      state: health.state,
      lastError: health.lastError,
    };
  }

  private replace(
    envelope: SyncReadSnapshotEnvelope<T>,
    payloadDigest: string,
    now: number,
  ): void {
    this.current = {
      value: envelope.value,
      metadata: {
        appliedCursor: envelope.cursor,
        payloadDigest,
        sourceAsOf: envelope.asOf,
        lastObservedAt: now,
        freshUntil: envelope.freshUntil,
        lastAppliedAt: now,
      },
    };
    this.forcedState = null;
    this.lastError = null;
  }
}

export function syncReadProcessReadiness(
  health: readonly SyncReadMirrorHealth[],
  checkedAt = Date.now(),
): SyncReadProcessReadiness {
  const blockers = health
    .filter((entry) => entry.required && entry.state !== 'ready')
    .map((entry) => ({
      stream: entry.stream,
      state: entry.state as Exclude<SyncReadMirrorState, 'ready'>,
      lastError: entry.lastError,
    }));
  return blockers.length === 0
    ? { state: 'ready', checkedAt, blockers: [] }
    : { state: 'not_ready', checkedAt, blockers };
}

export type ConfigFreshnessRuntimeServiceMode =
  | 'monolith'
  | 'api'
  | 'automation'
  | 'content';

export type ConfigFreshnessAuthorityMode = 'local-authority' | 'remote-mirror';

export interface PerProcessConfigFreshnessRuntimeOptions {
  serviceMode: ConfigFreshnessRuntimeServiceMode;
  authorityMode: ConfigFreshnessAuthorityMode;
  source?: ConfigMirrorFreshnessSource;
}

export class PerProcessConfigFreshnessRuntime implements ConfigMirrorFreshnessSource {
  private readonly serviceMode: ConfigFreshnessRuntimeServiceMode;
  private readonly authorityMode: ConfigFreshnessAuthorityMode;
  private readonly source: ConfigMirrorFreshnessSource | null;

  constructor(options: PerProcessConfigFreshnessRuntimeOptions) {
    if (options.authorityMode === 'local-authority' && options.serviceMode !== 'monolith') {
      throw new Error(
        `config_freshness_local_authority_forbidden serviceMode=${options.serviceMode}`,
      );
    }
    this.serviceMode = options.serviceMode;
    this.authorityMode = options.authorityMode;
    this.source = options.source ?? null;
  }

  stateOf(mirrorKey: ConfigMirrorKey): MirrorReadState {
    if (this.authorityMode === 'local-authority') return 'fresh';
    if (!this.source) return 'stale';
    try {
      return this.source.stateOf(mirrorKey);
    } catch {
      return 'stale';
    }
  }

  noteStaleRefusal(mirrorKey: ConfigMirrorKey, context?: string): void {
    if (this.authorityMode === 'local-authority' || !this.source) return;
    try {
      this.source.noteStaleRefusal(mirrorKey, context);
    } catch {
      // Observability cannot turn a fail-closed decision into a thrown hot-path error.
    }
  }

  readiness(requiredKeys: readonly ConfigMirrorKey[]): {
    state: 'ready' | 'not_ready';
    serviceMode: ConfigFreshnessRuntimeServiceMode;
    authorityMode: ConfigFreshnessAuthorityMode;
    blockers: ConfigMirrorKey[];
  } {
    const blockers = requiredKeys.filter((key) => this.stateOf(key) !== 'fresh');
    return {
      state: blockers.length === 0 ? 'ready' : 'not_ready',
      serviceMode: this.serviceMode,
      authorityMode: this.authorityMode,
      blockers,
    };
  }
}

function deliveryStateOf(state: SyncReadMirrorState): SyncReadDeliveryState {
  switch (state) {
    case 'ready':
      return 'fresh';
    case 'stale':
      return 'stale';
    case 'invalid':
      return 'invalid';
    case 'uninitialized':
    case 'recovering':
      return 'unknown';
  }
}

function assertUnsignedCursor(value: string): void {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    invalid('cursor_format', 'snapshot cursor must be a canonical unsigned decimal string');
  }
}

function assertTimestamp(value: unknown, name: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    invalid('timestamp', `snapshot ${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function invalid(reason: string, message: string): never {
  throw new SyncReadSnapshotValidationError(reason, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSyncReadJson(value: unknown): value is SyncReadJson {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isSyncReadJson);
  if (!isRecord(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return (
    (proto === Object.prototype || proto === null) &&
    Object.values(value).every(isSyncReadJson)
  );
}

function isSemanticallyEmpty(value: SyncReadJson): boolean {
  if (value === null || value === false || value === '' || value === 0) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && Object.keys(value).length === 0;
}

function canonicalJson(value: SyncReadJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as { readonly [key: string]: SyncReadJson };
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`)
    .join(',')}}`;
}

function freezeJson<T extends SyncReadJson>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const member of Object.values(value)) freezeJson(member);
    Object.freeze(value);
  }
  return value;
}
