import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AtomicSyncReadMirror,
  SyncReadConsumerCheckpointStore,
  syncReadPayloadDigest,
  type SyncReadCheckpointBackend,
  type SyncReadConsumer,
  type SyncReadConsumerCheckpoint,
  type SyncReadSnapshotEnvelope,
  type SyncReadStream,
} from '../../src/kernel/sync-read-snapshot.js';
import type { DeploymentTarget } from '../../src/deployment-target.js';

function envelope(
  overrides: Partial<SyncReadSnapshotEnvelope<{ value: string }>> = {},
): SyncReadSnapshotEnvelope<{ value: string }> {
  return {
    contractVersion: 1,
    executionTarget: 'dev',
    factScope: 'shared',
    stream: 'session_config_global',
    cursor: '10',
    asOf: 1_000,
    freshUntil: 2_000,
    complete: true,
    value: { value: 'current' },
    ...overrides,
  };
}

class MemoryCheckpointBackend implements SyncReadCheckpointBackend {
  private readonly rows = new Map<string, SyncReadConsumerCheckpoint>();

  constructor(readonly consumer: SyncReadConsumer) {}

  corrupt(
    target: DeploymentTarget,
    stream: SyncReadStream,
    value: SyncReadConsumerCheckpoint,
  ): void {
    this.rows.set(`${target}:${stream}`, value);
  }

  async load(
    executionTarget: DeploymentTarget,
    stream: SyncReadStream,
  ): Promise<unknown | null> {
    return this.rows.get(`${executionTarget}:${stream}`) ?? null;
  }

  async store(
    checkpoint: SyncReadConsumerCheckpoint,
  ): Promise<
    | { stored: true; row: unknown }
    | { stored: false; current: unknown | null }
  > {
    const key = `${checkpoint.executionTarget}:${checkpoint.stream}`;
    const current = this.rows.get(key);
    if (current?.appliedCursor !== null && current?.appliedCursor !== undefined) {
      if (checkpoint.appliedCursor === null) {
        return { stored: false, current };
      }
      const cursorOrder =
        BigInt(checkpoint.appliedCursor) - BigInt(current.appliedCursor);
      if (
        cursorOrder < 0n ||
        (
          cursorOrder === 0n &&
          (
            checkpoint.payloadDigest !== current.payloadDigest ||
            checkpoint.sourceAsOf! < current.sourceAsOf! ||
            checkpoint.lastObservedAt! < current.lastObservedAt! ||
            (
              checkpoint.sourceAsOf === current.sourceAsOf &&
              (
                checkpoint.lastObservedAt !== current.lastObservedAt ||
                checkpoint.freshUntil !== current.freshUntil ||
                checkpoint.lastAppliedAt !== current.lastAppliedAt
              )
            ) ||
            (
              checkpoint.sourceAsOf! > current.sourceAsOf! &&
              checkpoint.lastAppliedAt !== current.lastAppliedAt
            )
          )
        )
      ) {
        return { stored: false, current };
      }
    }
    this.rows.set(key, checkpoint);
    return { stored: true, row: checkpoint };
  }
}

test('checkpoint survives a process restart and preserves the monotonic cursor barrier', async () => {
  let now = 1_100;
  const first = new AtomicSyncReadMirror<{ value: string }>({
    executionTarget: 'dev',
    stream: 'session_config_global',
    clock: () => now,
  });
  first.apply(envelope(), 'owner_fetch');

  const backend = new MemoryCheckpointBackend('api');
  const store = new SyncReadConsumerCheckpointStore({
    executionTarget: 'dev',
    consumer: 'api',
    backend,
  });
  assert.equal((await store.save(first.checkpoint())).outcome, 'stored');

  const loaded = await store.load('session_config_global');
  assert.equal(loaded.outcome, 'loaded');
  if (loaded.outcome !== 'loaded') return;

  const restarted = new AtomicSyncReadMirror<{ value: string }>({
    executionTarget: 'dev',
    stream: 'session_config_global',
    clock: () => now,
  });
  assert.equal(restarted.restoreCheckpoint(loaded.checkpoint).outcome, 'loaded');
  assert.equal(restarted.view().state, 'recovering');
  assert.equal(restarted.view().value, null, 'checkpoint metadata MUST NOT masquerade as a restored payload');
  assert.equal(restarted.health().appliedCursor, '10');

  assert.deepEqual(
    restarted.apply(
      envelope({ cursor: '9', asOf: 1_050, value: { value: 'old' } }),
      'owner_fetch',
    ),
    {
      outcome: 'rejected',
      reason: 'old_cursor',
      currentCursor: '10',
      message: 'out_of_order cursor=9 current=10',
    },
  );
  now = 1_200;
  assert.deepEqual(
    restarted.apply(envelope({ asOf: 1_100, freshUntil: 2_100 }), 'replay'),
    {
      outcome: 'rejected',
      reason: 'recovery_owner_fetch_required',
      currentCursor: '10',
      message: 'authenticated owner snapshot required before replay',
    },
  );
  assert.equal(restarted.view().state, 'recovering', 'historical replay MUST NOT make restart ready');
  assert.equal(
    restarted.apply(envelope({ asOf: 1_100, freshUntil: 2_100 }), 'owner_fetch').outcome,
    'freshness_renewed',
  );
  assert.equal(restarted.view().state, 'ready');
  assert.deepEqual(restarted.view().value, { value: 'current' });
});

test('a newer replay cannot bypass the restored owner-fetch recovery barrier', async () => {
  const source = new AtomicSyncReadMirror<{ value: string }>({
    executionTarget: 'dev',
    stream: 'session_config_global',
    clock: () => 1_100,
  });
  source.apply(envelope(), 'owner_fetch');

  const restarted = new AtomicSyncReadMirror<{ value: string }>({
    executionTarget: 'dev',
    stream: 'session_config_global',
    clock: () => 1_200,
  });
  restarted.restoreCheckpoint(source.checkpoint());

  assert.deepEqual(
    restarted.apply(
      envelope({
        cursor: '11',
        asOf: 1_150,
        freshUntil: 2_150,
        value: { value: 'replayed-newer' },
      }),
      'replay',
    ),
    {
      outcome: 'rejected',
      reason: 'recovery_owner_fetch_required',
      currentCursor: '10',
      message: 'authenticated owner snapshot required before replay',
    },
  );
  assert.equal(restarted.view().state, 'recovering');
  assert.equal(restarted.health().appliedCursor, '10');

  assert.equal(
    restarted.apply(
      envelope({
        cursor: '11',
        asOf: 1_200,
        freshUntil: 2_200,
        value: { value: 'owner-current' },
      }),
      'owner_fetch',
    ).outcome,
    'applied',
  );
  assert.equal(restarted.view().state, 'ready');
  assert.deepEqual(restarted.view().value, { value: 'owner-current' });
});

test('checkpoint keys isolate target and stream and reject a stream owned by another consumer', async () => {
  const backend = new MemoryCheckpointBackend('api');
  const dev = new SyncReadConsumerCheckpointStore({
    executionTarget: 'dev',
    consumer: 'api',
    backend,
  });
  const ol = new SyncReadConsumerCheckpointStore({
    executionTarget: 'ol',
    consumer: 'api',
    backend,
  });
  const digest = syncReadPayloadDigest({ value: 'dev' });
  assert.equal(
    (
      await dev.save({
        executionTarget: 'dev',
        consumer: 'api',
        stream: 'session_config_global',
        appliedCursor: '1',
        payloadDigest: digest,
        sourceAsOf: 100,
        lastObservedAt: 110,
        freshUntil: 200,
        lastAppliedAt: 110,
        state: 'ready',
        lastError: null,
      })
    ).outcome,
    'stored',
  );
  assert.equal((await ol.load('session_config_global')).outcome, 'not_found');
  assert.equal((await dev.load('edge_presence')).outcome, 'not_found');
  assert.equal((await dev.load('account_persona')).outcome, 'unknown');
});

test('corrupt persisted metadata fails closed as unknown instead of becoming ready', async () => {
  const backend = new MemoryCheckpointBackend('api');
  backend.corrupt('dev', 'session_config_global', {
    executionTarget: 'dev',
    consumer: 'api',
    stream: 'session_config_global',
    appliedCursor: '7',
    payloadDigest: 'not-a-digest',
    sourceAsOf: 100,
    lastObservedAt: 110,
    freshUntil: 200,
    lastAppliedAt: 110,
    state: 'ready',
    lastError: null,
  });
  const store = new SyncReadConsumerCheckpointStore({
    executionTarget: 'dev',
    consumer: 'api',
    backend,
  });
  const result = await store.load('session_config_global');
  assert.equal(result.outcome, 'unknown');
  if (result.outcome === 'unknown') assert.match(result.message, /payloadDigest/);
});

test('persisted checkpoint never accepts an older cursor or same-cursor digest drift', async () => {
  const backend = new MemoryCheckpointBackend('api');
  const store = new SyncReadConsumerCheckpointStore({
    executionTarget: 'dev',
    consumer: 'api',
    backend,
  });
  const base: SyncReadConsumerCheckpoint = {
    executionTarget: 'dev',
    consumer: 'api',
    stream: 'session_config_global',
    appliedCursor: '900719925474099312345',
    payloadDigest: syncReadPayloadDigest({ value: 'base' }),
    sourceAsOf: 100,
    lastObservedAt: 110,
    freshUntil: 200,
    lastAppliedAt: 110,
    state: 'ready',
    lastError: null,
  };
  assert.equal((await store.save(base)).outcome, 'stored');

  const old = await store.save({ ...base, appliedCursor: '9' });
  assert.deepEqual(
    { outcome: old.outcome, reason: old.outcome === 'rejected' ? old.reason : null },
    { outcome: 'rejected', reason: 'old_cursor' },
  );
  const drift = await store.save({
    ...base,
    payloadDigest: syncReadPayloadDigest({ value: 'drift' }),
  });
  assert.deepEqual(
    { outcome: drift.outcome, reason: drift.outcome === 'rejected' ? drift.reason : null },
    { outcome: 'rejected', reason: 'same_cursor_payload_drift' },
  );
  const historical = await store.save({
    ...base,
    sourceAsOf: 99,
    lastObservedAt: 109,
  });
  assert.deepEqual(
    {
      outcome: historical.outcome,
      reason: historical.outcome === 'rejected' ? historical.reason : null,
    },
    { outcome: 'rejected', reason: 'historical_checkpoint' },
  );
});
