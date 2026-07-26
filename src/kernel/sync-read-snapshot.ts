import { createHash } from 'node:crypto';

import type {
  ConfigMirrorFreshnessSource,
  ConfigMirrorKey,
  MirrorReadState,
} from './config-mirror-bump-types.js';
import type { DeploymentTarget } from '../deployment-target.js';

export const SYNC_READ_CONTRACT_VERSION = 1 as const;
export const SYNC_READ_CHANGED_TOPIC = 'sync_read.changed' as const;
export const SYNC_READ_CHANGED_STREAMS = [
  'edge_presence',
  'publish_in_flight',
  'captcha_availability',
  'automation_config_mirror_health',
] as const;

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
export type SyncReadChangedStream =
  (typeof SYNC_READ_CHANGED_STREAMS)[number];
export type SyncReadConsumer =
  (typeof SYNC_READ_STREAM_DEFINITIONS)[SyncReadStream]['consumer'];

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
  stream: SyncReadChangedStream;
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
  consumer: SyncReadConsumer;
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

export type SyncReadCheckpointLoadResult =
  | { outcome: 'loaded'; checkpoint: SyncReadConsumerCheckpoint }
  | { outcome: 'not_found'; checkpoint: null }
  | {
      outcome: 'unknown';
      checkpoint: null;
      reason: 'checkpoint_invalid';
      message: string;
    };

export type SyncReadCheckpointSaveResult =
  | { outcome: 'stored'; checkpoint: SyncReadConsumerCheckpoint }
  | {
      outcome: 'rejected';
      reason:
        | 'checkpoint_invalid'
        | 'old_cursor'
        | 'historical_checkpoint'
        | 'same_cursor_payload_drift';
      currentCursor: string | null;
      message: string;
    };

export interface SyncReadCheckpointBackend {
  readonly consumer: SyncReadConsumer;
  load(
    executionTarget: DeploymentTarget,
    stream: SyncReadStream,
  ): Promise<unknown | null>;
  store(
    checkpoint: SyncReadConsumerCheckpoint,
  ): Promise<
    | { stored: true; row: unknown }
    | { stored: false; current: unknown | null }
  >;
}

export interface SyncReadConsumerCheckpointStoreOptions {
  executionTarget: DeploymentTarget;
  consumer: SyncReadConsumer;
  backend: SyncReadCheckpointBackend;
}

/**
 * Consumer-local checkpoint orchestration. The backend is owner-specific so
 * api and automation never need to write a shared cross-owner table.
 */
export class SyncReadConsumerCheckpointStore {
  private readonly executionTarget: DeploymentTarget;
  private readonly consumer: SyncReadConsumer;
  private readonly backend: SyncReadCheckpointBackend;

  constructor(options: SyncReadConsumerCheckpointStoreOptions) {
    if (options.backend.consumer !== options.consumer) {
      throw new Error(
        `sync_read_checkpoint_backend_consumer_mismatch expected=${options.consumer} actual=${options.backend.consumer}`,
      );
    }
    this.executionTarget = options.executionTarget;
    this.consumer = options.consumer;
    this.backend = options.backend;
  }

  async load(stream: SyncReadStream): Promise<SyncReadCheckpointLoadResult> {
    if (SYNC_READ_STREAM_DEFINITIONS[stream].consumer !== this.consumer) {
      return {
        outcome: 'unknown',
        checkpoint: null,
        reason: 'checkpoint_invalid',
        message: `stream ${stream} does not belong to consumer ${this.consumer}`,
      };
    }
    const row = await this.backend.load(this.executionTarget, stream);
    if (row === null) return { outcome: 'not_found', checkpoint: null };
    try {
      return {
        outcome: 'loaded',
        checkpoint: parseSyncReadConsumerCheckpoint(row, {
          executionTarget: this.executionTarget,
          consumer: this.consumer,
          stream,
        }),
      };
    } catch (error) {
      return {
        outcome: 'unknown',
        checkpoint: null,
        reason: 'checkpoint_invalid',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async save(input: unknown): Promise<SyncReadCheckpointSaveResult> {
    let checkpoint: SyncReadConsumerCheckpoint;
    try {
      checkpoint = parseSyncReadConsumerCheckpoint(input, {
        executionTarget: this.executionTarget,
        consumer: this.consumer,
      });
    } catch (error) {
      return {
        outcome: 'rejected',
        reason: 'checkpoint_invalid',
        currentCursor: null,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const stored = await this.backend.store(checkpoint);
    if (stored.stored) {
      try {
        return {
          outcome: 'stored',
          checkpoint: parseSyncReadConsumerCheckpoint(stored.row, {
            executionTarget: this.executionTarget,
            consumer: this.consumer,
            stream: checkpoint.stream,
          }),
        };
      } catch (error) {
        return {
          outcome: 'rejected',
          reason: 'checkpoint_invalid',
          currentCursor: null,
          message: `stored checkpoint could not be verified: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }

    let current: SyncReadConsumerCheckpoint | null = null;
    try {
      current =
        stored.current === null
          ? null
          : parseSyncReadConsumerCheckpoint(stored.current, {
              executionTarget: this.executionTarget,
              consumer: this.consumer,
              stream: checkpoint.stream,
            });
    } catch (error) {
      return {
        outcome: 'rejected',
        reason: 'checkpoint_invalid',
        currentCursor: null,
        message: `current checkpoint could not be verified: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    const currentCursor = current?.appliedCursor ?? null;
    const cursorOrder =
      currentCursor !== null &&
      checkpoint.appliedCursor !== null
        ? compareUnsignedSyncReadCursor(checkpoint.appliedCursor, currentCursor)
        : -1;
    const reason =
      cursorOrder !== 0
        ? 'old_cursor'
        : checkpoint.payloadDigest !== current?.payloadDigest
          ? 'same_cursor_payload_drift'
          : 'historical_checkpoint';
    return {
      outcome: 'rejected',
      reason,
      currentCursor,
      message:
        reason === 'same_cursor_payload_drift'
          ? `same cursor ${currentCursor} cannot replace its persisted payload digest`
          : reason === 'historical_checkpoint'
            ? `same cursor ${currentCursor} carried older or inconsistent observation metadata`
            : `checkpoint cursor ${checkpoint.appliedCursor ?? '(null)'} is older than ${currentCursor ?? '(null)'}`,
    };
  }
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
        | 'same_cursor_payload_drift'
        | 'recovery_owner_fetch_required';
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

export function isSyncReadChangedStream(
  value: unknown,
): value is SyncReadChangedStream {
  return (
    typeof value === 'string' &&
    (SYNC_READ_CHANGED_STREAMS as readonly string[]).includes(value)
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
  if (!isSyncReadChangedStream(input.stream)) {
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

export function parseSyncReadChangedSignal(
  input: unknown,
  expectation?: { executionTarget?: DeploymentTarget },
): SyncReadChangedSignal {
  if (!isRecord(input)) {
    invalid('changed_signal_type', 'sync_read.changed signal must be an object');
  }
  if (
    !hasExactKeys(input, [
      'contractVersion',
      'executionTarget',
      'stream',
      'generation',
    ])
  ) {
    invalid(
      'changed_signal_keys',
      'sync_read.changed signal contains missing or unknown keys',
    );
  }
  if (input.contractVersion !== SYNC_READ_CONTRACT_VERSION) {
    invalid(
      'changed_signal_contract_version',
      'sync_read.changed contractVersion is unsupported',
    );
  }
  if (input.executionTarget !== 'dev' && input.executionTarget !== 'ol') {
    invalid(
      'changed_signal_target',
      'sync_read.changed executionTarget must be dev or ol',
    );
  }
  if (
    expectation?.executionTarget !== undefined &&
    input.executionTarget !== expectation.executionTarget
  ) {
    invalid(
      'changed_signal_target_mismatch',
      `sync_read.changed target ${String(input.executionTarget)} does not match ${expectation.executionTarget}`,
    );
  }
  if (!isSyncReadChangedStream(input.stream)) {
    invalid(
      'changed_signal_stream',
      `sync_read.changed stream is not an automation runtime stream: ${String(input.stream)}`,
    );
  }
  if (
    typeof input.generation !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/.test(input.generation)
  ) {
    invalid(
      'changed_signal_generation',
      'sync_read.changed generation must be a canonical unsigned decimal string',
    );
  }
  return syncReadChangedSignal({
    executionTarget: input.executionTarget,
    stream: input.stream,
    generation: input.generation,
  });
}

export function syncReadPayloadDigest(value: SyncReadJson): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function parseSyncReadSnapshotEnvelope<T extends SyncReadJson>(
  input: unknown,
  expectation: SyncReadEnvelopeExpectation<T>,
): SyncReadSnapshotEnvelope<T> {
  if (!isRecord(input)) invalid('envelope_type', 'snapshot envelope must be an object');
  if (
    !hasExactKeys(input, [
      'contractVersion',
      'executionTarget',
      'factScope',
      'stream',
      'cursor',
      'asOf',
      'freshUntil',
      'complete',
      'value',
    ])
  ) {
    invalid('envelope_keys', 'snapshot envelope contains missing or unknown keys');
  }
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
  private readonly consumer: SyncReadConsumer;
  private readonly factScope: SyncReadFactScope;
  private readonly required: boolean;
  private readonly validateValue: ((value: unknown) => value is T) | undefined;
  private readonly clock: () => number;
  private current: { value: Readonly<T>; metadata: SyncReadAppliedMetadata } | null = null;
  private restoredMetadata: SyncReadAppliedMetadata | null = null;
  private forcedState: 'invalid' | 'recovering' | null = null;
  private lastError: string | null = null;

  constructor(options: AtomicSyncReadMirrorOptions<T>) {
    this.executionTarget = options.executionTarget;
    this.stream = options.stream;
    this.consumer = SYNC_READ_STREAM_DEFINITIONS[options.stream].consumer;
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
        currentCursor:
          this.current?.metadata.appliedCursor ??
          this.restoredMetadata?.appliedCursor ??
          null,
        message,
      };
    }

    const now = this.clock();
    const digest = syncReadPayloadDigest(envelope.value);
    const reference = this.current?.metadata ?? this.restoredMetadata;
    if (this.forcedState === 'recovering' && source !== 'owner_fetch') {
      this.lastError = 'authenticated owner snapshot required before replay';
      return {
        outcome: 'rejected',
        reason: 'recovery_owner_fetch_required',
        currentCursor: reference?.appliedCursor ?? null,
        message: this.lastError,
      };
    }
    if (!reference) {
      this.replace(envelope, digest, now);
      return { outcome: 'applied', cursor: envelope.cursor, payloadDigest: digest };
    }

    const comparison = compareUnsignedSyncReadCursor(
      envelope.cursor,
      reference.appliedCursor,
    );
    if (comparison < 0) {
      this.lastError = `out_of_order cursor=${envelope.cursor} current=${reference.appliedCursor}`;
      return {
        outcome: 'rejected',
        reason: 'old_cursor',
        currentCursor: reference.appliedCursor,
        message: this.lastError,
      };
    }
    if (comparison > 0) {
      this.replace(envelope, digest, now);
      return { outcome: 'applied', cursor: envelope.cursor, payloadDigest: digest };
    }
    if (digest !== reference.payloadDigest) {
      this.forcedState = 'invalid';
      this.lastError = `same cursor ${envelope.cursor} carried a different payload digest`;
      return {
        outcome: 'rejected',
        reason: 'same_cursor_payload_drift',
        currentCursor: reference.appliedCursor,
        message: this.lastError,
      };
    }
    if (!this.current) {
      if (source !== 'owner_fetch' || envelope.asOf <= reference.sourceAsOf) {
        return {
          outcome: 'already_applied',
          cursor: envelope.cursor,
          payloadDigest: digest,
        };
      }
      this.current = {
        value: envelope.value,
        metadata: {
          ...reference,
          sourceAsOf: envelope.asOf,
          lastObservedAt: now,
          freshUntil: envelope.freshUntil,
        },
      };
      this.restoredMetadata = null;
      this.forcedState = null;
      this.lastError = null;
      return {
        outcome: 'freshness_renewed',
        cursor: envelope.cursor,
        payloadDigest: digest,
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

  restoreCheckpoint(input: unknown): SyncReadCheckpointLoadResult {
    let checkpoint: SyncReadConsumerCheckpoint;
    try {
      checkpoint = parseSyncReadConsumerCheckpoint(input, {
        executionTarget: this.executionTarget,
        consumer: this.consumer,
        stream: this.stream,
      });
    } catch (error) {
      this.current = null;
      this.restoredMetadata = null;
      this.forcedState = 'invalid';
      this.lastError = error instanceof Error ? error.message : String(error);
      return {
        outcome: 'unknown',
        checkpoint: null,
        reason: 'checkpoint_invalid',
        message: this.lastError,
      };
    }
    this.current = null;
    this.restoredMetadata =
      checkpoint.appliedCursor === null
        ? null
        : {
            appliedCursor: checkpoint.appliedCursor,
            payloadDigest: checkpoint.payloadDigest!,
            sourceAsOf: checkpoint.sourceAsOf!,
            lastObservedAt: checkpoint.lastObservedAt!,
            freshUntil: checkpoint.freshUntil!,
            lastAppliedAt: checkpoint.lastAppliedAt!,
          };
    this.forcedState = 'recovering';
    this.lastError = 'checkpoint restored; authenticated owner snapshot required';
    return { outcome: 'loaded', checkpoint };
  }

  view(now = this.clock()): SyncReadMirrorView<T> {
    if (!this.current) {
      if (this.forcedState === 'invalid' || this.forcedState === 'recovering') {
        return {
          state: this.forcedState,
          value: null,
          metadata: this.restoredMetadata ? { ...this.restoredMetadata } : null,
        };
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
      consumer: this.consumer,
      stream: health.stream,
      appliedCursor: health.appliedCursor,
      payloadDigest:
        this.current?.metadata.payloadDigest ??
        this.restoredMetadata?.payloadDigest ??
        null,
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
    this.restoredMetadata = null;
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

export interface SyncReadCheckpointExpectation {
  executionTarget: DeploymentTarget;
  consumer: SyncReadConsumer;
  stream?: SyncReadStream;
}

export interface SyncReadCheckpointStorageRow {
  execution_target: unknown;
  consumer: unknown;
  stream: unknown;
  applied_cursor: unknown;
  payload_digest: unknown;
  source_as_of_ms: unknown;
  last_observed_at_ms: unknown;
  fresh_until_ms: unknown;
  last_applied_at_ms: unknown;
  state: unknown;
  last_error: unknown;
}

export function syncReadCheckpointFromStorageRow(
  row: SyncReadCheckpointStorageRow,
): unknown {
  return {
    executionTarget: row.execution_target,
    consumer: row.consumer,
    stream: row.stream,
    appliedCursor:
      row.applied_cursor === null ? null : String(row.applied_cursor),
    payloadDigest: row.payload_digest,
    sourceAsOf: storageTimestamp(row.source_as_of_ms),
    lastObservedAt: storageTimestamp(row.last_observed_at_ms),
    freshUntil: storageTimestamp(row.fresh_until_ms),
    lastAppliedAt: storageTimestamp(row.last_applied_at_ms),
    state: row.state,
    lastError: row.last_error,
  };
}

export function parseSyncReadConsumerCheckpoint(
  input: unknown,
  expectation: SyncReadCheckpointExpectation,
): SyncReadConsumerCheckpoint {
  if (!isRecord(input)) {
    throw new SyncReadSnapshotValidationError(
      'checkpoint_type',
      'sync-read checkpoint must be an object',
    );
  }
  if (input.executionTarget !== expectation.executionTarget) {
    throw new SyncReadSnapshotValidationError(
      'checkpoint_target',
      `checkpoint target ${String(input.executionTarget)} does not match ${expectation.executionTarget}`,
    );
  }
  if (input.consumer !== expectation.consumer) {
    throw new SyncReadSnapshotValidationError(
      'checkpoint_consumer',
      `checkpoint consumer ${String(input.consumer)} does not match ${expectation.consumer}`,
    );
  }
  if (!isSyncReadStream(input.stream)) {
    throw new SyncReadSnapshotValidationError(
      'checkpoint_stream',
      `checkpoint stream ${String(input.stream)} is not registered`,
    );
  }
  if (expectation.stream !== undefined && input.stream !== expectation.stream) {
    throw new SyncReadSnapshotValidationError(
      'checkpoint_stream',
      `checkpoint stream ${input.stream} does not match ${expectation.stream}`,
    );
  }
  if (SYNC_READ_STREAM_DEFINITIONS[input.stream].consumer !== expectation.consumer) {
    throw new SyncReadSnapshotValidationError(
      'checkpoint_stream_consumer',
      `checkpoint stream ${input.stream} does not belong to consumer ${expectation.consumer}`,
    );
  }
  if (!isSyncReadMirrorState(input.state)) {
    throw new SyncReadSnapshotValidationError(
      'checkpoint_state',
      `checkpoint state ${String(input.state)} is invalid`,
    );
  }
  const lastError = nullableString(input.lastError, 'lastError');
  if (input.appliedCursor === null) {
    if (
      input.payloadDigest !== null ||
      input.sourceAsOf !== null ||
      input.lastObservedAt !== null ||
      input.freshUntil !== null ||
      input.lastAppliedAt !== null
    ) {
      throw new SyncReadSnapshotValidationError(
        'checkpoint_partial',
        'checkpoint without an applied cursor cannot carry applied metadata',
      );
    }
    if (input.state === 'ready' || input.state === 'stale') {
      throw new SyncReadSnapshotValidationError(
        'checkpoint_state',
        `checkpoint state ${input.state} requires an applied cursor`,
      );
    }
    return {
      executionTarget: expectation.executionTarget,
      consumer: expectation.consumer,
      stream: input.stream,
      appliedCursor: null,
      payloadDigest: null,
      sourceAsOf: null,
      lastObservedAt: null,
      freshUntil: null,
      lastAppliedAt: null,
      state: input.state,
      lastError,
    };
  }
  if (typeof input.appliedCursor !== 'string') {
    throw new SyncReadSnapshotValidationError(
      'checkpoint_cursor',
      'checkpoint appliedCursor must be a canonical unsigned decimal string or null',
    );
  }
  assertUnsignedCursor(input.appliedCursor);
  if (
    typeof input.payloadDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(input.payloadDigest)
  ) {
    throw new SyncReadSnapshotValidationError(
      'checkpoint_digest',
      'checkpoint payloadDigest must be a sha256 digest',
    );
  }
  const sourceAsOf = assertTimestamp(input.sourceAsOf, 'checkpoint sourceAsOf');
  const lastObservedAt = assertTimestamp(
    input.lastObservedAt,
    'checkpoint lastObservedAt',
  );
  const freshUntil = assertTimestamp(input.freshUntil, 'checkpoint freshUntil');
  const lastAppliedAt = assertTimestamp(
    input.lastAppliedAt,
    'checkpoint lastAppliedAt',
  );
  if (freshUntil < sourceAsOf) {
    throw new SyncReadSnapshotValidationError(
      'checkpoint_freshness',
      'checkpoint freshUntil must be greater than or equal to sourceAsOf',
    );
  }
  if (input.state === 'uninitialized') {
    throw new SyncReadSnapshotValidationError(
      'checkpoint_state',
      'checkpoint state uninitialized cannot carry an applied cursor',
    );
  }
  return {
    executionTarget: expectation.executionTarget,
    consumer: expectation.consumer,
    stream: input.stream,
    appliedCursor: input.appliedCursor,
    payloadDigest: input.payloadDigest,
    sourceAsOf,
    lastObservedAt,
    freshUntil,
    lastAppliedAt,
    state: input.state,
    lastError,
  };
}

function isSyncReadMirrorState(value: unknown): value is SyncReadMirrorState {
  return (
    value === 'uninitialized' ||
    value === 'ready' ||
    value === 'stale' ||
    value === 'invalid' ||
    value === 'recovering'
  );
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  throw new SyncReadSnapshotValidationError(
    'checkpoint_string',
    `checkpoint ${name} must be a string or null`,
  );
}

function storageTimestamp(value: unknown): unknown {
  if (value === null || typeof value === 'number') return value;
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : value;
  }
  return value;
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

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
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
