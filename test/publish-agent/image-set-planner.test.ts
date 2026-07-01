import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ImageSetPlannerRole } from '../../src/publish-agent/roles/image-set-planner.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, CreatedContent } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };
const created: CreatedContent = { title: 'vLLM 部署踩坑', content: '正文内容'.repeat(30), tags: ['a'], tone: 'casual', style: {}, createdAt: clock() };

function run(llm: unknown, maxImages = 3, waitMs = 60) {
  const role = new ImageSetPlannerRole({ llmClient: llm as never, maxImages, clock, logger: silentLogger });
  const ctx = new PipelineContext<PipelineFields>();
  role.register(ctx);
  ctx.write('createdContent', created);
  return new Promise<NonNullable<PipelineFields['imageSetPlan']>>((resolve) =>
    setTimeout(() => resolve(ctx.get('imageSetPlan')!), waitMs),
  );
}

describe('ImageSetPlannerRole（图集选题，仅桩 LLM、不依赖图源）', () => {
  test('LLM 出多主题 → wantImage:true + 张数=themes 长度 + styleHint 透传', async () => {
    const llm = { chat: async () => JSON.stringify({ wantImage: true, imageCount: 3, themes: [{ subject: '架构' }, { subject: '对比' }, { subject: '场景' }], styleHint: '科技扁平' }), complete: async () => '' };
    const plan = await run(llm);
    assert.equal(plan.wantImage, true);
    assert.equal(plan.imageCount, 3);
    assert.equal(plan.themes.length, 3);
    assert.equal(plan.themes[0].subject, '架构', '[0]=钩子图/封面位');
    assert.equal(plan.styleHint, '科技扁平');
  });

  test('越界张数 → 夹到 maxImages（themes 随之裁到 count）', async () => {
    const llm = { chat: async () => JSON.stringify({ wantImage: true, imageCount: 9, themes: Array.from({ length: 9 }, (_, i) => ({ subject: `t${i}` })), styleHint: null }), complete: async () => '' };
    const plan = await run(llm, 3);
    assert.equal(plan.imageCount, 3, '夹到 maxImages=3');
    assert.equal(plan.themes.length, 3);
  });

  test('themes 少于 count → 用标题派生补齐到 count，且保住第 0 张', async () => {
    const llm = { chat: async () => JSON.stringify({ wantImage: true, imageCount: 3, themes: [{ subject: '唯一主题' }], styleHint: null }), complete: async () => '' };
    const plan = await run(llm, 3);
    assert.equal(plan.imageCount, 3);
    assert.equal(plan.themes.length, 3);
    assert.equal(plan.themes[0].subject, '唯一主题', '首张钩子图保留');
  });

  test('图文帖必须有图：张数恒 ≥1（clamp 下界，imageCount:0 也回 1）', async () => {
    const llm = { chat: async () => JSON.stringify({ wantImage: true, imageCount: 0, themes: [{ subject: 'x' }], styleHint: null }), complete: async () => '' };
    const plan = await run(llm, 3);
    assert.ok(plan.imageCount >= 1, '不得为 0 张');
    assert.equal(plan.wantImage, true);
  });

  test('LLM 抛错 → 降级朝更少图退（1 张通用主题，键必写不死锁）', async () => {
    const llm = { chat: async () => { throw new Error('LLM down'); }, complete: async () => '' };
    const plan = await run(llm, 3, 2600); // executeWithFallback 重试 2 次（500+1000ms）
    assert.equal(plan.wantImage, true);
    assert.equal(plan.imageCount, 1, '降级只 1 张');
    assert.equal(plan.themes.length, 1);
  });
});
