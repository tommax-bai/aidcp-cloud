import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';

import {
  createApiSyncReadSnapshotSource,
  type FacebookOperationPolicyBaselineStore,
} from '../../src/config/api-sync-read-source.js';
import type { FacebookOperationPolicyBaseProjection } from '../../src/kernel/facebook-operation-policy-resolution.js';
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

const TOKEN = 'facebook-policy-loopback-token';
const BASELINE: FacebookOperationPolicyBaseProjection = {
  envKey: 'fb-env-1',
  primarySurface: 'reels',
  surfaceRevision: 3,
  baseMode: 'rule',
  policyRevision: 7,
  cadenceSource: 'environment',
  rule: { viewsPerLike: 5, joinEveryNRounds: 2 },
  consumption: {
    viewsPerLike: 4,
    confirmedLikesPerJoin: 3,
    confirmedJoinsPerComment: 2,
  },
  reels: {
    persona: { viewsPerLike: 6, viewsPerFollow: 12 },
    slowStart: { viewsPerLike: 18, viewsPerFollow: 20 },
    rule: { viewsPerFollow: 15 },
    consumption: { viewsPerFollow: 10 },
  },
  updatedAt: '2026-08-02T00:00:00.000Z',
  updatedBy: 'loopback-test',
};

function fakePool(events: string[]): pg.Pool {
  const client = {
    async query(sql: string) {
      if (sql.includes('FROM config_mirror_version')) {
        events.push('cursor');
        return {
          rows: [{ mirror_key: 'facebook_operation_policy', version: '12' }],
        };
      }
      events.push(sql);
      return { rows: [] };
    },
    release() {
      events.push('release');
    },
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

async function withApiOwnerLoopback(
  store: FacebookOperationPolicyBaselineStore,
  events: string[],
  run: (port: number, client: SyncReadSnapshotHttpClient) => Promise<void>,
): Promise<void> {
  const source = createApiSyncReadSnapshotSource({
    executionTarget: 'dev',
    pool: fakePool(events),
    parseSoul: () => null,
    facebookOperationPolicyStore: () => store,
  });
  const server = new InternalHttpServer();
  registerSyncReadSnapshotRoute(
    server,
    { snapshotFor: ({ stream }) => source.snapshot(stream) },
    {
      owner: 'api',
      executionTarget: 'dev',
      bearerToken: TOKEN,
      streams: ['facebook_operation_policy'],
    },
  );
  const port = await server.listen(0);
  try {
    assert.ok(port > 0, 'port=0 MUST resolve to a random listening port');
    await run(
      port,
      new SyncReadSnapshotHttpClient(
        new InternalHttpClient(`http://127.0.0.1:${port}`),
        { executionTarget: 'dev', bearerToken: TOKEN },
      ),
    );
  } finally {
    await server.close();
  }
}

test('api-mode production source serves Facebook policy to the automation HTTP client', async () => {
  const events: string[] = [];
  const store: FacebookOperationPolicyBaselineStore = {
    async refreshFromAuthority() {
      events.push('refresh');
    },
    baselineProjections() {
      events.push('project');
      return [BASELINE];
    },
  };

  await withApiOwnerLoopback(store, events, async (_port, client) => {
    const snapshot = await client.fetch('facebook_operation_policy');
    assert.equal(snapshot.executionTarget, 'dev');
    assert.equal(snapshot.factScope, 'shared');
    assert.equal(snapshot.cursor, '90');
    assert.deepEqual(snapshot.value, { environments: [BASELINE] });
  });

  assert.deepEqual(events, [
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'cursor',
    'refresh',
    'project',
    'COMMIT',
    'release',
  ]);
});

test('api-mode policy failure stays an HTTP 200 error envelope and becomes InternalHttpError', async () => {
  const events: string[] = [];
  const store: FacebookOperationPolicyBaselineStore = {
    async refreshFromAuthority() {
      events.push('refresh');
      throw new Error('facebook_policy_refresh_failed');
    },
    baselineProjections() {
      assert.fail('projection MUST NOT run after refresh failure');
    },
  };

  await withApiOwnerLoopback(store, events, async (port, client) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/${SYNC_READ_SNAPSHOT_ROUTE}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ args: { stream: 'facebook_operation_policy' } }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: {
        code: 'handler_error',
        message: 'facebook_policy_refresh_failed',
      },
    });

    await assert.rejects(
      client.fetch('facebook_operation_policy'),
      (error: unknown) =>
        error instanceof InternalHttpError
        && error.code === 'handler_error'
        && error.message === 'facebook_policy_refresh_failed',
    );
  });

  assert.equal(events.filter((event) => event === 'refresh').length, 2);
  assert.equal(events.filter((event) => event === 'ROLLBACK').length, 2);
});
