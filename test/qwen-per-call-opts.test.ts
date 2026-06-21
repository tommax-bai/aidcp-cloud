import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QwenClient } from '../src/llm/qwen.js';

/** 捕获请求体的 fetch 桩（始终成功）。 */
function captureFetch() {
  const calls: Array<{ model: string; temperature: number; messages: unknown }> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test('不传 opts → 用 getModel() 与构造温度（零回归不变量）', async () => {
  const { calls, fetchImpl } = captureFetch();
  const c = new QwenClient({ apiKey: 'k', getModel: () => 'qwen-turbo', temperature: 0, fetchImpl });
  await c.complete('hi');
  assert.equal(calls[0].model, 'qwen-turbo');
  assert.equal(calls[0].temperature, 0);
});

test('opts.role → getModel(role)/getTemperature(role) 解析', async () => {
  const { calls, fetchImpl } = captureFetch();
  const c = new QwenClient({
    apiKey: 'k',
    getModel: (role) => (role === 'browse:comment_composer' ? 'qwen-max' : 'qwen-turbo'),
    getTemperature: (role) => (role === 'browse:comment_composer' ? 0.8 : undefined),
    fetchImpl,
  });
  await c.complete('hi', { role: 'browse:comment_composer' });
  assert.equal(calls[0].model, 'qwen-max');
  assert.equal(calls[0].temperature, 0.8);
});

test('opts.model/temperature 显式覆盖优先（探活用）', async () => {
  const { calls, fetchImpl } = captureFetch();
  const c = new QwenClient({ apiKey: 'k', getModel: () => 'qwen-turbo', getTemperature: () => 0.5, fetchImpl });
  await c.chat([{ role: 'user', content: 'p' }], { model: 'qwen-probe', temperature: 0.1 });
  assert.equal(calls[0].model, 'qwen-probe');
  assert.equal(calls[0].temperature, 0.1);
});

test('getTemperature 返回 undefined → 回落构造温度', async () => {
  const { calls, fetchImpl } = captureFetch();
  const c = new QwenClient({ apiKey: 'k', getModel: () => 'm', getTemperature: () => undefined, temperature: 0, fetchImpl });
  await c.complete('hi', { role: 'browse:content_evaluator' });
  assert.equal(calls[0].temperature, 0);
});

test('onCall 钩子回报 role/model/ok，且不含 prompt 正文', async () => {
  const { fetchImpl } = captureFetch();
  const seen: Array<{ role?: string; model: string; ms: number; ok: boolean }> = [];
  const c = new QwenClient({ apiKey: 'k', getModel: () => 'qwen-max', fetchImpl, onCall: (i) => seen.push(i) });
  await c.complete('secret-prompt', { role: 'publish:ContentCreator' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].role, 'publish:ContentCreator');
  assert.equal(seen[0].model, 'qwen-max');
  assert.equal(seen[0].ok, true);
  assert.ok(!JSON.stringify(seen[0]).includes('secret-prompt'));
});
