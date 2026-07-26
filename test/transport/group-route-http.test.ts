import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from '../../src/transport/internal-http.js';
import {
  GROUP_ROUTE_ROUTES,
  GroupRouteHttpClient,
  type GroupRoutePort,
  registerGroupRouteRoutes,
} from '../../src/transport/group-route-http.js';

interface SeenCall {
  method: 'getRoute' | 'listRoutes' | 'setRoute';
  groupLabel?: string;
  chatId?: string | null;
  updatedBy?: string | null;
}

function ownerPort(seen: SeenCall[]): GroupRoutePort {
  return {
    getRoute: async (groupLabel) => {
      seen.push({ method: 'getRoute', groupLabel });
      if (groupLabel === 'owner-error') {
        throw new InternalHttpError('owner_read_failed', 'group route owner unavailable');
      }
      return groupLabel === 'unconfigured' ? null : `chat-${groupLabel}`;
    },
    listRoutes: async () => {
      seen.push({ method: 'listRoutes' });
      return [
        {
          groupLabel: 'north',
          chatId: 'chat-north',
          updatedBy: null,
          updatedAt: 1_700_000_000_123,
        },
      ];
    },
    setRoute: async (groupLabel, chatId, updatedBy) => {
      seen.push({ method: 'setRoute', groupLabel, chatId, updatedBy });
      if (!groupLabel.trim()) return { ok: false, reason: 'invalid_key' };
      return {
        ok: true,
        route: chatId === null
          ? null
          : {
              groupLabel,
              chatId,
              updatedBy,
              updatedAt: 1_700_000_000_456,
            },
      };
    },
  };
}

async function withOwner(
  run: (
    client: GroupRoutePort,
    raw: InternalHttpClient,
    seen: SeenCall[],
  ) => Promise<void>,
): Promise<void> {
  const seen: SeenCall[] = [];
  const server = new InternalHttpServer();
  registerGroupRouteRoutes(server, ownerPort(seen));
  const port = await server.listen(0);
  const raw = new InternalHttpClient(`http://127.0.0.1:${port}`);
  const client: GroupRoutePort = new GroupRouteHttpClient(raw);
  try {
    await run(client, raw, seen);
  } finally {
    await server.close();
  }
}

test('group-route exposes get/list/set with stable shared route names', async () => {
  await withOwner(async (client) => {
    for (const method of ['getRoute', 'listRoutes', 'setRoute'] as const) {
      assert.equal(typeof client[method], 'function', `missing method: ${method}`);
    }
  });
  assert.deepEqual(GROUP_ROUTE_ROUTES, {
    getRoute: 'group-route/get-route',
    listRoutes: 'group-route/list-routes',
    setRoute: 'group-route/set-route',
  });
});

test('route hit and legitimate null both round-trip without changing owner truth', async () => {
  await withOwner(async (client, _raw, seen) => {
    assert.equal(await client.getRoute('north'), 'chat-north');
    assert.equal(await client.getRoute('unconfigured'), null);
    assert.deepEqual(await client.listRoutes(), [
      {
        groupLabel: 'north',
        chatId: 'chat-north',
        updatedBy: null,
        updatedAt: 1_700_000_000_123,
      },
    ]);
    assert.deepEqual(seen, [
      { method: 'getRoute', groupLabel: 'north' },
      { method: 'getRoute', groupLabel: 'unconfigured' },
      { method: 'listRoutes' },
    ]);
  });
});

test('setRoute preserves null clear, nullable actor, business rejection, and write-back truth', async () => {
  await withOwner(async (client, _raw, seen) => {
    assert.deepEqual(await client.setRoute('north', 'chat-new', null), {
      ok: true,
      route: {
        groupLabel: 'north',
        chatId: 'chat-new',
        updatedBy: null,
        updatedAt: 1_700_000_000_456,
      },
    });
    assert.deepEqual(await client.setRoute('north', null, 'operator-1'), {
      ok: true,
      route: null,
    });
    assert.deepEqual(await client.setRoute(' ', 'chat-unused', null), {
      ok: false,
      reason: 'invalid_key',
    });
    assert.deepEqual(seen, [
      {
        method: 'setRoute',
        groupLabel: 'north',
        chatId: 'chat-new',
        updatedBy: null,
      },
      {
        method: 'setRoute',
        groupLabel: 'north',
        chatId: null,
        updatedBy: 'operator-1',
      },
      {
        method: 'setRoute',
        groupLabel: ' ',
        chatId: 'chat-unused',
        updatedBy: null,
      },
    ]);
  });
});

test('missing write fields are bad_request and cannot be mistaken for a null clear', async () => {
  await withOwner(async (_client, raw, seen) => {
    await assert.rejects(
      () => raw.call(GROUP_ROUTE_ROUTES.setRoute, { groupLabel: 'north', updatedBy: null }),
      (error: unknown) => error instanceof InternalHttpError && error.code === 'bad_request',
    );
    await assert.rejects(
      () => raw.call(GROUP_ROUTE_ROUTES.getRoute, {}),
      (error: unknown) => error instanceof InternalHttpError && error.code === 'bad_request',
    );
    assert.deepEqual(seen, []);
  });
});

test('owner and transport failures remain errors rather than unconfigured null', async () => {
  await withOwner(async (client) => {
    await assert.rejects(
      () => client.getRoute('owner-error'),
      (error: unknown) =>
        error instanceof InternalHttpError
        && error.code === 'owner_read_failed'
        && error.message === 'group route owner unavailable',
    );
  });
  const dead = new GroupRouteHttpClient(
    new InternalHttpClient('http://127.0.0.1:1', { timeoutMs: 500 }),
  );
  await assert.rejects(() => dead.getRoute('north'), (error: unknown) =>
    error instanceof InternalHttpError
    && (error.code === 'transport_error' || error.code === 'timeout'));
});
