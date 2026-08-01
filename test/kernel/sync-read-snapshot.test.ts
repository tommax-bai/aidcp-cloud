import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AtomicSyncReadMirror,
  compareUnsignedSyncReadCursor,
  PerProcessConfigFreshnessRuntime,
  syncReadChangedSignal,
  syncReadPayloadDigest,
  syncReadProcessReadiness,
  SYNC_READ_STREAM_DEFINITIONS,
  type SyncReadSnapshotEnvelope,
} from '../../src/kernel/sync-read-snapshot.js';

function envelope(
  overrides: Partial<SyncReadSnapshotEnvelope<{ value: string }>> = {},
): SyncReadSnapshotEnvelope<{ value: string }> {
  return {
    contractVersion: 1,
    executionTarget: 'dev',
    factScope: 'shared',
    stream: 'session_config_global',
    cursor: '1',
    asOf: 1_000,
    freshUntil: 2_000,
    complete: true,
    value: { value: 'first' },
    ...overrides,
  };
}

test('stream registry is closed and distinguishes shared from target facts', () => {
  assert.equal(Object.keys(SYNC_READ_STREAM_DEFINITIONS).length, 13);
  assert.equal(SYNC_READ_STREAM_DEFINITIONS.session_config_global.factScope, 'shared');
  assert.equal(SYNC_READ_STREAM_DEFINITIONS.edge_presence.factScope, 'target');
  assert.equal(SYNC_READ_STREAM_DEFINITIONS.automation_account_projection.factScope, 'shared');
});

test('cursor comparison uses unsigned integer semantics rather than lexical order', () => {
  assert.equal(compareUnsignedSyncReadCursor('9', '10'), -1);
  assert.equal(compareUnsignedSyncReadCursor('10', '9'), 1);
  assert.equal(compareUnsignedSyncReadCursor('900719925474099312345', '900719925474099312344'), 1);
  assert.throws(() => compareUnsignedSyncReadCursor('-1', '0'), /unsigned decimal/);
  assert.throws(() => compareUnsignedSyncReadCursor('01', '1'), /canonical unsigned/);
});

test('payload digest is stable across object key order', () => {
  assert.equal(
    syncReadPayloadDigest({ alpha: 1, nested: { x: true, y: null } }),
    syncReadPayloadDigest({ nested: { y: null, x: true }, alpha: 1 }),
  );
});

test('sync_read.changed only carries target runtime generation and rejects shared facts', () => {
  assert.deepEqual(
    syncReadChangedSignal({
      executionTarget: 'dev',
      stream: 'edge_presence',
      generation: '12',
    }),
    {
      contractVersion: 1,
      executionTarget: 'dev',
      stream: 'edge_presence',
      generation: '12',
    },
  );
  assert.throws(
    () =>
      syncReadChangedSignal({
        executionTarget: 'dev',
        stream: 'session_config_global',
        generation: '12',
      }),
    /reserved for target-scoped runtime facts/,
  );
  assert.throws(
    () =>
      syncReadChangedSignal({
        executionTarget: 'dev',
        stream: 'edge_presence',
        generation: '-1',
      }),
    /unsigned decimal/,
  );
});

test('new cursor applies atomically and an older cursor cannot roll it back', () => {
  let now = 1_100;
  const mirror = new AtomicSyncReadMirror<{ value: string }>({
    executionTarget: 'dev',
    stream: 'session_config_global',
    clock: () => now,
  });
  assert.equal(mirror.view().state, 'uninitialized');
  assert.equal(mirror.apply(envelope(), 'owner_fetch').outcome, 'applied');
  assert.deepEqual(mirror.view(), {
    state: 'ready',
    value: { value: 'first' },
    metadata: {
      appliedCursor: '1',
      payloadDigest: syncReadPayloadDigest({ value: 'first' }),
      sourceAsOf: 1_000,
      lastObservedAt: 1_100,
      freshUntil: 2_000,
      lastAppliedAt: 1_100,
    },
  });

  now = 1_200;
  const rejected = mirror.apply(
    envelope({ cursor: '0', asOf: 1_100, value: { value: 'old' } }),
    'replay',
  );
  assert.deepEqual(rejected, {
    outcome: 'rejected',
    reason: 'old_cursor',
    currentCursor: '1',
    message: 'out_of_order cursor=0 current=1',
  });
  assert.deepEqual(mirror.view().value, { value: 'first' });
});

test('same-cursor owner observation renews only with identical digest and later asOf', () => {
  let now = 1_100;
  const mirror = new AtomicSyncReadMirror<{ value: string }>({
    executionTarget: 'dev',
    stream: 'session_config_global',
    clock: () => now,
  });
  mirror.apply(envelope(), 'owner_fetch');

  now = 2_100;
  assert.equal(mirror.view().state, 'stale');
  assert.equal(
    mirror.apply(
      envelope({ asOf: 2_050, freshUntil: 3_000 }),
      'owner_fetch',
    ).outcome,
    'freshness_renewed',
  );
  assert.equal(mirror.view().state, 'ready');
  assert.equal(mirror.view().metadata?.lastAppliedAt, 1_100);
  assert.equal(mirror.view().metadata?.lastObservedAt, 2_100);
});

test('historical replay never renews freshness even if it carries a later asOf', () => {
  let now = 1_100;
  const mirror = new AtomicSyncReadMirror<{ value: string }>({
    executionTarget: 'dev',
    stream: 'session_config_global',
    clock: () => now,
  });
  mirror.apply(envelope(), 'owner_fetch');
  now = 2_100;
  assert.equal(
    mirror.apply(
      envelope({ asOf: 2_050, freshUntil: 3_000 }),
      'replay',
    ).outcome,
    'already_applied',
  );
  assert.equal(mirror.view().state, 'stale');
  assert.equal(mirror.view().metadata?.freshUntil, 2_000);
});

test('same cursor with payload drift becomes invalid and retains last good value', () => {
  const mirror = new AtomicSyncReadMirror<{ value: string }>({
    executionTarget: 'dev',
    stream: 'session_config_global',
    clock: () => 1_100,
  });
  mirror.apply(envelope(), 'owner_fetch');
  assert.equal(
    mirror.apply(envelope({ value: { value: 'drift' } }), 'owner_fetch').outcome,
    'rejected',
  );
  assert.equal(mirror.view().state, 'invalid');
  assert.deepEqual(mirror.view().value, { value: 'first' });
  assert.equal(mirror.health().deliveryState, 'invalid');
});

test('invalid target, scope, cursor and incomplete envelopes cannot apply or renew', () => {
  const cases: unknown[] = [
    envelope({ executionTarget: 'ol' }),
    envelope({ factScope: 'target' }),
    envelope({ cursor: '-1' }),
    { ...envelope(), complete: false },
  ];
  for (const value of cases) {
    const mirror = new AtomicSyncReadMirror<{ value: string }>({
      executionTarget: 'dev',
      stream: 'session_config_global',
      clock: () => 1_100,
    });
    const result = mirror.apply(value, 'owner_fetch');
    assert.equal(result.outcome, 'rejected');
    assert.equal(mirror.view().state, 'invalid');
    assert.equal(mirror.health().appliedCursor, null);
  }
});

test('snapshot envelope is closed and rejects unknown top-level keys', () => {
  const mirror = new AtomicSyncReadMirror<{ value: string }>({
    executionTarget: 'dev',
    stream: 'session_config_global',
    clock: () => 1_100,
  });
  const result = mirror.apply(
    { ...envelope(), unexpected: true },
    'owner_fetch',
  );
  assert.equal(result.outcome, 'rejected');
  if (result.outcome !== 'rejected') return;
  assert.equal(result.reason, 'invalid_envelope');
  assert.match(result.message, /unknown keys/);
});

test('recovering preserves last good value but is not ready', () => {
  const mirror = new AtomicSyncReadMirror<{ value: string }>({
    executionTarget: 'dev',
    stream: 'session_config_global',
    clock: () => 1_100,
  });
  mirror.apply(envelope(), 'owner_fetch');
  mirror.beginRecovery();
  assert.equal(mirror.view().state, 'recovering');
  assert.deepEqual(mirror.view().value, { value: 'first' });
  assert.equal(mirror.health().deliveryState, 'unknown');
  assert.deepEqual(mirror.checkpoint(), {
    executionTarget: 'dev',
    consumer: 'api',
    stream: 'session_config_global',
    appliedCursor: '1',
    payloadDigest: syncReadPayloadDigest({ value: 'first' }),
    sourceAsOf: 1_000,
    lastObservedAt: 1_100,
    freshUntil: 2_000,
    lastAppliedAt: 1_100,
    state: 'recovering',
    lastError: 'owner snapshot recovery in progress',
  });
  assert.equal(syncReadProcessReadiness([mirror.health()]).state, 'not_ready');
});

test('process readiness ignores optional stale streams but names required blockers', () => {
  let now = 1_100;
  const required = new AtomicSyncReadMirror({
    executionTarget: 'dev',
    stream: 'session_config_global',
    required: true,
    clock: () => now,
  });
  const optional = new AtomicSyncReadMirror({
    executionTarget: 'dev',
    stream: 'publish_in_flight',
    required: false,
    clock: () => now,
  });
  required.apply(envelope(), 'owner_fetch');
  optional.apply(
    {
      ...envelope(),
      factScope: 'target',
      stream: 'publish_in_flight',
      value: [],
    },
    'owner_fetch',
  );
  now = 2_100;
  assert.equal(syncReadProcessReadiness([required.health(), optional.health()]).state, 'not_ready');
  now = 1_500;
  assert.equal(syncReadProcessReadiness([required.health(), optional.health()]).state, 'ready');
});

test('per-process freshness runtime treats missing remote source as stale/not-ready', () => {
  const runtime = new PerProcessConfigFreshnessRuntime({
    serviceMode: 'automation',
    authorityMode: 'remote-mirror',
  });
  assert.equal(runtime.stateOf('persona_config'), 'stale');
  assert.deepEqual(runtime.readiness(['persona_config']), {
    state: 'not_ready',
    serviceMode: 'automation',
    authorityMode: 'remote-mirror',
    blockers: ['persona_config'],
  });
});

test('local-authority freshness is explicit and monolith-only', () => {
  assert.throws(
    () =>
      new PerProcessConfigFreshnessRuntime({
        serviceMode: 'api',
        authorityMode: 'local-authority',
      }),
    /local_authority_forbidden/,
  );
  const runtime = new PerProcessConfigFreshnessRuntime({
    serviceMode: 'monolith',
    authorityMode: 'local-authority',
  });
  assert.equal(runtime.stateOf('persona_config'), 'fresh');
  assert.equal(runtime.readiness(['persona_config']).state, 'ready');
});

test('remote freshness source failures stay stale and refusal accounting never throws', () => {
  const runtime = new PerProcessConfigFreshnessRuntime({
    serviceMode: 'api',
    authorityMode: 'remote-mirror',
    source: {
      stateOf: () => {
        throw new Error('source failed');
      },
      noteStaleRefusal: () => {
        throw new Error('metrics failed');
      },
    },
  });
  assert.equal(runtime.stateOf('account_status'), 'stale');
  assert.doesNotThrow(() => runtime.noteStaleRefusal('account_status', 'test'));
});
