/**
 * 候审卡投递判定的跨进程往返 + **fail-open 契约**。
 *
 * 往返部分与别的三件套同形。真正值得钉的是最后两条：这条口拆进程后新增了一整类失败
 * （对端没起 / 端口没配 / 超时），它们落在实现体的 try/catch 之外。若原样抛给调用方，
 * 结果不是「多发一张卡」而是**整个候审出口失败**。方向必须朝「照发」倒。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InternalHttpClient, InternalHttpServer } from '@automation/transport/internal-http.js';
import {
  REVIEW_CARD_DELIVERY_ROUTES,
  ReviewCardDeliveryHttpClient,
  registerReviewCardDeliveryRoutes,
} from '@automation/transport/review-card-delivery-http.js';
import type { ReviewCardDeliveryPort } from '@kernel/kernel/review-card-delivery-port.js';

const silent = { warn() {} };

async function withServer(
  local: ReviewCardDeliveryPort,
  run: (client: ReviewCardDeliveryPort) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  registerReviewCardDeliveryRoutes(server, local);
  const port = await server.listen(0);
  try {
    await run(new ReviewCardDeliveryHttpClient(new InternalHttpClient(`http://127.0.0.1:${port}`), silent));
  } finally {
    await server.close();
  }
}

test('往返：账号 id 原样送达属主侧，判定结果原样回来（两个方向都不改写 reason）', async () => {
  const seen: string[] = [];
  await withServer(
    {
      resolveReviewCardDelivery: async (accountId) => {
        seen.push(accountId);
        return accountId === 'acct-client-only'
          ? { send: false, reason: 'suppressed_by_client_only_policy' }
          : { send: true, reason: 'client_and_feishu' };
      },
    },
    async (client) => {
      assert.deepEqual(await client.resolveReviewCardDelivery('acct-client-only'), {
        send: false,
        reason: 'suppressed_by_client_only_policy',
      });
      assert.deepEqual(await client.resolveReviewCardDelivery('acct-normal'), {
        send: true,
        reason: 'client_and_feishu',
      });
      assert.deepEqual(seen, ['acct-client-only', 'acct-normal']);
    },
  );
});

test('属主侧实现抛错 → 客户端 fail-open 回「照发」，MUST NOT 把异常抛给调用方', async () => {
  await withServer(
    {
      resolveReviewCardDelivery: async () => {
        throw new Error('policy table blew up');
      },
    },
    async (client) => {
      const decision = await client.resolveReviewCardDelivery('acct-1');
      assert.equal(decision.send, true, '判不出来一律保留飞书卡');
      assert.equal(decision.reason, 'delivery_port_unreachable');
    },
  );
});

test('对端根本没起（连不上）→ 同样 fail-open，绝不回 send:false', async () => {
  // 指向一个没人监听的端口：拆进程后最常见的失败形态（对端没起 / 端口没配错）。
  const client = new ReviewCardDeliveryHttpClient(new InternalHttpClient('http://127.0.0.1:1'), silent);
  const decision = await client.resolveReviewCardDelivery('acct-1');
  assert.equal(decision.send, true, '少发一张卡=没人知道要审；多发一张=多看一眼。只能朝后者倒');
  assert.equal(decision.reason, 'delivery_port_unreachable');
});

test('路由名两侧共用同一常量（防漂移：两端各写一份会各自编译通过、只有真跑才 404）', () => {
  assert.equal(REVIEW_CARD_DELIVERY_ROUTES.resolveReviewCardDelivery, 'review-card-delivery/resolve');
});
