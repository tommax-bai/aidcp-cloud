import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InternalHttpClient,
  InternalHttpServer,
} from '@automation/transport/internal-http.js';
import {
  INTERACTION_STORE_READER_ROUTES,
  InteractionStoreReaderHttpClient,
  registerInteractionStoreReaderRoutes,
} from '@automation/transport/interaction-store-reader-http.js';
import type { InteractionStoreReaderPort } from '@kernel/kernel/interaction-types.js';

const ALL_METHODS = [
  'getAuth', 'getSyncFreshness', 'listInteractions', 'listReplyPreviewContexts',
  'getDetail', 'getJobContext', 'transitionMessageJob', 'getRuntimeControls',
  'resetTestData', 'updateRuntimeControls', 'recordAudit', 'claimApiRequest',
  'completeApiRequest',
] as const satisfies readonly (keyof InteractionStoreReaderPort)[];

const notImpl = () => {
  throw new Error('not stubbed');
};

/** 只实现被测方法的本地端口桩（其余抛错），捕获入参。结构上满足 InteractionStoreReaderPort。 */
function stubReader(seen: { calls: unknown[] }): InteractionStoreReaderPort {
  return {
    getAuth: async (accountId, envKey) => {
      seen.calls.push({ m: 'getAuth', accountId, envKey });
      return null; // 最简响应：验证 arg 送达 + null 往返。
    },
    getSyncFreshness: notImpl as InteractionStoreReaderPort['getSyncFreshness'],
    listInteractions: notImpl as InteractionStoreReaderPort['listInteractions'],
    listReplyPreviewContexts: notImpl as InteractionStoreReaderPort['listReplyPreviewContexts'],
    getDetail: notImpl as InteractionStoreReaderPort['getDetail'],
    getJobContext: notImpl as InteractionStoreReaderPort['getJobContext'],
    transitionMessageJob: notImpl as InteractionStoreReaderPort['transitionMessageJob'],
    getRuntimeControls: notImpl as InteractionStoreReaderPort['getRuntimeControls'],
    resetTestData: notImpl as InteractionStoreReaderPort['resetTestData'],
    updateRuntimeControls: notImpl as InteractionStoreReaderPort['updateRuntimeControls'],
    recordAudit: async (input) => {
      seen.calls.push({ m: 'recordAudit', input });
    },
    claimApiRequest: async (input) => {
      seen.calls.push({ m: 'claimApiRequest', input });
      return { requestId: 'req-1', fresh: true, response: null };
    },
    completeApiRequest: async (requestId, response) => {
      seen.calls.push({ m: 'completeApiRequest', requestId, response });
    },
  };
}

async function withPortServer(
  run: (port: InteractionStoreReaderPort, seen: { calls: unknown[] }) => Promise<void>,
): Promise<void> {
  const seen = { calls: [] as unknown[] };
  const server = new InternalHttpServer();
  registerInteractionStoreReaderRoutes(server, stubReader(seen));
  const listenPort = await server.listen(0);
  const client: InteractionStoreReaderPort = new InteractionStoreReaderHttpClient(
    new InternalHttpClient(`http://127.0.0.1:${listenPort}`),
  );
  try {
    await run(client, seen);
  } finally {
    await server.close();
  }
}

test('InteractionStoreReaderHttpClient 满足 kernel 端口形状（13 方法齐全）', async () => {
  await withPortServer(async (port) => {
    for (const m of ALL_METHODS) {
      assert.equal(typeof port[m], 'function', `missing method: ${m}`);
    }
  });
});

test('getAuth：accountId+envKey 送达，null 往返', async () => {
  await withPortServer(async (port, seen) => {
    const out = await port.getAuth('acc-1', 'env-1');
    assert.equal(out, null);
    assert.deepEqual(seen.calls[0], { m: 'getAuth', accountId: 'acc-1', envKey: 'env-1' });
  });
});

test('claimApiRequest：结构化入参对象整体送达，回幂等结果', async () => {
  await withPortServer(async (port, seen) => {
    const out = await port.claimApiRequest({
      actor: 'op', action: 'send', idempotencyKey: 'k1', accountId: 'acc-1', envKey: 'env-1',
    });
    assert.equal(out.requestId, 'req-1');
    assert.equal(out.fresh, true);
    assert.deepEqual((seen.calls[0] as { input: unknown }).input, {
      actor: 'op', action: 'send', idempotencyKey: 'k1', accountId: 'acc-1', envKey: 'env-1',
    });
  });
});

test('void 方法往返：recordAudit / completeApiRequest 无返回值、不抛', async () => {
  await withPortServer(async (port, seen) => {
    await port.recordAudit({
      accountId: 'acc-1', envKey: 'env-1', actor: 'op', action: 'x', entityType: 't', summary: 's',
    });
    await port.completeApiRequest('req-1', { ok: true });
    assert.equal((seen.calls[0] as { m: string }).m, 'recordAudit');
    assert.deepEqual(seen.calls[1], { m: 'completeApiRequest', requestId: 'req-1', response: { ok: true } });
  });
});

test('路由常量表被 server 接住（getAuth route 存在，不落 route_not_found）', async () => {
  const server = new InternalHttpServer();
  registerInteractionStoreReaderRoutes(server, stubReader({ calls: [] }));
  const listenPort = await server.listen(0);
  const raw = new InternalHttpClient(`http://127.0.0.1:${listenPort}`);
  try {
    const out = await raw.call<null>(INTERACTION_STORE_READER_ROUTES.getAuth, { accountId: 'a', envKey: 'e' });
    assert.equal(out, null);
  } finally {
    await server.close();
  }
});
