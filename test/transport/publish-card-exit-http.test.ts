/**
 * 发布候审卡片出口的跨进程往返 + **失败一律原样抛**。
 *
 * 这是四条口里的第四种、也是最直白的一种失败语义。为什么不吞：
 *   - 发卡失败：发布出口角色自己接得住（记成 sent:false + 真实 error）。端口吞掉反而让它记成「发出去了」。
 *   - 授权写失败：吞掉 = 「以为已授权其实没写」，稿子既不在候审也不会被发。
 *   - 落点解析失败：抛出去才能让调用方诚实回「没有目标」，吞掉会把卡发进一个猜出来的会话。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InternalHttpClient, InternalHttpServer } from '../../src/transport/internal-http.js';
import {
  PUBLISH_CARD_EXIT_ROUTES,
  PublishCardExitHttpClient,
  registerPublishCardExitRoutes,
} from '../../src/transport/publish-card-exit-http.js';
import type { PublishCardExitPort } from '../../src/kernel/publish-card-exit-port.js';

function stub(seen: unknown[], failing = false): PublishCardExitPort {
  const boom = () => {
    throw new Error('feishu is down');
  };
  return {
    sendApprovalCard: async (chatId, data) => {
      if (failing) boom();
      seen.push({ m: 'sendApprovalCard', chatId, requestId: (data as { requestId?: string }).requestId });
    },
    sendCommandResult: async (chatId) => {
      if (failing) boom();
      seen.push({ m: 'sendCommandResult', chatId });
    },
    uploadImageFromUrl: async (url) => {
      if (failing) boom();
      seen.push({ m: 'uploadImageFromUrl', url });
      return 'img_key_1';
    },
    getDefaultChat: async () => {
      if (failing) boom();
      seen.push({ m: 'getDefaultChat' });
      return { chatId: 'chat-default', chatName: '默认群' };
    },
    resolveCardChatId: async (originChatId, accountId) => {
      if (failing) boom();
      seen.push({ m: 'resolveCardChatId', originChatId, accountId });
      return 'chat-resolved';
    },
    writeApprovalSignal: async (requestId, approved, _payload, decidedBy) => {
      if (failing) boom();
      seen.push({ m: 'writeApprovalSignal', requestId, approved, decidedBy });
      return { written: true };
    },
  };
}

async function withServer(
  local: PublishCardExitPort,
  run: (client: PublishCardExitPort) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  registerPublishCardExitRoutes(server, local);
  const port = await server.listen(0);
  try {
    await run(new PublishCardExitHttpClient(new InternalHttpClient(`http://127.0.0.1:${port}`)));
  } finally {
    await server.close();
  }
}

test('六个方法往返：入参原样送达属主侧，返回值原样回来', async () => {
  const seen: unknown[] = [];
  await withServer(stub(seen), async (client) => {
    await client.sendApprovalCard('chat-1', { requestId: 'publish-7' } as never);
    await client.sendCommandResult('chat-2', {} as never);
    assert.equal(await client.uploadImageFromUrl('https://example.invalid/a.png'), 'img_key_1');
    assert.deepEqual(await client.getDefaultChat(), { chatId: 'chat-default', chatName: '默认群' });
    assert.equal(await client.resolveCardChatId(null, 'acct-1'), 'chat-resolved');
    assert.deepEqual(
      await client.writeApprovalSignal('publish-7', true, {} as never, 'schedule:rule-3'),
      { written: true },
    );
    assert.deepEqual(seen, [
      { m: 'sendApprovalCard', chatId: 'chat-1', requestId: 'publish-7' },
      { m: 'sendCommandResult', chatId: 'chat-2' },
      { m: 'uploadImageFromUrl', url: 'https://example.invalid/a.png' },
      { m: 'getDefaultChat' },
      { m: 'resolveCardChatId', originChatId: null, accountId: 'acct-1' },
      { m: 'writeApprovalSignal', requestId: 'publish-7', approved: true, decidedBy: 'schedule:rule-3' },
    ]);
  });
});

test('属主侧任一方法抛错 → 客户端原样抛，六个方法一个都不吞', async () => {
  await withServer(stub([], true), async (client) => {
    await assert.rejects(() => client.sendApprovalCard('c', {} as never), /feishu is down/);
    await assert.rejects(() => client.sendCommandResult('c', {} as never));
    await assert.rejects(() => client.uploadImageFromUrl('u'));
    await assert.rejects(() => client.getDefaultChat());
    await assert.rejects(() => client.resolveCardChatId(null, 'a'));
    await assert.rejects(() => client.writeApprovalSignal('r', true, {} as never, 'd'));
  });
});

test('对端没起：授权写 MUST 抛 —— 「以为已授权其实没写」是红线', async () => {
  const client = new PublishCardExitHttpClient(new InternalHttpClient('http://127.0.0.1:1'));
  await assert.rejects(() => client.writeApprovalSignal('publish-7', true, {} as never, 'schedule:rule-3'));
});

test('六条路由名两侧共用同一常量', () => {
  assert.deepEqual(PUBLISH_CARD_EXIT_ROUTES, {
    sendApprovalCard: 'publish-card-exit/send-approval-card',
    sendCommandResult: 'publish-card-exit/send-command-result',
    uploadImageFromUrl: 'publish-card-exit/upload-image-from-url',
    getDefaultChat: 'publish-card-exit/get-default-chat',
    resolveCardChatId: 'publish-card-exit/resolve-card-chat-id',
    writeApprovalSignal: 'publish-card-exit/write-approval-signal',
  });
});
