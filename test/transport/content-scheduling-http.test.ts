/**
 * 排期器那一族窄口的传输三件套（change wire-content-scheduler-into-api-process）。
 *
 * 本文件钉的是**这一层不会替调用方做决定**：读口失败必须响亮抛出，绝不在客户端悄悄译成
 * 「没人在线 / 状态正常 / 不忙」。失败方向由排期器按「哪边更严」判，判据在它那儿；
 * 一旦这一层先兜了个缺省值，那个决定就被拿走了，而且外部看不出区别。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InternalHttpClient, InternalHttpServer } from '@automation/transport/internal-http.js';
import {
  CONTENT_SCHEDULING_ROUTES,
  ContentSchedulingHttpClient,
  registerContentSchedulingRoutes,
} from '@automation/transport/content-scheduling-http.js';
import type { ContentSchedulingAutomationPort } from '@kernel/kernel/content-scheduling-port.js';

const TOKEN = 'content-scheduling-token';

function stubPort(
  overrides: Partial<ContentSchedulingAutomationPort> = {},
): ContentSchedulingAutomationPort {
  return {
    listOnlineAccounts: async () => ({ accounts: [] }),
    readRiskStatus: async () => ({ status: 'normal' }),
    readPublishBusy: async () => ({ busy: false }),
    readCommentBusy: async () => ({ busy: false }),
    readJoinBusy: async () => ({ busy: false }),
    readDelegatedOwnershipBusy: async () => ({ busy: false }),
    readCommentedTodayCount: async () => ({ count: 0 }),
    readJoinedTodayCount: async () => ({ count: 0 }),
    readJoinDailyCap: async () => ({ cap: 0 }),
    triggerScheduledPost: async () => ({ accepted: true }),
    triggerScheduledComment: async () => ({ accepted: true }),
    triggerScheduledJoin: async () => ({ accepted: true }),
    ...overrides,
  };
}

async function withServer(
  port: ContentSchedulingAutomationPort | null,
  run: (client: ContentSchedulingHttpClient) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  if (port) registerContentSchedulingRoutes(server, port, TOKEN, 'dev');
  const listening = await server.listen(0);
  try {
    await run(
      new ContentSchedulingHttpClient(
        new InternalHttpClient(`http://127.0.0.1:${listening}`),
        TOKEN,
        'dev',
      ),
    );
  } finally {
    await server.close();
  }
}

test('注册函数覆盖的路由集合 MUST 逐字等于路由表 —— 多一条少一条都当场红', async () => {
  const registered: string[] = [];
  const recorder = {
    registerBearer(route: string) {
      registered.push(route);
      return recorder;
    },
  };
  registerContentSchedulingRoutes(
    recorder as unknown as InternalHttpServer,
    stubPort(),
    TOKEN,
    'dev',
  );
  assert.deepEqual(registered.sort(), Object.values(CONTENT_SCHEDULING_ROUTES).sort());
});

test('往返：在线清单 / 触发回执逐字段带回来，envKey 的 null 不被压成空串', async () => {
  const asked: string[] = [];
  await withServer(
    stubPort({
      listOnlineAccounts: async () => ({
        accounts: [
          { accountId: 'acc-1', envKey: 'env-1' },
          { accountId: 'acc-2', envKey: null },
        ],
      }),
      triggerScheduledPost: async (input) => {
        asked.push(`${input.accountId}|${input.approvalMode}|${String(input.execution.envKey)}`);
        return { accepted: false, reason: 'edge_offline', retryable: true };
      },
    }),
    async (client) => {
      assert.deepEqual((await client.listOnlineAccounts()).accounts, [
        { accountId: 'acc-1', envKey: 'env-1' },
        { accountId: 'acc-2', envKey: null },
      ]);
      assert.deepEqual(
        await client.triggerScheduledPost({
          accountId: 'acc-2',
          approvalMode: 'review',
          execution: { executionTarget: 'dev', envKey: null, hourCell: '2026-08-03-10' },
        }),
        { accepted: false, reason: 'edge_offline', retryable: true },
      );
      assert.deepEqual(asked, ['acc-2|review|null']);
    },
  );
});

test('漏注册 MUST 抛，且原因码与「对面暂时不可达」分得开', async () => {
  await withServer(null, async (client) => {
    for (const call of [
      () => client.listOnlineAccounts(),
      () => client.readRiskStatus({ accountId: 'acc-1' }),
      () => client.readPublishBusy({ accountId: 'acc-1' }),
      () => client.triggerScheduledJoin({ accountId: 'acc-1' }),
    ]) {
      await assert.rejects(
        call,
        (err: Error & { code?: string }) => {
          // **纯接线遗漏保留自己的具名码**，MUST NOT 被压成 api_authority_unavailable ——
          // 后者是留给「对面暂时不可达 / 版本落后」的，被冒名顶替就再也查不出是漏注册。
          assert.equal(err.code, 'route_not_found');
          return true;
        },
        '客户端绝不把「问不到」译成「没人在线 / 状态正常 / 不忙」',
      );
    }
  });
});

test('对面不可达：读抛 unavailable、扳机抛 result_unknown（有副作用，绝不推断成败）', async () => {
  const server = new InternalHttpServer();
  registerContentSchedulingRoutes(server, stubPort(), TOKEN, 'dev');
  const listening = await server.listen(0);
  await server.close();
  const client = new ContentSchedulingHttpClient(
    new InternalHttpClient(`http://127.0.0.1:${listening}`),
    TOKEN,
    'dev',
  );
  await assert.rejects(
    () => client.listOnlineAccounts(),
    (err: Error & { code?: string }) => err.code === 'api_authority_unavailable',
  );
  await assert.rejects(
    () => client.triggerScheduledJoin({ accountId: 'acc-1' }),
    (err: Error & { code?: string }) => err.code === 'api_authority_result_unknown',
  );
});

test('部署 target 不符 MUST 拒 —— DEV/OL 共库，这条是唯一把两台机器的稿子分开的判据', async () => {
  const server = new InternalHttpServer();
  registerContentSchedulingRoutes(server, stubPort(), TOKEN, 'ol');
  const listening = await server.listen(0);
  try {
    const client = new ContentSchedulingHttpClient(
      new InternalHttpClient(`http://127.0.0.1:${listening}`),
      TOKEN,
      'dev',
    );
    await assert.rejects(() => client.readRiskStatus({ accountId: 'acc-1' }));
  } finally {
    await server.close();
  }
});
