import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TopicGeneratorRole } from '../../src/publish-agent/roles/topic-generator.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, AssembledContent, TriggerInput } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function makeAssembled(finalContent = '昨天试了 vLLM 跑 14B，显存直接爆了，调小 max_model_len 才起来'): AssembledContent {
  return {
    finalContent, finalTags: [], imageUrls: [], imageUrl: null,
    aiScore: 0.1, qualityScore: 80, rewritten: false, flaggedPhrases: [], assembledAt: clock(),
  };
}
function makeTrigger(): TriggerInput {
  return {
    metrics: { hoursSinceLastPublish: 30, newConceptCount: 3, likedSinceLastPublish: 20 },
    generateInput: {
      concepts: [], likedContents: [],
      soul: { identity: { name: '小林', role: 'AI研发', background: '3年', tone: '理性' } } as any,
      recentPosts: [],
    },
    recentPublished: [],
  };
}
/** 装 trigger，再写 assembledContent 触发角色（与 TitleCreator 同 watch assembledContent），等待结算。 */
async function run(role: TopicGeneratorRole, assembled: AssembledContent, ms = 60) {
  const ctx = new PipelineContext<PipelineFields>();
  ctx.write('trigger', makeTrigger());
  role.register(ctx);
  ctx.write('assembledContent', assembled);
  await new Promise((r) => setTimeout(r, ms));
  return ctx;
}

describe('split-topic-roles TopicGenerator', () => {
  test('LLM 产候选 → strip 前导#、去重保序，写 topicCandidates', async () => {
    const fakeLlm = { chat: async () => JSON.stringify({ topics: ['#vLLM', 'vLLM', '大模型部署', '踩坑'] }), complete: async () => '' };
    const role = new TopicGeneratorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = await run(role, makeAssembled());
    const cand = ctx.get('topicCandidates');
    assert.ok(cand);
    assert.deepEqual(cand.candidates, ['vLLM', '大模型部署', '踩坑']);
  });

  test('LLM 失败 → 空候选（R1 默认必写键、防 waitAll 死锁、不编造）', async () => {
    const fakeLlm = { chat: async () => { throw new Error('llm down'); }, complete: async () => '' };
    const role = new TopicGeneratorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    // executeWithFallback 重试 2 次（500ms+1000ms 退避）后才降级，故等 2600ms（同 quality-scorer 惯例）。
    const ctx = await run(role, makeAssembled(), 2600);
    const cand = ctx.get('topicCandidates');
    assert.ok(cand, '失败也必写键');
    assert.deepEqual(cand.candidates, []);
  });

  test('空正文 → 空候选、不白调 LLM', async () => {
    let calls = 0;
    const fakeLlm = { chat: async () => { calls++; return '{"topics":["x"]}'; }, complete: async () => '' };
    const role = new TopicGeneratorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = await run(role, makeAssembled(''));
    assert.deepEqual(ctx.get('topicCandidates')!.candidates, []);
    assert.equal(calls, 0);
  });
});
