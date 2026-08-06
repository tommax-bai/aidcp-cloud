import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { EventBus } from '@automation/event-bus/index.js';
import {
  PANEL_EVENT_DELIVERY_CONTRACT_VERSION,
} from '@kernel/kernel/panel-event-delivery-port.js';
import { PanelEventFanout } from '@api/panel/panel-event-fanout.js';
import {
  startPanelWs,
  serializePanelFrame,
  backpressureDecision,
  PANEL_WS_MAX_SLOW_STRIKES,
} from '@api/panel/panel-ws.js';
import { signJwt } from '@api/panel/jwt.js';
import { TokenRevocationStore } from '@api/panel/revocation.js';

const silent = { log() {}, warn() {} };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function httpListen() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as AddressInfo).port };
}

function jtiOf(token: string): string {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).jti as string;
}

/** 连上并发首帧 {token}（#25 首帧鉴权，不走 URL query）。 */
async function connect(port: number, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((r) => ws.on('open', () => r()));
  ws.send(JSON.stringify({ token }));
  return ws;
}

/** 轮询到认证完成（clientCount = 已认证连接数），再 emit 避免帧在认证前被短路丢弃。 */
async function waitAuthed(handle: { clientCount(): number }): Promise<void> {
  for (let i = 0; i < 100 && handle.clientCount() === 0; i++) await sleep(5);
}

test('panel WS: 首帧有效 token → 认证 + 收到 EventBus 扇出帧（#25）', async () => {
  const { server, port } = await httpListen();
  const eventBus = new EventBus();
  const handle = startPanelWs({ httpServer: server, eventBus, jwtSecret: 'sec', logger: silent });
  const ws = await connect(port, signJwt({ sub: 'alice' }, 'sec', 3600));
  await waitAuthed(handle);
  assert.equal(handle.clientCount(), 1);
  const frame = await new Promise<{ kind: string }>((resolve) => {
    ws.once('message', (d) => resolve(JSON.parse(d.toString())));
    eventBus.emit('interaction.occurred', { action: 'like' });
  });
  assert.equal(frame.kind, 'interaction.occurred');
  ws.close();
  await handle.close();
  await new Promise<void>((r) => server.close(() => r()));
});

test('panel WS: API-local fanout ingress → 已认证 WebSocket，保留 automation 原始时间', async () => {
  const { server, port } = await httpListen();
  const fanout = new PanelEventFanout(silent);
  const handle = startPanelWs({ httpServer: server, eventBus: fanout, jwtSecret: 'sec', logger: silent });
  const ws = await connect(port, signJwt({ sub: 'alice' }, 'sec', 3600));
  await waitAuthed(handle);

  const framePromise = new Promise<{ ts: number; kind: string; data: unknown }>((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
  await fanout.deliver({
    contractVersion: PANEL_EVENT_DELIVERY_CONTRACT_VERSION,
    executionTarget: 'dev',
    deliveryId: 'event_outbox:dev:3',
    event: 'interaction.occurred',
    data: { action: 'like' },
    originTs: 1_700_000_000_123,
  });

  assert.deepEqual(await framePromise, {
    ts: 1_700_000_000_123,
    kind: 'interaction.occurred',
    data: { action: 'like' },
  });
  ws.close();
  await handle.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('panel WS: 首帧无效 token → close 4401（#25）', async () => {
  const { server, port } = await httpListen();
  const eventBus = new EventBus();
  const handle = startPanelWs({ httpServer: server, eventBus, jwtSecret: 'sec', logger: silent });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((r) => ws.on('open', () => r()));
  ws.send(JSON.stringify({ token: 'bad' }));
  const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
  assert.equal(code, 4401);
  await handle.close();
  await new Promise<void>((r) => server.close(() => r()));
});

test('panel WS: URL ?token= 不再被认证（#25 首帧鉴权止 Nginx 日志泄露）', async () => {
  const { server, port } = await httpListen();
  const eventBus = new EventBus();
  const handle = startPanelWs({ httpServer: server, eventBus, jwtSecret: 'sec', logger: silent });
  const token = signJwt({ sub: 'a' }, 'sec', 3600);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  await new Promise<void>((r) => ws.on('open', () => r()));
  await sleep(60);
  assert.equal(handle.clientCount(), 0, 'URL token 不被认证，须走首帧');
  ws.close();
  await handle.close();
  await new Promise<void>((r) => server.close(() => r()));
});

test('panel WS: 被撤销令牌首帧 → close 4401（#26）', async () => {
  const { server, port } = await httpListen();
  const eventBus = new EventBus();
  const revocation = new TokenRevocationStore();
  const handle = startPanelWs({ httpServer: server, eventBus, jwtSecret: 'sec', revocation, logger: silent });
  const token = signJwt({ sub: 'a' }, 'sec', 3600);
  revocation.revoke(jtiOf(token), Math.floor(Date.now() / 1000) + 3600);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((r) => ws.on('open', () => r()));
  ws.send(JSON.stringify({ token }));
  const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
  assert.equal(code, 4401);
  await handle.close();
  await new Promise<void>((r) => server.close(() => r()));
});

test('panel WS: 令牌到 exp 主动断连 4401（#25 堵连接期法外之地）', async () => {
  const { server, port } = await httpListen();
  const eventBus = new EventBus();
  const handle = startPanelWs({ httpServer: server, eventBus, jwtSecret: 'sec', logger: silent });
  const ws = await connect(port, signJwt({ sub: 'a' }, 'sec', 1)); // 1s TTL
  const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
  assert.equal(code, 4401);
  await handle.close();
  await new Promise<void>((r) => server.close(() => r()));
});

test('panel WS: 认证后 client 消息被忽略、连接保持（纯只读）', async () => {
  const { server, port } = await httpListen();
  const eventBus = new EventBus();
  const handle = startPanelWs({ httpServer: server, eventBus, jwtSecret: 'sec', logger: silent });
  const ws = await connect(port, signJwt({ sub: 'a' }, 'sec', 3600));
  await waitAuthed(handle);
  ws.send('client指令应被忽略'); // 认证后：面板 WS 不接收指令（指令走 /api）
  await sleep(30);
  assert.equal(handle.clientCount(), 1);
  ws.close();
  await handle.close();
  await new Promise<void>((r) => server.close(() => r()));
});

test('serializePanelFrame: 正常帧原样、超大载荷截断为摘要帧（#20）', () => {
  const normal = JSON.parse(serializePanelFrame('interaction.occurred', { action: 'like' }, 1000));
  assert.equal(normal.kind, 'interaction.occurred');
  assert.deepEqual(normal.data, { action: 'like' });

  const big = { blob: 'x'.repeat(300 * 1024) }; // 超 256KB
  const truncated = JSON.parse(serializePanelFrame('page.cards.arrived', big, 1000, 256 * 1024));
  assert.equal(truncated.kind, 'page.cards.arrived');
  assert.equal(truncated.data.truncated, true);
  assert.equal(truncated.data.reason, 'payload_too_large');
  assert.ok(truncated.data.bytes > 256 * 1024);
});

test('backpressureDecision: 低于阈值发送、超阈值跳帧累计、达上限断开（#20）', () => {
  assert.deepEqual(backpressureDecision(0, 5, { thresholdBytes: 1000, maxStrikes: 3 }), {
    send: true, close: false, nextStrikes: 0,
  });
  assert.deepEqual(backpressureDecision(2000, 0, { thresholdBytes: 1000, maxStrikes: 3 }), {
    send: false, close: false, nextStrikes: 1,
  });
  assert.deepEqual(backpressureDecision(2000, 2, { thresholdBytes: 1000, maxStrikes: 3 }), {
    send: false, close: true, nextStrikes: 0,
  });
  assert.ok(PANEL_WS_MAX_SLOW_STRIKES > 0);
});

test('panel WS: 超大事件载荷端到端被截断为摘要帧（#20）', async () => {
  const { server, port } = await httpListen();
  const eventBus = new EventBus();
  const emitAny = eventBus.emit.bind(eventBus) as (kind: string, payload: unknown) => void;
  const handle = startPanelWs({ httpServer: server, eventBus, jwtSecret: 'sec', logger: silent });
  const ws = await connect(port, signJwt({ sub: 'a' }, 'sec', 3600));
  await waitAuthed(handle);
  const frame = await new Promise<{ data: { truncated?: boolean } }>((resolve) => {
    ws.once('message', (d) => resolve(JSON.parse(d.toString())));
    emitAny('interaction.occurred', { action: 'like', blob: 'x'.repeat(300 * 1024) });
  });
  assert.equal(frame.data.truncated, true);
  ws.close();
  await handle.close();
  await new Promise<void>((r) => server.close(() => r()));
});

test('panel WS: 无已认证订阅时 emit 不崩（短路，不序列化 #20）', async () => {
  const { server } = await httpListen();
  const eventBus = new EventBus();
  const handle = startPanelWs({ httpServer: server, eventBus, jwtSecret: 'sec', logger: silent });
  assert.doesNotThrow(() => eventBus.emit('interaction.occurred', { action: 'like' }));
  await handle.close();
  await new Promise<void>((r) => server.close(() => r()));
});
