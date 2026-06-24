import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QwenClient } from '../src/llm/qwen.js';

/**
 * change llm-token-usage-stats：出口捕获 token 用量，且 token 与 ok 解耦（红线）。
 */

type OnCallInfo = {
  role?: string;
  model: string;
  ms: number;
  ok: boolean;
  accountId?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

function fetchReturning(body: unknown, ok = true, status = 200) {
  return (async () => {
    if (!ok) {
      return { ok: false, status, text: async () => 'boom' } as unknown as Response;
    }
    return { ok: true, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

test('成功调用：onCall 带 usage 三件套 + accountId', async () => {
  const seen: OnCallInfo[] = [];
  const c = new QwenClient({
    apiKey: 'k',
    getModel: () => 'qwen-plus',
    fetchImpl: fetchReturning({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    }),
    onCall: (i) => seen.push(i),
  });
  await c.complete('hi', { role: 'browse:content_evaluator', accountId: 'acct-A' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ok, true);
  assert.equal(seen[0].accountId, 'acct-A');
  assert.equal(seen[0].promptTokens, 12);
  assert.equal(seen[0].completionTokens, 7);
  assert.equal(seen[0].totalTokens, 19);
});

test('红线：响应带 usage 但 content 缺失判失败 → 仍如实记真实已计费 token，ok=false', async () => {
  const seen: OnCallInfo[] = [];
  const c = new QwenClient({
    apiKey: 'k',
    getModel: () => 'qwen-plus',
    // usage 已返回（prompt 已计费），但 choices 为空 → chat() 抛错
    fetchImpl: fetchReturning({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 0, total_tokens: 30 } }),
    onCall: (i) => seen.push(i),
  });
  await assert.rejects(() => c.complete('hi', { role: 'browse:content_evaluator' }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ok, false, '判失败');
  assert.equal(seen[0].promptTokens, 30, '已计费 prompt token 绝不因失败清零');
  assert.equal(seen[0].totalTokens, 30);
});

test('真没拿到 usage（HTTP 错）→ token 为 undefined（recorder 端记 0），ok=false', async () => {
  const seen: OnCallInfo[] = [];
  const c = new QwenClient({
    apiKey: 'k',
    getModel: () => 'qwen-plus',
    fetchImpl: fetchReturning(null, false, 500),
    onCall: (i) => seen.push(i),
  });
  await assert.rejects(() => c.complete('hi', { role: 'browse:content_evaluator' }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ok, false);
  assert.equal(seen[0].promptTokens, undefined);
  assert.equal(seen[0].totalTokens, undefined);
});

test('零回归：不传 accountId/不带 usage 的旧响应 → onCall 不报错、token 为 undefined', async () => {
  const seen: OnCallInfo[] = [];
  const c = new QwenClient({
    apiKey: 'k',
    getModel: () => 'qwen-turbo',
    fetchImpl: fetchReturning({ choices: [{ message: { content: 'ok' } }] }), // 无 usage 字段
    onCall: (i) => seen.push(i),
  });
  await c.complete('hi');
  assert.equal(seen[0].ok, true);
  assert.equal(seen[0].accountId, undefined);
  assert.equal(seen[0].totalTokens, undefined);
});
