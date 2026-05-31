import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EdgeCloudServer, makeEnvelope } from '../src/comm/index.js';
import type { MessageHandler, EdgeSession } from '../src/comm/ws-server.js';
import type { Envelope } from '../src/comm/protocol.js';

/** 回声 handler：把请求 id 原样回 pong */
const echoHandler: MessageHandler = {
  handle(env: Envelope): Envelope {
    return makeEnvelope('pong', env.id, 0, {});
  },
};

function server() {
  return new EdgeCloudServer({ handler: echoHandler, clock: () => 0 });
}

const session: EdgeSession = { sessionId: 's1' };

test('routeMessage 解析坏帧 → error 信封', async () => {
  const s = server();
  const res = await s.routeMessage('garbage', session);
  assert.equal(res?.type, 'error');
  const payload = res?.payload as { code: string };
  assert.equal(payload.code, 'bad_envelope');
});

test('routeMessage 合法帧 → 交给 handler 并回包', async () => {
  const s = server();
  const text = JSON.stringify(makeEnvelope('ping', 'q1', 1, {}));
  const res = await s.routeMessage(text, session);
  assert.equal(res?.type, 'pong');
  assert.equal(res?.id, 'q1');
});

test('handler 抛错被兜成 error 信封（不崩连接）', async () => {
  const throwing: MessageHandler = {
    handle() {
      throw new Error('boom');
    },
  };
  const s = new EdgeCloudServer({ handler: throwing, clock: () => 0 });
  const text = JSON.stringify(makeEnvelope('ping', 'q2', 1, {}));
  const res = await s.routeMessage(text, session);
  assert.equal(res?.type, 'error');
  const payload = res?.payload as { code: string; message: string };
  assert.equal(payload.code, 'handler_error');
  assert.match(payload.message, /boom/);
});
