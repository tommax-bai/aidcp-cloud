import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiSyncReadMirrors } from '../../src/config/api-sync-read-mirrors.js';
import { PgAutomationSyncReadGenerationStore } from '../../src/transport/automation-sync-read-generation-store.js';
import {
  AutomationSyncReadSnapshotSource,
  type AutomationSyncReadRuntimeSources,
} from '../../src/transport/automation-sync-read-source.js';
import { SyncReadChangedOutbox } from '../../src/transport/sync-read-changed-outbox.js';

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

  const first = await sourceOne.snapshot('edge_presence', 100);
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
  const sameAfterRestart = await sourceAfterRestart.snapshot('edge_presence', 300);
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

test('runtime owner snapshot fails loudly when durable generation cannot be observed', async () => {
  const source = new AutomationSyncReadSnapshotSource(
    'dev',
    runtimeSources(() => 0),
    {
      async observe() {
        throw new Error('generation_store_unavailable');
      },
    },
    { async emit(_stream, generation) { return { emitted: false, generation }; } },
  );
  await assert.rejects(
    source.snapshot('edge_presence', 100),
    /generation_store_unavailable/,
  );
});

test('sync_read.changed coalescing is durable across outbox wrapper restarts', async () => {
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
  assert.equal(state.events, 2);
});

test('A1 first-load version failure is not converted into a zero cursor', async () => {
  const source = new AutomationSyncReadSnapshotSource(
    'dev',
    {
      ...runtimeSources(() => 0),
      async versionOf() {
        return null;
      },
    },
    {
      async observe() {
        return '1';
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
    async versionOf() {
      return 1;
    },
    weekActiveMask: () => null,
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
      async query(_sql: string, params?: unknown[]) {
        const key = `${String(params?.[0])}:${String(params?.[1])}`;
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
