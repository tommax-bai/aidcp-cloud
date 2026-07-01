import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TopicEvaluatorRole } from '../../src/publish-agent/roles/topic-evaluator.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, TopicCandidates } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function makeCandidates(candidates: string[]): TopicCandidates {
  return { candidates, generatedAt: clock() };
}
/** 写 topicCandidates 触发评判角色，等待结算。 */
async function run(role: TopicEvaluatorRole, cand: TopicCandidates, ms = 60) {
  const ctx = new PipelineContext<PipelineFields>();
  role.register(ctx);
  ctx.write('topicCandidates', cand);
  await new Promise((r) => setTimeout(r, ms));
  return ctx;
}

describe('split-topic-roles TopicEvaluator', () => {
  test('LLM 保留子集 → 写 topicSelection', async () => {
    const fakeLlm = { chat: async () => JSON.stringify({ kept: ['vLLM', '大模型部署'] }), complete: async () => '' };
    const role = new TopicEvaluatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = await run(role, makeCandidates(['vLLM', '大模型部署', '踩坑']));
    const sel = ctx.get('topicSelection');
    assert.ok(sel);
    assert.deepEqual(sel.selectedTopics, ['vLLM', '大模型部署']);
  });

  test('只筛不加：LLM 返回候选外话题一律剔除', async () => {
    const fakeLlm = { chat: async () => JSON.stringify({ kept: ['vLLM', '编造的候选外热词'] }), complete: async () => '' };
    const role = new TopicEvaluatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = await run(role, makeCandidates(['vLLM', '大模型部署']));
    assert.deepEqual(ctx.get('topicSelection')!.selectedTopics, ['vLLM'], '候选外话题被剔除');
  });

  test('LLM 失败 → 空选择（失败保守，不放行未评判候选）', async () => {
    const fakeLlm = { chat: async () => { throw new Error('down'); }, complete: async () => '' };
    const role = new TopicEvaluatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    // executeWithFallback 重试 2 次（500ms+1000ms 退避）后才降级，故等 2600ms。
    const ctx = await run(role, makeCandidates(['vLLM', '大模型部署']), 2600);
    assert.deepEqual(ctx.get('topicSelection')!.selectedTopics, []);
  });

  test('保留项截断到 ≤30', async () => {
    const many = Array.from({ length: 40 }, (_, i) => 't' + i);
    const fakeLlm = { chat: async () => JSON.stringify({ kept: many }), complete: async () => '' };
    const role = new TopicEvaluatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = await run(role, makeCandidates(many));
    assert.equal(ctx.get('topicSelection')!.selectedTopics.length, 30);
  });

  test('无候选 → 空选择、不白调 LLM', async () => {
    let calls = 0;
    const fakeLlm = { chat: async () => { calls++; return '{"kept":["x"]}'; }, complete: async () => '' };
    const role = new TopicEvaluatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = await run(role, makeCandidates([]));
    assert.deepEqual(ctx.get('topicSelection')!.selectedTopics, []);
    assert.equal(calls, 0);
  });
});
