import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InternalHttpClient,
  InternalHttpServer,
} from '@automation/transport/internal-http.js';
import {
  CURATED_CONTENT_ROUTES,
  CuratedContentHttpClient,
  registerCuratedContentRoutes,
} from '@automation/transport/curated-content-http.js';
import type {
  CuratedContentReader,
  CuratedPanelRow,
} from '@kernel/kernel/curated-content-types.js';

function sampleRow(id: number, accountId: string): CuratedPanelRow {
  return {
    id,
    accountId,
  } as unknown as CuratedPanelRow; // 仅测传输往返，不构造全字段业务夹具（口径由 typecheck 在真实调用处保证）。
}

/** 捕获入参的本地端口桩，结构上满足 CuratedContentReader。 */
function stubReader(seen: { calls: unknown[] }): CuratedContentReader {
  return {
    listForClient: async (accountId, opts) => {
      seen.calls.push({ m: 'listForClient', accountId, opts });
      return { items: [sampleRow(1, accountId)], total: 1 };
    },
    getOneForAccount: async (id, accountId) => {
      seen.calls.push({ m: 'getOneForAccount', id, accountId });
      return id === 0 ? null : sampleRow(id, accountId);
    },
  };
}

async function withPortServer(
  run: (port: CuratedContentReader, seen: { calls: unknown[] }) => Promise<void>,
): Promise<void> {
  const seen = { calls: [] as unknown[] };
  const server = new InternalHttpServer();
  registerCuratedContentRoutes(server, stubReader(seen));
  const listenPort = await server.listen(0);
  const client: CuratedContentReader = new CuratedContentHttpClient(
    new InternalHttpClient(`http://127.0.0.1:${listenPort}`),
  );
  try {
    await run(client, seen);
  } finally {
    await server.close();
  }
}

test('CuratedContentHttpClient 满足 kernel 端口形状（编译期注解 + 运行期方法齐全）', async () => {
  await withPortServer(async (port) => {
    for (const m of ['listForClient', 'getOneForAccount'] as const) {
      assert.equal(typeof port[m], 'function', `missing method: ${m}`);
    }
  });
});

test('listForClient：accountId + opts 原样送达，回投影 + total', async () => {
  await withPortServer(async (port, seen) => {
    const out = await port.listForClient('acc-9', { creationStatus: 'all', sort: 'recent', limit: 20, offset: 0 });
    assert.equal(out.total, 1);
    assert.equal(out.items[0].accountId, 'acc-9');
    assert.deepEqual(seen.calls[0], {
      m: 'listForClient',
      accountId: 'acc-9',
      opts: { creationStatus: 'all', sort: 'recent', limit: 20, offset: 0 },
    });
  });
});

test('getOneForAccount：位置参数 id+accountId 送达；未命中回 null', async () => {
  await withPortServer(async (port) => {
    const row = await port.getOneForAccount(42, 'acc-1');
    assert.equal(row?.id, 42);
    const miss = await port.getOneForAccount(0, 'acc-1');
    assert.equal(miss, null);
  });
});

test('路由常量表被 server 接住（list route 存在，不落 route_not_found）', async () => {
  const server = new InternalHttpServer();
  registerCuratedContentRoutes(server, stubReader({ calls: [] }));
  const listenPort = await server.listen(0);
  const raw = new InternalHttpClient(`http://127.0.0.1:${listenPort}`);
  try {
    const out = await raw.call<{ total: number }>(CURATED_CONTENT_ROUTES.listForClient, {
      accountId: 'a',
      opts: { creationStatus: 'all', limit: 1, offset: 0 },
    });
    assert.equal(out.total, 1);
  } finally {
    await server.close();
  }
});
