import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ImageSetPlannerRole } from '../../src/publish-agent/roles/image-set-planner.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import { buildImageSetPlanPrompt } from '../../src/publish-agent/prompts.js';
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

/** 洗稿场景：先写含源参照笔记图的 trigger，再写 createdContent 触发 execute（rewrite-image-count-parity）。 */
function runWithSource(
  llm: unknown,
  sourceImages: Array<{ sourceUrl?: string; ossUrl?: string }>,
  maxImages = 9,
  waitMs = 60,
) {
  const role = new ImageSetPlannerRole({ llmClient: llm as never, maxImages, clock, logger: silentLogger });
  const ctx = new PipelineContext<PipelineFields>();
  role.register(ctx);
  ctx.write('trigger', { generateInput: { referenceNote: { images: sourceImages } } } as never);
  ctx.write('createdContent', created);
  return new Promise<NonNullable<PipelineFields['imageSetPlan']>>((resolve) =>
    setTimeout(() => resolve(ctx.get('imageSetPlan')!), waitMs),
  );
}

/** N 张有效源图（有 sourceUrl）。 */
const usableSrc = (n: number) => Array.from({ length: n }, (_, i) => ({ sourceUrl: `https://src/${i}.jpg` }));

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

describe('ImageSetPlannerRole — 洗稿张数对齐源稿（rewrite-image-count-parity）', () => {
  test('洗稿源 5 张（≤上限）→ 张数钉死 5，LLM 主题不足由系统补齐至 5、保住钩子图', async () => {
    // LLM 只给 3 主题：验证 targetCount=5 覆盖 LLM 的 imageCount，并补齐到 5。
    const llm = { chat: async () => JSON.stringify({ wantImage: true, imageCount: 3, themes: [{ subject: '钩子' }, { subject: '对比' }, { subject: '场景' }], styleHint: null }), complete: async () => '' };
    const plan = await runWithSource(llm, usableSrc(5), 9);
    assert.equal(plan.imageCount, 5, '对齐源稿有效图数 5');
    assert.equal(plan.themes.length, 5, '补齐到 5 项');
    assert.equal(plan.themes[0].subject, '钩子', '图 0 钩子/封面位保留');
  });

  test('洗稿源 12 张（超上限 9）→ 夹回 9', async () => {
    const llm = { chat: async () => JSON.stringify({ wantImage: true, imageCount: 2, themes: [{ subject: 'a' }, { subject: 'b' }], styleHint: null }), complete: async () => '' };
    const plan = await runWithSource(llm, usableSrc(12), 9);
    assert.equal(plan.imageCount, 9, '夹回平台上界 9');
    assert.equal(plan.themes.length, 9);
  });

  test('有效图口径：3 张有 URL + 2 张空 URL → 有效=3 → 张数 3', async () => {
    const mixed = [...usableSrc(3), { sourceUrl: '' }, { sourceUrl: '   ' }];
    const llm = { chat: async () => JSON.stringify({ wantImage: true, imageCount: 8, themes: Array.from({ length: 8 }, (_, i) => ({ subject: `t${i}` })), styleHint: null }), complete: async () => '' };
    const plan = await runWithSource(llm, mixed, 9);
    assert.equal(plan.imageCount, 3, '只按有效（有 URL）源图数对齐');
    assert.equal(plan.themes.length, 3);
  });

  test('洗稿但源无有效图（全空 URL）→ 回落内容驱动（LLM 判断值夹 [1,maxImages]）', async () => {
    const llm = { chat: async () => JSON.stringify({ wantImage: true, imageCount: 2, themes: [{ subject: 'a' }, { subject: 'b' }], styleHint: null }), complete: async () => '' };
    const plan = await runWithSource(llm, [{ sourceUrl: '' }, { sourceUrl: '' }], 9);
    assert.equal(plan.imageCount, 2, '无有效源图 → 用 LLM 判断值，不强制张数');
  });

  test('非洗稿（无 trigger）默认上限已放宽到 9：LLM 出 9 主题不再被夹到 3', async () => {
    const llm = { chat: async () => JSON.stringify({ wantImage: true, imageCount: 9, themes: Array.from({ length: 9 }, (_, i) => ({ subject: `t${i}` })), styleHint: null }), complete: async () => '' };
    const plan = await run(llm, 9); // maxImages=9（默认已 9）
    assert.equal(plan.imageCount, 9, '非洗稿在上限内由内容驱动，最多 9');
  });

  test('洗稿 + LLM 失败 → 降级仍只 1 张（不按源数凑泛图）', async () => {
    const llm = { chat: async () => { throw new Error('LLM down'); }, complete: async () => '' };
    const plan = await runWithSource(llm, usableSrc(9), 9, 2600);
    assert.equal(plan.imageCount, 1, 'LLM 失败诚实降级 1 张，不强凑源数');
  });
});

describe('buildImageSetPlanPrompt — 固定张数措辞（rewrite-image-count-parity）', () => {
  test('传 exactCount → prompt 钉死「固定配 N 张」+ 要求正好 N 项 themes', () => {
    const p = buildImageSetPlanPrompt(created, 9, 5);
    assert.ok(p.includes('固定配 5 张'), 'imageCount 措辞钉死为 5');
    assert.ok(p.includes('正好 5 项'), 'themes 要求正好 5 项');
  });

  test('exactCount 超 cap → 夹回 cap 后钉死', () => {
    const p = buildImageSetPlanPrompt(created, 9, 20);
    assert.ok(p.includes('固定配 9 张'), '超 cap 夹回 9');
  });

  test('不传 exactCount → 维持「建议/范围」措辞（非洗稿零回归）', () => {
    const p = buildImageSetPlanPrompt(created, 9);
    assert.ok(p.includes('建议') && p.includes('范围 1~9'), '非洗稿维持内容驱动措辞');
    assert.ok(!p.includes('固定配'), '不含固定张数措辞');
  });
});
