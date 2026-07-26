import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  registerSyncReadChangedRoute,
  SYNC_READ_CHANGED_ROUTE,
  SyncReadChangedHttpClient,
} from '../../src/transport/sync-read-changed-http.js';
import {
  createSyncReadChangedHttpRelay,
} from '../../src/transport/sync-read-changed-outbox.js';
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

test('authenticated relay receives an ack only after the API handler succeeds', async () => {
  const handled: unknown[] = [];
  await withServer(
    (server) =>
      registerSyncReadChangedRoute(
        server,
        {
          async handle(signal) {
            handled.push(signal);
          },
        },
        {
          executionTarget: 'dev',
          bearerToken: 'automation-to-api',
        },
      ),
    async (port) => {
      const delivery = new SyncReadChangedHttpClient(
        new InternalHttpClient(`http://127.0.0.1:${port}`),
        {
          executionTarget: 'dev',
          bearerToken: 'automation-to-api',
        },
      );
      const relay = createSyncReadChangedHttpRelay({
        executionTarget: 'dev',
        delivery,
      });
      await relay({
        id: 41,
        topic: 'sync_read.changed',
        executionTarget: 'dev',
        createdAt: new Date(),
        payload: {
          contractVersion: 1,
          executionTarget: 'dev',
          stream: 'edge_presence',
          generation: '12',
        },
      });
    },
  );
  assert.deepEqual(handled, [
    {
      contractVersion: 1,
      executionTarget: 'dev',
      stream: 'edge_presence',
      generation: '12',
    },
  ]);
});

test('handler failure rejects the relay so the outbox event remains unacknowledged', async () => {
  await withServer(
    (server) =>
      registerSyncReadChangedRoute(
        server,
        {
          async handle() {
            throw new Error('snapshot_apply_failed');
          },
        },
        {
          executionTarget: 'dev',
          bearerToken: 'automation-to-api',
        },
      ),
    async (port) => {
      const delivery = new SyncReadChangedHttpClient(
        new InternalHttpClient(`http://127.0.0.1:${port}`),
        {
          executionTarget: 'dev',
          bearerToken: 'automation-to-api',
        },
      );
      const relay = createSyncReadChangedHttpRelay({
        executionTarget: 'dev',
        delivery,
      });
      await assert.rejects(
        relay({
          id: 42,
          topic: 'sync_read.changed',
          executionTarget: 'dev',
          createdAt: new Date(),
          payload: {
            contractVersion: 1,
            executionTarget: 'dev',
            stream: 'publish_in_flight',
            generation: '9',
          },
        }),
        /snapshot_apply_failed/,
      );
    },
  );
});

test('route requires bearer auth and rejects caller-selected target or open payloads', async () => {
  let handled = 0;
  await withServer(
    (server) =>
      registerSyncReadChangedRoute(
        server,
        {
          async handle() {
            handled += 1;
          },
        },
        {
          executionTarget: 'dev',
          bearerToken: 'automation-to-api',
        },
      ),
    async (port) => {
      const http = new InternalHttpClient(`http://127.0.0.1:${port}`);
      await assert.rejects(
        http.callBearer(
          SYNC_READ_CHANGED_ROUTE,
          {
            contractVersion: 1,
            stream: 'edge_presence',
            generation: '1',
          },
          'wrong-token',
        ),
        (error: unknown) =>
          error instanceof InternalHttpError &&
          error.code === 'internal_http_unauthorized',
      );
      for (const request of [
        {
          contractVersion: 1,
          executionTarget: 'ol',
          stream: 'edge_presence',
          generation: '1',
        },
        {
          contractVersion: 1,
          stream: 'edge_presence',
          generation: '1',
          extra: true,
        },
        {
          contractVersion: 1,
          stream: 'session_config_global',
          generation: '1',
        },
        {
          contractVersion: 1,
          stream: 'edge_presence',
          generation: 1,
        },
      ]) {
        await assert.rejects(
          http.callBearer(
            SYNC_READ_CHANGED_ROUTE,
            request,
            'automation-to-api',
          ),
          (error: unknown) =>
            error instanceof InternalHttpError &&
            error.code === 'sync_read_changed_request_invalid',
        );
      }
    },
  );
  assert.equal(handled, 0);
});

test('relay validates the closed outbox signal before attempting HTTP delivery', async () => {
  let deliveries = 0;
  const relay = createSyncReadChangedHttpRelay({
    executionTarget: 'dev',
    delivery: {
      async deliver() {
        deliveries += 1;
      },
    },
  });
  const base = {
    id: 43,
    topic: 'sync_read.changed',
    executionTarget: 'dev' as const,
    createdAt: new Date(),
  };
  for (const payload of [
    {
      contractVersion: 1,
      executionTarget: 'ol',
      stream: 'edge_presence',
      generation: '1',
    },
    {
      contractVersion: 1,
      executionTarget: 'dev',
      stream: 'edge_presence',
      generation: '1',
      extra: true,
    },
    {
      contractVersion: 1,
      executionTarget: 'dev',
      stream: 'account_persona',
      generation: '1',
    },
  ]) {
    await assert.rejects(relay({ ...base, payload }));
  }
  assert.equal(deliveries, 0);
});

test('client rejects a malformed or mismatched acknowledgement', async () => {
  await withServer(
    (server) => {
      server.registerBearer(
        SYNC_READ_CHANGED_ROUTE,
        'automation-to-api',
        async () => ({
          accepted: true,
          contractVersion: 1,
          executionTarget: 'dev',
          stream: 'edge_presence',
          generation: '999',
        }),
      );
    },
    async (port) => {
      const client = new SyncReadChangedHttpClient(
        new InternalHttpClient(`http://127.0.0.1:${port}`),
        {
          executionTarget: 'dev',
          bearerToken: 'automation-to-api',
        },
      );
      await assert.rejects(
        client.deliver({ stream: 'edge_presence', generation: '1' }),
        (error: unknown) =>
          error instanceof InternalHttpError && error.code === 'bad_response',
      );
    },
  );
});
