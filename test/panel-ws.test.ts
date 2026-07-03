import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { EventBus } from '../src/event-bus/index.js';
import {
  startPanelWs,
  serializePanelFrame,
  backpressureDecision,
  PANEL_WS_MAX_SLOW_STRIKES,
} from '../src/panel/panel-ws.js';
import { signJwt } from '../src/panel/jwt.js';

const silent = { log() {}, warn() {} };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function httpListen() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as AddressInfo).port };
}

test('panel WS: 有效 token 连上 + 收到 EventBus 扇出帧', async () => {
  const { server, port } = await httpListen();
  const eventBus = new EventBus();
  const handle = startPanelWs({ httpServer: server, eventBus, jwtSecret: 'sec', logger: silent });
  const token = signJwt({ sub: 'alice' }, 'sec', 3600);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  await new Promise<void>((r) => ws.on('open', () => r()));

  const frame = await new Promise<{ kind: string; data: unknown }>((resolve) => {
    ws.once('message', (d) => resolve(JSON.parse(d.toString())));
    eventBus.emit('interaction.occurred', { action: 'like' });
  });
  assert.equal(frame.kind, 'interaction.occurred');

  ws.close();
  await handle.close();
  await new Promise<void>((r) => server.close(() => r()));
});

test('panel WS: 无效 token 被拒（close 4401）', async () => {
  const { server, port } = await httpListen();
  const eventBus = new EventBus();
  const handle = startPanelWs({ httpServer: server, eventBus, jwtSecret: 'sec', logger: silent });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=bad`);
  const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
  assert.equal(code, 4401);
  await handle.close();
  await new Promise<void>((r) => server.close(() => r()));
});

test('panel WS: 纯只读——接收 client 消息也不报错、不回发（连接保持）', async () => {
  const { server, port } = await httpListen();
  const eventBus = new EventBus();
  const handle = startPanelWs({ httpServer: server, eventBus, jwtSecret: 'sec', logger: silent });
  const token = signJwt({ sub: 'a' }, 'sec', 3600);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  await new Promise<void>((r) => ws.on('open', () => r()));
  ws.send('client指令应被忽略'); // 面板 WS 不接收指令（指令走 /api）
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
  // 缓冲空闲 → 发送、strike 清零
  assert.deepEqual(backpressureDecision(0, 5, { thresholdBytes: 1000, maxStrikes: 3 }), {
    send: true, close: false, nextStrikes: 0,
  });
  // 超阈值、未达上限 → 跳帧、strike+1
  assert.deepEqual(backpressureDecision(2000, 0, { thresholdBytes: 1000, maxStrikes: 3 }), {
    send: false, close: false, nextStrikes: 1,
  });
  // 超阈值、达上限 → 断开
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
  const token = signJwt({ sub: 'a' }, 'sec', 3600);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  await new Promise<void>((r) => ws.on('open', () => r()));
  const frame = await new Promise<{ data: { truncated?: boolean } }>((resolve) => {
    ws.once('message', (d) => resolve(JSON.parse(d.toString())));
    emitAny('interaction.occurred', { action: 'like', blob: 'x'.repeat(300 * 1024) });
  });
  assert.equal(frame.data.truncated, true);
  ws.close();
  await handle.close();
  await new Promise<void>((r) => server.close(() => r()));
});

test('panel WS: 零订阅时 emit 不崩（短路，不序列化 #20）', async () => {
  const { server } = await httpListen();
  const eventBus = new EventBus();
  const handle = startPanelWs({ httpServer: server, eventBus, jwtSecret: 'sec', logger: silent });
  assert.doesNotThrow(() => eventBus.emit('interaction.occurred', { action: 'like' }));
  await handle.close();
  await new Promise<void>((r) => server.close(() => r()));
});
