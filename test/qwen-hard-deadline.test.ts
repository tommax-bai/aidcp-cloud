import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LlmTimeoutError,
  QwenClient,
  type LlmCallCompletedInfo,
  type LlmCallStartedInfo,
} from '../src/llm/qwen.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('fetch 忽略 Abort 且永不 settle → 应用层 deadline 仍单次失败结算', async () => {
  const starts: LlmCallStartedInfo[] = [];
  const terminals: LlmCallCompletedInfo[] = [];
  const fetchImpl = (async () => new Promise<Response>(() => {})) as typeof fetch;
  const client = new QwenClient({
    apiKey: 'test-key',
    model: 'test-model',
    timeoutMs: 25,
    fetchImpl,
    onStart: (info) => starts.push(info),
    onCall: (info) => terminals.push(info),
  });

  const startedAt = Date.now();
  await assert.rejects(
    () => client.complete('secret prompt', { role: 'browse:comment_composer', accountId: 'acct-1' }),
    (error: unknown) => {
      assert.ok(error instanceof LlmTimeoutError);
      assert.equal(error.timeoutMs, 25);
      assert.equal(error.stage, 'request_started');
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 500, '调用方必须由 deadline 结算，不等待底层 fetch');
  assert.deepEqual(starts, [{
    role: 'browse:comment_composer',
    provider: undefined,
    model: 'test-model',
    accountId: 'acct-1',
    timeoutMs: 25,
  }]);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].ok, false);
  assert.equal(terminals[0].timedOut, true);
  assert.equal(terminals[0].stage, 'request_started');
  assert.ok(!JSON.stringify({ starts, terminals }).includes('secret prompt'));
});

test('已收到响应头但 body 永不 settle → deadline 带最后阶段与火山请求 ID', async () => {
  const terminals: LlmCallCompletedInfo[] = [];
  const fetchImpl = (async () => ({
    ok: true,
    headers: new Headers({ 'x-tt-logid': 'volc-log-123' }),
    json: async () => new Promise<never>(() => {}),
  }) as unknown as Response) as typeof fetch;
  const client = new QwenClient({
    apiKey: 'test-key',
    model: 'test-model',
    timeoutMs: 25,
    fetchImpl,
    onCall: (info) => terminals.push(info),
  });

  await assert.rejects(
    () => client.complete('prompt'),
    (error: unknown) => {
      assert.ok(error instanceof LlmTimeoutError);
      assert.equal(error.stage, 'headers_received');
      assert.equal(error.requestId, 'volc-log-123');
      return true;
    },
  );
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].stage, 'headers_received');
  assert.equal(terminals[0].requestId, 'volc-log-123');
  assert.equal(terminals[0].timedOut, true);
});

test('正常响应 → 开始一次、终局一次并记录 body_parsed/requestId', async () => {
  const starts: LlmCallStartedInfo[] = [];
  const terminals: LlmCallCompletedInfo[] = [];
  const fetchImpl = (async () => ({
    ok: true,
    headers: new Headers({ 'x-request-id': 'req-ok-1' }),
    json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
  }) as unknown as Response) as typeof fetch;
  const client = new QwenClient({
    apiKey: 'test-key',
    model: 'test-model',
    fetchImpl,
    onStart: (info) => starts.push(info),
    onCall: (info) => terminals.push(info),
  });

  assert.equal(await client.complete('prompt'), 'ok');
  assert.equal(starts.length, 1);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].ok, true);
  assert.equal(terminals[0].timedOut, false);
  assert.equal(terminals[0].stage, 'body_parsed');
  assert.equal(terminals[0].requestId, 'req-ok-1');
});

test('底层在 deadline 后迟到 reject → 不重复终局且不形成 unhandled rejection', async () => {
  let rejectFetch: ((error: Error) => void) | undefined;
  const terminals: LlmCallCompletedInfo[] = [];
  const fetchImpl = (async () => new Promise<Response>((_resolve, reject) => {
    rejectFetch = reject;
  })) as typeof fetch;
  const client = new QwenClient({
    apiKey: 'test-key',
    timeoutMs: 20,
    fetchImpl,
    onCall: (info) => terminals.push(info),
  });

  await assert.rejects(() => client.complete('prompt'), LlmTimeoutError);
  rejectFetch?.(new Error('late transport failure'));
  await wait(20);
  assert.equal(terminals.length, 1, '迟到 reject 不得产生第二终局');
});
