/**
 * 发布台账窄写入口的跨进程往返 + **写失败必须原样抛**。
 *
 * 与候审卡投递判定那条口刻意相反：那条 fail-open（多发一张卡无害），这条不行 ——
 * 「以为落库了其实没落」是本仓红线点名的静默假成功，稿子会以为自己已候审，
 * 而后续任何按 id 定位的动作都找不到那一行。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InternalHttpClient, InternalHttpServer } from '@automation/transport/internal-http.js';
import {
  PUBLISH_LOG_ROUTES,
  PublishLogHttpClient,
  registerPublishLogRoutes,
} from '@automation/transport/publish-log-http.js';
import type { PublishLogWriter } from '@kernel/kernel/publish-log-writer-port.js';
import type { PublishRecord } from '@kernel/kernel/publish-pipeline-types.js';

function sampleRecord(): PublishRecord {
  return {
    title: '标题',
    content: '正文',
    tags: ['a'],
    imageUrl: 'https://example.invalid/1.png',
    imageUrls: ['https://example.invalid/1.png'],
    status: 'pending_approval',
    qualityScore: 8,
    aiScore: 2,
    sourceConcepts: [],
    sourceLikedIds: [],
    accountId: 'acct-1',
  } as unknown as PublishRecord; // 只测传输往返，不构造全字段业务夹具（口径由 typecheck 在真实调用处保证）。
}

async function withServer(
  local: PublishLogWriter,
  run: (client: PublishLogWriter) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  registerPublishLogRoutes(server, local);
  const port = await server.listen(0);
  try {
    await run(new PublishLogHttpClient(new InternalHttpClient(`http://127.0.0.1:${port}`)));
  } finally {
    await server.close();
  }
}

test('四个方法往返：入参原样送达属主侧，insert 的自增 id 原样回来', async () => {
  const seen: unknown[] = [];
  await withServer(
    {
      insert: async (record) => {
        seen.push({ m: 'insert', title: record.title, accountId: record.accountId });
        return 42;
      },
      updateStatus: async (id, status) => {
        seen.push({ m: 'updateStatus', id, status });
      },
      recordMetadata: async (id, metadata, aiEnforced) => {
        seen.push({ m: 'recordMetadata', id, metadata, aiEnforced });
      },
      markImagesAttached: async (id, count) => {
        seen.push({ m: 'markImagesAttached', id, count });
      },
    },
    async (client) => {
      assert.equal(await client.insert(sampleRecord()), 42);
      await client.updateStatus(42, 'published');
      await client.recordMetadata(42, { topics: ['x'] }, true);
      await client.markImagesAttached(42, 3);
      assert.deepEqual(seen, [
        { m: 'insert', title: '标题', accountId: 'acct-1' },
        { m: 'updateStatus', id: 42, status: 'published' },
        { m: 'recordMetadata', id: 42, metadata: { topics: ['x'] }, aiEnforced: true },
        { m: 'markImagesAttached', id: 42, count: 3 },
      ]);
    },
  );
});

test('属主侧写失败 → 客户端原样抛，MUST NOT 吞成成功（那是「以为落库了其实没落」）', async () => {
  await withServer(
    {
      insert: async () => {
        throw new Error('publish_log insert blew up');
      },
      updateStatus: async () => {},
      recordMetadata: async () => {},
      markImagesAttached: async () => {},
    },
    async (client) => {
      await assert.rejects(() => client.insert(sampleRecord()));
    },
  );
});

test('对端没起也必须抛：写路径没有 fail-open 这一说', async () => {
  const client = new PublishLogHttpClient(new InternalHttpClient('http://127.0.0.1:1'));
  await assert.rejects(() => client.markImagesAttached(1, 2));
});

test('四条路由名两侧共用同一常量（各写一份会两边都编译通过、只有真跑才 404）', () => {
  assert.deepEqual(PUBLISH_LOG_ROUTES, {
    insert: 'publish-log/insert',
    updateStatus: 'publish-log/update-status',
    recordMetadata: 'publish-log/record-metadata',
    markImagesAttached: 'publish-log/mark-images-attached',
  });
});
