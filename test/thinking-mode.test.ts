import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QwenClient, buildThinkingParams } from '../src/llm/qwen.js';

/** 捕获请求体的 fetch 桩（始终成功）。 */
function captureFetch() {
  const calls: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

// ── buildThinkingParams（纯函数翻译表，change role-thinking-mode-config）────────────

test('default(undefined) → 空对象（零回归：不发任何 thinking 字段）', () => {
  assert.deepEqual(buildThinkingParams('dashscope', 'qwen3.7-plus', undefined), { params: {} });
  assert.deepEqual(buildThinkingParams('volcengine', 'doubao-seed-2-0-pro', undefined), { params: {} });
});

test('dashscope + Qwen + off → enable_thinking:false', () => {
  assert.deepEqual(buildThinkingParams('dashscope', 'qwen3.7-plus', 'off').params, { enable_thinking: false });
});

test('dashscope + Qwen + on → 守卫回落空 + warn（绝不发会 400 的 enable_thinking:true）', () => {
  const r = buildThinkingParams('dashscope', 'qwen3.7-max', 'on');
  assert.deepEqual(r.params, {});
  assert.ok(r.warn && r.warn.length > 0);
});

test('dashscope + DeepSeek + on → enable_thinking:true（非流式可用）', () => {
  assert.deepEqual(buildThinkingParams('dashscope', 'deepseek-v4-flash', 'on').params, { enable_thinking: true });
});

test('dashscope + DeepSeek + off → enable_thinking:false', () => {
  assert.deepEqual(buildThinkingParams('dashscope', 'deepseek-v4-flash', 'off').params, { enable_thinking: false });
});

test('volcengine + off/on → thinking.type disabled/enabled（非流式可用）', () => {
  assert.deepEqual(buildThinkingParams('volcengine', 'doubao-seed-character', 'off').params, {
    thinking: { type: 'disabled' },
  });
  assert.deepEqual(buildThinkingParams('volcengine', 'doubao-seed-2-0-pro', 'on').params, {
    thinking: { type: 'enabled' },
  });
});

test('未知 provider + on → 失败安全回落空 + warn', () => {
  const r = buildThinkingParams('mystery', 'some-model', 'on');
  assert.deepEqual(r.params, {});
  assert.ok(r.warn);
});

// ── QwenClient 出口请求体形状（注入 fetch 断言 body）────────────────────────────

test('不注入 getThinking / default → 请求体只含 model/messages/temperature（逐字零回归）', async () => {
  const { calls, fetchImpl } = captureFetch();
  const c = new QwenClient({ apiKey: 'k', getModel: () => 'qwen3.7-plus', temperature: 0, fetchImpl });
  await c.complete('hi', { role: 'browse:content_evaluator' });
  assert.deepEqual(Object.keys(calls[0]).sort(), ['messages', 'model', 'temperature']);
  assert.equal('enable_thinking' in calls[0], false);
  assert.equal('thinking' in calls[0], false);
});

test('getThinking=off（豆包）→ body 带 thinking.type disabled', async () => {
  const { calls, fetchImpl } = captureFetch();
  const c = new QwenClient({
    apiKey: 'k',
    getModel: () => 'doubao-seed-character-260628',
    getProvider: () => 'volcengine',
    getThinking: () => 'off',
    providerRuntime: { volcengine: { baseUrl: 'https://ark', apiKey: 'vk' } },
    fetchImpl,
  });
  await c.complete('hi', { role: 'browse:comment_composer' });
  assert.deepEqual(calls[0].thinking, { type: 'disabled' });
});

test('opts.thinkingMode=on 显式覆盖（dashscope deepseek）→ body 带 enable_thinking:true', async () => {
  const { calls, fetchImpl } = captureFetch();
  const c = new QwenClient({ apiKey: 'k', getModel: () => 'deepseek-v4-flash', getProvider: () => 'dashscope', fetchImpl });
  await c.complete('hi', { role: 'publish:ApprovalGatekeeper', thinkingMode: 'on' });
  assert.equal(calls[0].enable_thinking, true);
});

test('opts.thinkingMode=default 显式覆盖 → 压制按角色解析（body 无 thinking 字段）', async () => {
  const { calls, fetchImpl } = captureFetch();
  const c = new QwenClient({
    apiKey: 'k',
    getModel: () => 'doubao-x',
    getProvider: () => 'volcengine',
    getThinking: () => 'on',
    providerRuntime: { volcengine: { baseUrl: 'https://ark', apiKey: 'vk' } },
    fetchImpl,
  });
  await c.complete('hi', { role: 'r', thinkingMode: 'default' });
  assert.equal('thinking' in calls[0], false);
});

test('Qwen+on 经出口 → body 无 enable_thinking（守卫，绝不 400）', async () => {
  const { calls, fetchImpl } = captureFetch();
  const c = new QwenClient({ apiKey: 'k', getModel: () => 'qwen3.7-plus', getProvider: () => 'dashscope', getThinking: () => 'on', fetchImpl });
  await c.complete('hi', { role: 'browse:content_evaluator' });
  assert.equal('enable_thinking' in calls[0], false);
});
