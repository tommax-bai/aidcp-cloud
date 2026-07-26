import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiSyncReadMirrors } from '../../src/config/api-sync-read-mirrors.js';
import { syncReadPayloadDigest } from '../../src/kernel/sync-read-snapshot.js';
import { PgAutomationSyncReadGenerationStore } from '../../src/transport/automation-sync-read-generation-store.js';
import {
  AutomationSyncReadSnapshotSource,
  type AutomationSyncReadRuntimeSources,
} from '../../src/transport/automation-sync-read-source.js';
import {
  createSyncReadChangedHandler,
  SyncReadChangedOutbox,
} from '../../src/transport/sync-read-changed-outbox.js';

test('runtime generation survives owner process restart and continues an API checkpoint cursor', async () => {
  const durable = generationPool();
  const generationOne = new PgAutomationSyncReadGenerationStore('dev', durable.pool as never);
  const emitted = new Map<string, string>();
  const emitter = {
    async emit(stream: string, generation: string) {
      const prior = emitted.get(stream);
      if (prior === generation) return { emitted: false, generation };
      emitted.set(stream, generation);
      return { emitted: true, generation };
    },
  };
  let onlineEdgeCount = 0;
  const runtime = runtimeSources(() => onlineEdgeCount);
  const sourceOne = new AutomationSyncReadSnapshotSource(
    'dev',
    runtime,
    generationOne,
    emitter as never,
  );
  const api = new ApiSyncReadMirrors('dev', () => 1_000);

  const first = await sourceOne.publishChanged('edge_presence', 100);
  assert.equal(first.cursor, '1');
  assert.equal(api.apply(first, 'owner_fetch').outcome, 'applied');

  onlineEdgeCount = 1;
  const changed = await sourceOne.publishChanged('edge_presence', 200);
  assert.equal(changed.cursor, '2');
  assert.equal(api.apply(changed, 'owner_fetch').outcome, 'applied');

  const sourceAfterRestart = new AutomationSyncReadSnapshotSource(
    'dev',
    runtime,
    new PgAutomationSyncReadGenerationStore('dev', durable.pool as never),
    emitter as never,
  );
  await assert.rejects(
    sourceAfterRestart.snapshot('edge_presence', 300),
    /runtime_unobserved/,
  );
  const sameAfterRestart = await sourceAfterRestart.publishChanged(
    'edge_presence',
    300,
  );
  assert.equal(sameAfterRestart.cursor, '2');
  assert.equal(api.apply(sameAfterRestart, 'owner_fetch').outcome, 'freshness_renewed');

  onlineEdgeCount = 0;
  const nextAfterRestart = await sourceAfterRestart.publishChanged(
    'edge_presence',
    400,
  );
  assert.equal(nextAfterRestart.cursor, '3');
  assert.equal(api.apply(nextAfterRestart, 'owner_fetch').outcome, 'applied');
});

test('runtime snapshot is side-effect-free and only publishChanged observes mutable state', async () => {
  let online = 0;
  let observations = 0;
  let emitted = 0;
  const durable = generationPool();
  const source = new AutomationSyncReadSnapshotSource(
    'dev',
    runtimeSources(() => online),
    {
      async observe(stream, value) {
        observations += 1;
        return new PgAutomationSyncReadGenerationStore(
          'dev',
          durable.pool as never,
        ).observe(stream, value);
      },
      async current(stream) {
        return new PgAutomationSyncReadGenerationStore(
          'dev',
          durable.pool as never,
        ).current(stream);
      },
    },
    {
      async emit(_stream, generation) {
        emitted += 1;
        return { emitted: true, generation };
      },
    },
  );
  const observed = await source.publishChanged('edge_presence', 100);
  const api = new ApiSyncReadMirrors('dev', () => 100);
  assert.equal(api.apply(observed, 'owner_fetch').outcome, 'applied');
  online = 1;
  const fetched = await source.snapshot('edge_presence', 50_000);
  assert.equal(observations, 1);
  assert.equal(emitted, 1);
  assert.equal(fetched.cursor, observed.cursor);
  assert.deepEqual(fetched.value, observed.value);
  assert.equal(fetched.asOf, 50_000);
  assert.equal(fetched.freshUntil, 95_000);
  assert.equal(fetched.value.onlineEdgeCount, 0);
  assert.equal(api.apply(fetched, 'owner_fetch').outcome, 'freshness_renewed');
});

test('runtime publish serializes per stream and rereads mutable state inside the critical section', async () => {
  let online = 0;
  let observeCalls = 0;
  let releaseFirst!: () => void;
  let enteredFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    enteredFirst = resolve;
  });
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let current:
    | { generation: string; payloadDigest: string }
    | null = null;
  const source = new AutomationSyncReadSnapshotSource(
    'dev',
    runtimeSources(() => online),
    {
      async observe(_stream, value) {
        observeCalls += 1;
        if (observeCalls === 1) {
          enteredFirst();
          await firstRelease;
        }
        current = {
          generation: String(observeCalls),
          payloadDigest: syncReadPayloadDigest(value),
        };
        return current.generation;
      },
      async current() {
        return current;
      },
    },
    { async emit(_stream, generation) { return { emitted: true, generation }; } },
  );

  const first = source.publishChanged('edge_presence', 100);
  await firstEntered;
  online = 1;
  const second = source.publishChanged('edge_presence', 200);
  releaseFirst();
  assert.equal((await first).value.onlineEdgeCount, 0);
  assert.equal((await second).value.onlineEdgeCount, 1);
  const stable = await source.snapshot('edge_presence', 300);
  assert.equal(stable.cursor, '2');
  assert.equal(stable.value.onlineEdgeCount, 1);
});

test('sync_read.changed emit deduplicates the same generation across wrapper restarts', async () => {
  const state = {
    generation: '5',
    lastEmitted: '0',
    events: 0,
  };
  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes('WITH claimed AS')) {
        const requested = String(params?.[2]);
        if (
          requested !== state.generation ||
          BigInt(state.lastEmitted) >= BigInt(state.generation)
        ) {
          return { rows: [] };
        }
        state.lastEmitted = state.generation;
        state.events += 1;
        return { rows: [{ id: state.events }] };
      }
      if (sql.includes('pg_notify')) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  const firstProcess = new SyncReadChangedOutbox('dev', pool as never);
  assert.deepEqual(await firstProcess.emit('edge_presence', '5'), {
    emitted: true,
    generation: '5',
  });
  const afterRestart = new SyncReadChangedOutbox('dev', pool as never);
  assert.deepEqual(await afterRestart.emit('edge_presence', '5'), {
    emitted: false,
    generation: '5',
  });
  state.generation = '6';
  assert.deepEqual(await afterRestart.emit('edge_presence', '6'), {
    emitted: true,
    generation: '6',
  });
  assert.equal(
    state.events,
    2,
    'consecutive generations each remain durable events; only identical-generation retries dedupe',
  );
});

test('sync_read.changed rejects unknown keys, unsupported versions and non-string generations', async () => {
  let fetches = 0;
  const handler = createSyncReadChangedHandler({
    executionTarget: 'dev',
    async fetchSnapshot() {
      fetches += 1;
      throw new Error('unexpected_fetch');
    },
    apply() {
      throw new Error('unexpected_apply');
    },
  });
  const base = {
    id: 1,
    topic: 'sync_read.changed',
    executionTarget: 'dev',
    createdAt: new Date(),
  };
  for (const payload of [
    {
      contractVersion: 999,
      executionTarget: 'dev',
      stream: 'edge_presence',
      generation: '1',
    },
    {
      contractVersion: 1,
      executionTarget: 'dev',
      stream: 'edge_presence',
      generation: ['1'],
    },
    {
      contractVersion: 1,
      executionTarget: 'dev',
      stream: 'edge_presence',
      generation: '1',
      extra: true,
    },
  ]) {
    await assert.rejects(handler({ ...base, payload } as never), /payload_invalid/);
  }
  assert.equal(fetches, 0);
});

test('A1 first-load version failure is not converted into a zero cursor', async () => {
  const source = new AutomationSyncReadSnapshotSource(
    'dev',
    {
      ...runtimeSources(() => 0),
      async sessionConfigGlobal() {
        throw new Error('session_config_global_version_unavailable');
      },
    },
    {
      async observe() {
        return '1';
      },
      async current() {
        return null;
      },
    },
    { async emit(_stream, generation) { return { emitted: false, generation }; } },
  );
  await assert.rejects(
    source.snapshot('session_config_global', 100),
    /session_config_global_version_unavailable/,
  );
});

function runtimeSources(
  online: () => number,
): AutomationSyncReadRuntimeSources {
  return {
    async sessionConfigGlobal() {
      return { cursor: '1', weekActiveMask: null };
    },
    edgePresence: () => ({
      edgeCount: 1,
      onlineEdgeCount: online(),
      accountEdges: online() === 1 ? [{ accountId: 'a', edgeId: 'edge-1' }] : [],
    }),
    publishInFlight: () => ({ recordIds: [] }),
    captchaAvailability: () => ({ state: 'disabled' }),
    configMirrorHealth: () => ({
      sourceService: 'automation',
      asOf: 1,
      enabled: true,
      pollMs: 1_000,
      entries: [],
    }),
  };
}

function generationPool() {
  const rows = new Map<
    string,
    { generation: bigint; digest: string }
  >();
  return {
    pool: {
      async query(sql: string, params?: unknown[]) {
        const key = `${String(params?.[0])}:${String(params?.[1])}`;
        if (sql.includes('SELECT generation, payload_digest')) {
          const current = rows.get(key);
          return {
            rows: current
              ? [{
                  generation: current.generation.toString(),
                  payload_digest: current.digest,
                }]
              : [],
          };
        }
        const digest = String(params?.[2]);
        const current = rows.get(key);
        if (!current) {
          rows.set(key, { generation: 1n, digest });
        } else if (current.digest !== digest) {
          current.generation += 1n;
          current.digest = digest;
        }
        return { rows: [{ generation: rows.get(key)!.generation.toString() }] };
      },
    },
  };
}
