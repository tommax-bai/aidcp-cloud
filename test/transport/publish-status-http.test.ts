import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InternalHttpClient,
  InternalHttpServer,
} from '../../src/transport/internal-http.js';
import {
  PUBLISH_STATUS_ROUTES,
  PublishStatusHttpClient,
  registerPublishStatusRoutes,
} from '../../src/transport/publish-status-http.js';
import type {
  PublishQueueStatus,
  PublishStatusReader,
} from '../../src/kernel/publish-status-types.js';

/** 一个含 running run 的状态样本（载荷 unknown，只测传输往返不构造管线全字段）。 */
function runningStatus(): PublishQueueStatus {
  return {
    status: 'running',
    snapshot: { stage: 'content' },
    runs: [
      {
        runId: 'run-1',
        accountId: 'acc-1',
        kind: 'rewrite',
        sourceId: 'src-9',
        startedAt: 1234,
        status: 'running',
        snapshot: { stage: 'content' },
      },
    ],
  };
}

/** 计数入参的本地端口桩，结构上满足 PublishStatusReader。 */
function stubReader(seen: { calls: number }): PublishStatusReader {
  return {
    getStatus: async () => {
      seen.calls += 1;
      return runningStatus();
    },
  };
}

async function withPortServer(
  run: (port: PublishStatusReader, seen: { calls: number }) => Promise<void>,
): Promise<void> {
  const seen = { calls: 0 };
  const server = new InternalHttpServer();
  registerPublishStatusRoutes(server, stubReader(seen));
  const listenPort = await server.listen(0);
  const client: PublishStatusReader = new PublishStatusHttpClient(
    new InternalHttpClient(`http://127.0.0.1:${listenPort}`),
  );
  try {
    await run(client, seen);
  } finally {
    await server.close();
  }
}

test('PublishStatusHttpClient 满足 kernel 端口形状（编译期注解 + 运行期方法齐全）', async () => {
  await withPortServer(async (port) => {
    assert.equal(typeof port.getStatus, 'function', 'missing method: getStatus');
  });
});

test('getStatus：无参 round-trip，回结构一致的 running 状态', async () => {
  await withPortServer(async (port, seen) => {
    const out = await port.getStatus();
    assert.equal(out.status, 'running');
    assert.deepEqual(out.snapshot, { stage: 'content' });
    assert.equal(out.runs?.length, 1);
    const runRow = out.runs?.[0];
    assert.equal(runRow?.runId, 'run-1');
    assert.equal(runRow?.accountId, 'acc-1');
    assert.equal(runRow?.kind, 'rewrite');
    assert.equal(runRow?.sourceId, 'src-9');
    assert.equal(runRow?.startedAt, 1234);
    assert.equal(runRow?.status, 'running');
    assert.deepEqual(runRow?.snapshot, { stage: 'content' });
    assert.equal(seen.calls, 1);
  });
});

test('路由常量表被 server 接住（get-status route 存在，不落 route_not_found）', async () => {
  const server = new InternalHttpServer();
  registerPublishStatusRoutes(server, stubReader({ calls: 0 }));
  const listenPort = await server.listen(0);
  const raw = new InternalHttpClient(`http://127.0.0.1:${listenPort}`);
  try {
    const out = await raw.call<PublishQueueStatus>(PUBLISH_STATUS_ROUTES.getStatus, {});
    assert.equal(out.status, 'running');
  } finally {
    await server.close();
  }
});
