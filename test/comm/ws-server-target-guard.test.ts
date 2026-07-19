/**
 * edge-command-target-guard：定向边缘命令的目标寻址保证（R2）。
 *
 * 验证出口 pushToEdges：
 *  - 缺目标 edgeId 时**绝不广播**——命中 0（诚实失败），即使有多个在线 edge；
 *  - 带目标 edgeId 时只命中目标那一台，其余节点号的在线 edge 不被误投。
 * 用真实 ws 往返以触达 edges 登记表（与 ws-server-pause 同构）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { EdgeCloudServer, makeEnvelope } from '../../src/comm/index.js';
import type { MessageHandler, EdgeSession } from '../../src/comm/ws-server.js';
import type { Envelope, HelloPayload } from '../../src/comm/protocol.js';

/** 最小 handler：hello 落 edgeId/accountId 到 session 并回 welcome。 */
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

async function connectEdge(port: number, edgeId: string, accountId?: string, capabilities?: string[]): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(ws, 'open');
  ws.send(JSON.stringify(makeEnvelope('hello', `h-${edgeId}`, 0, { edgeId, accountId, capabilities })));
  await once(ws, 'message'); // welcome：此时 edges 已登记
  return ws;
}

test('失败 hello 即使已写入账号/能力也不登记在线路由，并在 error 后关闭', async () => {
  const failedHello: MessageHandler = {
    handle(env: Envelope, session: EdgeSession): Envelope {
      if (env.type === 'hello') {
        const p = env.payload as HelloPayload;
        session.edgeId = p.edgeId;
        session.accountId = p.accountId;
        session.capabilities = p.capabilities;
        throw new Error('runtime registry not ready');
      }
      return makeEnvelope('pong', env.id, 0, {});
    },
  };
  const s = new EdgeCloudServer({ handler: failedHello, port: 0, clock: () => 0 });
  await s.start();
  const ws = new WebSocket(`ws://127.0.0.1:${s.address()!}`);
  await once(ws, 'open');
  ws.send(JSON.stringify(makeEnvelope('hello', 'failed-hello', 0, {
    edgeId: 'edge-ghost', accountId: 'acc-ghost', capabilities: ['interaction_test_data_reset_v1'],
  })));
  const [data] = (await once(ws, 'message')) as [Buffer | string];
  assert.equal(JSON.parse(data.toString()).type, 'error');
  await once(ws, 'close');
  assert.equal(s.edgeCount(), 0);
  assert.equal(s.resolveEdgeIdForAccount('acc-ghost', 'interaction_test_data_reset_v1'), null);
  assert.equal(s.pushToEdges(makeEnvelope('interaction.sync.request', 'reset-ghost', 0, {
    requestId: 'reset-ghost',
    envKey: 'env-ghost',
    accountId: 'acc-ghost',
    platform: 'wechat_channels',
    channel: 'comment',
    scopeExternalId: null,
    reason: 'test_reset',
    requestedAt: 0,
  }), 'edge-ghost'), 0);
  await s.close();
});

test('缺目标 edgeId 绝不广播：多个在线 edge 时命中 0（诚实失败）', async () => {
  const s = new EdgeCloudServer({ handler: helloHandler, port: 0, clock: () => 0 });
  await s.start();
  const port = s.address()!;
  const wsA = await connectEdge(port, 'edge-a', 'acc-1');
  const wsB = await connectEdge(port, 'edge-b', 'acc-2');

  const scroll = makeEnvelope('page.scroll', 'c1', 0, {});
  // undefined 目标 → 不广播、命中 0
  assert.equal(s.pushToEdges(scroll), 0, 'undefined edgeId 不得广播');
  // 空串目标 → 同样不广播
  assert.equal(s.pushToEdges(scroll, ''), 0, '空串 edgeId 不得广播');
  // 空白目标 → 同样不广播（trim 后为空）
  assert.equal(s.pushToEdges(scroll, '   '), 0, '空白 edgeId 不得广播');

  wsA.close();
  wsB.close();
  await s.close();
});

test('账号控制只解析到同账号且协商 controls capability 的在线 Edge', async () => {
  const s = new EdgeCloudServer({ handler: helloHandler, port: 0, clock: () => 0 });
  await s.start();
  const port = s.address()!;
  const oldPeer = await connectEdge(port, 'edge-old', 'acc-1', ['interaction_inbox_v1']);
  const wrongAccount = await connectEdge(port, 'edge-wrong', 'acc-2', ['interaction_runtime_controls_v1']);
  assert.equal(s.resolveEdgeIdForAccount('acc-1', 'interaction_runtime_controls_v1'), null);
  const capable = await connectEdge(port, 'edge-capable', 'acc-1', ['interaction_runtime_controls_v1']);
  assert.equal(s.resolveEdgeIdForAccount('acc-1', 'interaction_runtime_controls_v1'), 'edge-capable');
  assert.equal(s.resolveEdgeIdForAccount('acc-2', 'interaction_runtime_controls_v1'), 'edge-wrong');
  oldPeer.close();
  wrongAccount.close();
  capable.close();
  await s.close();
});

test('账号控制是本机安全状态，验证码暂停期间仍须定向下发', async () => {
  const s = new EdgeCloudServer({ handler: helloHandler, port: 0, clock: () => 0 });
  await s.start();
  const port = s.address()!;
  const edge = await connectEdge(port, 'edge-capable', 'acc-1', ['interaction_runtime_controls_v1']);
  s.pauseEdge('edge-capable');
  const controls = makeEnvelope('interaction.runtime.controls', 'controls-1', 0, {
    accountId: 'acc-1', envKey: 'acc-1', version: 2,
    commentsReadEnabled: false, commentsReplyEnabled: false,
    dmReadEnabled: false, dmSendTextEnabled: false, dmSendImageEnabled: false,
  });
  assert.equal(s.pushToEdges(controls, 'edge-capable'), 1);
  const [data] = (await once(edge, 'message')) as [Buffer | string];
  assert.equal(JSON.parse(data.toString()).type, 'interaction.runtime.controls');
  edge.close();
  await s.close();
});

test('浏览器前后台控制在验证码暂停期间仍须定向下发', async () => {
  const s = new EdgeCloudServer({ handler: helloHandler, port: 0, clock: () => 0 });
  await s.start();
  const port = s.address()!;
  const edge = await connectEdge(port, 'edge-browser', 'acc-1', ['interaction_browser_control_v1']);
  s.pauseEdge('edge-browser');
  const control = makeEnvelope('interaction.browser.control', 'browser-control-1', 0, {
    requestId: 'browser-control-1', accountId: 'acc-1', envKey: 'env-1', platform: 'wechat_channels',
    action: 'open', requestedAt: 0,
  });
  assert.equal(s.pushToEdges(control, 'edge-browser'), 1);
  const [data] = (await once(edge, 'message')) as [Buffer | string];
  assert.equal(JSON.parse(data.toString()).type, 'interaction.browser.control');
  edge.close();
  await s.close();
});

test('带目标 edgeId 只命中目标那一台，其余在线 edge 不被误投', async () => {
  const s = new EdgeCloudServer({ handler: helloHandler, port: 0, clock: () => 0 });
  await s.start();
  const port = s.address()!;
  const wsA = await connectEdge(port, 'edge-a', 'acc-1');
  const wsB = await connectEdge(port, 'edge-b', 'acc-2');

  // 捕获 edge-b 收到的帧，证明定向 edge-a 的命令不会落到 edge-b。
  const bFrames: string[] = [];
  wsB.on('message', (d) => bFrames.push(typeof d === 'string' ? d : d.toString()));

  const scroll = makeEnvelope('page.scroll', 'c1', 0, {});
  assert.equal(s.pushToEdges(scroll, 'edge-a'), 1, '定向 edge-a 只命中 1 台');
  // edge-a 应收到该帧（等一条消息，确认送达）。
  const [aData] = (await once(wsA, 'message')) as [Buffer | string];
  const aEnv = JSON.parse(typeof aData === 'string' ? aData : aData.toString()) as Envelope;
  assert.equal(aEnv.type, 'page.scroll');

  // 定向不存在的 edgeId → 命中 0（诚实失败，不回退广播）。
  assert.equal(s.pushToEdges(scroll, 'edge-zzz'), 0, '未知 edgeId 命中 0，不广播');

  // edge-b 全程不应收到任何 page.scroll。
  assert.equal(
    bFrames.filter((f) => f.includes('page.scroll')).length,
    0,
    'edge-b 不得收到定向 edge-a 的命令',
  );

  wsA.close();
  wsB.close();
  await s.close();
});
