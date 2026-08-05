/**
 * 关停回归（change close-edge-connections-on-shutdown）。
 *
 * 这两条用例守的是同一件事：**关停 MUST NOT 依赖边缘自己断开**。
 *
 * 背景：`ws` 的 `close()` 只做「不再接受新连接」，已建立的连接它一条都不碰，然后等内部 HTTP
 * 服务端把所有连接收干净才回调。边缘客户端只会持续心跳、不会主动下线 —— 于是回调永远不触发。
 * dev 2026-08-05 上的表现是每次重启都吃满 systemd 的 90 秒停止超时、整组被 SIGKILL，
 * 而关停日志停在「开始」上：既没有完成也没有失败。
 *
 * **改这两条用例时的红线**：客户端在 `close()` 之前和之中 MUST NOT 有任何主动断开动作。
 * 一旦写成「先把客户端关掉再调 close()」，两条用例就都恒绿、什么都不证明了 ——
 * 那正是本 bug 能一直活到生产的原因（既有用例全都在结尾先 `ws.close()` 再 `server.close()`）。
 */
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

/** 超时即判失败。默认 `close()` 挂死时 node:test 只会报一句超时，看不出是哪一步没回来。 */
async function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(what)), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function startServer(closeGraceMs?: number): Promise<{ server: EdgeCloudServer; port: number }> {
  const server = new EdgeCloudServer({
    port: 0,
    host: '127.0.0.1',
    handler: echo,
    heartbeatMs: 0,
    ...(closeGraceMs === undefined ? {} : { closeGraceMs }),
  });
  await server.start();
  const port = server.address();
  assert.ok(port, '服务端应已监听');
  return { server, port };
}

test('close(): 边缘连着且全程不动时，关停仍在有界时间内完成，并收到 1001 going away', async () => {
  const { server, port } = await startServer();
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((r) => client.on('open', () => r()));

  const closes: { code: number; reason: string }[] = [];
  client.on('close', (code, reason) => closes.push({ code, reason: reason.toString() }));

  // 完成 hello，让它成为一条**已登记**的边缘连接。
  client.send(JSON.stringify(makeEnvelope('hello', 'h1', 0, { edgeId: 'e1', accountId: 'acct-1' })));
  await new Promise<void>((r) => client.once('message', () => r()));
  await sleep(20);
  assert.equal(server.edgeCount(), 1, '前置：这一条应已登记');

  // 客户端从这里开始什么都不做 —— 它就是生产上那个只会心跳、永不主动下线的边缘。
  await withDeadline(
    server.close(),
    2_000,
    'close() 没有在有界时间内返回：在线连接没有被主动断开，回归到了 90 秒强杀那个形态',
  );

  await sleep(50);
  assert.equal(closes.length, 1, '在线连接应收到一次服务端发起的关闭');
  assert.equal(
    closes[0]?.code,
    1001,
    '关闭码 MUST 是 1001 going away：边缘据此走正常重连，而不是把一次计划内重启记成异常掉线',
  );
});

test('close(): 未完成 hello 的连接同样会被断开（它不在 edges 里，只在 wss.clients 里）', async () => {
  const { server, port } = await startServer();
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((r) => client.on('open', () => r()));
  // 故意不发 hello。
  assert.equal(server.edgeCount(), 0, '前置：这一条不该被登记');

  const closes: number[] = [];
  client.on('close', (code) => closes.push(code));

  await withDeadline(
    server.close(),
    2_000,
    'close() 挂住了：断连若只遍历已登记的 edges，这条 pre-hello 连接就会把关停拖死',
  );

  await sleep(50);
  assert.deepEqual(closes, [1001], 'pre-hello 连接也 MUST 被主动断开');
});

test('close(): 对端装死不回关闭握手时，有界兜底掐断它，关停照样完成', async () => {
  const graceMs = 150;
  const { server, port } = await startServer(graceMs);
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((r) => client.on('open', () => r()));

  // 把客户端的底层 socket 暂停：它收不到、也就不会回应服务端发来的关闭帧。
  // 这是「对端装死」在本进程内最忠实的模拟 —— 连接还在、TCP 还通、就是不回话。
  const raw = (client as unknown as { _socket?: { pause(): void } })._socket;
  assert.ok(raw, '需要底层 socket 才能模拟装死的对端');
  raw.pause();

  const startedAt = Date.now();
  await withDeadline(
    server.close(),
    2_000,
    'close() 挂住了：对端不回关闭握手时，兜底没有把它掐断',
  );
  const elapsed = Date.now() - startedAt;

  assert.ok(
    elapsed >= graceMs,
    `关停应当等满兜底时限才强掐（实测 ${elapsed}ms < ${graceMs}ms）——` +
      '若明显短于时限，说明走的不是兜底路径，这条用例就没验到它',
  );
});

test('close(): 可重复调用，第二次是空操作', async () => {
  const { server, port } = await startServer();
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((r) => client.on('open', () => r()));

  await withDeadline(server.close(), 2_000, '首次 close() 未在有界时间内返回');
  await withDeadline(server.close(), 500, '重复 close() 未立即返回：幂等路径被断连逻辑破坏了');
});
