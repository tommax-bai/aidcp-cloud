import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SYNC_READ_SNAPSHOT_ROUTE,
  SyncReadSnapshotHttpClient,
  registerSyncReadSnapshotRoute,
} from '../../src/transport/sync-read-snapshot-http.js';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from '../../src/transport/internal-http.js';

async function withServer(
  configure: (server: InternalHttpServer) => void,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  configure(server);
  const port = await server.listen(0);
  try {
    await run(port);
  } finally {
    await server.close();
  }
}

test('authenticated client receives server-targeted and fact-scope-validated snapshot', async () => {
  const requested: unknown[] = [];
  await withServer(
    (server) =>
      registerSyncReadSnapshotRoute(
        server,
        {
          snapshotFor: async (input) => {
            requested.push(input);
            return {
              contractVersion: 1,
              executionTarget: input.executionTarget,
              factScope: 'shared',
              stream: input.stream,
              cursor: '7',
              asOf: 1_000,
              freshUntil: 2_000,
              complete: true,
              value: { weekActiveMask: '1111100' },
            };
          },
        },
        {
          owner: 'automation',
          executionTarget: 'dev',
          bearerToken: 'snapshot-token',
          streams: ['session_config_global'],
        },
      ),
    async (port) => {
      const client = new SyncReadSnapshotHttpClient(
        new InternalHttpClient(`http://127.0.0.1:${port}`),
        {
          executionTarget: 'dev',
          bearerToken: 'snapshot-token',
        },
      );
      const snapshot = await client.fetch('session_config_global');
      assert.equal(snapshot.executionTarget, 'dev');
      assert.equal(snapshot.factScope, 'shared');
      assert.deepEqual(requested, [
        { stream: 'session_config_global', executionTarget: 'dev' },
      ]);
    },
  );
});

test('route rejects missing auth before invoking provider', async () => {
  let calls = 0;
  await withServer(
    (server) =>
      registerSyncReadSnapshotRoute(
        server,
        {
          snapshotFor: async () => {
            calls += 1;
            return {};
          },
        },
        {
          owner: 'automation',
          executionTarget: 'dev',
          bearerToken: 'snapshot-token',
          streams: ['edge_presence'],
        },
      ),
    async (port) => {
      const raw = new InternalHttpClient(`http://127.0.0.1:${port}`);
      await assert.rejects(
        () => raw.call(SYNC_READ_SNAPSHOT_ROUTE, { stream: 'edge_presence' }),
        (error: unknown) =>
          error instanceof InternalHttpError &&
          error.code === 'internal_http_unauthorized',
      );
      assert.equal(calls, 0);
    },
  );
});

test('route forbids caller-selected target and rejects stream not owned by the server', async () => {
  await withServer(
    (server) =>
      registerSyncReadSnapshotRoute(
        server,
        { snapshotFor: async () => ({}) },
        {
          owner: 'automation',
          executionTarget: 'dev',
          bearerToken: 'snapshot-token',
          streams: ['session_config_global'],
        },
      ),
    async (port) => {
      const raw = new InternalHttpClient(`http://127.0.0.1:${port}`);
      await assert.rejects(
        () =>
          raw.callBearer(
            SYNC_READ_SNAPSHOT_ROUTE,
            { stream: 'session_config_global', executionTarget: 'ol' },
            'snapshot-token',
          ),
        (error: unknown) =>
          error instanceof InternalHttpError &&
          error.code === 'sync_read_caller_target_forbidden',
      );
      await assert.rejects(
        () =>
          raw.callBearer(
            SYNC_READ_SNAPSHOT_ROUTE,
            { stream: 'edge_presence' },
            'snapshot-token',
          ),
        (error: unknown) =>
          error instanceof InternalHttpError &&
          error.code === 'sync_read_stream_not_owned',
      );
    },
  );
});

test('owner allowlist is mandatory, non-empty and cannot include the other owner service streams', () => {
  const provider = { snapshotFor: async () => ({}) };
  assert.throws(
    () =>
      registerSyncReadSnapshotRoute(new InternalHttpServer(), provider, {
        owner: 'automation',
        executionTarget: 'dev',
        bearerToken: 'snapshot-token',
        streams: [],
      }),
    (error: unknown) =>
      error instanceof InternalHttpError &&
      error.code === 'sync_read_stream_allowlist_empty',
  );
  for (const options of [
    { owner: 'automation' as const, streams: ['account_persona'] as const },
    { owner: 'api' as const, streams: ['edge_presence'] as const },
  ]) {
    assert.throws(
      () =>
        registerSyncReadSnapshotRoute(new InternalHttpServer(), provider, {
          ...options,
          executionTarget: 'dev',
          bearerToken: 'snapshot-token',
        }),
      (error: unknown) =>
        error instanceof InternalHttpError &&
        error.code === 'sync_read_stream_owner_mismatch',
    );
  }
});

test('server rejects provider target/scope drift before writing a success response', async () => {
  for (const drift of [
    { executionTarget: 'ol', factScope: 'shared' },
    { executionTarget: 'dev', factScope: 'target' },
  ] as const) {
    await withServer(
      (server) =>
        registerSyncReadSnapshotRoute(
          server,
          {
            snapshotFor: async () => ({
              contractVersion: 1,
              executionTarget: drift.executionTarget,
              factScope: drift.factScope,
              stream: 'session_config_global',
              cursor: '1',
              asOf: 1_000,
              freshUntil: 2_000,
              complete: true,
              value: { weekActiveMask: '1111100' },
            }),
          },
          {
            owner: 'automation',
            executionTarget: 'dev',
            bearerToken: 'snapshot-token',
            streams: ['session_config_global'],
          },
        ),
      async (port) => {
        const client = new SyncReadSnapshotHttpClient(
          new InternalHttpClient(`http://127.0.0.1:${port}`),
          { executionTarget: 'dev', bearerToken: 'snapshot-token' },
        );
        await assert.rejects(
          () => client.fetch('session_config_global'),
          (error: unknown) =>
            error instanceof InternalHttpError &&
            error.code === 'sync_read_snapshot_invalid',
        );
      },
    );
  }
});

test('owner route rejects a typed-looking payload with unknown or malformed fields', async () => {
  for (const value of [
    { weekActiveMask: '1111100', secret: 'must-not-cross-owner-boundary' },
    { weekActiveMask: 123 },
  ]) {
    await withServer(
      (server) =>
        registerSyncReadSnapshotRoute(
          server,
          {
            snapshotFor: async () => ({
              contractVersion: 1,
              executionTarget: 'dev',
              factScope: 'shared',
              stream: 'session_config_global',
              cursor: '1',
              asOf: 1_000,
              freshUntil: 2_000,
              complete: true,
              value,
            }),
          },
          {
            owner: 'automation',
            executionTarget: 'dev',
            bearerToken: 'snapshot-token',
            streams: ['session_config_global'],
          },
        ),
      async (port) => {
        const client = new SyncReadSnapshotHttpClient(
          new InternalHttpClient(`http://127.0.0.1:${port}`),
          { executionTarget: 'dev', bearerToken: 'snapshot-token' },
        );
        await assert.rejects(
          () => client.fetch('session_config_global'),
          (error: unknown) =>
            error instanceof InternalHttpError &&
            error.code === 'sync_read_snapshot_invalid',
        );
      },
    );
  }
});

test('client independently rejects a response targeted at another process instance', async () => {
  await withServer(
    (server) =>
      server.registerBearer(
        SYNC_READ_SNAPSHOT_ROUTE,
        'snapshot-token',
        async () => ({
          contractVersion: 1,
          executionTarget: 'ol',
          factScope: 'target',
          stream: 'edge_presence',
          cursor: '1',
          asOf: 1_000,
          freshUntil: 2_000,
          complete: true,
          value: [],
        }),
      ),
    async (port) => {
      const client = new SyncReadSnapshotHttpClient(
        new InternalHttpClient(`http://127.0.0.1:${port}`),
        { executionTarget: 'dev', bearerToken: 'snapshot-token' },
      );
      await assert.rejects(
        () => client.fetch('edge_presence'),
        /snapshot target ol does not match dev/,
      );
    },
  );
});
