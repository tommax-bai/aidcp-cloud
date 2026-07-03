/**
 * EdgeCloudServer 按 edge 暂停下发 — captcha-incident-handling 的传输层闸。
 *
 * 验证：暂停后该 edge 收不到普通指令；session.end 仍必达（红线：不死锁）；恢复后续发；
 * 以及按账号批量恢复（飞书人工恢复快路）。用真实 ws 往返以触达 edges 登记表。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { EdgeCloudServer, makeEnvelope } from '../../src/comm/index.js';
import type { MessageHandler, EdgeSession } from '../../src/comm/ws-server.js';
import type { Envelope, HelloPayload } from '../../src/comm/protocol.js';

/** 最小 handler：hello 时把 edgeId/accountId 落到 session 并回 welcome。 */
const helloHandler: MessageHandler = {
  handle(env: Envelope, session: EdgeSession): Envelope {
    if (env.type === 'hello') {
      const p = env.payload as HelloPayload;
      session.edgeId = p.edgeId;
      session.accountId = p.accountId;
      return makeEnvelope('welcome', env.id, 0, { sessionId: session.sessionId, serverVersion: 't' });
    }
    return makeEnvelope('pong', env.id, 0, {});
  },
};

async function connectEdge(port: number, edgeId: string, accountId?: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(ws, 'open');
  ws.send(JSON.stringify(makeEnvelope('hello', `h-${edgeId}`, 0, { edgeId, accountId })));
  await once(ws, 'message'); // welcome：此时 edges 已登记
  return ws;
}

test('暂停后普通指令被丢弃、session.end 必达、恢复后续发', async () => {
  const s = new EdgeCloudServer({ handler: helloHandler, port: 0, clock: () => 0 });
  await s.start();
  const port = s.address();
  assert.ok(port, '应分配到端口');
  const ws = await connectEdge(port!, 'edge-1');

  const scroll = makeEnvelope('page.scroll', 'c1', 0, {});
  const end = makeEnvelope('session.end', 'c2', 0, { reason: 'x' });

  // 暂停前：普通指令可达（定向下发，edge-command-target-guard 后须显式带目标 edgeId）
  assert.equal(s.pushToEdges(scroll, 'edge-1'), 1);

  s.pauseEdge('edge-1');
  // 暂停中：普通指令被丢弃；session.end 仍必达（不死锁）
  assert.equal(s.pushToEdges(scroll, 'edge-1'), 0, '暂停的 edge 不应收到普通指令');
  assert.equal(s.pushToEdges(end, 'edge-1'), 1, 'session.end 必达，绕过暂停闸');
  // ui.snapshot 同样豁免（edge-companion-ui 8.1）：纯界面数据非页面命令，验证码暂停期
  // 吞掉它会让发布终态（rejected/failed）推送永久丢失（终态不经 hello 快照回放）。
  const snap = makeEnvelope('ui.snapshot', 'c3', 0, { publish: { state: 'failed', code: '#1' } });
  assert.equal(s.pushToEdges(snap, 'edge-1'), 1, 'ui.snapshot 必达，绕过暂停闸');

  s.resumeEdge('edge-1');
  assert.equal(s.pushToEdges(scroll, 'edge-1'), 1, '恢复后普通指令应再次可达');

  ws.close();
  await s.close();
});

test('resumeEdgesForAccount 批量恢复某账号名下 edge', async () => {
  const s = new EdgeCloudServer({ handler: helloHandler, port: 0, clock: () => 0 });
  await s.start();
  const port = s.address()!;
  const wsA = await connectEdge(port, 'edge-a', 'acc-1');
  const wsB = await connectEdge(port, 'edge-b', 'acc-2');

  s.pauseEdge('edge-a');
  s.pauseEdge('edge-b');
  const resumed = s.resumeEdgesForAccount('acc-1');
  assert.equal(resumed, 1, '只恢复 acc-1 名下的 edge');
  assert.equal(s.isEdgePaused('edge-a'), false);
  assert.equal(s.isEdgePaused('edge-b'), true, 'acc-2 的 edge 仍暂停');

  wsA.close();
  wsB.close();
  await s.close();
});
