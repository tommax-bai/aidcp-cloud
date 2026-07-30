/**
 * 任务模式调度排除（期1-3）ws-server 层单测。
 *
 * 用真实 ws 往返触达 edges 登记表（与 ws-server-target-guard 同构），验证：
 *  - 开关开：mode=task 的会话被 resolveEdgeIdForAccount（account→edge 派工解析收口）跳过；
 *    同账号存在编排态兄弟连接时解析落到编排态那台；
 *  - 开关关（默认）：过滤短路，task 会话照常被解析——行为与主干逐字节一致；
 *  - isTaskModeEdge 是事实查询：不论开关开关都如实报告登记态（开关只管调度是否消费该事实）；
 *  - 不带 mode 的旧会话：isTaskModeEdge=false，开关开时照常解析（滚动兼容缺省）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { EdgeCloudServer, makeEnvelope } from '../../src/comm/index.js';
import type { MessageHandler, EdgeSession } from '../../src/comm/ws-server.js';
import type { Envelope, HelloPayload } from '../../src/comm/protocol.js';
import { resolveSessionMode } from '../../src/managed-automation/contracts/session-mode.js';

/** 最小 handler：与生产 onHello 同语义地落 edgeId/accountId/mode（经 resolveSessionMode 归一）。 */
const helloHandler: MessageHandler = {
  handle(env: Envelope, session: EdgeSession): Envelope {
    if (env.type === 'hello') {
      const p = env.payload as HelloPayload;
      session.edgeId = p.edgeId;
      session.accountId = p.accountId;
      session.capabilities = p.capabilities;
      session.mode = resolveSessionMode(p.mode);
      return makeEnvelope('welcome', env.id, 0, { sessionId: session.sessionId, serverVersion: 't' });
    }
    return makeEnvelope('pong', env.id, 0, {});
  },
};

async function connectEdge(
  port: number,
  edgeId: string,
  accountId?: string,
  mode?: HelloPayload['mode'],
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(ws, 'open');
  ws.send(JSON.stringify(makeEnvelope('hello', `h-${edgeId}`, 0, { edgeId, accountId, mode })));
  await once(ws, 'message'); // welcome：此时 edges 已登记
  return ws;
}

test('开关开：task 会话被 account→edge 派工解析跳过；有编排态兄弟时解析落编排态', async () => {
  const s = new EdgeCloudServer({ handler: helloHandler, port: 0, clock: () => 0, taskModeExclusionEnabled: true });
  await s.start();
  const port = s.address()!;

  // 账号只有一条 task 连接 → 解析为 null（诚实失败，不回退）。
  const taskOnly = await connectEdge(port, 'ads-task-1', 'acc-solo', 'task');
  assert.equal(s.resolveEdgeIdForAccount('acc-solo'), null, 'task 会话不得参与派工解析');
  assert.equal(s.isTaskModeEdge('ads-task-1'), true);

  // 同账号 task + orchestration 并存 → 解析必须落编排态那台。
  const taskPeer = await connectEdge(port, 'ads-task-2', 'acc-dual', 'task');
  const orchPeer = await connectEdge(port, 'edge-orch-2', 'acc-dual', 'orchestration');
  assert.equal(s.resolveEdgeIdForAccount('acc-dual'), 'edge-orch-2', '解析必须跳过 task、落到编排态兄弟');
  assert.equal(s.isTaskModeEdge('ads-task-2'), true);
  assert.equal(s.isTaskModeEdge('edge-orch-2'), false);

  taskOnly.close();
  taskPeer.close();
  orchPeer.close();
  await s.close();
});

test('开关关（默认）：过滤短路，task 会话照常被解析——行为与主干一致', async () => {
  const s = new EdgeCloudServer({ handler: helloHandler, port: 0, clock: () => 0, taskModeExclusionEnabled: false });
  await s.start();
  const ws = await connectEdge(s.address()!, 'ads-task-off', 'acc-off', 'task');

  assert.equal(s.resolveEdgeIdForAccount('acc-off'), 'ads-task-off', '开关关时 task 会话不得被排除');
  // 事实查询与开关解耦：登记态照实报告。
  assert.equal(s.isTaskModeEdge('ads-task-off'), true, 'isTaskModeEdge 报告登记事实，不受开关影响');

  ws.close();
  await s.close();
});

test('不带 mode 的旧会话：缺省 orchestration，开关开时照常解析（滚动兼容）', async () => {
  const s = new EdgeCloudServer({ handler: helloHandler, port: 0, clock: () => 0, taskModeExclusionEnabled: true });
  await s.start();
  const ws = await connectEdge(s.address()!, 'edge-legacy', 'acc-legacy');

  assert.equal(s.resolveEdgeIdForAccount('acc-legacy'), 'edge-legacy', '旧客户端行为必须与今天一致');
  assert.equal(s.isTaskModeEdge('edge-legacy'), false);
  assert.equal(s.isTaskModeEdge('edge-unknown'), false, '未登记 edgeId 如实返回 false');

  ws.close();
  await s.close();
});

test('模式随会话生命周期：task 连接断开后 isTaskModeEdge 归 false', async () => {
  const s = new EdgeCloudServer({ handler: helloHandler, port: 0, clock: () => 0, taskModeExclusionEnabled: true });
  await s.start();
  const ws = await connectEdge(s.address()!, 'ads-ephemeral', 'acc-eph', 'task');
  assert.equal(s.isTaskModeEdge('ads-ephemeral'), true);

  ws.close();
  await once(ws, 'close');
  // 服务端摘除连接是异步的，轮询到登记消失为止（上限 2s）。
  const deadline = Date.now() + 2000;
  while (s.isTaskModeEdge('ads-ephemeral') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(s.isTaskModeEdge('ads-ephemeral'), false, '断开后任务态登记必须失效');
  await s.close();
});
