import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ContentAssemblerRole } from '../../src/publish-agent/roles/content-assembler.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, CreatedContent } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function makeCreatedContent(): CreatedContent {
  return {
    title: 'vLLM 部署踩坑',
    content: '原始正文',
    tags: ['vLLM', '大模型部署'],
    tone: 'casual',
    style: { type: '踩坑记录' },
    createdAt: clock(),
  };
}

/** 写入瘦身 ContentAssembler 所需的全部上游键（createdContent + 5 个 waitAll 键）。 */
function writeAllUpstream(ctx: PipelineContext<PipelineFields>, over: { imageUrls?: string[] } = {}) {
  const urls = over.imageUrls ?? [];
  ctx.write('createdContent', makeCreatedContent());
  ctx.write('cleanedContent', { content: '正文(cleaned)', rewritten: true, flaggedPhrases: ['首先'], aiScore: 0.15, cleanedAt: clock() });
  ctx.write('aiFlavorScore', { aiScore: 0.15, scoredAt: clock() });
  ctx.write('qualityReport', { qualityScore: 85, reviewedAt: clock() });
  ctx.write('imageDirective', { imagePrompt: null, imageUrls: urls, imageUrl: urls[0] ?? null, imageStyle: null, fallbackStrategy: 'skip', directedAt: clock() });
  ctx.write('coverSelection', { imageUrls: urls, hasCover: urls.length > 0, selectedAt: clock() });
}

describe('ContentAssemblerRole（瘦身，纯组装）', () => {
  test('waitAll 五键全就绪才触发；缺一不触发', async () => {
    const role = new ContentAssemblerRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);

    // 只写 4 个 waitAll 键 → 不触发
    ctx.write('createdContent', makeCreatedContent());
    ctx.write('cleanedContent', { content: 'c', rewritten: false, flaggedPhrases: [], aiScore: 0.1, cleanedAt: clock() });
    ctx.write('aiFlavorScore', { aiScore: 0.1, scoredAt: clock() });
    ctx.write('qualityReport', { qualityScore: 70, reviewedAt: clock() });
    ctx.write('imageDirective', { imagePrompt: null, imageUrls: [], imageUrl: null, imageStyle: null, fallbackStrategy: 'skip', directedAt: clock() });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ctx.get('assembledContent'), undefined);

    // 补第 5 个 waitAll 键 → 触发
    ctx.write('coverSelection', { imageUrls: [], hasCover: false, selectedAt: clock() });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(ctx.get('assembledContent'));
  });

  test('纯组装：多图透传 imageUrls + imageUrl 派生=首张（无 LLM / 无 IO）', async () => {
    const role = new ContentAssemblerRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    writeAllUpstream(ctx, { imageUrls: ['https://example.com/a.png', 'https://example.com/b.png'] });
    await new Promise((r) => setTimeout(r, 30));

    const a = ctx.get('assembledContent');
    assert.ok(a);
    assert.equal(a.finalContent, '正文(cleaned)');
    assert.deepEqual(a.finalTags, ['vLLM', '大模型部署']);
    assert.deepEqual(a.imageUrls, ['https://example.com/a.png', 'https://example.com/b.png'], '透传上传全集');
    assert.equal(a.imageUrl, 'https://example.com/a.png', 'imageUrl 派生 = 首张（封面）');
    assert.equal(a.aiScore, 0.15);
    assert.equal(a.qualityScore, 85);
    assert.equal(a.rewritten, true);
    assert.deepEqual(a.flaggedPhrases, ['首先']);
    assert.equal(a.assembledAt, clock());
  });

  test('无图：imageUrls 空 + imageUrl 诚实为 null（来自空封面）', async () => {
    const role = new ContentAssemblerRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    writeAllUpstream(ctx, { imageUrls: [] });
    await new Promise((r) => setTimeout(r, 30));
    const a = ctx.get('assembledContent')!;
    assert.deepEqual(a.imageUrls, []);
    assert.equal(a.imageUrl, null);
  });
});
