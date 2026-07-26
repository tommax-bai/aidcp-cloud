import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { EdgeCloudServer, makeEnvelope } from '../src/comm/index.js';
import type { MessageHandler } from '../src/comm/ws-server.js';

const echo: MessageHandler = {
  handle: (env, session) => {
    if (env.type === 'hello') {
      const payload = env.payload as { edgeId?: string; accountId?: string };
      session.edgeId = payload.edgeId;
      session.accountId = payload.accountId;
      return makeEnvelope('welcome', env.id, 0, {
        sessionId: session.sessionId,
        serverVersion: 'test',
      });
    }
    return makeEnvelope('pong', env.id, 0, {});
  },
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('onlineEdgeCount: staleness——新连接在线、超时 stale、新帧刷新（heartbeat 关定时器、控制 clock）', async () => {
  let now = 1000;
  const server = new EdgeCloudServer({
    port: 0,
    host: '127.0.0.1',
    handler: echo,
    clock: () => now,
    heartbeatMs: 0, // 关定时器，手动控制 staleness
    staleAfterMs: 1000,
  });
  await server.start();
  const port = server.address();
  assert.ok(port);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((r) => ws.on('open', () => r()));

  // hello 登记
  ws.send(JSON.stringify(makeEnvelope('hello', 'h1', now, {
    edgeId: 'e1',
    accountId: 'acct-1',
  })));
  await new Promise<void>((r) => ws.once('message', () => r()));
  await sleep(20); // 等异步登记落定

  assert.equal(server.edgeCount(), 1);
  assert.equal(server.onlineEdgeCount(), 1, '新连接应在线');
  assert.deepEqual(server.edgePresenceSnapshot(), {
    edgeCount: 1,
    onlineEdgeCount: 1,
    accountEdges: [{ accountId: 'acct-1', edgeId: 'e1' }],
  });

  // 时间推进超过 staleAfterMs，无新帧 → stale（不在线），但仍在 Map（edgeCount=1）
  now = 1000 + 2000;
  assert.equal(server.onlineEdgeCount(), 0, '超时无帧应 stale（不在线），不把死连接当在线');
  assert.deepEqual(server.edgePresenceSnapshot(), {
    edgeCount: 1,
    onlineEdgeCount: 0,
    accountEdges: [],
  });
  assert.equal(server.edgeCount(), 1, 'edgeCount 仍是登记总数');

  // 新帧刷新 lastSeen → 回到在线
  ws.send(JSON.stringify(makeEnvelope('ping', 'p1', now, {})));
  await new Promise<void>((r) => ws.once('message', () => r()));
  await sleep(20);
  assert.equal(server.onlineEdgeCount(), 1, '新帧后应回到在线');

  ws.close();
  await server.close();
});
