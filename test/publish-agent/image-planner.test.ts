import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ImagePlannerRole } from '../../src/publish-agent/roles/image-planner.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, CreatedContent } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };
const created: CreatedContent = { title: 'T', content: '正文', tags: ['a'], tone: 'casual', style: {}, createdAt: clock() };

function run(llm: any, waitMs = 50) {
  const role = new ImagePlannerRole({ llmClient: llm, clock, logger: silentLogger });
  const ctx = new PipelineContext<PipelineFields>();
  role.register(ctx);
  ctx.write('createdContent', created);
  return new Promise<NonNullable<PipelineFields['imagePlan']>>((resolve) =>
    setTimeout(() => resolve(ctx.get('imagePlan')!), waitMs),
  );
}

describe('ImagePlannerRole', () => {
  test('LLM 出 prompt → wantImage:true + 钳合法 style', async () => {
    const llm = { chat: async () => JSON.stringify({ imagePrompt: 'flat illustration', imageStyle: 'illustration', fallbackStrategy: 'skip' }), complete: async () => '' };
    const plan = await run(llm);
    assert.equal(plan.wantImage, true);
    assert.equal(plan.imagePrompt, 'flat illustration');
    assert.equal(plan.imageStyle, 'illustration');
  });

  test('LLM 无 prompt → wantImage:false（不配图计划）', async () => {
    const llm = { chat: async () => JSON.stringify({ imagePrompt: null }), complete: async () => '' };
    const plan = await run(llm);
    assert.equal(plan.wantImage, false);
    assert.equal(plan.imagePrompt, null);
  });

  test('LLM 抛错 → 降级 wantImage:false（键必写，不死锁）', async () => {
    const llm = { chat: async () => { throw new Error('LLM down'); }, complete: async () => '' };
    const plan = await run(llm, 2600); // executeWithFallback 重试 2 次（500+1000ms）
    assert.equal(plan.wantImage, false);
  });
});
