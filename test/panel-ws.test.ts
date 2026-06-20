import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { EventBus } from '../src/event-bus/index.js';
import { startPanelWs } from '../src/panel/panel-ws.js';
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
