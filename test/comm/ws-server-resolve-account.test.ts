/**
 * account-level-slow-start 10.1：resolveAccountIdForEdge —— 「这个环境此刻在跑哪个账号」。
 *
 * 它是账号级慢启动写入的目标解析器：客户端只提交 envKey（→ edgeId），accountId 全程由云端解析。
 * 与反方向的 resolveEdgeIdForAccount 同一循环、判据反过来，但**多条时的取舍刻意相反**：
 * 那边取最早登记者（「总得发给一个」），这边诚实失败（猜错就是把慢启动加到别人的号上）。
 *
 * 用真实 ws 往返以触达 edges 登记表（与 ws-server-target-guard 同构）。
 * 环境层级：离线 / 逻辑级（本机回环 ws，无外部依赖）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { EdgeCloudServer, makeEnvelope } from '../../src/comm/index.js';
import type { MessageHandler, EdgeSession } from '../../src/comm/ws-server.js';
import type { Envelope, HelloPayload } from '../../src/comm/protocol.js';

const helloHandler: MessageHandler = {
  handle(env: Envelope, session: EdgeSession): Envelope {
    if (env.type === 'hello') {
      const p = env.payload as HelloPayload;
      session.edgeId = p.edgeId;
      session.accountId = p.accountId;
      session.capabilities = p.capabilities;
      return makeEnvelope('welcome', env.id, 0, { sessionId: session.sessionId, serverVersion: 't' });
    }
    return makeEnvelope('pong', env.id, 0, {});
  },
};

async function connectEdge(port: number, edgeId: string, accountId?: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(ws, 'open');
  ws.send(JSON.stringify(makeEnvelope('hello', `h-${edgeId}-${accountId ?? 'none'}`, 0, { edgeId, accountId })));
  await once(ws, 'message');
  return ws;
}

test('resolveAccountIdForEdge：解析到该 edge 此刻在跑的账号，不串到别的 edge', async () => {
  const s = new EdgeCloudServer({ handler: helloHandler, port: 0, clock: () => 0 });
  await s.start();
  const port = s.address()!;
  const wsA = await connectEdge(port, 'ads-101', 'acc-1');
  const wsB = await connectEdge(port, 'ads-102', 'acc-2');

  assert.equal(s.resolveAccountIdForEdge('ads-101'), 'acc-1');
  assert.equal(s.resolveAccountIdForEdge('ads-102'), 'acc-2');
  assert.equal(s.resolveAccountIdForEdge('ads-999'), null, '没有这台 edge → 诚实 null（路由层据此 409）');

  wsA.close();
  wsB.close();
  await s.close();
});

test('resolveAccountIdForEdge：同一 edgeId 上有两个不同账号 → 诚实失败 null，MUST NOT 任取其一', async () => {
  // 猜错的后果不是报错，而是把慢启动加到另一个号上——一个没人会去查的静默错配。
  const s = new EdgeCloudServer({ handler: helloHandler, port: 0, clock: () => 0 });
  await s.start();
  const port = s.address()!;
  const wsA = await connectEdge(port, 'ads-101', 'acc-1');
  const wsB = await connectEdge(port, 'ads-101', 'acc-2');

  assert.equal(s.resolveAccountIdForEdge('ads-101'), null, '多账号即拒绝猜测');

  wsA.close();
  wsB.close();
  await s.close();
});

test('resolveAccountIdForEdge：同一账号的重复连接不算歧义（去重后仍是唯一账号）', async () => {
  const s = new EdgeCloudServer({ handler: helloHandler, port: 0, clock: () => 0 });
  await s.start();
  const port = s.address()!;
  const wsA = await connectEdge(port, 'ads-101', 'acc-1');
  const wsB = await connectEdge(port, 'ads-101', 'acc-1');

  assert.equal(s.resolveAccountIdForEdge('ads-101'), 'acc-1', '同账号多连接 → 仍能确定写入目标');

  wsA.close();
  wsB.close();
  await s.close();
});

test('resolveAccountIdForEdge：未自报 accountId 的连接不产出目标', async () => {
  const s = new EdgeCloudServer({ handler: helloHandler, port: 0, clock: () => 0 });
  await s.start();
  const port = s.address()!;
  const ws = await connectEdge(port, 'ads-101');

  assert.equal(s.resolveAccountIdForEdge('ads-101'), null);

  ws.close();
  await s.close();
});
