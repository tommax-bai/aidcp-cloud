import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AlertResolutionPort } from '../../src/kernel/alert-resolution-port.js';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from '../../src/transport/internal-http.js';
import {
  ALERT_RESOLUTION_ROUTES,
  AlertResolutionHttpClient,
  registerAlertResolutionRoutes,
} from '../../src/transport/alert-resolution-http.js';

interface ResolveCall {
  alertId: number;
  at: number | undefined;
}

function ownerPort(seen: ResolveCall[]): AlertResolutionPort {
  return {
    resolveById: async (alertId, at) => {
      seen.push({ alertId, at });
      if (alertId === 500) {
        throw new InternalHttpError('owner_write_failed', 'alerts table unavailable');
      }
      return alertId === 1 ? 1 : 0;
    },
  };
}

async function withOwner(
  run: (
    client: AlertResolutionPort,
    raw: InternalHttpClient,
    seen: ResolveCall[],
  ) => Promise<void>,
): Promise<void> {
  const seen: ResolveCall[] = [];
  const server = new InternalHttpServer();
  registerAlertResolutionRoutes(server, ownerPort(seen));
  const port = await server.listen(0);
  const raw = new InternalHttpClient(`http://127.0.0.1:${port}`);
  const client: AlertResolutionPort = new AlertResolutionHttpClient(raw);
  try {
    await run(client, raw, seen);
  } finally {
    await server.close();
  }
}

test('alert-resolution exposes only resolveById on one stable route', async () => {
  await withOwner(async (client) => {
    assert.equal(typeof client.resolveById, 'function');
    for (const forbidden of ['applySignal', 'setQuotaLevel', 'recoverRestricted', 'resumeEdge', 'resumeEdgesForAccount']) {
      assert.equal(
        (client as unknown as Record<string, unknown>)[forbidden],
        undefined,
        `unexpected capability: ${forbidden}`,
      );
    }
  });
  assert.deepEqual(ALERT_RESOLUTION_ROUTES, {
    resolveById: 'alert-resolution/resolve-by-id',
  });
});

test('true 1 and 0 owner row counts round-trip unchanged, while at=0 remains present', async () => {
  await withOwner(async (client, _raw, seen) => {
    assert.equal(await client.resolveById(1, 0), 1);
    assert.equal(await client.resolveById(999), 0);
    assert.deepEqual(seen, [
      { alertId: 1, at: 0 },
      { alertId: 999, at: undefined },
    ]);
  });
});

test('malformed alertId/at is rejected before the owner write', async () => {
  await withOwner(async (_client, raw, seen) => {
    for (const payload of [
      {},
      { alertId: 0 },
      { alertId: 1, at: null },
      { alertId: 1, at: Number.POSITIVE_INFINITY },
    ]) {
      await assert.rejects(
        () => raw.call(ALERT_RESOLUTION_ROUTES.resolveById, payload),
        (error: unknown) => error instanceof InternalHttpError && error.code === 'bad_request',
      );
    }
    assert.deepEqual(seen, []);
  });
});

test('owner and transport failure cannot become a false 0 result', async () => {
  await withOwner(async (client) => {
    await assert.rejects(
      () => client.resolveById(500),
      (error: unknown) =>
        error instanceof InternalHttpError
        && error.code === 'owner_write_failed'
        && error.message === 'alerts table unavailable',
    );
  });
  const dead = new AlertResolutionHttpClient(
    new InternalHttpClient('http://127.0.0.1:1', { timeoutMs: 500 }),
  );
  await assert.rejects(() => dead.resolveById(1), (error: unknown) =>
    error instanceof InternalHttpError
    && (error.code === 'transport_error' || error.code === 'timeout'));
});
